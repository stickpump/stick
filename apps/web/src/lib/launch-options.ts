import type { BoostPreset, LaunchType, QuoteAsset, RewardPreset, VestingPreset } from "@fair/shared";
import { REWARD_PRESETS } from "@fair/shared";

export const launchTypes: LaunchType[] = [
  "EarlyBoostBatch"
];

export const quoteAssets: QuoteAsset[] = ["SOL", "USDC"];
export const rewardPresets: RewardPreset[] = ["Balanced", "Community", "Creator"];
export const vestingPresets: VestingPreset[] = ["Instant", "Linear7Days", "Linear30Days"];
export const boostPresets: BoostPreset[] = ["Low", "Medium", "High"];

export function splitRows(preset: RewardPreset) {
  const split = REWARD_PRESETS[preset];
  return [
    ["Creator", split.creatorBps],
    ["Holder rewards", split.holderBps],
    ["Token buyback", split.tokenBuybackBps]
  ] as const;
}
