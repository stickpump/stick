import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PumpSdk, type BondingCurve, type Global } from "@pump-fun/pump-sdk";
import { PUMP_AMM_SDK, type SwapSolanaState } from "@pump-fun/pump-swap-sdk";
import BN from "bn.js";
import {
  type AggregatedFinalizePlan,
  type FinalizePlan,
  type PumpCurveState,
  quoteAggregatedFinalizePlan,
  quoteFinalizePlan
} from "@fair/shared";

export const MAINNET_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

export type PumpCreateV2Input = {
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creator: PublicKey;
  user: PublicKey;
  quoteMint?: PublicKey;
  mayhemMode?: boolean;
  cashback?: boolean;
};

export type PumpBuyV2Input = {
  global: Global;
  bondingCurveAccountInfo: Parameters<PumpSdk["decodeBondingCurve"]>[0];
  bondingCurve: BondingCurve;
  associatedUserAccountInfo: Parameters<PumpSdk["decodeBondingCurve"]>[0] | null;
  mint: PublicKey;
  user: PublicKey;
  amount: BN;
  quoteAmount: BN;
  slippage: number;
  tokenProgram?: PublicKey;
  quoteTokenProgram?: PublicKey;
};

export type PumpSwapRemainderBuyInput = {
  swapState: SwapSolanaState;
  baseOut: BN;
  maxQuoteIn: BN;
};

export type FinalizeQuoteInput = {
  totalQuote: BN;
  curve: PumpCurveState;
};

export type AggregatedFinalizeQuoteInput = {
  totalCommitted: BN;
  target: BN;
  curve: PumpCurveState;
};

export type JitoBundleInput = {
  transactions: VersionedTransaction[];
  tipLamports?: number;
};

export function planFinalize(input: FinalizeQuoteInput): FinalizePlan {
  return quoteFinalizePlan(input);
}

export function planAggregatedFinalize(input: AggregatedFinalizeQuoteInput): AggregatedFinalizePlan {
  return quoteAggregatedFinalizePlan(input);
}

export async function buildCreateV2Instructions(input: PumpCreateV2Input): Promise<TransactionInstruction[]> {
  const sdk = new PumpSdk();
  return [
    await sdk.createV2Instruction({
      mint: input.mint,
      name: input.name,
      symbol: input.symbol,
      uri: input.uri,
      creator: input.creator,
      user: input.user,
      mayhemMode: input.mayhemMode ?? false,
      cashback: input.cashback ?? false,
      quoteMint: input.quoteMint
    })
  ];
}

export async function buildBuyV2Instructions(input: PumpBuyV2Input): Promise<TransactionInstruction[]> {
  const sdk = new PumpSdk();
  return sdk.buyV2Instructions({
    global: input.global,
    bondingCurveAccountInfo: input.bondingCurveAccountInfo,
    bondingCurve: input.bondingCurve,
    associatedUserAccountInfo: input.associatedUserAccountInfo,
    mint: input.mint,
    user: input.user,
    amount: input.amount,
    quoteAmount: input.quoteAmount,
    slippage: input.slippage,
    tokenProgram: input.tokenProgram ?? TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: input.quoteTokenProgram ?? TOKEN_PROGRAM_ID
  });
}

export async function buildCreateV2AndBuyV2Instructions(input: PumpCreateV2Input & {
  global: Global;
  amount: BN;
  quoteAmount: BN;
  quoteTokenProgram?: PublicKey;
}): Promise<TransactionInstruction[]> {
  const sdk = new PumpSdk();
  return sdk.createV2AndBuyV2Instructions({
    global: input.global,
    mint: input.mint,
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    creator: input.creator,
    user: input.user,
    amount: input.amount,
    quoteAmount: input.quoteAmount,
    mayhemMode: input.mayhemMode ?? false,
    cashback: input.cashback ?? false,
    quoteMint: input.quoteMint,
    quoteTokenProgram: input.quoteTokenProgram ?? TOKEN_PROGRAM_ID
  });
}

export async function buildPumpSwapRemainderBuy(input: PumpSwapRemainderBuyInput): Promise<TransactionInstruction[]> {
  return PUMP_AMM_SDK.buyInstructions(input.swapState, input.baseOut, input.maxQuoteIn);
}

export function quoteMintForAsset(asset: "SOL" | "USDC", cluster: "mainnet-beta" | "devnet" = "mainnet-beta"): PublicKey {
  if (asset === "SOL") {
    return NATIVE_MINT;
  }
  return cluster === "devnet" ? DEVNET_USDC_MINT : MAINNET_USDC_MINT;
}

export function buildJitoBundle(input: JitoBundleInput): string[] {
  return input.transactions.map((tx) => Buffer.from(tx.serialize()).toString("base64"));
}

export async function submitJitoBundle(params: {
  endpoint: string;
  transactions: VersionedTransaction[];
  fetchImpl?: typeof fetch;
}): Promise<{ bundleId: string }> {
  const fetcher = params.fetchImpl ?? fetch;
  const response = await fetcher(params.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [buildJitoBundle({ transactions: params.transactions })]
    })
  });

  if (!response.ok) {
    throw new Error(`Jito bundle submit failed: HTTP ${response.status}`);
  }

  const json = (await response.json()) as { result?: string; error?: unknown };
  if (!json.result) {
    throw new Error(`Jito bundle submit failed: ${JSON.stringify(json.error ?? json)}`);
  }
  return { bundleId: json.result };
}

export async function addPriorityFee(
  connection: Connection,
  instructions: TransactionInstruction[],
  microLamports = 10_000
): Promise<TransactionInstruction[]> {
  const recentFees = await connection.getRecentPrioritizationFees().catch(() => []);
  const dynamicFee = recentFees.length > 0
    ? Math.max(microLamports, Math.floor(recentFees.reduce((sum, fee) => sum + fee.prioritizationFee, 0) / recentFees.length))
    : microLamports;

  return [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: dynamicFee }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    ...instructions
  ];
}

export function loadKeypairFromJson(secret: number[]): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
