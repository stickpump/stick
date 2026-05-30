import { Connection, PublicKey } from "@solana/web3.js";
import { contributorPda } from "@fair/launchpad-client";

import { getRuntimeConfig } from "@/lib/mainnet-config";

const SETTLEMENT_CLAIMED_OFFSET = 161;
const ACCEPTED_AMOUNT_OFFSET = 72;
const CONTRIBUTION_WEIGHT_OFFSET = 88;

export type OnchainContributorState = {
  acceptedAmount: string;
  contributionWeight: string;
  settlementClaimed: boolean;
};

function readU64Le(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

function readU128Le(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset + offset, 16);
  const lo = view.getBigUint64(0, true);
  const hi = view.getBigUint64(8, true);
  return lo + (hi << 64n);
}

export async function readOnchainContributorState(presaleAddress: string, ownerAddress: string): Promise<OnchainContributorState | null> {
  const config = getRuntimeConfig();
  const presale = new PublicKey(presaleAddress);
  const owner = new PublicKey(ownerAddress);
  const contributor = contributorPda(config.programId, presale, owner);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const account = await connection.getAccountInfo(contributor, "confirmed");
  if (!account || account.data.length <= SETTLEMENT_CLAIMED_OFFSET) return null;

  return {
    acceptedAmount: readU64Le(account.data, ACCEPTED_AMOUNT_OFFSET).toString(),
    contributionWeight: readU128Le(account.data, CONTRIBUTION_WEIGHT_OFFSET).toString(),
    settlementClaimed: account.data[SETTLEMENT_CLAIMED_OFFSET] === 1
  };
}

export async function readOnchainContributorStateWithRetry(
  presaleAddress: string,
  ownerAddress: string,
  attempts = 10
): Promise<OnchainContributorState | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await readOnchainContributorState(presaleAddress, ownerAddress);
    if (state) return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}
