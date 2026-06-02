import "dotenv/config";
import { createRequire } from "node:module";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type RawMint
} from "@solana/spl-token";
import type {
  BondingCurve,
  FeeConfig,
  Global,
  PumpSdk as PumpSdkClass
} from "@pump-fun/pump-sdk";
import * as PumpSwapSdk from "@pump-fun/pump-swap-sdk";
import type {
  GlobalConfig,
  Pool,
  SwapSolanaState
} from "@pump-fun/pump-swap-sdk";
import BN from "bn.js";
import pg from "pg";
import bs58 from "bs58";
import {
  buildClosePresaleInstruction,
  buildFinalizeMigrateInstruction,
  buildFinalizePumpCreateBuyInstruction,
  buildFinalizePumpSwapBuyInstruction,
  buildSetSettlementInstruction,
  mintPda,
  quoteVaultPda,
  tokenVaultAta,
  type RouteCpiInstruction
} from "@fair/launchpad-client";
import {
  calculatePumpCurveCompletion,
  bytesToHex,
  calculateOversubscriptionSettlement,
  calculatePumpSpendFromTarget,
  merkleProof,
  merkleRoot,
  PUMP_TOKEN_TOTAL_SUPPLY,
  quoteAggregatedFinalizePlan,
  type PumpCurveState,
  type SettlementManifest
} from "@fair/shared";

const DEFAULT_PROGRAM_ID = "3cp7EpueLdu5RM5sPGLdnE8smPdWAkco3aMwAihju7VL";
const PUMP_FEE_RECIPIENT = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
const PUMP_BUYBACK_FEE_RECIPIENT = new PublicKey("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD");
const ROUTE_SOL_RENT_BUFFER_LAMPORTS = new BN(3_000_000);
const {
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_SDK,
  buyQuoteInput,
  canonicalPumpPoolPda,
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
  lpMintPda,
  pumpPoolAuthorityPda
} = PumpSwapSdk;

const require = createRequire(import.meta.url);
const PumpSdkCjs = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const {
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PumpSdk,
  creatorVaultPda,
  feeSharingConfigPda,
  getBuyTokenAmountFromSolAmount,
  userVolumeAccumulatorPda
} = PumpSdkCjs;

type KeeperConfig = {
  rpcUrl: string;
  jitoEndpoint: string;
  programId: PublicKey;
  cluster: "mainnet-beta" | "devnet" | "localnet";
  pollMs: number;
  databaseUrl?: string;
  keeper?: Keypair;
  autoFinalize: boolean;
};

export type SettlementContributor = {
  owner: string;
  committed: BN;
  weight: BN;
};

export type AggregatedRoutePlanInput = {
  target: BN;
  totalCommitted: BN;
  curve: PumpCurveState;
};

function readConfig(): KeeperConfig {
  const cluster = process.env.SOLANA_CLUSTER === "devnet" || process.env.SOLANA_CLUSTER === "localnet"
    ? process.env.SOLANA_CLUSTER
    : "mainnet-beta";
  const programIdRaw = process.env.LAUNCHPAD_PROGRAM_ID ?? DEFAULT_PROGRAM_ID;
  return {
    rpcUrl: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
    jitoEndpoint: process.env.JITO_ENDPOINT ?? "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
    programId: new PublicKey(programIdRaw),
    cluster,
    pollMs: Number(process.env.POLL_MS ?? 10_000),
    databaseUrl: process.env.DATABASE_URL,
    keeper: readKeeperKeypair(),
    autoFinalize: process.env.DISABLE_AUTO_FINALIZE !== "true"
  };
}

function readKeeperKeypair(): Keypair | undefined {
  const raw = process.env.KEEPER_KEYPAIR_JSON ?? process.env.KEEPER_PRIVATE_KEY ?? process.env.SPONSOR_KEYPAIR_JSON;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed) as number[]));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

async function findCloseablePresales(db: pg.Pool): Promise<PublicKey[]> {
  const result = await db.query<{ presale_address: string }>(
    `
      select presale_address
      from launches
      where status = 'LIVE'
        and end_at is not null
        and end_at <= now()
      order by end_at asc
      limit 25
    `
  );
  return result.rows.map((row) => new PublicKey(row.presale_address));
}

export function buildSettlementManifest(input: {
  presale: PublicKey;
  grossAcceptedTotal: BN;
  totalTokensPurchased?: BN;
  maxWalletSupplyBps?: number;
  contributors: SettlementContributor[];
}): SettlementManifest {
  const maxWalletTokenAllocation = input.maxWalletSupplyBps && input.maxWalletSupplyBps > 0
    ? PUMP_TOKEN_TOTAL_SUPPLY.muln(input.maxWalletSupplyBps).divn(10_000)
    : undefined;
  const settlement = calculateOversubscriptionSettlement({
    presale: input.presale.toBytes(),
    target: input.grossAcceptedTotal,
    totalTokensPurchased: input.totalTokensPurchased,
    maxWalletTokenAllocation,
    entries: input.contributors.map((contributor) => ({
      owner: new PublicKey(contributor.owner).toBytes(),
      committed: contributor.committed,
      weight: contributor.weight
    }))
  });
  const leaves = settlement.map((entry) => entry.leaf);
  const root = merkleRoot(leaves);

  return {
    presale: input.presale.toBase58(),
    target: input.grossAcceptedTotal.toString(),
    pumpSpend: calculatePumpSpendFromTarget(input.grossAcceptedTotal).toString(),
    maxWalletSupplyBps: input.maxWalletSupplyBps,
    merkleRoot: bytesToHex(root),
    entries: settlement.map((entry, index) => ({
      owner: input.contributors[index]!.owner,
      committed: entry.committed.toString(),
      weight: entry.weight.toString(),
      grossAccepted: entry.grossAccepted.toString(),
      refund: entry.refund.toString(),
      leaf: bytesToHex(entry.leaf),
      proof: merkleProof(leaves, entry.leaf).map(bytesToHex)
    }))
  };
}

export function buildAggregatedRoutePlan(input: AggregatedRoutePlanInput) {
  return quoteAggregatedFinalizePlan({
    totalCommitted: input.totalCommitted,
    target: input.target,
    curve: input.curve
  });
}

export async function runKeeperOnce(config = readConfig()): Promise<void> {
  const connection = new Connection(config.rpcUrl, "confirmed");
  console.log(`keeper cluster=${config.cluster} program=${config.programId.toBase58()} jito=${config.jitoEndpoint}`);
  const slot = await connection.getSlot("confirmed");
  console.log(`keeper rpc slot=${slot}`);
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required for the keeper/indexer.");
  }

  const db = new pg.Pool({ connectionString: config.databaseUrl });
  const closeable = await findCloseablePresales(db);

  for (const presale of closeable) {
    await prepareSettlementFromDatabase(connection, db, config, presale);
  }
  await db.end();
}

export async function runKeeperLoop(config = readConfig()): Promise<void> {
  console.log(`keeper loop started pollMs=${config.pollMs}`);
  while (true) {
    try {
      await runKeeperOnce(config);
    } catch (error) {
      console.error("keeper iteration failed", error);
    }
    await sleep(config.pollMs);
  }
}

async function prepareSettlementFromDatabase(
  connection: Connection,
  db: pg.Pool,
  config: KeeperConfig,
  presale: PublicKey
): Promise<void> {
  const launchResult = await db.query<{
    target_lamports: string;
    committed_lamports: string;
    creator: string | null;
    mint_address: string | null;
    name: string;
    symbol: string;
    metadata_uri: string | null;
    avatar_url: string | null;
    banner_url: string | null;
    max_wallet_supply_bps: number | null;
  }>(
    `
      select
        target_lamports::text,
        committed_lamports::text,
        creator,
        mint_address,
        name,
        symbol,
        metadata_uri,
        avatar_url,
        banner_url,
        coalesce(max_wallet_supply_bps, 0) as max_wallet_supply_bps
      from launches
      where presale_address = $1
      limit 1
    `,
    [presale.toBase58()]
  );
  const launch = launchResult.rows[0];
  if (!launch) return;

  const presaleAccount = await connection.getAccountInfo(presale, "confirmed");
  if (!presaleAccount || !presaleAccount.owner.equals(config.programId)) {
    console.log(`presale ${presale.toBase58()} is not owned by current program; skipping`);
    return;
  }

  const contributorResult = await db.query<{ owner: string; committed_lamports: string; weight: string }>(
    `
      select owner, committed_lamports::text, weight::text
      from contributors
      where presale_address = $1
      order by owner asc
    `,
    [presale.toBase58()]
  );
  if (contributorResult.rows.length === 0) {
    console.log(`presale ${presale.toBase58()} has no indexed contributors yet`);
    return;
  }

  const target = new BN(launch.target_lamports);
  const committed = new BN(launch.committed_lamports);
  if (config.keeper) {
    await sendInstructions(connection, config.keeper, [
      buildClosePresaleInstruction(config.programId, presale)
    ]).catch((error) => {
      console.warn(`close_presale failed for ${presale.toBase58()}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  if (committed.lt(target)) {
    await db.query("update launches set status = 'REFUNDED', updated_at = now() where presale_address = $1", [presale.toBase58()]);
    await db.query(
      "insert into activity_events(type, presale_address, symbol, message) select 'refund', presale_address, symbol, symbol || ' refunds claimable' from launches where presale_address = $1 on conflict do nothing",
      [presale.toBase58()]
    );
    console.log(`presale ${presale.toBase58()} missed target; marked refunding`);
    return;
  }

  if (config.keeper && config.autoFinalize) {
    if (!launch.creator) {
      throw new Error(`presale ${presale.toBase58()} is missing creator; refusing to finalize without a creator fee recipient`);
    }
    const routeQuote = await chooseRouteQuoteForWalletCap({
      target,
      totalCommitted: committed,
      contributors: contributorResult.rows.map((row) => ({
        committed: new BN(row.committed_lamports)
      })),
      maxWalletSupplyBps: launch.max_wallet_supply_bps ?? 0,
      connection
    });
    if (routeQuote.lte(new BN(0))) {
      throw new Error(`presale ${presale.toBase58()} cannot route any quote under max wallet supply cap`);
    }
    const pumpState = await fetchPumpState(connection);
    const estimatedBuyQuote = routeQuote.gt(ROUTE_SOL_RENT_BUFFER_LAMPORTS)
      ? routeQuote.sub(ROUTE_SOL_RENT_BUFFER_LAMPORTS)
      : routeQuote;
    const estimatedTokensPurchased = estimateRouteTokensForQuote(estimatedBuyQuote, pumpState.global, pumpState.feeConfig);
    if (estimatedTokensPurchased.lte(new BN(0))) {
      throw new Error(`presale ${presale.toBase58()} route quote produced zero estimated tokens`);
    }
    const manifestUri = `${process.env.SETTLEMENT_MANIFEST_BASE_URL ?? "db://settlements"}/${presale.toBase58()}.json`;
    const contributorInputs = contributorResult.rows.map((row) => ({
      owner: row.owner,
      committed: new BN(row.committed_lamports),
      weight: new BN(row.weight)
    }));
    let routeTotals = await readPresaleRouteTotals(connection, presale);
    if (routeTotals.finalizedQuote.isZero()) {
      const preFinalizeManifest = buildSettlementManifest({
        presale,
        grossAcceptedTotal: routeQuote,
        totalTokensPurchased: estimatedTokensPurchased,
        maxWalletSupplyBps: launch.max_wallet_supply_bps ?? 0,
        contributors: contributorInputs
      });
      const preFinalizeGrossAccepted = preFinalizeManifest.entries.reduce((sum, entry) => sum.add(new BN(entry.grossAccepted)), new BN(0));
      if (!preFinalizeGrossAccepted.eq(routeQuote)) {
        throw new Error(
          `settlement manifest gross ${preFinalizeGrossAccepted.toString()} does not match route quote ${routeQuote.toString()}`
        );
      }
      await sendInstructions(connection, config.keeper, [
        buildSetSettlementInstruction({
          programId: config.programId,
          presale,
          authority: config.keeper.publicKey,
          grossAcceptedTotal: routeQuote,
          settlementRoot: hexToBytes(preFinalizeManifest.merkleRoot),
          settlementUri: manifestUri
        })
      ]);
      await upsertSettlementManifest(db, presale, preFinalizeManifest, manifestUri);

      const finalized = await finalizeLaunchRoute({
        connection,
        db,
        config,
        presale,
        launch: {
          creator: new PublicKey(launch.creator),
          mint: launch.mint_address ? new PublicKey(launch.mint_address) : mintPda(config.programId, presale),
          name: launch.name,
          symbol: launch.symbol,
          metadataUri: launch.metadata_uri ?? "",
          avatarUrl: launch.avatar_url,
          bannerUrl: launch.banner_url
        },
        target: routeQuote,
        totalCommitted: committed
      });
      if (!finalized) return;
      routeTotals = await readPresaleRouteTotals(connection, presale);
    }

    if (routeTotals.finalizedQuote.gt(new BN(0))) {
      const grossAcceptedTotal = routeTotals.finalizedQuote;
      const totalTokensPurchased = routeTotals.totalTokensPurchased;
      const finalManifest = buildSettlementManifest({
        presale,
        grossAcceptedTotal,
        totalTokensPurchased,
        maxWalletSupplyBps: launch.max_wallet_supply_bps ?? 0,
        contributors: contributorInputs
      });
      const finalGrossAccepted = finalManifest.entries.reduce((sum, entry) => sum.add(new BN(entry.grossAccepted)), new BN(0));
      if (!finalGrossAccepted.eq(grossAcceptedTotal)) {
        throw new Error(
          `settlement manifest gross ${finalGrossAccepted.toString()} does not match finalized quote ${grossAcceptedTotal.toString()}`
        );
      }
      await sendInstructions(connection, config.keeper, [
        buildSetSettlementInstruction({
          programId: config.programId,
          presale,
          authority: config.keeper.publicKey,
          grossAcceptedTotal,
          settlementRoot: hexToBytes(finalManifest.merkleRoot),
          settlementUri: manifestUri
        })
      ]);
      await upsertSettlementManifest(db, presale, finalManifest, manifestUri);
      await db.query(
        "insert into activity_events(type, presale_address, symbol, message) values ('settlement_ready', $1, $2, $2 || ' settlement ready') on conflict do nothing",
        [presale.toBase58(), launch.symbol]
      );
      console.log(`presale ${presale.toBase58()} settlement root=${finalManifest.merkleRoot} tokens=${totalTokensPurchased.toString()}`);
      await db.query("update launches set status = 'COMPLETED', updated_at = now() where presale_address = $1", [presale.toBase58()]);
    }
    return;
  }
}

async function upsertSettlementManifest(
  db: pg.Pool,
  presale: PublicKey,
  manifest: SettlementManifest,
  manifestUri: string
) {
  await db.query(
    `
      insert into settlement_manifests(
        presale_address,
        target_lamports,
        pump_spend_lamports,
        merkle_root,
        manifest_uri,
        manifest_json
      ) values ($1, $2, $3, $4, $5, $6)
      on conflict (presale_address) do update set
        target_lamports = excluded.target_lamports,
        pump_spend_lamports = excluded.pump_spend_lamports,
        merkle_root = excluded.merkle_root,
        manifest_uri = excluded.manifest_uri,
        manifest_json = excluded.manifest_json
    `,
    [
      presale.toBase58(),
      manifest.target,
      manifest.pumpSpend,
      manifest.merkleRoot,
      manifestUri,
      JSON.stringify(manifest)
    ]
  );
}

type FinalizeLaunchInput = {
  connection: Connection;
  db: pg.Pool;
  config: KeeperConfig;
  presale: PublicKey;
  launch: {
    creator: PublicKey;
    mint: PublicKey;
    name: string;
    symbol: string;
    metadataUri: string;
    avatarUrl: string | null;
    bannerUrl: string | null;
  };
  target: BN;
  totalCommitted: BN;
};

async function chooseRouteQuoteForWalletCap(input: {
  target: BN;
  totalCommitted: BN;
  contributors: { committed: BN }[];
  maxWalletSupplyBps: number;
  connection: Connection;
}): Promise<BN> {
  const target = BN.min(input.target, input.totalCommitted);
  if (target.lte(new BN(0)) || input.contributors.length <= 0 || input.maxWalletSupplyBps <= 0) {
    return target;
  }

  const maxWalletTokens = PUMP_TOKEN_TOTAL_SUPPLY.muln(input.maxWalletSupplyBps).divn(10_000);
  const pumpState = await fetchPumpState(input.connection);
  const targetTokens = estimateRouteTokensForQuote(target, pumpState.global, pumpState.feeConfig);
  if (canDistributeQuoteWithWalletTokenCap({
    quote: target,
    expectedTokens: targetTokens,
    maxWalletTokens,
    contributors: input.contributors
  })) {
    return target;
  }

  let low = new BN(0);
  let high = target;
  for (let index = 0; index < 48; index += 1) {
    const mid = low.add(high).divn(2);
    if (mid.eq(low) || mid.eq(high)) break;
    const tokens = estimateRouteTokensForQuote(mid, pumpState.global, pumpState.feeConfig);
    if (canDistributeQuoteWithWalletTokenCap({
      quote: mid,
      expectedTokens: tokens,
      maxWalletTokens,
      contributors: input.contributors
    })) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

function canDistributeQuoteWithWalletTokenCap(input: {
  quote: BN;
  expectedTokens: BN;
  maxWalletTokens: BN;
  contributors: { committed: BN }[];
}): boolean {
  if (input.quote.lte(new BN(0)) || input.expectedTokens.lte(new BN(0))) {
    return false;
  }
  const maxGrossAcceptedPerWallet = input.maxWalletTokens
    .mul(input.quote)
    .div(input.expectedTokens);
  if (maxGrossAcceptedPerWallet.lte(new BN(0))) {
    return false;
  }
  const distributableQuote = input.contributors.reduce((sum, contributor) => {
    return sum.add(BN.min(contributor.committed, maxGrossAcceptedPerWallet));
  }, new BN(0));
  return distributableQuote.gte(input.quote);
}

function estimateRouteTokensForQuote(quote: BN, global: Global, feeConfig: FeeConfig | null): BN {
  if (quote.lte(new BN(0))) return new BN(0);
  const completion = calculatePumpCurveCompletion();
  const pumpQuote = BN.min(quote, completion.realSolReserves);
  const pumpTokens = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: pumpQuote,
    quoteMint: NATIVE_MINT
  });
  if (quote.lte(completion.realSolReserves)) {
    return pumpTokens;
  }

  const remainder = quote.sub(completion.realSolReserves);
  const pumpSwapTokens = remainder
    .mul(completion.virtualTokenReserves)
    .div(completion.virtualSolReserves.add(remainder));
  return pumpTokens.add(pumpSwapTokens);
}

async function readPresaleRouteTotals(connection: Connection, presale: PublicKey): Promise<{
  finalizedQuote: BN;
  totalTokensPurchased: BN;
}> {
  const account = await connection.getAccountInfo(presale, "confirmed");
  if (!account) {
    throw new Error(`presale account not found after finalize: ${presale.toBase58()}`);
  }
  const buffer = account.data;
  let offset = 8 + 8 + (32 * 4);
  const metadataLength = buffer.readUInt32LE(offset);
  offset += 4 + metadataLength;
  const statusOffset = offset + 5;
  const settlementUriOffset = statusOffset + 193;
  const settlementUriLength = buffer.readUInt32LE(settlementUriOffset);
  const routeStateOffset = settlementUriOffset + 4 + settlementUriLength;
  const totalTokensOffset = routeStateOffset + 1 + 8 + 8 + 8;
  const finalizedQuoteOffset = totalTokensOffset + 8 + 8;
  return {
    totalTokensPurchased: new BN(buffer.readBigUInt64LE(totalTokensOffset).toString()),
    finalizedQuote: new BN(buffer.readBigUInt64LE(finalizedQuoteOffset).toString())
  };
}

async function finalizeLaunchRoute(input: FinalizeLaunchInput): Promise<boolean> {
  const { connection, db, config, presale, launch, target, totalCommitted } = input;
  if (!config.keeper) return false;

  const pumpSpend = calculatePumpSpendFromTarget(target);
  const completion = calculatePumpCurveCompletion();
  const routePlan = buildAggregatedRoutePlan({
    target,
    totalCommitted,
    curve: {
      quoteRemainingToGraduate: completion.realSolReserves,
      expectedTokensBeforeMigration: new BN(0),
      expectedTokensAfterMigration: new BN(0),
      migrationRequired: pumpSpend.gt(completion.realSolReserves)
    }
  });

  const pumpState = await fetchPumpState(connection);
  const quoteForPump = BN.min(routePlan.quoteForPump, pumpSpend);
  const quoteForPumpBuy = quoteForPump.gt(ROUTE_SOL_RENT_BUFFER_LAMPORTS)
    ? quoteForPump.sub(ROUTE_SOL_RENT_BUFFER_LAMPORTS)
    : quoteForPump;
  const quoteForPumpSwap = routePlan.quoteForPumpSwap;
  const pumpBuyTokens = getBuyTokenAmountFromSolAmount({
    global: pumpState.global,
    feeConfig: pumpState.feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: quoteForPumpBuy,
    quoteMint: NATIVE_MINT
  });
  if (pumpBuyTokens.lte(new BN(0))) {
    throw new Error(`Pump quote produced zero tokens for ${presale.toBase58()}`);
  }

  const pumpCoinCreator = config.keeper.publicKey;
  const sharedFeeCreator = feeSharingConfigPda(launch.mint);

  const setupCreateBuyRoute = await buildPumpCreateBuySetup({
    connection,
    programId: config.programId,
    finalizer: config.keeper.publicKey,
    presale,
    routeCreator: sharedFeeCreator
  });
  if (setupCreateBuyRoute.length > 0) {
    await sendInstructions(connection, config.keeper, setupCreateBuyRoute);
  }

  const createBuyRoute = await buildPumpCreateBuyRoute({
    programId: config.programId,
    finalizer: config.keeper.publicKey,
    presale,
    mint: launch.mint,
    pumpCoinCreator,
    routeCreator: sharedFeeCreator,
    feeShareRecipient: launch.creator,
    name: launch.name,
    symbol: launch.symbol,
    uri: launch.metadataUri,
    global: pumpState.global,
    tokenAmount: pumpBuyTokens,
    quoteAmount: quoteForPumpBuy
  });

  const createBuyIx = buildFinalizePumpCreateBuyInstruction({
    programId: config.programId,
    presale,
    mint: launch.mint,
    finalizer: config.keeper.publicKey,
    maxQuoteSpend: quoteForPump,
    minTokensOut: pumpBuyTokens,
    routeInstructions: toRouteCpis(createBuyRoute, [config.keeper.publicKey]),
    complete: quoteForPumpSwap.isZero()
  });

  await db.query(
    "insert into route_steps(presale_address, step, status, quote_lamports) values ($1, 'pump_create_buy', 'planned', $2) on conflict do nothing",
    [presale.toBase58(), quoteForPump.toString()]
  );

  if (quoteForPumpSwap.isZero()) {
    const signature = await sendInstructions(connection, config.keeper, [createBuyIx]);
    await markRouteStep(db, presale, "pump_create_buy", "landed", signature, null);
    await writeLaunchedToken(db, presale, launch, target, "Pump.fun", signature);
    return true;
  }

  const migrateRoute = await buildPumpMigrateRoute({
    finalizer: config.keeper.publicKey,
    mint: launch.mint,
    global: pumpState.global
  });
  const migrateIx = buildFinalizeMigrateInstruction({
    programId: config.programId,
    presale,
    mint: launch.mint,
    finalizer: config.keeper.publicKey,
    routeInstructions: toRouteCpis(migrateRoute, [config.keeper.publicKey])
  });

  const pumpSwapRoute = await buildPumpSwapBuyRoute({
    connection,
    programId: config.programId,
    finalizer: config.keeper.publicKey,
    presale,
    mint: launch.mint,
    creator: sharedFeeCreator,
    quoteAmount: quoteForPumpSwap
  });
  const pumpSwapMinTokens = pumpSwapRoute.expectedBaseOut;
  const pumpSwapIx = buildFinalizePumpSwapBuyInstruction({
    programId: config.programId,
    presale,
    mint: launch.mint,
    finalizer: config.keeper.publicKey,
    maxQuoteSpend: quoteForPumpSwap,
    minTokensOut: pumpSwapMinTokens,
    routeInstructions: toRouteCpis(pumpSwapRoute.instructions, [config.keeper.publicKey])
  });

  await db.query(
    `
      insert into route_steps(presale_address, step, status, quote_lamports)
      values ($1, 'migrate', 'planned', 0), ($1, 'pumpswap_buy', 'planned', $2)
      on conflict do nothing
    `,
    [presale.toBase58(), quoteForPumpSwap.toString()]
  );

  const bundle = await buildSignedTransactions(connection, config.keeper, [
    [createBuyIx],
    [migrateIx],
    [pumpSwapIx]
  ]);
  const bundleResult = await submitJitoBundleWithPolling({
    endpoint: config.jitoEndpoint,
    payer: config.keeper,
    connection,
    transactions: bundle
  });

  await markRouteStep(db, presale, "pump_create_buy", "submitted", null, bundleResult.bundleId);
  await markRouteStep(db, presale, "migrate", "submitted", null, bundleResult.bundleId);
  await markRouteStep(db, presale, "pumpswap_buy", "submitted", null, bundleResult.bundleId);
  if (bundleResult.status !== "landed") {
    throw new Error(`Jito bundle ${bundleResult.bundleId} did not land; status=${bundleResult.status ?? "unknown"}`);
  }

  await markRouteStep(db, presale, "pump_create_buy", "landed", null, bundleResult.bundleId);
  await markRouteStep(db, presale, "migrate", "landed", null, bundleResult.bundleId);
  await markRouteStep(db, presale, "pumpswap_buy", "landed", null, bundleResult.bundleId);
  await writeLaunchedToken(db, presale, launch, target, "Pump.fun + PumpSwap", bundleResult.bundleId);
  return true;
}

async function fetchPumpState(connection: Connection): Promise<{
  sdk: PumpSdkClass;
  global: Global;
  feeConfig: FeeConfig | null;
}> {
  const sdk = new PumpSdk();
  const [globalInfo, feeConfigInfo] = await Promise.all([
    getAccountInfoWithRetry(connection, GLOBAL_PDA),
    getAccountInfoWithRetry(connection, PUMP_FEE_CONFIG_PDA)
  ]);
  if (!globalInfo) {
    throw new Error("Pump global account not found.");
  }
  return {
    sdk,
    global: sdk.decodeGlobal(globalInfo),
    feeConfig: feeConfigInfo ? sdk.decodeFeeConfig(feeConfigInfo) : null
  };
}

async function buildPumpCreateBuyRoute(params: {
  programId: PublicKey;
  finalizer: PublicKey;
  presale: PublicKey;
  mint: PublicKey;
  pumpCoinCreator: PublicKey;
  routeCreator: PublicKey;
  feeShareRecipient: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  global: Global;
  tokenAmount: BN;
  quoteAmount: BN;
}): Promise<TransactionInstruction[]> {
  const sdk = new PumpSdk();
  const quoteVault = quoteVaultPda(params.programId, params.presale);
  const allocationVault = tokenVaultAta(params.presale, params.mint);
  const quoteVaultTokenAta = getAssociatedTokenAddressSync(params.mint, quoteVault, true, TOKEN_2022_PROGRAM_ID);

  const createIx = await sdk.createV2Instruction({
    mint: params.mint,
    name: params.name,
    symbol: params.symbol,
    uri: params.uri,
    creator: params.pumpCoinCreator,
    user: params.finalizer,
    mayhemMode: false,
    cashback: false,
    quoteMint: NATIVE_MINT
  });
  const createFeeSharingIx = await sdk.createFeeSharingConfig({
    creator: params.pumpCoinCreator,
    mint: params.mint,
    pool: null
  });
  const updateFeeSharesIx = await sdk.updateFeeSharesV2({
    authority: params.pumpCoinCreator,
    mint: params.mint,
    currentShareholders: [params.pumpCoinCreator],
    newShareholders: [{ address: params.feeShareRecipient, shareBps: 10_000 }],
    quoteMint: NATIVE_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID
  });
  const buyIx = await sdk.getBuyV2InstructionRaw({
    user: quoteVault,
    mint: params.mint,
    creator: params.routeCreator,
    amount: params.tokenAmount,
    quoteAmount: params.quoteAmount,
    feeRecipient: PUMP_FEE_RECIPIENT,
    buybackFeeRecipient: PUMP_BUYBACK_FEE_RECIPIENT,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteMint: NATIVE_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID
  });

  return [
    createIx,
    createFeeSharingIx,
    updateFeeSharesIx,
    createAssociatedTokenAccountIdempotentInstruction(
      params.finalizer,
      allocationVault,
      params.presale,
      params.mint,
      TOKEN_2022_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      params.finalizer,
      quoteVaultTokenAta,
      quoteVault,
      params.mint,
      TOKEN_2022_PROGRAM_ID
    ),
    buyIx,
    createTransferInstruction(
      quoteVaultTokenAta,
      allocationVault,
      quoteVault,
      BigInt(params.tokenAmount.toString()),
      [],
      TOKEN_2022_PROGRAM_ID
    )
  ];
}

async function buildPumpCreateBuySetup(params: {
  connection: Connection;
  programId: PublicKey;
  finalizer: PublicKey;
  presale: PublicKey;
  routeCreator: PublicKey;
}): Promise<TransactionInstruction[]> {
  const sdk = new PumpSdk();
  const quoteVault = quoteVaultPda(params.programId, params.presale);
  const quoteVaultWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, quoteVault, true, TOKEN_PROGRAM_ID);
  const creatorVault = creatorVaultPda(params.routeCreator);
  const creatorVaultWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, creatorVault, true, TOKEN_PROGRAM_ID);
  const feeRecipientWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, PUMP_FEE_RECIPIENT, true, TOKEN_PROGRAM_ID);
  const buybackFeeRecipientWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, PUMP_BUYBACK_FEE_RECIPIENT, true, TOKEN_PROGRAM_ID);
  const quoteVaultVolumeAccumulator = userVolumeAccumulatorPda(quoteVault);
  const quoteVaultVolumeAccumulatorAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    quoteVaultVolumeAccumulator,
    true,
    TOKEN_PROGRAM_ID
  );
  const [volumeInfo, volumeAtaInfo, quoteVaultWsolInfo, creatorVaultWsolInfo, feeRecipientWsolInfo, buybackFeeRecipientWsolInfo] = await Promise.all([
    getAccountInfoWithRetry(params.connection, quoteVaultVolumeAccumulator),
    getAccountInfoWithRetry(params.connection, quoteVaultVolumeAccumulatorAta),
    getAccountInfoWithRetry(params.connection, quoteVaultWsolAta),
    getAccountInfoWithRetry(params.connection, creatorVaultWsolAta),
    getAccountInfoWithRetry(params.connection, feeRecipientWsolAta),
    getAccountInfoWithRetry(params.connection, buybackFeeRecipientWsolAta)
  ]);
  const instructions: TransactionInstruction[] = [];
  if (!volumeInfo) {
    instructions.push(await sdk.initUserVolumeAccumulator({
      payer: params.finalizer,
      user: quoteVault
    }));
  }
  if (!volumeAtaInfo) {
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(
      params.finalizer,
      quoteVaultVolumeAccumulatorAta,
      quoteVaultVolumeAccumulator,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ));
  }
  if (!quoteVaultWsolInfo) {
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(
      params.finalizer,
      quoteVaultWsolAta,
      quoteVault,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ));
  }
  if (!creatorVaultWsolInfo) {
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(
      params.finalizer,
      creatorVaultWsolAta,
      creatorVault,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ));
  }
  if (!feeRecipientWsolInfo) {
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(
      params.finalizer,
      feeRecipientWsolAta,
      PUMP_FEE_RECIPIENT,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ));
  }
  if (!buybackFeeRecipientWsolInfo) {
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(
      params.finalizer,
      buybackFeeRecipientWsolAta,
      PUMP_BUYBACK_FEE_RECIPIENT,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ));
  }
  return instructions;
}

async function buildPumpMigrateRoute(params: {
  finalizer: PublicKey;
  mint: PublicKey;
  global: Global;
}): Promise<TransactionInstruction[]> {
  const sdk = new PumpSdk();
  return [
    await sdk.migrateV2Instruction({
      withdrawAuthority: params.global.withdrawAuthority,
      mint: params.mint,
      user: params.finalizer,
      quoteMint: NATIVE_MINT,
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID
    })
  ];
}

async function buildPumpSwapBuyRoute(params: {
  connection: Connection;
  programId: PublicKey;
  finalizer: PublicKey;
  presale: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  quoteAmount: BN;
}): Promise<{ instructions: TransactionInstruction[]; expectedBaseOut: BN }> {
  const [globalConfigInfo] = await Promise.all([
    getAccountInfoWithRetry(params.connection, GLOBAL_CONFIG_PDA)
  ]);
  if (!globalConfigInfo) {
    throw new Error("PumpSwap global config account not found.");
  }
  const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(globalConfigInfo);
  const completion = calculatePumpCurveCompletion();
  const poolKey = canonicalPumpPoolPda(params.mint, NATIVE_MINT);
  const poolAuthority = pumpPoolAuthorityPda(params.mint);
  const pool: Pool = {
    poolBump: 0,
    index: 0,
    creator: poolAuthority,
    baseMint: params.mint,
    quoteMint: NATIVE_MINT,
    lpMint: lpMintPda(poolKey),
    poolBaseTokenAccount: getAssociatedTokenAddressSync(params.mint, poolKey, true, TOKEN_2022_PROGRAM_ID),
    poolQuoteTokenAccount: getAssociatedTokenAddressSync(NATIVE_MINT, poolKey, true, TOKEN_PROGRAM_ID),
    lpSupply: new BN(0),
    coinCreator: params.creator,
    isMayhemMode: false,
    isCashbackCoin: false
  };
  const allocationVault = tokenVaultAta(params.presale, params.mint);
  const presaleWsol = getAssociatedTokenAddressSync(NATIVE_MINT, params.presale, true, TOKEN_PROGRAM_ID);
  const baseMintAccount = {
    address: params.mint,
    mintAuthority: null,
    supply: BigInt("1000000000000000"),
    decimals: 6,
    isInitialized: true,
    freezeAuthority: null,
    tlvData: Buffer.alloc(0)
  } as unknown as RawMint;
  const swapState: SwapSolanaState = {
    globalConfig,
    feeConfig: null,
    poolKey,
    poolAccountInfo: fakeAccountInfo(poolKey),
    pool,
    poolBaseAmount: completion.virtualTokenReserves,
    poolQuoteAmount: completion.virtualSolReserves,
    baseTokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    baseMint: params.mint,
    baseMintAccount,
    user: params.presale,
    userBaseTokenAccount: allocationVault,
    userQuoteTokenAccount: presaleWsol,
    userBaseAccountInfo: fakeAccountInfo(allocationVault, TOKEN_2022_PROGRAM_ID),
    userQuoteAccountInfo: fakeAccountInfo(presaleWsol, TOKEN_PROGRAM_ID)
  };

  const quote = buyQuoteInput({
    quote: params.quoteAmount,
    slippage: 0,
    baseReserve: swapState.poolBaseAmount,
    quoteReserve: swapState.poolQuoteAmount,
    globalConfig,
    baseMintAccount,
    baseMint: params.mint,
    coinCreator: params.creator,
    creator: pool.creator,
    feeConfig: null
  });

  const instructions = await PUMP_AMM_SDK.buyInstructionsNoPool(
    swapState,
    quote.base,
    params.quoteAmount
  );

  return {
    expectedBaseOut: quote.base,
    instructions: [
      ...wrapSolFromQuoteVault({
        payer: params.finalizer,
        owner: params.presale,
        quoteVault: quoteVaultPda(params.programId, params.presale),
        wsolAta: presaleWsol,
        amount: params.quoteAmount
      }),
      ...instructions
    ]
  };
}

function wrapSolFromQuoteVault(params: {
  payer: PublicKey;
  owner: PublicKey;
  quoteVault: PublicKey;
  wsolAta: PublicKey;
  amount: BN;
}): TransactionInstruction[] {
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      params.payer,
      params.wsolAta,
      params.owner,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ),
    SystemProgram.transfer({
      fromPubkey: params.quoteVault,
      toPubkey: params.wsolAta,
      lamports: BigInt(params.amount.toString())
    }),
    createSyncNativeInstruction(params.wsolAta)
  ];
}

function toRouteCpis(instructions: TransactionInstruction[], externalSigners: PublicKey[] = []): RouteCpiInstruction[] {
  const signerSet = new Set(externalSigners.map((signer) => signer.toBase58()));
  return instructions.map((instruction) => ({
    programId: instruction.programId,
    keys: instruction.keys.map((key) => ({
      ...key,
      isSigner: signerSet.has(key.pubkey.toBase58())
    })),
    data: instruction.data
  }));
}

function fakeAccountInfo(pubkey: PublicKey, owner = PublicKey.default) {
  return {
    data: Buffer.alloc(0),
    executable: false,
    lamports: 1,
    owner,
    rentEpoch: 0,
    pubkey
  };
}

async function markRouteStep(
  db: pg.Pool,
  presale: PublicKey,
  step: "pump_create_buy" | "migrate" | "pumpswap_buy",
  status: "submitted" | "landed" | "failed",
  signature: string | null,
  bundleId: string | null
) {
  await db.query(
    `
      update route_steps
      set status = $3, signature = coalesce($4, signature), bundle_id = coalesce($5, bundle_id), updated_at = now()
      where presale_address = $1 and step = $2
    `,
    [presale.toBase58(), step, status, signature, bundleId]
  );
}

async function writeLaunchedToken(
  db: pg.Pool,
  presale: PublicKey,
  launch: FinalizeLaunchInput["launch"],
  raised: BN,
  liquidityLabel: string,
  signatureOrBundle: string
) {
  await db.query(
    `
      insert into launched_tokens(
        mint,
        presale_address,
        name,
        symbol,
        raised_lamports,
        liquidity_label,
        dex_screener_url,
        avatar_url,
        banner_url,
        updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      on conflict (mint) do update set
        presale_address = excluded.presale_address,
        raised_lamports = excluded.raised_lamports,
        liquidity_label = excluded.liquidity_label,
        dex_screener_url = excluded.dex_screener_url,
        updated_at = now()
    `,
    [
      launch.mint.toBase58(),
      presale.toBase58(),
      launch.name,
      launch.symbol,
      raised.toString(),
      liquidityLabel,
      `https://dexscreener.com/solana/${launch.mint.toBase58()}`,
      launch.avatarUrl,
      launch.bannerUrl
    ]
  );
  await db.query(
    "insert into activity_events(type, presale_address, symbol, message, signature) values ('finalized', $1, $2, $2 || ' finalized', $3) on conflict do nothing",
    [presale.toBase58(), launch.symbol, signatureOrBundle]
  );
}

async function buildSignedTransactions(
  connection: Connection,
  payer: Keypair,
  instructionGroups: TransactionInstruction[][]
): Promise<VersionedTransaction[]> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  return instructionGroups.map((instructions) => {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    return tx;
  });
}

async function submitJitoBundleWithPolling(params: {
  endpoint: string;
  connection: Connection;
  payer: Keypair;
  transactions: VersionedTransaction[];
}): Promise<{ bundleId: string; status: "landed" | "failed" | "invalid" | null }> {
  const endpoints = jitoEndpoints(params.endpoint);
  const tipLamports = Number(process.env.JITO_TIP_LAMPORTS ?? 0);
  const transactions = [...params.transactions];
  if (tipLamports > 0) {
    const tipAccount = process.env.JITO_TIP_ACCOUNT
      ? new PublicKey(process.env.JITO_TIP_ACCOUNT)
      : await getJitoTipAccount(endpoints);
    if (!tipAccount) {
      throw new Error("Jito tip account unavailable. Set JITO_TIP_ACCOUNT or JITO_TIP_LAMPORTS=0 for dry testing.");
    }
    const [tipTx] = await buildSignedTransactions(params.connection, params.payer, [[
      SystemProgram.transfer({
        fromPubkey: params.payer.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports
      })
    ]]);
    transactions.push(tipTx!);
  }

  const txsBase64 = transactions.map((tx) => Buffer.from(tx.serialize()).toString("base64"));
  const bundleId = await sendJitoBundle(endpoints, txsBase64);
  const status = await pollJitoBundle(endpoints, bundleId);
  return { bundleId, status };
}

async function sendJitoBundle(endpoints: string[], txsBase64: string[]): Promise<string> {
  let lastError: unknown = new Error("sendBundle failed");
  const retries = Number(process.env.JITO_SEND_RETRIES ?? 8);
  for (let attempt = 0; attempt < retries; attempt++) {
    for (const endpoint of endpoints) {
      try {
        const result = await jitoRpc(endpoint, "sendBundle", [txsBase64, { encoding: "base64" }]) as string | { bundle_id?: string };
        if (typeof result === "string") return result;
        if (result?.bundle_id) return result.bundle_id;
        throw new Error(`Unexpected sendBundle result: ${JSON.stringify(result)}`);
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(Number(process.env.JITO_SEND_BACKOFF_MS ?? 1_200));
  }
  throw lastError;
}

async function pollJitoBundle(endpoints: string[], bundleId: string): Promise<"landed" | "failed" | "invalid" | null> {
  let sawInvalid = false;
  const polls = Number(process.env.JITO_STATUS_POLLS ?? 10);
  for (let i = 0; i < polls; i++) {
    for (const endpoint of endpoints) {
      try {
        const inflight = await jitoRpc(endpoint, "getInflightBundleStatuses", [[bundleId]]) as { value?: Array<{ status?: string }> };
        const status = inflight.value?.[0]?.status;
        if (status === "Landed") return "landed";
        if (status === "Failed") return "failed";
        if (status === "Invalid") sawInvalid = true;

        const landed = await jitoRpc(endpoint, "getBundleStatuses", [[bundleId]]) as { value?: Array<{ confirmation_status?: string }> };
        const confirmation = landed.value?.[0]?.confirmation_status;
        if (confirmation === "confirmed" || confirmation === "finalized") return "landed";
      } catch {
        // Try the next block-engine endpoint.
      }
    }
    await sleep(Number(process.env.JITO_STATUS_DELAY_MS ?? 1_200));
  }
  return sawInvalid ? "invalid" : null;
}

async function getJitoTipAccount(endpoints: string[]): Promise<PublicKey | null> {
  for (const endpoint of endpoints) {
    try {
      const result = await jitoRpc(endpoint, "getTipAccounts", []) as string[];
      if (Array.isArray(result) && result.length > 0) {
        return new PublicKey(result[Math.floor(Math.random() * result.length)]!);
      }
    } catch {
      // Try next endpoint.
    }
  }
  return null;
}

async function jitoRpc(endpoint: string, method: string, params: unknown[]) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) {
    throw new Error(`${method} failed: HTTP ${response.status}`);
  }
  const json = await response.json() as { result?: unknown; error?: { message?: string; data?: unknown } };
  if (json.error) {
    throw new Error(`${method} failed: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  return json.result;
}

function jitoEndpoints(endpoint: string): string[] {
  return endpoint
    .split(",")
    .map((item) => normalizeBundleUrl(item))
    .filter(Boolean);
}

function normalizeBundleUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/transactions")) {
    return `${trimmed.slice(0, -"/transactions".length)}/bundles`;
  }
  if (trimmed.endsWith("/bundles")) {
    return trimmed;
  }
  return `${trimmed}/api/v1/bundles`;
}

async function getAccountInfoWithRetry(connection: Connection, pubkey: PublicKey, attempts = 4) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await connection.getAccountInfo(pubkey, "confirmed");
    } catch (error) {
      lastError = error;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendInstructions(connection: Connection, payer: Keypair, instructions: TransactionInstruction[]) {
  let lastError: unknown;
  let lookupTables: AddressLookupTableAccount[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await sendInstructionsCompiled(connection, payer, instructions, lookupTables);
    } catch (error) {
      lastError = error;
      if (error instanceof RangeError && String(error.message).includes("encoding overruns") && lookupTables.length === 0) {
        console.warn("transaction exceeded packet size; creating temporary address lookup table");
        const lookupTable = await createTemporaryLookupTable(connection, payer, collectLookupAddresses(payer.publicKey, instructions));
        lookupTables = [lookupTable];
        continue;
      }
      if (isBlockhashExpiry(error) && attempt < 2) {
        console.warn(`transaction confirmation expired; retrying with fresh blockhash (${attempt + 2}/3)`);
        await sleep(1_000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function isBlockhashExpiry(error: unknown) {
  return error instanceof Error
    && (error.name === "TransactionExpiredBlockheightExceededError"
      || error.message.includes("block height exceeded")
      || error.message.includes("has expired"));
}

async function sendInstructionsCompiled(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[] = []
) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const messageInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    ...instructions
  ];
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: messageInstructions
  }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  tx.serialize();
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5, skipPreflight: false });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

async function createTemporaryLookupTable(
  connection: Connection,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<AddressLookupTableAccount> {
  if (addresses.length === 0) {
    throw new Error("Cannot create address lookup table without addresses.");
  }
  const recentSlot = Math.max(0, (await connection.getSlot("confirmed")) - 20);
  const [createIx, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot
  });
  await sendInstructionsCompiled(connection, payer, [createIx]);

  for (const chunk of chunkArray(addresses, 20)) {
    await sendInstructionsCompiled(connection, payer, [
      AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: lookupTableAddress,
        addresses: chunk
      })
    ]);
  }

  const extensionSlot = await connection.getSlot("confirmed");
  while ((await connection.getSlot("confirmed")) <= extensionSlot + 1) {
    await sleep(500);
  }

  let lookupTable: AddressLookupTableAccount | null = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await connection.getAddressLookupTable(lookupTableAddress, { commitment: "confirmed" });
    const addressCount = result.value?.state.addresses.length ?? 0;
    if (result.value && addressCount >= addresses.length) {
      lookupTable = result.value;
      break;
    }
    await sleep(750 * (attempt + 1));
  }
  if (!lookupTable) {
    throw new Error(`Address lookup table ${lookupTableAddress.toBase58()} was not fully extended after creation.`);
  }
  console.warn(`temporary address lookup table ${lookupTableAddress.toBase58()} contains ${addresses.length} addresses`);
  return lookupTable;
}

function collectLookupAddresses(payer: PublicKey, instructions: TransactionInstruction[]) {
  const signerAddresses = new Set<string>([payer.toBase58()]);
  for (const instruction of instructions) {
    for (const key of instruction.keys) {
      if (key.isSigner) signerAddresses.add(key.pubkey.toBase58());
    }
  }

  const seen = new Set<string>();
  const addresses: PublicKey[] = [];
  const add = (address: PublicKey) => {
    const value = address.toBase58();
    if (signerAddresses.has(value) || seen.has(value)) return;
    seen.add(value);
    addresses.push(address);
  };

  for (const instruction of instructions) {
    add(instruction.programId);
    for (const key of instruction.keys) {
      add(key.pubkey);
    }
  }
  return addresses;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function hexToBytes(hex: string) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(clean.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runKeeperLoop().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
