import { PublicKey } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID, type Cluster } from "@fair/launchpad-client";

export type RuntimeConfig = {
  cluster: Cluster;
  rpcUrl: string;
  programId: PublicKey;
  sponsoredTransactions: boolean;
};

export function getRuntimeConfig(): RuntimeConfig {
  const cluster = parseCluster(process.env.NEXT_PUBLIC_SOLANA_CLUSTER);
  const programIdRaw = process.env.NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID;
  const programId = programIdRaw ? new PublicKey(programIdRaw) : DEFAULT_PROGRAM_ID;

  return {
    cluster,
    rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    programId,
    sponsoredTransactions: process.env.NEXT_PUBLIC_SPONSORED_TX === "true"
  };
}

export function assertMainnetProgramConfigured(config = getRuntimeConfig()) {
  if (config.cluster === "mainnet-beta" && !process.env.NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID) {
    throw new Error("Set NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID before using mainnet.");
  }
}

function parseCluster(value?: string): Cluster {
  if (value === "devnet" || value === "localnet") {
    return value;
  }
  return "mainnet-beta";
}
