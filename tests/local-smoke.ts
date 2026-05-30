import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import BN from "bn.js";
import {
  DEFAULT_PROGRAM_ID,
  buildClaimSolRefundInstruction,
  buildClosePresaleInstruction,
  buildCreatePresaleInstruction,
  buildFinalizePumpCreateBuyInstruction,
  buildInitializeConfigInstruction,
  buildOpenPresaleInstruction,
  buildSolContributeInstruction,
  buildSolDevbuyInstruction,
  buildSetSettlementInstruction,
  contributorPda,
  mintPda,
  presalePda,
  quoteVaultPda
} from "@fair/launchpad-client";
import {
  bytesToHex,
  calculateOversubscriptionSettlement,
  merkleRoot
} from "@fair/shared";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM_ID = process.env.LAUNCHPAD_PROGRAM_ID
  ? new PublicKey(process.env.LAUNCHPAD_PROGRAM_ID)
  : DEFAULT_PROGRAM_ID;
const SOL = new BN(LAMPORTS_PER_SOL);
const DEVBUY = new BN("100000000");
const MIN_CONTRIBUTION = new BN("10000000");
const DURATION_SECONDS = 60;

type TxResult = {
  label: string;
  signature: string;
  feeLamports: number;
};

type ContributorAccount = {
  owner: PublicKey;
  acceptedAmount: BN;
  contributionWeight: BN;
};

const connection = new Connection(RPC_URL, "confirmed");
const authority = Keypair.generate();
const creator = Keypair.generate();
const userA = Keypair.generate();
const userB = Keypair.generate();

const txResults: TxResult[] = [];

async function main() {
  await assertLocalProgramLoaded();
  await Promise.all([
    airdrop(authority.publicKey, 5),
    airdrop(creator.publicKey, 5),
    airdrop(userA.publicKey, 5),
    airdrop(userB.publicKey, 5)
  ]);

  await sendTx("initialize config", [buildInitializeConfigInstruction({
    programId: PROGRAM_ID,
    authority: authority.publicKey
  })], [authority], authority);

  const missed = await createAndOpen({
    label: "missed target",
    presaleId: new BN(Date.now()),
    target: new BN("300000000")
  });
  await sendTx("missed contribution", [
    buildSolContributeInstruction(PROGRAM_ID, missed.presale, userA.publicKey, new BN("50000000"))
  ], [userA], userA);

  const oversub = await createAndOpen({
    label: "oversub target",
    presaleId: new BN(Date.now() + 1),
    target: new BN("200000000")
  });
  await sendTx("oversub contribution A", [
    buildSolContributeInstruction(PROGRAM_ID, oversub.presale, userA.publicKey, new BN("200000000"))
  ], [userA], userA);
  await sendTx("oversub contribution B", [
    buildSolContributeInstruction(PROGRAM_ID, oversub.presale, userB.publicKey, new BN("200000000"))
  ], [userB], userB);

  process.stdout.write(`Waiting ${DURATION_SECONDS + 4}s for local presales to close...\n`);
  await sleep((DURATION_SECONDS + 4) * 1000);

  const keeperBefore = await connection.getBalance(authority.publicKey);
  await sendTx("close missed", [buildClosePresaleInstruction(PROGRAM_ID, missed.presale)], [authority], authority);
  await sendTx("close oversub", [buildClosePresaleInstruction(PROGRAM_ID, oversub.presale)], [authority], authority);

  const userABeforeRefund = await connection.getBalance(userA.publicKey);
  await sendTx("claim missed refund", [
    buildClaimSolRefundInstruction(PROGRAM_ID, missed.presale, userA.publicKey)
  ], [userA], userA);
  const userAAfterRefund = await connection.getBalance(userA.publicKey);
  assert(
    userAAfterRefund > userABeforeRefund,
    "missed-target user refund did not increase wallet balance"
  );

  const settlementEntries = await Promise.all([
    readContributor(oversub.presale, creator.publicKey),
    readContributor(oversub.presale, userA.publicKey),
    readContributor(oversub.presale, userB.publicKey)
  ]);
  const settlement = calculateOversubscriptionSettlement({
    presale: oversub.presale.toBytes(),
    target: new BN("200000000"),
    entries: settlementEntries.map((entry) => ({
      owner: entry.owner.toBytes(),
      committed: entry.acceptedAmount,
      weight: entry.contributionWeight
    }))
  });
  const grossAccepted = settlement.reduce((sum, entry) => sum.add(entry.grossAccepted), new BN(0));
  const refund = settlement.reduce((sum, entry) => sum.add(entry.refund), new BN(0));
  assert(grossAccepted.eq(new BN("200000000")), `oversub gross accepted mismatch: ${grossAccepted.toString()}`);
  assert(refund.eq(new BN("300000000")), `oversub refund mismatch: ${refund.toString()}`);

  const root = merkleRoot(settlement.map((entry) => entry.leaf));
  await sendTx("set oversub settlement", [
    buildSetSettlementInstruction({
      programId: PROGRAM_ID,
      presale: oversub.presale,
      authority: authority.publicKey,
      grossAcceptedTotal: new BN("200000000"),
      settlementRoot: root,
      settlementUri: "local://smoke-settlement"
    })
  ], [authority], authority);

  await expectFailure("fake finalize without Pump CPI", async () => {
    const fakeTransfer = SystemProgram.transfer({
      fromPubkey: quoteVaultPda(PROGRAM_ID, oversub.presale),
      toPubkey: authority.publicKey,
      lamports: 1
    });
    await sendTx("fake finalize", [
      buildFinalizePumpCreateBuyInstruction({
        programId: PROGRAM_ID,
        presale: oversub.presale,
        mint: oversub.mint,
        finalizer: authority.publicKey,
        maxQuoteSpend: new BN(1),
        minTokensOut: new BN(1),
        routeInstructions: [{
          programId: fakeTransfer.programId,
          keys: fakeTransfer.keys,
          data: fakeTransfer.data,
        }],
        complete: true
      })
    ], [authority], authority);
  });

  const keeperAfter = await connection.getBalance(authority.publicKey);
  const keeperFeeLamports = keeperBefore - keeperAfter;
  const measuredFees = txResults.reduce((sum, tx) => sum + tx.feeLamports, 0);

  process.stdout.write(JSON.stringify({
    ok: true,
    programId: PROGRAM_ID.toBase58(),
    missedPresale: missed.presale.toBase58(),
    oversubPresale: oversub.presale.toBase58(),
    oversubRoot: bytesToHex(root),
    oversubGrossAcceptedLamports: grossAccepted.toString(),
    oversubRefundLamports: refund.toString(),
    keeperPostCloseAndSettlementCostLamports: keeperFeeLamports,
    measuredAllTxFeesLamports: measuredFees,
    transactions: txResults
  }, null, 2));
  process.stdout.write("\n");
}

async function createAndOpen(params: {
  label: string;
  presaleId: BN;
  target: BN;
}) {
  const presale = presalePda(PROGRAM_ID, creator.publicKey, params.presaleId);
  const mint = mintPda(PROGRAM_ID, presale);
  await sendTx(`create/devbuy/open ${params.label}`, [
    buildCreatePresaleInstruction({
      programId: PROGRAM_ID,
      creator: creator.publicKey,
      presaleId: params.presaleId,
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
        softCap: params.target,
        hardCap: params.target,
        maxWalletContribution: new BN(0),
        ticketSize: new BN(0),
        maxTicketsPerWallet: 0
      },
      metadataUri: `local://${params.label}`,
      rewardPreset: "Balanced",
      vestingPreset: "Instant"
    }),
    buildSolDevbuyInstruction(PROGRAM_ID, presale, creator.publicKey, DEVBUY),
    buildOpenPresaleInstruction(PROGRAM_ID, presale, creator.publicKey)
  ], [creator], creator);
  return { presale, mint };
}

async function sendTx(label: string, instructions: any[], signers: Keypair[], payer: Keypair) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions
  }).compileToV0Message());
  tx.sign(signers);
  const signature = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  const parsed = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0
  });
  txResults.push({
    label,
    signature,
    feeLamports: parsed?.meta?.fee ?? 0
  });
  process.stdout.write(`${label}: ${signature}\n`);
}

async function readContributor(presale: PublicKey, owner: PublicKey): Promise<ContributorAccount> {
  const account = await connection.getAccountInfo(contributorPda(PROGRAM_ID, presale, owner), "confirmed");
  if (!account) {
    throw new Error(`Contributor missing: ${owner.toBase58()}`);
  }
  let offset = 8;
  const parsedOwner = new PublicKey(account.data.subarray(offset, offset + 32));
  offset += 32;
  offset += 32;
  const acceptedAmount = readU64(account.data, offset);
  offset += 8;
  offset += 8;
  const contributionWeight = readU128(account.data, offset);
  return { owner: parsedOwner, acceptedAmount, contributionWeight };
}

function readU64(data: Buffer, offset: number): BN {
  return new BN(data.subarray(offset, offset + 8), "le");
}

function readU128(data: Buffer, offset: number): BN {
  return new BN(data.subarray(offset, offset + 16), "le");
}

async function assertLocalProgramLoaded() {
  const account = await connection.getAccountInfo(PROGRAM_ID, "confirmed");
  if (!account?.executable) {
    throw new Error(`Program ${PROGRAM_ID.toBase58()} is not deployed on ${RPC_URL}`);
  }
}

async function airdrop(pubkey: PublicKey, sol: number) {
  const signature = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

async function expectFailure(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    process.stdout.write(`${label}: rejected as expected\n`);
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
