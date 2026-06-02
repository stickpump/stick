import { createRequire } from "node:module";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection
} from "@solana/web3.js";
import {
  createBurnCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount
} from "@solana/spl-token";
import BN from "bn.js";
import type pg from "pg";
import type { CreatorFeeMode } from "@fair/shared";
import { decryptText } from "./secretCrypto.js";

const require = createRequire(import.meta.url);
const PumpSdk = require("@pump-fun/pump-sdk") as any;
const PumpSwapSdk = require("@pump-fun/pump-swap-sdk") as any;

const {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount
} = PumpSdk;
const {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  canonicalPumpPoolPda
} = PumpSwapSdk;

export const CREATOR_FEE_RESERVE_LAMPORTS = 50_000_000n;
export const BUYBACK_BURN_THRESHOLD_LAMPORTS = 20_000_000n;
export const COINFLIP_THRESHOLD_LAMPORTS = 20_000_000n;
export const FLYWHEEL_THRESHOLD_LAMPORTS = 100_000_000n;

type NonSelfCreatorFeeMode = Exclude<CreatorFeeMode, "self">;

type CreatorFeeJob = {
  presale_address: string;
  mint_address: string;
  creator: string | null;
  symbol: string;
  creator_fee_mode: NonSelfCreatorFeeMode;
  creator_fee_recipient: string | null;
  creator_fee_subwallet_public_key: string | null;
  wallet_public_key: string | null;
  encrypted_secret: string | null;
  funded_at: Date | string | null;
  funding_signature: string | null;
};

type CreatorFeeWorkerOptions = {
  connection: Connection;
  db: pg.Pool;
  keeper: Keypair;
  walletEncryptionKey?: string;
  dryRun?: boolean;
};

type CreatorFeeCycleInput = {
  presaleAddress: string;
  mint?: string;
  mode: NonSelfCreatorFeeMode;
  walletPublicKey?: string;
  claimedLamports?: bigint;
  actionLamports?: bigint;
  result: string;
  holderCount?: number;
  burnedRawAmount?: bigint;
  signatures?: Record<string, string | undefined>;
  recipients?: Array<{ owner: string; lamports: string }>;
  error?: string;
};

export async function runCreatorFeeWorkerOnce(options: CreatorFeeWorkerOptions) {
  if (process.env.DISABLE_CREATOR_FEE_WORKER === "true") return;
  if (!options.walletEncryptionKey && !options.dryRun) {
    console.warn("creator fee worker disabled: WALLET_ENCRYPTION_KEY is not configured");
    return;
  }

  const jobs = await loadCreatorFeeJobs(options.db);
  for (const job of jobs) {
    await withPresaleLock(options.db, job.presale_address, async (client) => {
      await processCreatorFeeJob({ ...options, client, job });
    });
  }
}

async function loadCreatorFeeJobs(db: pg.Pool) {
  const result = await db.query<CreatorFeeJob>(
    `
      select
        l.presale_address,
        l.mint_address,
        l.creator,
        l.symbol,
        l.creator_fee_mode::text as creator_fee_mode,
        l.creator_fee_recipient,
        l.creator_fee_subwallet_public_key,
        w.public_key as wallet_public_key,
        w.encrypted_secret,
        w.funded_at,
        w.funding_signature
      from launches l
      left join creator_fee_wallets w on w.presale_address = l.presale_address
      where l.status = 'COMPLETED'
        and l.mint_address is not null
        and l.creator_fee_mode in ('buyback_burn', 'coinflip', 'flywheel')
      order by l.updated_at asc
      limit 25
    `
  );
  return result.rows;
}

async function withPresaleLock(db: pg.Pool, presaleAddress: string, callback: (client: pg.PoolClient) => Promise<void>) {
  const client = await db.connect();
  try {
    const lockResult = await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtext($1)) as locked", [presaleAddress]);
    if (!lockResult.rows[0]?.locked) return;
    await callback(client);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [presaleAddress]).catch(() => undefined);
    client.release();
  }
}

async function processCreatorFeeJob(input: CreatorFeeWorkerOptions & { client: pg.PoolClient; job: CreatorFeeJob }) {
  const { connection, keeper, walletEncryptionKey, dryRun, client, job } = input;
  if (!job.wallet_public_key || !job.encrypted_secret || !job.creator_fee_recipient || !job.creator_fee_subwallet_public_key) {
    await insertCreatorFeeCycle(client, {
      presaleAddress: job.presale_address,
      mint: job.mint_address,
      mode: job.creator_fee_mode,
      result: "error",
      error: "Creator fee subwallet is missing for non-self mode."
    });
    return;
  }

  const subwallet = dryRun
    ? Keypair.generate()
    : loadEncryptedKeypair(job.encrypted_secret, walletEncryptionKey ?? "");
  const mint = new PublicKey(job.mint_address);
  const walletPublicKey = new PublicKey(job.wallet_public_key);

  if (!job.funded_at && !job.funding_signature) {
    const signature = await fundCreatorFeeReserve({
      connection,
      keeper,
      recipient: walletPublicKey,
      dryRun
    });
    await client.query(
      `
        update creator_fee_wallets
        set funded_lamports = $2,
            funded_at = now(),
            funding_signature = $3,
            updated_at = now()
        where presale_address = $1
      `,
      [job.presale_address, CREATOR_FEE_RESERVE_LAMPORTS.toString(), signature]
    );
  }

  try {
    const claimed = await distributeCreatorFees({
      connection,
      keeper,
      mint,
      recipient: walletPublicKey,
      simulationSigner: keeper.publicKey,
      dryRun
    });
    const walletBalance = dryRun
      ? CREATOR_FEE_RESERVE_LAMPORTS + claimed.claimedLamports + thresholdForMode(job.creator_fee_mode)
      : BigInt(await connection.getBalance(walletPublicKey, "confirmed"));
    const spendable = spendableAfterReserve(walletBalance);
    const threshold = thresholdForMode(job.creator_fee_mode);
    if (spendable < threshold) {
      if (claimed.claimedLamports > 0n || spendable > 0n) {
        await insertCreatorFeeCycle(client, {
          presaleAddress: job.presale_address,
          mint: job.mint_address,
          mode: job.creator_fee_mode,
          walletPublicKey: walletPublicKey.toBase58(),
          claimedLamports: claimed.claimedLamports,
          actionLamports: spendable,
          result: "skipped_threshold",
          signatures: { claim: claimed.claimSignature }
        });
      }
      return;
    }

    if (job.creator_fee_mode === "buyback_burn") {
      const burn = await buybackAndBurn({
        connection,
        keeper,
        wallet: subwallet,
        mint,
        lamports: spendable,
        dryRun
      });
      await insertCreatorFeeCycle(client, {
        presaleAddress: job.presale_address,
        mint: job.mint_address,
        mode: job.creator_fee_mode,
        walletPublicKey: walletPublicKey.toBase58(),
        claimedLamports: claimed.claimedLamports,
        actionLamports: spendable,
        result: "buyback_burn",
        burnedRawAmount: burn.burnedRawAmount,
        signatures: { claim: claimed.claimSignature, buy: burn.buySignature, burn: burn.burnSignature }
      });
      return;
    }

    if (job.creator_fee_mode === "coinflip") {
      const isHeads = Math.random() >= 0.5;
      const flip = await runSlotanaCoinflip({
        wallet: subwallet,
        lamports: spendable,
        isHeads,
        dryRun
      });
      if (!flip.won) {
        await insertCreatorFeeCycle(client, {
          presaleAddress: job.presale_address,
          mint: job.mint_address,
          mode: job.creator_fee_mode,
          walletPublicKey: walletPublicKey.toBase58(),
          claimedLamports: claimed.claimedLamports,
          actionLamports: spendable,
          result: isHeads ? "coinflip_lost_heads" : "coinflip_lost_tails",
          signatures: { claim: claimed.claimSignature, flip: flip.signature }
        });
        return;
      }

      const postFlipBalance = dryRun
        ? CREATOR_FEE_RESERVE_LAMPORTS + (spendable * 2n)
        : await waitForSpendableBalance(connection, walletPublicKey);
      const buybackBudget = spendableAfterReserve(postFlipBalance);
      const burn = await buybackAndBurn({
        connection,
        keeper,
        wallet: subwallet,
        mint,
        lamports: buybackBudget,
        dryRun
      });
      await insertCreatorFeeCycle(client, {
        presaleAddress: job.presale_address,
        mint: job.mint_address,
        mode: job.creator_fee_mode,
        walletPublicKey: walletPublicKey.toBase58(),
        claimedLamports: claimed.claimedLamports,
        actionLamports: buybackBudget,
        result: isHeads ? "coinflip_won_heads" : "coinflip_won_tails",
        burnedRawAmount: burn.burnedRawAmount,
        signatures: { claim: claimed.claimSignature, flip: flip.signature, buy: burn.buySignature, burn: burn.burnSignature }
      });
      return;
    }

    const recipients = await selectFlywheelRecipients({
      connection,
      mint,
      excludeOwners: [
        walletPublicKey.toBase58(),
        keeper.publicKey.toBase58(),
        job.presale_address,
        job.creator_fee_recipient ?? "",
        job.creator ?? ""
      ],
      dryRun
    });
    if (recipients.length === 0) {
      await insertCreatorFeeCycle(client, {
        presaleAddress: job.presale_address,
        mint: job.mint_address,
        mode: job.creator_fee_mode,
        walletPublicKey: walletPublicKey.toBase58(),
        claimedLamports: claimed.claimedLamports,
        actionLamports: spendable,
        result: "no_eligible_holders",
        signatures: { claim: claimed.claimSignature }
      });
      return;
    }
    const distribution = splitLamports(spendable, recipients);
    const signature = await sendFlywheelDistribution({
      connection,
      keeper,
      wallet: subwallet,
      recipients: distribution,
      dryRun
    });
    await insertCreatorFeeCycle(client, {
      presaleAddress: job.presale_address,
      mint: job.mint_address,
      mode: job.creator_fee_mode,
      walletPublicKey: walletPublicKey.toBase58(),
      claimedLamports: claimed.claimedLamports,
      actionLamports: spendable,
      result: "flywheel_distributed",
      holderCount: distribution.length,
      signatures: { claim: claimed.claimSignature, distribution: signature },
      recipients: distribution.map((recipient) => ({
        owner: recipient.owner.toBase58(),
        lamports: recipient.lamports.toString()
      }))
    });
  } catch (error) {
    await insertCreatorFeeCycle(client, {
      presaleAddress: job.presale_address,
      mint: job.mint_address,
      mode: job.creator_fee_mode,
      walletPublicKey: walletPublicKey.toBase58(),
      result: "error",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function loadEncryptedKeypair(encryptedSecret: string, encryptionKey: string) {
  const decrypted = decryptText(encryptedSecret, encryptionKey);
  const parsed = JSON.parse(decrypted) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

async function fundCreatorFeeReserve(input: {
  connection: Connection;
  keeper: Keypair;
  recipient: PublicKey;
  dryRun?: boolean;
}) {
  if (input.dryRun) return `dry-reserve-${Date.now()}`;
  return sendInstructions(input.connection, input.keeper, [
    SystemProgram.transfer({
      fromPubkey: input.keeper.publicKey,
      toPubkey: input.recipient,
      lamports: Number(CREATOR_FEE_RESERVE_LAMPORTS)
    })
  ]);
}

async function distributeCreatorFees(input: {
  connection: Connection;
  keeper: Keypair;
  mint: PublicKey;
  recipient: PublicKey;
  simulationSigner: PublicKey;
  dryRun?: boolean;
}) {
  if (input.dryRun) {
    return {
      claimedLamports: 25_000_000n,
      claimSignature: `dry-claim-${Date.now()}`
    };
  }
  const sdk = new OnlinePumpSdk(input.connection);
  const before = BigInt(await input.connection.getBalance(input.recipient, "confirmed"));
  const feeInfo = await sdk.getMinimumDistributableFee(input.mint, input.simulationSigner);
  if (!feeInfo.canDistribute || BigInt(feeInfo.distributableFees.toString()) <= 0n) {
    return { claimedLamports: 0n, claimSignature: undefined };
  }
  const { instructions } = await sdk.buildDistributeCreatorFeesInstructions(input.mint);
  const claimSignature = instructions.length ? await sendInstructions(input.connection, input.keeper, instructions) : undefined;
  const after = BigInt(await input.connection.getBalance(input.recipient, "confirmed"));
  return {
    claimedLamports: after > before ? after - before : BigInt(feeInfo.distributableFees.toString()),
    claimSignature
  };
}

async function buybackAndBurn(input: {
  connection: Connection;
  keeper: Keypair;
  wallet: Keypair;
  mint: PublicKey;
  lamports: bigint;
  dryRun?: boolean;
}) {
  if (input.lamports <= 0n) throw new Error("Buyback budget is zero");
  if (input.dryRun) {
    return {
      buySignature: `dry-buy-${Date.now()}`,
      burnSignature: `dry-burn-${Date.now()}`,
      burnedRawAmount: input.lamports * 1000n
    };
  }
  const tokenProgram = await detectTokenProgram(input.connection, input.mint);
  const ata = getAssociatedTokenAddressSync(input.mint, input.wallet.publicKey, true, tokenProgram);
  const beforeRaw = await tokenRawBalance(input.connection, ata, tokenProgram);
  const buySignature = await buyback({
    connection: input.connection,
    keeper: input.keeper,
    wallet: input.wallet,
    mint: input.mint,
    lamports: input.lamports,
    tokenProgram
  });
  const afterRaw = await tokenRawBalance(input.connection, ata, tokenProgram);
  const delta = afterRaw > beforeRaw ? afterRaw - beforeRaw : 0n;
  if (delta <= 0n) throw new Error("Buyback confirmed but token balance did not increase");
  const mintInfo = await getMint(input.connection, input.mint, "confirmed", tokenProgram);
  const burnIx = createBurnCheckedInstruction(ata, input.mint, input.wallet.publicKey, delta, mintInfo.decimals, [], tokenProgram);
  const burnSignature = await sendInstructions(input.connection, input.keeper, [burnIx], [input.wallet]);
  return { buySignature, burnSignature, burnedRawAmount: delta };
}

async function buyback(input: {
  connection: Connection;
  keeper: Keypair;
  wallet: Keypair;
  mint: PublicKey;
  lamports: bigint;
  tokenProgram: PublicKey;
}) {
  const sdk = new OnlinePumpSdk(input.connection);
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()]);
  const buyState = await sdk.fetchBuyState(input.mint, input.wallet.publicKey, input.tokenProgram).catch(() => null);
  if (!buyState || buyState.bondingCurve.complete) {
    return ammBuyback(input);
  }

  const solAmount = new BN(input.lamports.toString());
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: buyState.bondingCurve.tokenTotalSupply,
    bondingCurve: buyState.bondingCurve,
    amount: solAmount
  });
  if (amount.lte(new BN(0))) throw new Error("Buyback amount is zero");

  const buyIxs = await PUMP_SDK.buyInstructions({
    global,
    bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
    bondingCurve: buyState.bondingCurve,
    associatedUserAccountInfo: buyState.associatedUserAccountInfo,
    mint: input.mint,
    user: input.wallet.publicKey,
    amount,
    solAmount,
    slippage: Number(process.env.BUYBACK_SLIPPAGE ?? "1"),
    tokenProgram: input.tokenProgram
  });
  return sendInstructions(input.connection, input.keeper, buyIxs, [input.wallet]);
}

async function ammBuyback(input: {
  connection: Connection;
  keeper: Keypair;
  wallet: Keypair;
  mint: PublicKey;
  lamports: bigint;
}) {
  const ammSdk = new OnlinePumpAmmSdk(input.connection);
  const poolKey = canonicalPumpPoolPda(input.mint);
  const swapState = await ammSdk.swapSolanaState(poolKey, input.wallet.publicKey);
  const buyIxs = await PUMP_AMM_SDK.buyQuoteInput(
    swapState,
    new BN(input.lamports.toString()),
    Number(process.env.BUYBACK_SLIPPAGE ?? "1")
  );
  return sendInstructions(input.connection, input.keeper, buyIxs, [input.wallet]);
}

async function detectTokenProgram(connection: Connection, mint: PublicKey) {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`Mint account not found: ${mint.toBase58()}`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Unsupported mint owner: ${info.owner.toBase58()}`);
}

async function tokenRawBalance(connection: Connection, ata: PublicKey, tokenProgram: PublicKey) {
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (!info) return 0n;
  return unpackAccount(ata, info, tokenProgram).amount;
}

async function waitForSpendableBalance(connection: Connection, wallet: PublicKey) {
  let balance = 0n;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    balance = BigInt(await connection.getBalance(wallet, "confirmed"));
    if (spendableAfterReserve(balance) > 0n) return balance;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return balance;
}

async function runSlotanaCoinflip(input: {
  wallet: Keypair;
  lamports: bigint;
  isHeads: boolean;
  dryRun?: boolean;
}) {
  if (input.dryRun) {
    return {
      won: true,
      signature: `dry-flip-${Date.now()}`
    };
  }
  const buildRes = await fetch("https://backend.slotana.io/mainnet/transaction/build/flip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      betAmount: Number(input.lamports),
      cluster: "mainnet",
      mint: [0, 0],
      playerPublicKey: input.wallet.publicKey.toBase58()
    })
  });
  const build = await buildRes.json() as {
    success?: boolean;
    message?: string;
    lastValidBlockHeight?: number;
    serializedTransaction?: Record<string, number> | number[];
  };
  if (!build.success || !build.serializedTransaction || !build.lastValidBlockHeight) {
    throw new Error(build.message ?? "Slotana build failed");
  }
  const tx = VersionedTransaction.deserialize(new Uint8Array(Object.values(build.serializedTransaction)));
  tx.sign([input.wallet]);
  const signedBytes = tx.serialize();
  const submitRes = await fetch("https://backend.slotana.io/mainnet/transaction/flip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lastValidBlockHeight: build.lastValidBlockHeight,
      serializedTx: Array.from(signedBytes),
      isHeads: input.isHeads
    })
  });
  const submit = await submitRes.json() as Record<string, unknown>;
  if (submit.success === false) throw new Error(String(submit.message ?? "Slotana submit failed"));
  return {
    won: extractBoolean(submit.result) ?? extractBoolean(submit.coinFlipAccount) ?? extractBoolean(submit) ?? false,
    signature: String(submit.signature ?? submit.txSignature ?? submit.transactionSignature ?? "")
  };
}

function extractBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["won", "isWon", "isWin", "win", "winner", "isWinner", "hasWon"]) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const nested of ["result", "coinFlipAccount", "data"]) {
    const parsed = extractBoolean(record[nested]);
    if (parsed !== null) return parsed;
  }
  return null;
}

async function selectFlywheelRecipients(input: {
  connection: Connection;
  mint: PublicKey;
  excludeOwners: string[];
  dryRun?: boolean;
}) {
  if (input.dryRun) {
    return Array.from({ length: 10 }, () => Keypair.generate().publicKey);
  }
  const excluded = new Set(input.excludeOwners);
  const holders = new Map<string, bigint>();
  await collectTokenProgramHolders(input.connection, TOKEN_PROGRAM_ID, input.mint, holders);
  await collectTokenProgramHolders(input.connection, TOKEN_2022_PROGRAM_ID, input.mint, holders);
  const eligible = [...holders.entries()]
    .filter(([owner, amount]) => amount > 0n && !excluded.has(owner))
    .map(([owner]) => new PublicKey(owner));
  return pickRandomUnique(eligible, Math.min(10, eligible.length));
}

async function collectTokenProgramHolders(
  connection: Connection,
  tokenProgram: PublicKey,
  mint: PublicKey,
  holders: Map<string, bigint>
) {
  const accounts = await connection.getParsedProgramAccounts(tokenProgram, {
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }]
  }).catch(() => []);
  for (const account of accounts) {
    const parsed = account.account.data as unknown as { parsed?: { info?: { owner?: string; tokenAmount?: { amount?: string } } } };
    const owner = parsed.parsed?.info?.owner;
    const amountText = parsed.parsed?.info?.tokenAmount?.amount;
    if (!owner || !amountText) continue;
    const amount = BigInt(amountText);
    holders.set(owner, (holders.get(owner) ?? 0n) + amount);
  }
}

function pickRandomUnique<T>(items: T[], count: number) {
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < count && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length);
    const [item] = pool.splice(index, 1);
    if (item !== undefined) picked.push(item);
  }
  return picked;
}

function splitLamports(lamports: bigint, recipients: PublicKey[]) {
  if (recipients.length === 0) return [];
  const base = lamports / BigInt(recipients.length);
  let remainder = lamports % BigInt(recipients.length);
  return recipients.map((owner) => {
    const extra = remainder > 0n ? 1n : 0n;
    remainder -= extra;
    return { owner, lamports: base + extra };
  }).filter((entry) => entry.lamports > 0n);
}

async function sendFlywheelDistribution(input: {
  connection: Connection;
  keeper: Keypair;
  wallet: Keypair;
  recipients: Array<{ owner: PublicKey; lamports: bigint }>;
  dryRun?: boolean;
}) {
  if (input.dryRun) return `dry-flywheel-${Date.now()}`;
  return sendInstructions(
    input.connection,
    input.keeper,
    input.recipients.map((recipient) => SystemProgram.transfer({
      fromPubkey: input.wallet.publicKey,
      toPubkey: recipient.owner,
      lamports: Number(recipient.lamports)
    })),
    [input.wallet]
  );
}

async function sendInstructions(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  extraSigners: Keypair[] = []
) {
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: Number(process.env.COMPUTE_UNIT_LIMIT ?? "600000") }),
        ...instructions
      ]
    }).compileToV0Message()
  );
  const signers = [payer, ...extraSigners.filter((signer) => !signer.publicKey.equals(payer.publicKey))];
  tx.sign(signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction({ signature, ...blockhash }, "confirmed");
  return signature;
}

async function insertCreatorFeeCycle(client: pg.PoolClient, input: CreatorFeeCycleInput) {
  await client.query(
    `
      insert into creator_fee_cycles(
        presale_address,
        mint,
        mode,
        wallet_public_key,
        claimed_lamports,
        action_lamports,
        result,
        holder_count,
        burned_raw_amount,
        signatures,
        recipients,
        error
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
    `,
    [
      input.presaleAddress,
      input.mint ?? null,
      input.mode,
      input.walletPublicKey ?? null,
      (input.claimedLamports ?? 0n).toString(),
      (input.actionLamports ?? 0n).toString(),
      input.result,
      input.holderCount ?? null,
      input.burnedRawAmount?.toString() ?? null,
      JSON.stringify(input.signatures ?? {}),
      JSON.stringify(input.recipients ?? []),
      input.error ?? null
    ]
  );

  const eventType = input.mode === "buyback_burn"
    ? "buyback_burn"
    : input.mode === "coinflip"
      ? "coinflip"
      : "flywheel";
  await client.query(
    `
      insert into activity_events(type, presale_address, amount_lamports, message, signature)
      values ($1, $2, $3, $4, $5)
      on conflict do nothing
    `,
    [
      eventType,
      input.presaleAddress,
      (input.actionLamports ?? input.claimedLamports ?? 0n).toString(),
      `${input.mode} cycle: ${input.result}`,
      input.signatures?.burn ?? input.signatures?.distribution ?? input.signatures?.flip ?? input.signatures?.claim ?? null
    ]
  );
}

export function spendableAfterReserve(balanceLamports: bigint, reserveLamports = CREATOR_FEE_RESERVE_LAMPORTS) {
  return balanceLamports > reserveLamports ? balanceLamports - reserveLamports : 0n;
}

export function thresholdForMode(mode: NonSelfCreatorFeeMode) {
  if (mode === "flywheel") return FLYWHEEL_THRESHOLD_LAMPORTS;
  if (mode === "coinflip") return COINFLIP_THRESHOLD_LAMPORTS;
  return BUYBACK_BURN_THRESHOLD_LAMPORTS;
}
