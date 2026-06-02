import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import type { BoostPreset, LaunchType, QuoteAsset, RewardPreset, VestingPreset } from "@fair/shared";

export const DEFAULT_PROGRAM_ID = new PublicKey("3cp7EpueLdu5RM5sPGLdnE8smPdWAkco3aMwAihju7VL");
export const MAINNET_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

export type Cluster = "mainnet-beta" | "devnet" | "localnet";

export type PresaleConfigInput = {
  launchType: LaunchType;
  quoteAsset: QuoteAsset;
  boostPreset: BoostPreset;
  mint: PublicKey;
  quoteMint: PublicKey;
  durationSeconds: number;
  minContribution: BN;
  devbuyRequiredAmount: BN;
  devVestingCliffSeconds: number;
  devVestingLinearSeconds: number;
  devVestingInitialUnlockBps: number;
  softCap: BN;
  hardCap: BN;
  maxWalletContribution: BN;
  ticketSize: BN;
  maxTicketsPerWallet: number;
};

export type BuildCreatePresaleParams = {
  programId: PublicKey;
  creator: PublicKey;
  presaleId: BN;
  input: PresaleConfigInput;
  metadataUri: string;
  rewardPreset: RewardPreset;
  vestingPreset: VestingPreset;
};

const LAUNCH_TYPE: Record<LaunchType, number> = {
  ClassicFairBatch: 0,
  EarlyBoostBatch: 1,
  SoftCapRefund: 2,
  HardCapOverflow: 3,
  RaffleAllocation: 4
};

const QUOTE_ASSET: Record<QuoteAsset, number> = {
  SOL: 0,
  USDC: 1
};

const BOOST_PRESET: Record<BoostPreset, number> = {
  Low: 0,
  Medium: 1,
  High: 2
};

const REWARD_PRESET: Record<RewardPreset, number> = {
  Balanced: 0,
  Community: 1,
  Creator: 2
};

const VESTING_PRESET: Record<VestingPreset, number> = {
  Instant: 0,
  Linear7Days: 1,
  Linear30Days: 2
};

const DISCRIMINATORS: Record<string, number[]> = {
  initialize_config: [0xd0, 0x7f, 0x15, 0x01, 0xc2, 0xbe, 0xc4, 0x46],
  create_presale: [0xb0, 0x90, 0xc5, 0x9e, 0x3d, 0x77, 0x4b, 0x87],
  open_presale: [0x5c, 0xac, 0x20, 0xaa, 0xa7, 0xef, 0x44, 0x56],
  devbuy: [0x53, 0xd1, 0xd7, 0xaf, 0x1c, 0x00, 0x3d, 0x1d],
  contribute: [0x52, 0x21, 0x44, 0x83, 0x20, 0x00, 0xcd, 0x5f],
  close_presale: [0x6a, 0xf2, 0xd6, 0xd7, 0x16, 0x4b, 0x6d, 0xd3],
  set_settlement: [0x75, 0x93, 0x30, 0xca, 0x94, 0xbc, 0x5c, 0x68],
  finalize_pump_create_buy: [0x44, 0x83, 0x0a, 0xe7, 0x2a, 0xe4, 0xda, 0x8c],
  finalize_migrate: [0x2f, 0x0c, 0x0e, 0xa5, 0xf9, 0x1e, 0x15, 0x65],
  finalize_pumpswap_buy: [0x88, 0xa4, 0xea, 0x79, 0x66, 0xa6, 0x9e, 0x24],
  claim_refund: [0x0f, 0x10, 0x1e, 0xa1, 0xff, 0xe4, 0x61, 0x3c],
  send_refund_to_owner: [0x4b, 0x76, 0x48, 0x34, 0x20, 0xa4, 0x2e, 0xec],
  claim_tokens_now: [0x5e, 0xa3, 0x9f, 0x74, 0xcd, 0x15, 0xfc, 0x76],
  claim_all: [0xc2, 0xc2, 0x50, 0xc2, 0xea, 0xd2, 0xd9, 0x5a],
  send_tokens_to_owner_now: [0x59, 0x1c, 0xd1, 0x0b, 0xb9, 0x43, 0x6f, 0x5b],
  devbuy_quote_token: [0xc2, 0x93, 0x17, 0x82, 0x57, 0xb4, 0x22, 0xe1],
  contribute_quote_token: [0x7a, 0x82, 0x07, 0x4e, 0x49, 0x8c, 0x0d, 0x9a],
  claim_refund_quote_token: [0x57, 0xa5, 0xe4, 0x35, 0xe6, 0x8d, 0x82, 0xc5]
};

export function quoteMintForAsset(asset: QuoteAsset, cluster: Cluster): PublicKey {
  if (asset === "SOL") {
    return NATIVE_MINT;
  }
  return cluster === "devnet" ? DEVNET_USDC_MINT : MAINNET_USDC_MINT;
}

export function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

export function buildInitializeConfigInstruction(params: {
  programId: PublicKey;
  authority: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: configPda(params.programId), isSigner: false, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: discriminator("initialize_config")
  });
}

export function presalePda(programId: PublicKey, creator: PublicKey, presaleId: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("presale"), creator.toBuffer(), u64Buffer(presaleId)],
    programId
  )[0];
}

export function contributorPda(programId: PublicKey, presale: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("contributor"), presale.toBuffer(), owner.toBuffer()],
    programId
  )[0];
}

export function quoteVaultPda(programId: PublicKey, presale: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("quote_vault"), presale.toBuffer()],
    programId
  )[0];
}

export function mintPda(programId: PublicKey, presale: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), presale.toBuffer()],
    programId
  )[0];
}

export function quoteVaultAta(presale: PublicKey, quoteMint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(quoteMint, presale, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function ownerQuoteAta(owner: PublicKey, quoteMint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(quoteMint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function tokenVaultAta(presale: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, presale, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function ownerTokenAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function buildCreatePresaleInstruction(params: BuildCreatePresaleParams): TransactionInstruction {
  const presale = presalePda(params.programId, params.creator, params.presaleId);
  const mint = mintPda(params.programId, presale);
  const input = { ...params.input, mint };
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: configPda(params.programId), isSigner: false, isWritable: false },
      { pubkey: presale, isSigner: false, isWritable: true },
      { pubkey: quoteVaultPda(params.programId, presale), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: params.creator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([
      discriminator("create_presale"),
      u64Buffer(params.presaleId),
      encodePresaleConfigInput(input),
      stringBuffer(params.metadataUri),
      u8Buffer(REWARD_PRESET[params.rewardPreset]),
      u8Buffer(VESTING_PRESET[params.vestingPreset])
    ])
  });
}

export function buildOpenPresaleInstruction(programId: PublicKey, presale: PublicKey, creator: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: presale, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: true, isWritable: false }
    ],
    data: discriminator("open_presale")
  });
}

export function buildSolDevbuyInstruction(programId: PublicKey, presale: PublicKey, creator: PublicKey, amount: BN): TransactionInstruction {
  return buildSolAmountInstruction("devbuy", programId, presale, creator, amount);
}

export function buildSolContributeInstruction(programId: PublicKey, presale: PublicKey, owner: PublicKey, amount: BN): TransactionInstruction {
  return buildSolAmountInstruction("contribute", programId, presale, owner, amount);
}

export function buildQuoteVaultAtaInstruction(payer: PublicKey, presale: PublicKey, quoteMint: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    quoteVaultAta(presale, quoteMint),
    presale,
    quoteMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

export function buildOwnerQuoteAtaInstruction(payer: PublicKey, owner: PublicKey, quoteMint: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ownerQuoteAta(owner, quoteMint),
    owner,
    quoteMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

export function buildQuoteTokenDevbuyInstruction(
  programId: PublicKey,
  presale: PublicKey,
  owner: PublicKey,
  quoteMint: PublicKey,
  amount: BN
): TransactionInstruction {
  return buildQuoteTokenAmountInstruction("devbuy_quote_token", programId, presale, owner, quoteMint, amount);
}

export function buildQuoteTokenContributeInstruction(
  programId: PublicKey,
  presale: PublicKey,
  owner: PublicKey,
  quoteMint: PublicKey,
  amount: BN
): TransactionInstruction {
  return buildQuoteTokenAmountInstruction("contribute_quote_token", programId, presale, owner, quoteMint, amount);
}

export function buildClosePresaleInstruction(programId: PublicKey, presale: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: presale, isSigner: false, isWritable: true }],
    data: discriminator("close_presale")
  });
}

export function buildSetSettlementInstruction(params: {
  programId: PublicKey;
  presale: PublicKey;
  authority: PublicKey;
  grossAcceptedTotal: BN;
  settlementRoot: Uint8Array | number[];
  settlementUri: string;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.presale, isSigner: false, isWritable: true },
      { pubkey: configPda(params.programId), isSigner: false, isWritable: false },
      { pubkey: params.authority, isSigner: true, isWritable: false }
    ],
    data: Buffer.concat([
      discriminator("set_settlement"),
      u64Buffer(params.grossAcceptedTotal),
      Buffer.from(params.settlementRoot),
      stringBuffer(params.settlementUri)
    ])
  });
}

export type RouteCpiInstruction = {
  programId: PublicKey;
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  data: Uint8Array | Buffer;
};

export function buildFinalizePumpCreateBuyInstruction(params: {
  programId: PublicKey;
  presale: PublicKey;
  config?: PublicKey;
  mint: PublicKey;
  finalizer: PublicKey;
  maxQuoteSpend: BN;
  minTokensOut: BN;
  routeInstructions: RouteCpiInstruction[];
  complete: boolean;
}): TransactionInstruction {
  return buildRouteBuyInstruction("finalize_pump_create_buy", params);
}

export function buildFinalizeMigrateInstruction(params: {
  programId: PublicKey;
  presale: PublicKey;
  config?: PublicKey;
  mint: PublicKey;
  finalizer: PublicKey;
  routeInstructions: RouteCpiInstruction[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: routeBaseKeys(params),
    data: Buffer.concat([
      discriminator("finalize_migrate"),
      routeInstructionsBuffer(params.routeInstructions)
    ])
  });
}

export function buildFinalizePumpSwapBuyInstruction(params: {
  programId: PublicKey;
  presale: PublicKey;
  config?: PublicKey;
  mint: PublicKey;
  finalizer: PublicKey;
  maxQuoteSpend: BN;
  minTokensOut: BN;
  routeInstructions: RouteCpiInstruction[];
}): TransactionInstruction {
  return buildRouteBuyInstruction("finalize_pumpswap_buy", {
    ...params,
    complete: false
  });
}

export function buildClaimAllInstruction(params: {
  programId: PublicKey;
  presale: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  proof: Array<Uint8Array | number[]>;
  grossAccepted: BN;
  refund: BN;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.presale, isSigner: false, isWritable: true },
      { pubkey: quoteVaultPda(params.programId, params.presale), isSigner: false, isWritable: true },
      { pubkey: contributorPda(params.programId, params.presale, params.owner), isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: true },
      { pubkey: tokenVaultAta(params.presale, params.mint), isSigner: false, isWritable: true },
      { pubkey: ownerTokenAta(params.owner, params.mint), isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([
      discriminator("claim_all"),
      u32Buffer(params.proof.length),
      ...params.proof.map((item) => Buffer.from(item)),
      u64Buffer(params.grossAccepted),
      u64Buffer(params.refund)
    ])
  });
}

export function buildClaimSolRefundInstruction(programId: PublicKey, presale: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: presale, isSigner: false, isWritable: true },
      { pubkey: quoteVaultPda(programId, presale), isSigner: false, isWritable: true },
      { pubkey: contributorPda(programId, presale, owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: discriminator("claim_refund")
  });
}

export function buildSendSolRefundToOwnerInstruction(programId: PublicKey, presale: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: presale, isSigner: false, isWritable: true },
      { pubkey: quoteVaultPda(programId, presale), isSigner: false, isWritable: true },
      { pubkey: contributorPda(programId, presale, owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: discriminator("send_refund_to_owner")
  });
}

export function buildClaimTokensNowInstruction(
  programId: PublicKey,
  presale: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: presale, isSigner: false, isWritable: false },
      { pubkey: contributorPda(programId, presale, owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: tokenVaultAta(presale, mint), isSigner: false, isWritable: true },
      { pubkey: ownerTokenAta(owner, mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: discriminator("claim_tokens_now")
  });
}

export function buildSendTokensToOwnerNowInstruction(
  programId: PublicKey,
  presale: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: presale, isSigner: false, isWritable: false },
      { pubkey: contributorPda(programId, presale, owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: tokenVaultAta(presale, mint), isSigner: false, isWritable: true },
      { pubkey: ownerTokenAta(owner, mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: discriminator("send_tokens_to_owner_now")
  });
}

export function buildEnsureOwnerTokenAtaInstruction(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ownerTokenAta(owner, mint),
    owner,
    mint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

function buildRouteBuyInstruction(
  name: "finalize_pump_create_buy" | "finalize_pumpswap_buy",
  params: {
    programId: PublicKey;
    presale: PublicKey;
    config?: PublicKey;
    mint: PublicKey;
    finalizer: PublicKey;
    maxQuoteSpend: BN;
    minTokensOut: BN;
    routeInstructions: RouteCpiInstruction[];
    complete: boolean;
  }
): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: routeBaseKeys(params),
    data: Buffer.concat([
      discriminator(name),
      u64Buffer(params.maxQuoteSpend),
      u64Buffer(params.minTokensOut),
      routeInstructionsBuffer(params.routeInstructions),
      u8Buffer(params.complete ? 1 : 0)
    ])
  });
}

function routeBaseKeys(params: {
  programId: PublicKey;
  presale: PublicKey;
  config?: PublicKey;
  mint: PublicKey;
  finalizer: PublicKey;
  routeInstructions: RouteCpiInstruction[];
}) {
  return [
    { pubkey: params.presale, isSigner: false, isWritable: true },
    { pubkey: params.config ?? configPda(params.programId), isSigner: false, isWritable: false },
    { pubkey: quoteVaultPda(params.programId, params.presale), isSigner: false, isWritable: true },
    { pubkey: tokenVaultAta(params.presale, params.mint), isSigner: false, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: true },
    { pubkey: params.finalizer, isSigner: true, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...params.routeInstructions.flatMap((instruction) => instruction.keys)
  ];
}

function routeInstructionsBuffer(routeInstructions: RouteCpiInstruction[]): Buffer {
  return Buffer.concat([
    u32Buffer(routeInstructions.length),
    ...routeInstructions.map((instruction) => Buffer.concat([
      instruction.programId.toBuffer(),
      bytesBuffer(Buffer.from(instruction.data)),
      u8Buffer(instruction.keys.length)
    ]))
  ]);
}

export async function buildVersionedTransaction(params: {
  connection: Connection;
  payer: PublicKey;
  instructions: TransactionInstruction[];
}): Promise<VersionedTransaction> {
  const { blockhash } = await params.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: params.payer,
    recentBlockhash: blockhash,
    instructions: params.instructions
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export function serializeTransaction(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString("base64");
}

export function deserializeTransaction(serialized: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(serialized, "base64"));
}

export function loadKeypairFromJson(secret: number[] | string): Keypair {
  if (typeof secret === "string") {
    const trimmed = secret.trim();
    if (trimmed.startsWith("[")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed) as number[]));
    }
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function buildSolAmountInstruction(name: "devbuy" | "contribute", programId: PublicKey, presale: PublicKey, owner: PublicKey, amount: BN) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: presale, isSigner: false, isWritable: true },
      { pubkey: quoteVaultPda(programId, presale), isSigner: false, isWritable: true },
      { pubkey: contributorPda(programId, presale, owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([discriminator(name), u64Buffer(amount)])
  });
}

function buildQuoteTokenAmountInstruction(
  name: "devbuy_quote_token" | "contribute_quote_token",
  programId: PublicKey,
  presale: PublicKey,
  owner: PublicKey,
  quoteMint: PublicKey,
  amount: BN
) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: presale, isSigner: false, isWritable: true },
      { pubkey: contributorPda(programId, presale, owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: ownerQuoteAta(owner, quoteMint), isSigner: false, isWritable: true },
      { pubkey: quoteVaultAta(presale, quoteMint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data: Buffer.concat([discriminator(name), u64Buffer(amount)])
  });
}

function encodePresaleConfigInput(input: PresaleConfigInput): Buffer {
  return Buffer.concat([
    u8Buffer(LAUNCH_TYPE[input.launchType]),
    u8Buffer(QUOTE_ASSET[input.quoteAsset]),
    u8Buffer(BOOST_PRESET[input.boostPreset]),
    input.mint.toBuffer(),
    input.quoteMint.toBuffer(),
    u32Buffer(input.durationSeconds),
    u64Buffer(input.minContribution),
    u64Buffer(input.devbuyRequiredAmount),
    u32Buffer(input.devVestingCliffSeconds),
    u32Buffer(input.devVestingLinearSeconds),
    u16Buffer(input.devVestingInitialUnlockBps),
    u64Buffer(input.softCap),
    u64Buffer(input.hardCap),
    u64Buffer(input.maxWalletContribution),
    u64Buffer(input.ticketSize),
    u16Buffer(input.maxTicketsPerWallet)
  ]);
}

function discriminator(name: string): Buffer {
  const value = DISCRIMINATORS[name];
  if (!value) {
    throw new Error(`Missing Anchor discriminator for ${name}`);
  }
  return Buffer.from(value);
}

function stringBuffer(value: string): Buffer {
  const raw = Buffer.from(value, "utf8");
  return bytesBuffer(raw);
}

function bytesBuffer(raw: Buffer): Buffer {
  return Buffer.concat([u32Buffer(raw.length), raw]);
}

function u8Buffer(value: number): Buffer {
  return Buffer.from([value]);
}

function u16Buffer(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

function u32Buffer(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function u64Buffer(value: BN): Buffer {
  return value.toArrayLike(Buffer, "le", 8);
}
