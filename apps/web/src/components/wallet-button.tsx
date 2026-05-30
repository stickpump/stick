"use client";

import { Wallet } from "lucide-react";
import { useStickWallet } from "@/hooks/use-stick-wallet";

type WalletButtonProps = {
  iconOnlyWhenDisconnected?: boolean;
};

export function WalletButton({ iconOnlyWhenDisconnected = false }: WalletButtonProps) {
  const { connected, connecting, publicKey, connect, disconnect } = useStickWallet();

  async function handleClick() {
    if (connected) {
      await disconnect();
      return;
    }
    await connect();
  }

  const label = connected && publicKey
    ? `${publicKey.toBase58().slice(0, 4)}...${publicKey.toBase58().slice(-4)}`
    : connecting
      ? "Connecting"
      : "Connect Wallet";
  const iconOnly = iconOnlyWhenDisconnected && !connected;

  return (
    <button
      aria-label={label}
      className={[connected ? "walletButton connected" : "walletButton", iconOnly ? "iconOnly" : ""].filter(Boolean).join(" ")}
      onClick={handleClick}
      title={label}
      type="button"
    >
      {!connected && <Wallet size={16} />}
      {!iconOnly && label}
    </button>
  );
}
