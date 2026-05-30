"use client";

import { ConnectionProvider } from "@solana/wallet-adapter-react";
import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";

const DEFAULT_PRIVY_APP_ID = "cmhttt894009iic0ck51ffh7a";

function endpointFromEnv() {
  return process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
}

export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const endpoint = endpointFromEnv();
  const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? DEFAULT_PRIVY_APP_ID;

  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#4d8dff",
          walletChainType: "solana-only"
        },
        loginMethods: ["wallet"],
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors()
          }
        },
        embeddedWallets: {
          solana: {
            createOnLogin: "off"
          }
        }
      }}
    >
      <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
        {children}
      </ConnectionProvider>
    </PrivyProvider>
  );
}
