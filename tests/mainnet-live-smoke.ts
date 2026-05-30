import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import pg from "pg";
import {
  DEFAULT_PROGRAM_ID,
  buildClaimAllInstruction,
  buildClaimSolRefundInstruction,
  buildClosePresaleInstruction,
  buildCreatePresaleInstruction,
  buildEnsureOwnerTokenAtaInstruction,
  buildOpenPresaleInstruction,
  buildSolContributeInstruction,
  buildSolDevbuyInstruction,
  contributorPda,
  mintPda,
  presalePda
} from "../packages/launchpad-client/src/index";
import { runKeeperOnce } from "../services/keeper/src/index";

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/stick";
const KEY_DIR = process.env.KEY_DIR ?? "/tmp/stick-mainnet.V6ytBm";
const PROGRAM_ID = process.env.LAUNCHPAD_PROGRAM_ID
  ? new PublicKey(process.env.LAUNCHPAD_PROGRAM_ID)
  : DEFAULT_PROGRAM_ID;
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS ?? "60");
const DEVBUY = sol(process.env.DEVBUY_SOL ?? "0.01");
const TARGET = sol(process.env.TARGET_SOL ?? "0.03");
const MIN_CONTRIBUTION = sol(process.env.MIN_CONTRIBUTION_SOL ?? "0.005");
const REFUND_A = sol(process.env.REFUND_A_SOL ?? "0.005");
const OVERSUB_A = sol(process.env.OVERSUB_A_SOL ?? "0.02");
const OVERSUB_B = sol(process.env.OVERSUB_B_SOL ?? "0.02");
const B_DELAY_MS = Number(process.env.B_DELAY_SECONDS ?? "25") * 1000;
const SCENARIOS = (process.env.SCENARIOS ?? "refund,oversub")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

type ContributorAccount = {
  owner: PublicKey;
  acceptedAmount: BN;
  contributionWeight: BN;
};

const connection = new Connection(RPC_URL, "confirmed");
const keeper = loadKey("keeper");
const dev = loadKey("dev");
const walletA = loadKey("wallet_a");
const walletB = loadKey("wallet_b");
const txs: { label: string; signature: string; feeLamports: number }[] = [];

async function main() {
  console.log(JSON.stringify({
    programId: PROGRAM_ID.toBase58(),
    keeper: keeper.publicKey.toBase58(),
    dev: dev.publicKey.toBase58(),
    walletA: walletA.publicKey.toBase58(),
    walletB: walletB.publicKey.toBase58()
  }));

  await assertProgramReady();
  if (process.env.RESUME_KEEPER_ONLY === "true") {
    await runKeeperOnce({
      rpcUrl: RPC_URL,
      jitoEndpoint: process.env.JITO_ENDPOINT ?? "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
      programId: PROGRAM_ID,
      cluster: "mainnet-beta",
      pollMs: 10_000,
      databaseUrl: DATABASE_URL,
      keeper,
      autoFinalize: true
    });
    return;
  }
  if (SCENARIOS.includes("refund")) {
    await runRefundOnlyCase();
  }
  if (SCENARIOS.includes("oversub")) {
    await runPumpOnlyOversubCase();
  }

  const balances = await Promise.all([
    connection.getBalance(keeper.publicKey, "confirmed"),
    connection.getBalance(dev.publicKey, "confirmed"),
    connection.getBalance(walletA.publicKey, "confirmed"),
    connection.getBalance(walletB.publicKey, "confirmed")
  ]);

  console.log(JSON.stringify({
    ok: true,
    txFeesLamports: txs.reduce((sum, tx) => sum + tx.feeLamports, 0),
    balancesLamports: {
      keeper: balances[0],
      dev: balances[1],
      walletA: balances[2],
      walletB: balances[3]
    },
    txs
  }, null, 2));
}

async function runRefundOnlyCase() {
  const presaleId = new BN(Date.now());
  const { presale } = await createOpenPresale("refund-only", presaleId);
  await sendTx("refund-only wallet A contribution", [
    buildSolContributeInstruction(PROGRAM_ID, presale, walletA.publicKey, REFUND_A)
  ], [walletA], walletA);
  console.log(JSON.stringify({
    scenario: "refund-only",
    target: TARGET.toString(),
    devbuy: DEVBUY.toString(),
    walletACommitted: REFUND_A.toString(),
    totalCommitted: DEVBUY.add(REFUND_A).toString(),
    expectedRefunds: {
      dev: DEVBUY.toString(),
      walletA: REFUND_A.toString()
    }
  }, null, 2));

  await waitForCloseWindow();
  await sendTx("refund-only close", [buildClosePresaleInstruction(PROGRAM_ID, presale)], [keeper], keeper);
  const beforeA = await connection.getBalance(walletA.publicKey, "confirmed");
  const beforeDev = await connection.getBalance(dev.publicKey, "confirmed");
  await sendTx("refund-only wallet A claim", [
    buildClaimSolRefundInstruction(PROGRAM_ID, presale, walletA.publicKey)
  ], [walletA], walletA);
  await sendTx("refund-only dev claim", [
    buildClaimSolRefundInstruction(PROGRAM_ID, presale, dev.publicKey)
  ], [dev], dev);
  const afterA = await connection.getBalance(walletA.publicKey, "confirmed");
  const afterDev = await connection.getBalance(dev.publicKey, "confirmed");
  assert(afterA > beforeA, "wallet A refund did not increase balance");
  assert(afterDev > beforeDev, "dev refund did not increase balance");
}

async function runPumpOnlyOversubCase() {
  const presaleId = new BN(Date.now() + 1);
  const { presale, mint } = await createOpenPresale("pump-only-oversub", presaleId);
  await sendTx("oversub wallet A early contribution", [
    buildSolContributeInstruction(PROGRAM_ID, presale, walletA.publicKey, OVERSUB_A)
  ], [walletA], walletA);
  console.log(`waiting ${Math.ceil(B_DELAY_MS / 1000)}s before wallet B contribution`);
  await sleep(B_DELAY_MS);
  await sendTx("oversub wallet B late contribution", [
    buildSolContributeInstruction(PROGRAM_ID, presale, walletB.publicKey, OVERSUB_B)
  ], [walletB], walletB);

  await waitForCloseWindow(40_000);
  const contributors = await Promise.all([
    readContributor(presale, dev.publicKey),
    readContributor(presale, walletA.publicKey),
    readContributor(presale, walletB.publicKey)
  ]);
  const early = contributors[1]!;
  const late = contributors[2]!;
  assert(early.contributionWeight.gt(late.contributionWeight), "early wallet did not receive higher weight than late wallet");
  await seedDbForKeeper({
    presale,
    mint,
    contributors,
    name: "Stick Smoke",
    symbol: `PPS${String(Date.now()).slice(-4)}`
  });

  await runKeeperOnce({
    rpcUrl: RPC_URL,
    jitoEndpoint: process.env.JITO_ENDPOINT ?? "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
    programId: PROGRAM_ID,
    cluster: "mainnet-beta",
    pollMs: 10_000,
    databaseUrl: DATABASE_URL,
    keeper,
    autoFinalize: true
  });
  await printAndClaimSettlement(presale, mint);
}

async function printAndClaimSettlement(presale: PublicKey, mint: PublicKey) {
  const db = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const result = await db.query<{ manifest_json: any }>(
      "select manifest_json from settlement_manifests where presale_address = $1",
      [presale.toBase58()]
    );
    const manifest = result.rows[0]?.manifest_json;
    if (!manifest) throw new Error(`missing settlement manifest for ${presale.toBase58()}`);
    console.log(JSON.stringify({
      scenario: "oversub",
      presale: presale.toBase58(),
      mint: mint.toBase58(),
      target: manifest.target,
      pumpSpend: manifest.pumpSpend,
      entries: manifest.entries.map((entry: any) => ({
        owner: entry.owner,
        committed: entry.committed,
        weight: entry.weight,
        grossAccepted: entry.grossAccepted,
        refund: entry.refund
      }))
    }, null, 2));

    for (const keypair of [dev, walletA, walletB]) {
      const entry = manifest.entries.find((item: any) => item.owner === keypair.publicKey.toBase58());
      if (!entry) continue;
      await sendTx(`claim all ${keypair.publicKey.toBase58()}`, [
        buildEnsureOwnerTokenAtaInstruction(keypair.publicKey, keypair.publicKey, mint),
        buildClaimAllInstruction({
          programId: PROGRAM_ID,
          presale,
          owner: keypair.publicKey,
          mint,
          proof: entry.proof.map(hexToBytes),
          grossAccepted: new BN(entry.grossAccepted),
          refund: new BN(entry.refund)
        })
      ], [keypair], keypair);
    }
  } finally {
    await db.end();
  }
}

async function createOpenPresale(label: string, presaleId: BN) {
  const presale = presalePda(PROGRAM_ID, dev.publicKey, presaleId);
  const mint = mintPda(PROGRAM_ID, presale);
  await sendTx(`${label} create/devbuy/open`, [
    buildCreatePresaleInstruction({
      programId: PROGRAM_ID,
      creator: dev.publicKey,
      presaleId,
      input: {
        launchType: "EarlyBoostBatch",
        quoteAsset: "SOL",
        boostPreset: "Medium",
        mint,
        quoteMint: new PublicKey("So11111111111111111111111111111111111111112"),
        durationSeconds: DURATION_SECONDS,
        minContribution: MIN_CONTRIBUTION,
        devbuyRequiredAmount: DEVBUY,
        devVestingCliffSeconds: 0,
        devVestingLinearSeconds: 0,
        devVestingInitialUnlockBps: 10_000,
        softCap: TARGET,
        hardCap: TARGET,
        maxWalletContribution: new BN(0),
        ticketSize: new BN(0),
        maxTicketsPerWallet: 0
      },
      metadataUri: `https://stick.local/${label}.json`,
      rewardPreset: "Balanced",
      vestingPreset: "Instant"
    }),
    buildSolDevbuyInstruction(PROGRAM_ID, presale, dev.publicKey, DEVBUY),
    buildOpenPresaleInstruction(PROGRAM_ID, presale, dev.publicKey)
  ], [dev], dev);
  return { presale, mint };
}

async function seedDbForKeeper(input: {
  presale: PublicKey;
  mint: PublicKey;
  contributors: ContributorAccount[];
  name: string;
  symbol: string;
}) {
  const db = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const committed = input.contributors.reduce((sum, item) => sum.add(item.acceptedAmount), new BN(0));
    await db.query(
      `
        insert into launches(
          presale_address, slug, creator, mint_address, name, symbol, status,
          description, metadata_uri, target_lamports, committed_lamports,
          contributors_count, start_at, end_at
        ) values ($1,$2,$3,$4,$5,$6,'LIVE',$7,$8,$9,$10,$11,now() - interval '2 minutes',now() - interval '1 second')
        on conflict (presale_address) do update set
          status = 'LIVE',
          committed_lamports = excluded.committed_lamports,
          contributors_count = excluded.contributors_count,
          end_at = excluded.end_at,
          updated_at = now()
      `,
      [
        input.presale.toBase58(),
        input.presale.toBase58(),
        dev.publicKey.toBase58(),
        input.mint.toBase58(),
        input.name,
        input.symbol,
        "Mainnet smoke test launch.",
        `https://stick.local/${input.symbol}.json`,
        TARGET.toString(),
        committed.toString(),
        input.contributors.length
      ]
    );
    for (const contributor of input.contributors) {
      await db.query(
        `
          insert into contributors(presale_address, owner, committed_lamports, weight)
          values ($1,$2,$3,$4)
          on conflict (presale_address, owner) do update set
            committed_lamports = excluded.committed_lamports,
            weight = excluded.weight,
            updated_at = now()
        `,
        [
          input.presale.toBase58(),
          contributor.owner.toBase58(),
          contributor.acceptedAmount.toString(),
          contributor.contributionWeight.toString()
        ]
      );
    }
  } finally {
    await db.end();
  }
}

async function sendTx(label: string, instructions: any[], signers: Keypair[], payer: Keypair) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions
  }).compileToV0Message());
  tx.sign(signers);
  const signature = await connection.sendTransaction(tx, { maxRetries: 5, skipPreflight: false });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  const parsed = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0
  });
  txs.push({ label, signature, feeLamports: parsed?.meta?.fee ?? 0 });
  console.log(`${label}: ${signature}`);
}

async function readContributor(presale: PublicKey, owner: PublicKey): Promise<ContributorAccount> {
  const account = await connection.getAccountInfo(contributorPda(PROGRAM_ID, presale, owner), "confirmed");
  if (!account) throw new Error(`missing contributor ${owner.toBase58()}`);
  let offset = 8;
  const parsedOwner = new PublicKey(account.data.subarray(offset, offset + 32));
  offset += 32;
  offset += 32;
  const acceptedAmount = new BN(account.data.subarray(offset, offset + 8), "le");
  offset += 8;
  offset += 8;
  const contributionWeight = new BN(account.data.subarray(offset, offset + 16), "le");
  return { owner: parsedOwner, acceptedAmount, contributionWeight };
}

async function assertProgramReady() {
  const account = await connection.getAccountInfo(PROGRAM_ID, "confirmed");
  assert(account?.executable, `program ${PROGRAM_ID.toBase58()} is not executable`);
}

async function waitForCloseWindow(extraMs = 4_000) {
  const waitMs = DURATION_SECONDS * 1000 + extraMs;
  console.log(`waiting ${Math.ceil(waitMs / 1000)}s for close window`);
  await sleep(waitMs);
}

function loadKey(name: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${KEY_DIR}/${name}.json`, "utf8"))));
}

function sol(value: string): BN {
  const [whole, fraction = ""] = value.split(".");
  return new BN(whole || "0")
    .mul(new BN(LAMPORTS_PER_SOL))
    .add(new BN(fraction.padEnd(9, "0").slice(0, 9)));
}

function hexToBytes(hex: string) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
