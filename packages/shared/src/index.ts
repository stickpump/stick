import BN from "bn.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const BPS_DENOMINATOR = 10_000;
export const BASE_WEIGHT_BPS = 20_000;
export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;
export const MIN_RAISE_SECONDS = 60;
export const MAX_RAISE_SECONDS = 86_400;
export const PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES = new BN("1073000000000000");
export const PUMP_INITIAL_VIRTUAL_SOL_RESERVES = new BN("30000000000");
export const PUMP_INITIAL_REAL_TOKEN_RESERVES = new BN("793100000000000");
export const PUMP_TOKEN_TOTAL_SUPPLY = new BN("1000000000000000");

export type LaunchType =
  | "ClassicFairBatch"
  | "EarlyBoostBatch"
  | "SoftCapRefund"
  | "HardCapOverflow"
  | "RaffleAllocation";

export type QuoteAsset = "SOL" | "USDC";

export type RewardPreset = "Balanced" | "Community" | "Creator";

export type VestingPreset = "Instant" | "Linear7Days" | "Linear30Days";

export type BoostPreset = "Low" | "Medium" | "High";

export type PresaleStatus =
  | "Draft"
  | "Open"
  | "Closed"
  | "RefundOnly"
  | "RaffleSettled"
  | "Finalizing"
  | "Finalized"
  | "Cancelled";

export type RewardSplit = {
  creatorBps: number;
  holderBps: number;
  tokenBuybackBps: number;
};

export type PresaleConfig = {
  launchType: LaunchType;
  quoteAsset: QuoteAsset;
  rewardPreset: RewardPreset;
  vestingPreset: VestingPreset;
  boostPreset?: BoostPreset;
  durationSeconds: number;
  minContribution: BN;
  softCap?: BN;
  hardCap?: BN;
  maxWalletContribution?: BN;
  ticketSize?: BN;
  maxTicketsPerWallet?: number;
  devbuy?: DevbuyConfig;
  devVesting?: DevVestingConfig;
};

export type DevbuyConfig = {
  required: boolean;
  amount: BN;
  receivesEarlyBoost: boolean;
};

export type DevVestingConfig = {
  enabled: boolean;
  cliffSeconds: number;
  linearUnlockSeconds: number;
  initialUnlockBps: number;
};

export type ProjectMetadata = {
  name: string;
  symbol: string;
  logoUrl: string;
  bannerUrl: string;
  shortPitch: string;
  longDescription: string;
  website?: string;
  x?: string;
  telegram?: string;
  discord?: string;
  docs?: string;
  tags: string[];
  category: string;
  riskNotes: string[];
  tokenomics: {
    presaleBps: number;
    devbuyBps: number;
    rewardsBps: number;
    buybackBps: number;
    liquidityBps: number;
  };
};

export type PumpCurveState = {
  quoteRemainingToGraduate: BN;
  expectedTokensBeforeMigration: BN;
  expectedTokensAfterMigration?: BN;
  migrationRequired: boolean;
};

export type PumpBondingCurveParams = {
  virtualTokenReserves: BN;
  virtualSolReserves: BN;
  realTokenReserves: BN;
  tokenTotalSupply: BN;
};

export type FinalizePlan = {
  strategy: "PumpOnly" | "PumpThenPumpSwap";
  quoteForPump: BN;
  quoteForPumpSwap: BN;
  expectedTotalTokens: BN;
  requiresJitoBundle: boolean;
  notes: string[];
};

export type AggregatedFinalizePlan = FinalizePlan & {
  totalCommitted: BN;
  target: BN;
  grossAcceptedTotal: BN;
  pumpRouteQuote: BN;
  refundTotal: BN;
  transactionCount: number;
};

export type SettlementInput = {
  owner: Uint8Array;
  committed: BN;
  weight: BN;
};

export type SettlementLeaf = SettlementInput & {
  grossAccepted: BN;
  refund: BN;
  leaf: Uint8Array;
};

export type SettlementManifestEntry = {
  owner: string;
  committed: string;
  weight: string;
  grossAccepted: string;
  refund: string;
  leaf: string;
  proof: string[];
};

export type SettlementManifest = {
  presale: string;
  target: string;
  pumpSpend: string;
  maxWalletSupplyBps?: number;
  merkleRoot: string;
  entries: SettlementManifestEntry[];
};

export const REWARD_PRESETS: Record<RewardPreset, RewardSplit> = {
  Balanced: {
    creatorBps: 5_000,
    holderBps: 2_500,
    tokenBuybackBps: 2_500
  },
  Community: {
    creatorBps: 3_000,
    holderBps: 4_000,
    tokenBuybackBps: 3_000
  },
  Creator: {
    creatorBps: 6_000,
    holderBps: 1_500,
    tokenBuybackBps: 2_500
  }
};

export const BOOST_PRESET_BPS: Record<BoostPreset, number> = {
  Low: 2_500,
  Medium: 5_000,
  High: 10_000
};

export const DEFAULT_DEVBUY_BY_ASSET: Record<QuoteAsset, BN> = {
  SOL: toBaseUnits("0.1", SOL_DECIMALS),
  USDC: toBaseUnits("100", USDC_DECIMALS)
};

export function assertRewardSplit(split: RewardSplit): void {
  const sum =
    split.creatorBps +
    split.holderBps +
    split.tokenBuybackBps;

  if (sum !== BPS_DENOMINATOR) {
    throw new Error(`Reward split must equal ${BPS_DENOMINATOR} bps, got ${sum}`);
  }
}

export function quoteDecimals(asset: QuoteAsset): number {
  return asset === "SOL" ? SOL_DECIMALS : USDC_DECIMALS;
}

export function toBaseUnits(amount: string, decimals: number): BN {
  const trimmed = amount.trim();
  if (!/^\d*(?:\.\d*)?$/.test(trimmed)) {
    throw new Error("Amount must contain only digits and one optional decimal point.");
  }
  if (trimmed === "" || trimmed === ".") {
    return new BN(0);
  }
  const [wholeRaw = "0", fraction = ""] = trimmed.split(".");
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  const normalizedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return new BN(whole).mul(new BN(10).pow(new BN(decimals))).add(new BN(normalizedFraction || "0"));
}

export function calculateAcceptedContribution(params: {
  requestedAmount: BN;
  currentRaised: BN;
  hardCap?: BN;
  currentWalletAccepted?: BN;
  maxWalletContribution?: BN;
}): { accepted: BN; overflow: BN } {
  let requested = params.requestedAmount;

  if (params.maxWalletContribution) {
    const walletRemaining = params.maxWalletContribution.sub(params.currentWalletAccepted ?? new BN(0));
    requested = BN.min(requested, BN.max(walletRemaining, new BN(0)));
  }

  if (!params.hardCap) {
    return { accepted: requested, overflow: params.requestedAmount.sub(requested) };
  }

  return { accepted: requested, overflow: params.requestedAmount.sub(requested) };
}

export function calculateOversubscriptionSettlement(params: {
  presale: Uint8Array;
  entries: SettlementInput[];
  target: BN;
  totalTokensPurchased?: BN;
  maxWalletTokenAllocation?: BN;
}): SettlementLeaf[] {
  const totalCommitted = params.entries.reduce((sum, entry) => sum.add(entry.committed), new BN(0));
  const hasTokenCap = Boolean(
    params.totalTokensPurchased &&
    params.maxWalletTokenAllocation &&
    params.totalTokensPurchased.gt(new BN(0)) &&
    params.maxWalletTokenAllocation.gt(new BN(0))
  );
  if (totalCommitted.lte(params.target) && !hasTokenCap) {
    return params.entries.map((entry) => ({
      ...entry,
      grossAccepted: entry.committed,
      refund: new BN(0),
      leaf: settlementLeaf({
        presale: params.presale,
        owner: entry.owner,
        committed: entry.committed,
        weight: entry.weight,
        grossAccepted: entry.committed,
        refund: new BN(0)
      })
    }));
  }

  const target = BN.min(
    params.target,
    totalCommitted
  );
  const grossByIndex = params.entries.map(() => new BN(0));
  const maxGrossByIndex = params.entries.map((entry) => {
    if (!hasTokenCap) return entry.committed;
    const maxGrossFromTokenCap = params.maxWalletTokenAllocation!
      .mul(target)
      .div(params.totalTokensPurchased!);
    return BN.min(entry.committed, maxGrossFromTokenCap);
  });
  const active = new Set(params.entries.map((_, index) => index));
  let remaining = target.clone();

  while (active.size > 0 && remaining.gt(new BN(0))) {
    const totalWeight = [...active].reduce((sum, index) => sum.add(params.entries[index]!.weight), new BN(0));
    if (totalWeight.isZero()) {
      const equalShare = remaining.divn(active.size);
      for (const index of active) {
        grossByIndex[index] = grossByIndex[index]!.add(BN.min(equalShare, maxGrossByIndex[index]!.sub(grossByIndex[index]!)));
      }
      break;
    }

    const capped: number[] = [];
    let assignedThisRound = new BN(0);
    for (const index of active) {
      const entry = params.entries[index]!;
      const capacity = maxGrossByIndex[index]!.sub(grossByIndex[index]!);
      const share = remaining.mul(entry.weight).div(totalWeight);
      if (share.gte(capacity)) {
        grossByIndex[index] = grossByIndex[index]!.add(capacity);
        assignedThisRound = assignedThisRound.add(capacity);
        capped.push(index);
      }
    }

    if (capped.length === 0) {
      for (const index of active) {
        const share = remaining.mul(params.entries[index]!.weight).div(totalWeight);
        grossByIndex[index] = grossByIndex[index]!.add(share);
        assignedThisRound = assignedThisRound.add(share);
      }
      let dust = remaining.sub(assignedThisRound);
      const dustOrder = [...active].sort((a, b) => {
        const weightCmp = params.entries[b]!.weight.cmp(params.entries[a]!.weight);
        return weightCmp !== 0 ? weightCmp : a - b;
      });
      for (const index of dustOrder) {
        if (dust.isZero()) break;
        const capacity = maxGrossByIndex[index]!.sub(grossByIndex[index]!);
        if (capacity.gt(new BN(0))) {
          grossByIndex[index] = grossByIndex[index]!.addn(1);
          dust = dust.subn(1);
        }
      }
      break;
    }

    for (const index of capped) active.delete(index);
    remaining = remaining.sub(assignedThisRound);
  }

  return params.entries.map((entry, index) => {
    const grossAccepted = BN.min(grossByIndex[index]!, entry.committed);
    const refund = entry.committed.sub(grossAccepted);
    return {
      ...entry,
      grossAccepted,
      refund,
      leaf: settlementLeaf({
        presale: params.presale,
        owner: entry.owner,
        committed: entry.committed,
        weight: entry.weight,
        grossAccepted,
        refund
      })
    };
  });
}

export function calculatePumpSpendFromTarget(targetLamports: BN): BN {
  return targetLamports;
}

export function quoteAggregatedFinalizePlan(params: {
  totalCommitted: BN;
  target: BN;
  curve: PumpCurveState;
}): AggregatedFinalizePlan {
  const grossAcceptedTotal = BN.min(params.totalCommitted, params.target);
  const pumpRouteQuote = grossAcceptedTotal;
  const basePlan = quoteFinalizePlan({
    totalQuote: pumpRouteQuote,
    curve: params.curve
  });

  return {
    ...basePlan,
    totalCommitted: params.totalCommitted,
    target: params.target,
    grossAcceptedTotal,
    pumpRouteQuote,
    refundTotal: params.totalCommitted.sub(grossAcceptedTotal),
    transactionCount: basePlan.strategy === "PumpOnly" ? 1 : 3,
    notes: [
      "All contributor commitments are aggregated into one shared route.",
      ...basePlan.notes
    ]
  };
}

export function settlementLeaf(params: {
  presale?: Uint8Array;
  owner: Uint8Array;
  committed: BN;
  weight: BN;
  grossAccepted: BN;
  refund: BN;
}): Uint8Array {
  return copyBytes(keccak_256(
    concatBytes(
      textBytes("stick:settlement:v1"),
      params.presale ?? new Uint8Array(32),
      params.owner,
      bnToLeBytes(params.committed, 8),
      bnToLeBytes(params.weight, 16),
      bnToLeBytes(params.grossAccepted, 8),
      bnToLeBytes(params.refund, 8)
    )
  ));
}

export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) {
    return new Uint8Array(32);
  }
  let level: Uint8Array[] = leaves.map((leaf) => copyBytes(leaf)).sort(compareBytes);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(hashSortedPair(left!, right!));
    }
    level = next.sort(compareBytes);
  }
  return level[0]!;
}

export function merkleProof(leaves: Uint8Array[], targetLeaf: Uint8Array): Uint8Array[] {
  if (leaves.length <= 1) {
    return [];
  }
  let target = copyBytes(targetLeaf);
  const proof: Uint8Array[] = [];
  let level: Uint8Array[] = leaves.map((leaf) => copyBytes(leaf)).sort(compareBytes);

  while (level.length > 1) {
    const targetHex = bytesToHex(target);
    const index = level.findIndex((leaf) => bytesToHex(leaf) === targetHex);
    if (index === -1) {
      throw new Error("target leaf is not in the tree");
    }
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    const sibling = level[siblingIndex] ?? level[index]!;
    proof.push(sibling);
    target = hashSortedPair(level[index]!, sibling);

    const next: Uint8Array[] = [];
    for (let pairIndex = 0; pairIndex < level.length; pairIndex += 2) {
      const left = level[pairIndex]!;
      const right = level[pairIndex + 1] ?? left;
      next.push(hashSortedPair(left, right));
    }
    level = next.sort(compareBytes);
  }

  return proof;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error("hex string must have an even length");
  }
  const output = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export function calculateFillBps(params: {
  raisedBefore: BN;
  hardCap: BN;
}): BN {
  if (params.hardCap.lte(new BN(0))) {
    throw new Error("Hard cap is required for fill boost");
  }
  return BN.min(params.raisedBefore.muln(BPS_DENOMINATOR).div(params.hardCap), new BN(BPS_DENOMINATOR));
}

export function calculateFillMultiplierBps(params: {
  raisedBefore: BN;
  hardCap: BN;
  boostPreset: BoostPreset;
}): BN {
  const fillBps = calculateFillBps(params);
  const sparseBps = new BN(BPS_DENOMINATOR).sub(fillBps);
  const sparseSquaredBps = sparseBps.mul(sparseBps).divn(BPS_DENOMINATOR);
  const boostBps = new BN(BOOST_PRESET_BPS[params.boostPreset]);
  return new BN(BPS_DENOMINATOR).add(boostBps.mul(sparseSquaredBps).divn(BPS_DENOMINATOR));
}

export function calculateEarlyBoostWeight(params: {
  acceptedAmount: BN;
  contributionTs: number;
  presaleEndTs: number;
  presaleStartTs?: number;
  durationSeconds?: number;
  raisedBefore: BN;
  hardCap: BN;
  boostPreset: BoostPreset;
}): BN {
  const remainingSeconds = Math.max(0, params.presaleEndTs - params.contributionTs);
  const durationSeconds = Math.max(
    1,
    params.durationSeconds ?? (params.presaleStartTs === undefined ? params.presaleEndTs - params.contributionTs : params.presaleEndTs - params.presaleStartTs)
  );
  const timeBps = new BN(Math.min(BPS_DENOMINATOR, Math.floor((remainingSeconds * BPS_DENOMINATOR) / durationSeconds)));
  const multiplierBps = calculateFillMultiplierBps(params);
  const bonusBps = timeBps.mul(multiplierBps).divn(BPS_DENOMINATOR);
  return params.acceptedAmount.mul(new BN(BASE_WEIGHT_BPS).add(bonusBps)).divn(BPS_DENOMINATOR);
}

export function calculateDevbuyWeight(params: {
  devbuyAmount: BN;
  durationSeconds: number;
  hardCap: BN;
  boostPreset: BoostPreset;
}): BN {
  return calculateEarlyBoostWeight({
    acceptedAmount: params.devbuyAmount,
    contributionTs: 0,
    presaleEndTs: params.durationSeconds,
    durationSeconds: params.durationSeconds,
    raisedBefore: new BN(0),
    hardCap: params.hardCap,
    boostPreset: params.boostPreset
  });
}

export function calculateAllocationFromWeight(params: {
  totalTokens: BN;
  contributorWeight: BN;
  totalWeight: BN;
}): BN {
  if (params.contributorWeight.isZero() || params.totalWeight.isZero()) {
    return new BN(0);
  }
  return params.totalTokens.mul(params.contributorWeight).div(params.totalWeight);
}

export function calculatePumpBondingCurveMarketCapLamports(params: {
  virtualSolReserves: BN;
  tokenTotalSupply: BN;
  virtualTokenReserves: BN;
}): BN {
  if (params.virtualTokenReserves.lte(new BN(0))) {
    throw new Error("virtualTokenReserves must be greater than zero");
  }
  return params.virtualSolReserves.mul(params.tokenTotalSupply).div(params.virtualTokenReserves);
}

export function calculatePumpCurveCompletion(): PumpBondingCurveParams & {
  realSolReserves: BN;
  marketCapLamports: BN;
} {
  const finalVirtualTokenReserves = PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES.sub(PUMP_INITIAL_REAL_TOKEN_RESERVES);
  const invariant = PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES.mul(PUMP_INITIAL_VIRTUAL_SOL_RESERVES);
  const finalVirtualSolReserves = invariant.div(finalVirtualTokenReserves);
  const realSolReserves = finalVirtualSolReserves.sub(PUMP_INITIAL_VIRTUAL_SOL_RESERVES);
  const params = {
    virtualTokenReserves: finalVirtualTokenReserves,
    virtualSolReserves: finalVirtualSolReserves,
    realTokenReserves: new BN(0),
    tokenTotalSupply: PUMP_TOKEN_TOTAL_SUPPLY
  };

  return {
    ...params,
    realSolReserves,
    marketCapLamports: calculatePumpBondingCurveMarketCapLamports(params)
  };
}

export function estimatePumpRouteMarketCapLamports(params: {
  totalQuoteLamports: BN;
  pumpSwapBaseReserve?: BN;
  pumpSwapQuoteReserveLamports?: BN;
}): BN {
  const completion = calculatePumpCurveCompletion();
  if (params.totalQuoteLamports.lte(completion.realSolReserves)) {
    const virtualSolReserves = PUMP_INITIAL_VIRTUAL_SOL_RESERVES.add(params.totalQuoteLamports);
    const invariant = PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES.mul(PUMP_INITIAL_VIRTUAL_SOL_RESERVES);
    const virtualTokenReserves = invariant.div(virtualSolReserves);
    return calculatePumpBondingCurveMarketCapLamports({
      virtualSolReserves,
      virtualTokenReserves,
      tokenTotalSupply: PUMP_TOKEN_TOTAL_SUPPLY
    });
  }

  const remainder = params.totalQuoteLamports.sub(completion.realSolReserves);
  const baseReserve = params.pumpSwapBaseReserve ?? completion.virtualTokenReserves;
  const quoteReserve = params.pumpSwapQuoteReserveLamports ?? completion.virtualSolReserves;
  return quoteReserve
    .add(remainder)
    .mul(PUMP_TOKEN_TOTAL_SUPPLY)
    .div(baseReserve);
}

export function quoteFinalizePlan(params: {
  totalQuote: BN;
  curve: PumpCurveState;
}): FinalizePlan {
  const { totalQuote, curve } = params;
  if (totalQuote.lte(curve.quoteRemainingToGraduate)) {
    return {
      strategy: "PumpOnly",
      quoteForPump: totalQuote,
      quoteForPumpSwap: new BN(0),
      expectedTotalTokens: curve.expectedTokensBeforeMigration,
      requiresJitoBundle: false,
      notes: ["Presale quote fits before Pump.fun graduation."]
    };
  }

  const quoteForPump = curve.quoteRemainingToGraduate;
  const quoteForPumpSwap = totalQuote.sub(curve.quoteRemainingToGraduate);
  return {
    strategy: "PumpThenPumpSwap",
    quoteForPump,
    quoteForPumpSwap,
    expectedTotalTokens: curve.expectedTokensBeforeMigration.add(curve.expectedTokensAfterMigration ?? new BN(0)),
    requiresJitoBundle: true,
    notes: [
      "Presale quote crosses the Pump.fun graduation threshold.",
      "Keeper should submit an ordered Jito bundle; funds stay in the vault if the bundle does not land."
    ]
  };
}

function bnToLeBytes(value: BN, byteLength: number): Uint8Array {
  return Uint8Array.from(value.toArray("le", byteLength));
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concatBytes(...items: Uint8Array[]): Uint8Array {
  const length = items.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const item of items) {
    output.set(item, offset);
    offset += item.length;
  }
  return output;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) {
      return a[index]! - b[index]!;
    }
  }
  return a.length - b.length;
}

function hashSortedPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  return copyBytes(compareBytes(a, b) <= 0
    ? keccak_256(concatBytes(a, b))
    : keccak_256(concatBytes(b, a)));
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(bytes.length);
  output.set(bytes);
  return output;
}
