import { describe, expect, it } from "vitest";
import { decryptText, encryptText } from "./server-secret-crypto";

describe("server secret crypto", () => {
  it("round-trips encrypted wallet secrets without exposing plaintext in the payload", () => {
    const secret = JSON.stringify([1, 2, 3, 4, 5]);
    const encrypted = encryptText(secret, "test-encryption-key");

    expect(encrypted).not.toContain(secret);
    expect(decryptText(encrypted, "test-encryption-key")).toBe(secret);
  });

  it("fails with the wrong key", () => {
    const encrypted = encryptText("wallet-secret", "correct-key");
    expect(() => decryptText(encrypted, "wrong-key")).toThrow();
  });
});
