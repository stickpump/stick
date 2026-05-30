"use client";

import { useCallback, useMemo } from "react";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { useLinkAccount, usePrivy } from "@privy-io/react-auth";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";

const SOLANA_CHAIN = "solana:mainnet" as const;

export function useStickWallet() {
  const { authenticated, login, logout, ready } = usePrivy();
  const { linkWallet } = useLinkAccount();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const activeWallet = wallets[0] ?? null;
  const publicKey = useMemo(() => {
    const address = activeWallet?.address;
    if (!address) return null;
    try {
      return new PublicKey(address);
    } catch {
      return null;
    }
  }, [activeWallet?.address]);

  const connect = useCallback(async () => {
    if (!ready) return;

    if (authenticated) {
      linkWallet({ walletChainType: "solana-only" });
      return;
    }

    login({ loginMethods: ["wallet"], walletChainType: "solana-only" });
  }, [authenticated, linkWallet, login, ready]);

  const signPrivyTransaction = useCallback(async (transaction: VersionedTransaction) => {
    if (!activeWallet || !publicKey) {
      throw new Error("Connect a Solana wallet first.");
    }
    const { signedTransaction } = await signTransaction({
      transaction: transaction.serialize(),
      wallet: activeWallet,
      chain: SOLANA_CHAIN
    });
    return VersionedTransaction.deserialize(signedTransaction);
  }, [activeWallet, publicKey, signTransaction]);

  return {
    authenticated,
    connected: Boolean(authenticated && publicKey),
    connecting: !ready,
    publicKey,
    ready,
    connect,
    disconnect: logout,
    signTransaction: publicKey ? signPrivyTransaction : undefined
  };
}
