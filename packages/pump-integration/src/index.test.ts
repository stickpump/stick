import { describe, expect, it, vi } from "vitest";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

vi.mock("@pump-fun/agent-payments-sdk", () => ({
  PumpAgentOffline: {
    load: () => ({
      create: vi.fn()
    })
  }
}));

describe("pump integration", () => {
  it("builds create_v2 instruction with official Pump SDK", async () => {
    const { buildCreateV2Instructions, quoteMintForAsset } = await import("./index");
    const mint = Keypair.generate().publicKey;
    const user = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const instructions = await buildCreateV2Instructions({
      mint,
      name: "Fair Test",
      symbol: "FAIR",
      uri: "https://example.com/metadata.json",
      creator,
      user,
      quoteMint: quoteMintForAsset("SOL")
    });
    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.keys.length).toBeGreaterThan(0);
  });

  it("marks above-graduation plans as bundle-required", async () => {
    const { planFinalize } = await import("./index");
    const plan = planFinalize({
      totalQuote: new BN(101),
      curve: {
        quoteRemainingToGraduate: new BN(100),
        expectedTokensBeforeMigration: new BN(1_000),
        expectedTokensAfterMigration: new BN(10),
        migrationRequired: true
      }
    });
    expect(plan.strategy).toBe("PumpThenPumpSwap");
    expect(plan.requiresJitoBundle).toBe(true);
  });

  it("plans one aggregated route instead of per-contributor buys", async () => {
    const { planAggregatedFinalize } = await import("./index");
    const sol = new BN(1_000_000_000);
    const plan = planAggregatedFinalize({
      totalCommitted: new BN(1_000).mul(sol),
      target: new BN(100).mul(sol),
      curve: {
        quoteRemainingToGraduate: new BN(85).mul(sol),
        expectedTokensBeforeMigration: new BN(1_000),
        expectedTokensAfterMigration: new BN(100),
        migrationRequired: true
      }
    });

    expect(plan.strategy).toBe("PumpThenPumpSwap");
    expect(plan.grossAcceptedTotal.toString()).toBe(new BN(100).mul(sol).toString());
    expect(plan.refundTotal.toString()).toBe(new BN(900).mul(sol).toString());
    expect(plan.transactionCount).toBe(3);
  });

  it("serializes Jito bundles as base64 transactions", async () => {
    const { buildJitoBundle } = await import("./index");
    const payer = Keypair.generate().publicKey;
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: payer,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1
        })
      ]
    }).compileToV0Message());
    const [serialized] = buildJitoBundle({ transactions: [tx] });

    expect(serialized).toBe(Buffer.from(tx.serialize()).toString("base64"));
    expect(() => Buffer.from(serialized!, "base64")).not.toThrow();
  });
});
