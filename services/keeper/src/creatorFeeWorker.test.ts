import { describe, expect, it } from "vitest";
import {
  BUYBACK_BURN_THRESHOLD_LAMPORTS,
  COINFLIP_THRESHOLD_LAMPORTS,
  CREATOR_FEE_RESERVE_LAMPORTS,
  FLYWHEEL_THRESHOLD_LAMPORTS,
  spendableAfterReserve,
  thresholdForMode
} from "./creatorFeeWorker.js";

describe("creator fee worker budget math", () => {
  it("never spends the fixed subwallet reserve", () => {
    expect(spendableAfterReserve(0n)).toBe(0n);
    expect(spendableAfterReserve(CREATOR_FEE_RESERVE_LAMPORTS - 1n)).toBe(0n);
    expect(spendableAfterReserve(CREATOR_FEE_RESERVE_LAMPORTS)).toBe(0n);
    expect(spendableAfterReserve(CREATOR_FEE_RESERVE_LAMPORTS + 1n)).toBe(1n);
  });

  it("uses the expected mode thresholds", () => {
    expect(thresholdForMode("buyback_burn")).toBe(BUYBACK_BURN_THRESHOLD_LAMPORTS);
    expect(thresholdForMode("coinflip")).toBe(COINFLIP_THRESHOLD_LAMPORTS);
    expect(thresholdForMode("flywheel")).toBe(FLYWHEEL_THRESHOLD_LAMPORTS);
  });
});
