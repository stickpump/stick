import { Connection, PublicKey } from "@solana/web3.js";

import { getRuntimeConfig } from "@/lib/mainnet-config";

const PRESALE_STATUSES = [
  "Draft",
  "Open",
  "Closed",
  "RefundOnly",
  "RaffleSettled",
  "Finalizing",
  "Finalized",
  "Cancelled"
] as const;

export type OnchainPresaleStatus = typeof PRESALE_STATUSES[number] | "Unknown";

export type OnchainPresaleState = {
  status: OnchainPresaleStatus;
  endTs: number;
  clusterUnixTs: number | null;
};

export async function readOnchainPresaleState(presaleAddress: string): Promise<OnchainPresaleState | null> {
  const config = getRuntimeConfig();
  const connection = new Connection(config.rpcUrl, "confirmed");
  const account = await connection.getAccountInfo(new PublicKey(presaleAddress), "confirmed");
  if (!account) return null;

  const decoded = decodePresaleState(account.data);
  const slot = await connection.getSlot("confirmed").catch(() => null);
  const clusterUnixTs = slot === null ? null : await connection.getBlockTime(slot).catch(() => null);

  return {
    ...decoded,
    clusterUnixTs
  };
}

function decodePresaleState(data: Buffer | Uint8Array): Pick<OnchainPresaleState, "status" | "endTs"> {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

  let offset = 8 + 8 + (32 * 4);
  const metadataLength = buffer.readUInt32LE(offset);
  offset += 4 + metadataLength;

  const statusOffset = offset + 5;
  const status = PRESALE_STATUSES[buffer[statusOffset] ?? 255] ?? "Unknown";
  const endTs = Number(buffer.readBigInt64LE(statusOffset + 13));

  return { status, endTs };
}
