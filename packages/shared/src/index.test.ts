import { describe, expect, it } from "vitest";
import BN from "bn.js";
import {
  calculateAcceptedContribution,
  calculateOversubscriptionSettlement,
  calculateDevbuyWeight,
  calculateEarlyBoostWeight,
  calculateFillMultiplierBps,
  calculatePumpSpendFromTarget,
  bytesToHex,
  calculatePumpBondingCurveMarketCapLamports,
  merkleProof,
  merkleRoot,
  calculatePumpCurveCompletion,
  estimatePumpRouteMarketCapLamports,
  quoteAggregatedFinalizePlan,
  quoteFinalizePlan,
  REWARD_PRESETS,
  assertRewardSplit
} from "./index";

describe("shared launch math", () => {
  it("keeps all reward presets at 100%", () => {
    for (const split of Object.values(REWARD_PRESETS)) {
      expect(() => assertRewardSplit(split)).not.toThrow();
    }
  });

  it("accepts full commitments even above target", () => {
    const result = calculateAcceptedContribution({
      requestedAmount: new BN(50),
      currentRaised: new BN(80),
      hardCap: new BN(100)
    });
    expect(result.accepted.toString()).toBe("50");
    expect(result.overflow.toString()).toBe("0");
  });

  it("applies wallet cap without target overflow", () => {
    const result = calculateAcceptedContribution({
      requestedAmount: new BN(50),
      currentRaised: new BN(10),
      hardCap: new BN(100),
      currentWalletAccepted: new BN(30),
      maxWalletContribution: new BN(60)
    });
    expect(result.accepted.toString()).toBe("30");
    expect(result.overflow.toString()).toBe("20");
  });

  it("keeps oversubscribed commitments refundable after weighted settlement", () => {
    const settlement = calculateOversubscriptionSettlement({
      presale: new Uint8Array(32).fill(7),
      target: new BN(100),
      entries: [
        { owner: new Uint8Array(32).fill(1), committed: new BN(100), weight: new BN(300) },
        { owner: new Uint8Array(32).fill(2), committed: new BN(900), weight: new BN(700) }
      ]
    });
    const gross = settlement.reduce((sum, item) => sum.add(item.grossAccepted), new BN(0));
    const refund = settlement.reduce((sum, item) => sum.add(item.refund), new BN(0));
    expect(gross.toString()).toBe("100");
    expect(refund.toString()).toBe("900");
    expect(settlement[0]!.grossAccepted.lte(settlement[0]!.committed)).toBe(true);
    expect(settlement[0]!.grossAccepted.gt(new BN(10))).toBe(true);
  });

  it("does not apply weighted haircut when the raise is not oversubscribed", () => {
    const settlement = calculateOversubscriptionSettlement({
      presale: new Uint8Array(32).fill(7),
      target: new BN(200),
      entries: [
        { owner: new Uint8Array(32).fill(1), committed: new BN(100), weight: new BN(10_000) },
        { owner: new Uint8Array(32).fill(2), committed: new BN(100), weight: new BN(1) }
      ]
    });
    expect(settlement[0]!.grossAccepted.toString()).toBe("100");
    expect(settlement[1]!.grossAccepted.toString()).toBe("100");
    expect(settlement[0]!.refund.toString()).toBe("0");
    expect(settlement[1]!.refund.toString()).toBe("0");
  });

  it("caps wallet allocation by token supply and redistributes accepted quote", () => {
    const settlement = calculateOversubscriptionSettlement({
      presale: new Uint8Array(32).fill(7),
      target: new BN(100),
      totalTokensPurchased: new BN(1_000),
      maxWalletTokenAllocation: new BN(300),
      entries: [
        { owner: new Uint8Array(32).fill(1), committed: new BN(100), weight: new BN(900) },
        { owner: new Uint8Array(32).fill(2), committed: new BN(100), weight: new BN(100) },
        { owner: new Uint8Array(32).fill(3), committed: new BN(100), weight: new BN(100) }
      ]
    });
    const gross = settlement.reduce((sum, item) => sum.add(item.grossAccepted), new BN(0));
    expect(gross.toString()).toBe("90");
    expect(settlement[0]!.grossAccepted.toString()).toBe("30");
    expect(settlement[1]!.grossAccepted.toString()).toBe("30");
    expect(settlement[2]!.grossAccepted.toString()).toBe("30");
  });

  it("routes the full target into Pump/PumpSwap spend", () => {
    const spend = calculatePumpSpendFromTarget(new BN(100).mul(new BN(1_000_000_000)));
    expect(spend.div(new BN(1_000_000_000)).toString()).toBe("100");
    expect(spend.mod(new BN(1_000_000_000)).toString()).toBe("0");
  });

  it("builds deterministic settlement leaves and Merkle proofs", () => {
    const settlement = calculateOversubscriptionSettlement({
      presale: new Uint8Array(32).fill(9),
      target: new BN(100),
      entries: [
        { owner: new Uint8Array(32).fill(1), committed: new BN(100), weight: new BN(300) },
        { owner: new Uint8Array(32).fill(2), committed: new BN(900), weight: new BN(700) }
      ]
    });
    const root = merkleRoot(settlement.map((item) => item.leaf));
    const proof = merkleProof(settlement.map((item) => item.leaf), settlement[0]!.leaf);
    expect(bytesToHex(root)).toHaveLength(64);
    expect(proof).toHaveLength(1);
  });

  it("gives earlier same-size contributions more weight", () => {
    const early = calculateEarlyBoostWeight({
      acceptedAmount: new BN(100),
      contributionTs: 0,
      presaleEndTs: 100,
      presaleStartTs: 0,
      raisedBefore: new BN(0),
      hardCap: new BN(1_000),
      boostPreset: "Medium"
    });
    const late = calculateEarlyBoostWeight({
      acceptedAmount: new BN(100),
      contributionTs: 50,
      presaleEndTs: 100,
      presaleStartTs: 0,
      raisedBefore: new BN(0),
      hardCap: new BN(1_000),
      boostPreset: "Medium"
    });
    expect(early.gt(late)).toBe(true);
    expect(late.gt(new BN(0))).toBe(true);
    expect(early.muln(2).lte(late.muln(5))).toBe(true);
  });

  it("decreases fill boost as the pool fills", () => {
    const empty = calculateFillMultiplierBps({
      raisedBefore: new BN(0),
      hardCap: new BN(1_000),
      boostPreset: "High"
    });
    const half = calculateFillMultiplierBps({
      raisedBefore: new BN(500),
      hardCap: new BN(1_000),
      boostPreset: "High"
    });
    expect(empty.gt(half)).toBe(true);
    expect(empty.toString()).toBe("20000");
  });

  it("makes devbuy first-fill weight deterministic", () => {
    const low = calculateDevbuyWeight({
      devbuyAmount: new BN(100),
      durationSeconds: 100,
      hardCap: new BN(1_000),
      boostPreset: "Low"
    });
    const high = calculateDevbuyWeight({
      devbuyAmount: new BN(100),
      durationSeconds: 100,
      hardCap: new BN(1_000),
      boostPreset: "High"
    });
    expect(high.gt(low)).toBe(true);
    expect(low.toString()).toBe("325");
  });

  it("calculates Pump bonding curve completion cap from virtual reserves", () => {
    const completion = calculatePumpCurveCompletion();
    expect(completion.realTokenReserves.toString()).toBe("0");
    expect(completion.realSolReserves.div(new BN(1_000_000_000)).toString()).toBe("85");
    expect(completion.marketCapLamports.div(new BN(1_000_000_000)).toString()).toBe("410");
  });

  it("uses Pump docs virtual reserve market-cap formula", () => {
    const marketCap = calculatePumpBondingCurveMarketCapLamports({
      virtualSolReserves: new BN("30000000000"),
      tokenTotalSupply: new BN("1000000000000000"),
      virtualTokenReserves: new BN("1073000000000000")
    });
    expect(marketCap.toString()).toBe("27958993476");
  });

  it("continues market-cap estimate after Pump graduation through PumpSwap remainder", () => {
    const completion = calculatePumpCurveCompletion();
    const afterLargeBuy = estimatePumpRouteMarketCapLamports({
      totalQuoteLamports: new BN(10_000).mul(new BN(1_000_000_000))
    });
    expect(afterLargeBuy.gt(completion.marketCapLamports)).toBe(true);
    expect(afterLargeBuy.div(new BN(1_000_000_000)).toString()).toBe("35834");
  });

  it("plans pump-only finalize below graduation", () => {
    const plan = quoteFinalizePlan({
      totalQuote: new BN(90),
      curve: {
        quoteRemainingToGraduate: new BN(100),
        expectedTokensBeforeMigration: new BN(1_000),
        migrationRequired: false
      }
    });
    expect(plan.strategy).toBe("PumpOnly");
    expect(plan.requiresJitoBundle).toBe(false);
  });

  it("plans split finalize above graduation", () => {
    const plan = quoteFinalizePlan({
      totalQuote: new BN(130),
      curve: {
        quoteRemainingToGraduate: new BN(100),
        expectedTokensBeforeMigration: new BN(1_000),
        expectedTokensAfterMigration: new BN(200),
        migrationRequired: true
      }
    });
    expect(plan.strategy).toBe("PumpThenPumpSwap");
    expect(plan.quoteForPump.toString()).toBe("100");
    expect(plan.quoteForPumpSwap.toString()).toBe("30");
    expect(plan.requiresJitoBundle).toBe(true);
  });

  it("aggregates a 50 SOL raise into one Pump buy", () => {
    const plan = quoteAggregatedFinalizePlan({
      totalCommitted: new BN(50).mul(new BN(1_000_000_000)),
      target: new BN(50).mul(new BN(1_000_000_000)),
      curve: {
        quoteRemainingToGraduate: new BN(85).mul(new BN(1_000_000_000)),
        expectedTokensBeforeMigration: new BN(1_000),
        migrationRequired: false
      }
    });

    expect(plan.strategy).toBe("PumpOnly");
    expect(plan.transactionCount).toBe(1);
    expect(plan.pumpRouteQuote.toString()).toBe(new BN("50000000000").toString());
    expect(plan.quoteForPump.toString()).toBe(plan.pumpRouteQuote.toString());
    expect(plan.quoteForPumpSwap.toString()).toBe("0");
    expect(plan.refundTotal.toString()).toBe("0");
  });

  it("aggregates a 100 SOL raise into one Pump buy plus one PumpSwap remainder", () => {
    const plan = quoteAggregatedFinalizePlan({
      totalCommitted: new BN(100).mul(new BN(1_000_000_000)),
      target: new BN(100).mul(new BN(1_000_000_000)),
      curve: {
        quoteRemainingToGraduate: new BN(85).mul(new BN(1_000_000_000)),
        expectedTokensBeforeMigration: new BN(1_000),
        expectedTokensAfterMigration: new BN(150),
        migrationRequired: true
      }
    });

    expect(plan.strategy).toBe("PumpThenPumpSwap");
    expect(plan.transactionCount).toBe(3);
    expect(plan.pumpRouteQuote.toString()).toBe(new BN("100000000000").toString());
    expect(plan.quoteForPump.toString()).toBe(new BN("85000000000").toString());
    expect(plan.quoteForPumpSwap.toString()).toBe(new BN("15000000000").toString());
    expect(plan.refundTotal.toString()).toBe("0");
    expect(plan.requiresJitoBundle).toBe(true);
  });

  it("uses the full target for route and refunds oversubscription", () => {
    const plan = quoteAggregatedFinalizePlan({
      totalCommitted: new BN(1_000).mul(new BN(1_000_000_000)),
      target: new BN(100).mul(new BN(1_000_000_000)),
      curve: {
        quoteRemainingToGraduate: new BN(85).mul(new BN(1_000_000_000)),
        expectedTokensBeforeMigration: new BN(1_000),
        expectedTokensAfterMigration: new BN(150),
        migrationRequired: true
      }
    });

    expect(plan.grossAcceptedTotal.toString()).toBe(new BN("100000000000").toString());
    expect(plan.pumpRouteQuote.toString()).toBe(new BN("100000000000").toString());
    expect(plan.refundTotal.toString()).toBe(new BN("900000000000").toString());
    expect(plan.quoteForPump.toString()).toBe(new BN("85000000000").toString());
    expect(plan.quoteForPumpSwap.toString()).toBe(new BN("15000000000").toString());
  });
});
