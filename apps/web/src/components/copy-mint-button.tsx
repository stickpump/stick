"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

type CopyMintButtonProps = {
  mint: string;
  className?: string;
};

function shortMint(mint: string) {
  if (mint.length <= 14) return mint;
  return `${mint.slice(0, 4)}....${mint.slice(-5)}`;
}

export function CopyMintButton({ mint, className = "mintCopy" }: CopyMintButtonProps) {
  const [copied, setCopied] = useState(false);

  const copyMint = async () => {
    await navigator.clipboard.writeText(mint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button className={className} type="button" onClick={copyMint}>
      <span>{shortMint(mint)}</span>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
