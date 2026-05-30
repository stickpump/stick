"use client";

import { VersionedTransaction, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  buildVersionedTransaction,
  deserializeTransaction,
  serializeTransaction
} from "@fair/launchpad-client";

export type WalletSigner = {
  publicKey: PublicKey | null;
  signTransaction?: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
};

export async function getSponsorPayer(): Promise<PublicKey | null> {
  const { PublicKey } = await import("@solana/web3.js");
  const response = await fetch("/api/sponsor", { method: "GET" });
  if (!response.ok) {
    return null;
  }
  const json = await response.json() as { publicKey?: string };
  return json.publicKey ? new PublicKey(json.publicKey) : null;
}

export async function signAndSendInstructions(params: {
  connection: Connection;
  wallet: WalletSigner;
  instructions: TransactionInstruction[];
  sponsored: boolean;
}): Promise<string> {
  if (!params.wallet.publicKey || !params.wallet.signTransaction) {
    throw new Error("Connect a wallet that supports transaction signing.");
  }

  const sponsor = params.sponsored ? await getSponsorPayer() : null;
  const tx = await buildVersionedTransaction({
    connection: params.connection,
    payer: sponsor ?? params.wallet.publicKey,
    instructions: params.instructions
  });

  const userSigned = await params.wallet.signTransaction(tx);
  const finalTx = sponsor ? await sponsorTransaction(userSigned) : userSigned;
  const signature = await params.connection.sendRawTransaction(finalTx.serialize(), {
    maxRetries: 5,
    skipPreflight: false
  });
  await params.connection.confirmTransaction(signature, "confirmed");
  return signature;
}

async function sponsorTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
  const response = await fetch("/api/sponsor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: serializeTransaction(tx) })
  });
  const json = await response.json() as { transaction?: string; error?: string };
  if (!response.ok || !json.transaction) {
    throw new Error(json.error ?? "Sponsor signing failed");
  }
  return deserializeTransaction(json.transaction);
}
