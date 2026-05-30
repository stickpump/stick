"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import {
  buildClaimAllInstruction,
  buildClaimSolRefundInstruction,
  buildClosePresaleInstruction,
  buildEnsureOwnerTokenAtaInstruction,
  buildSolContributeInstruction,
  mintPda
} from "@fair/launchpad-client";
import { calculateEarlyBoostWeight, SOL_DECIMALS, toBaseUnits } from "@fair/shared";
import { getRuntimeConfig } from "@/lib/mainnet-config";
import { signAndSendInstructions } from "@/lib/transaction-runner";
import type { LaunchStatus } from "@/lib/launch-feed";
import { useStickWallet } from "@/hooks/use-stick-wallet";

type PresaleActionsProps = {
  presaleAddress: string;
  symbol: string;
  status: LaunchStatus;
  rawStatus?: LaunchStatus;
  startsAt?: string;
  endsAt?: string;
  committedLamports: string;
  targetLamports: string;
  dexScreenerUrl?: string;
};

type ClaimResponse = {
  grossAccepted: string;
  refund: string;
  proof: string[];
  claimed?: boolean;
  error?: string;
};

type RefundResponse = {
  refund: string;
  claimed?: boolean;
  ready?: boolean;
  onchainStatus?: string | null;
  error?: string;
};

export function PresaleActions(props: PresaleActionsProps) {
  const wallet = useStickWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [claimPreview, setClaimPreview] = useState<ClaimResponse | null>(null);
  const [claimPreviewStatus, setClaimPreviewStatus] = useState<"idle" | "loading" | "ready" | "missing">("idle");
  const [refundPreview, setRefundPreview] = useState<RefundResponse | null>(null);
  const [refundPreviewStatus, setRefundPreviewStatus] = useState<"idle" | "loading" | "ready" | "missing">("idle");
  const [refundClaimed, setRefundClaimed] = useState(false);
  const [tokensClaimed, setTokensClaimed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const runtimeConfig = useMemo(() => getRuntimeConfig(), []);
  const ended = props.endsAt ? now >= new Date(props.endsAt).getTime() : false;
  const presale = useMemo(() => new PublicKey(props.presaleAddress), [props.presaleAddress]);
  const target = useMemo(() => new BN(props.targetLamports), [props.targetLamports]);
  const committed = useMemo(() => new BN(props.committedLamports), [props.committedLamports]);
  const targetMissed = committed.lt(target);
  const refundMode = props.status === "REFUNDED" || (props.rawStatus === "LIVE" && ended && targetMissed);
  const settlementPending = props.status === "COMPLETED" && props.rawStatus === "LIVE";
  const refundReady = refundPreviewStatus === "ready" && refundPreview?.ready !== false;
  const contributionLamports = useMemo(() => {
    try {
      return toBaseUnits(amount || "0", SOL_DECIMALS);
    } catch {
      return new BN(0);
    }
  }, [amount]);
  const projectedCommitted = useMemo(() => committed.add(contributionLamports), [committed, contributionLamports]);
  const projectedOversub = target.gt(new BN(0)) && projectedCommitted.gt(target);

  useEffect(() => {
    setRefundClaimed(false);
    setTokensClaimed(false);
  }, [props.presaleAddress, wallet.publicKey]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadClaimPreview() {
      if (!wallet.publicKey || props.status !== "COMPLETED" || settlementPending) {
        setClaimPreview(null);
        setClaimPreviewStatus("idle");
        return;
      }

      setClaimPreviewStatus("loading");
      try {
        const response = await fetch(`/api/settlement/claim?presale=${props.presaleAddress}&owner=${wallet.publicKey.toBase58()}`, {
          cache: "no-store"
        });
        const claim = await response.json() as ClaimResponse;
        if (cancelled) return;
        if (!response.ok) {
          setClaimPreview(null);
          setClaimPreviewStatus("missing");
          return;
        }
        setClaimPreview(claim);
        if (claim.claimed) {
          setTokensClaimed(true);
        }
        setClaimPreviewStatus("ready");
      } catch {
        if (!cancelled) {
          setClaimPreview(null);
          setClaimPreviewStatus("missing");
        }
      }
    }

    void loadClaimPreview();
    return () => {
      cancelled = true;
    };
  }, [props.presaleAddress, props.status, settlementPending, wallet.publicKey]);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | undefined;

    async function loadRefundPreview() {
      if (!wallet.publicKey || !refundMode) {
        setRefundPreview(null);
        setRefundPreviewStatus("idle");
        return;
      }

      setRefundPreviewStatus("loading");
      try {
        const response = await fetch(`/api/settlement/refund?presale=${props.presaleAddress}&owner=${wallet.publicKey.toBase58()}`, {
          cache: "no-store"
        });
        const refund = await response.json() as RefundResponse;
        if (cancelled) return;
        if (!response.ok) {
          setRefundPreview(null);
          setRefundPreviewStatus("missing");
          return;
        }
        setRefundPreview(refund);
        if (refund.claimed) {
          setRefundClaimed(true);
        }
        setRefundPreviewStatus("ready");
        if (refund.ready === false) {
          timeout = window.setTimeout(loadRefundPreview, 2_000);
        }
      } catch {
        if (!cancelled) {
          setRefundPreview(null);
          setRefundPreviewStatus("missing");
        }
      }
    }

    void loadRefundPreview();
    return () => {
      cancelled = true;
      if (timeout) window.clearTimeout(timeout);
    };
  }, [props.presaleAddress, refundMode, wallet.publicKey]);

  async function run(action: () => Promise<string>, success: string, onSuccess?: (signature: string) => void | Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      const signature = await action();
      await onSuccess?.(signature);
      setMessage(`${success}: ${shortSignature(signature)}`);
    } catch (error) {
      setMessage(friendlyTransactionError(error));
    } finally {
      setBusy(false);
    }
  }

  async function connectWallet() {
    setBusy(true);
    setMessage(null);
    try {
      await wallet.connect();
    } catch (error) {
      setMessage(friendlyTransactionError(error));
    } finally {
      setBusy(false);
    }
  }

  async function runWalletAction(action: () => Promise<string>, success: string, onSuccess?: (signature: string) => void | Promise<void>) {
    if (!wallet.publicKey) {
      await connectWallet();
      return;
    }
    await run(action, success, onSuccess);
  }

  async function fund() {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    const lamports = toBaseUnits(amount, SOL_DECIMALS);
    if (lamports.lte(new BN(0))) throw new Error("Enter a SOL amount.");

    const signature = await signAndSendInstructions({
      connection,
      wallet,
      sponsored: runtimeConfig.sponsoredTransactions,
      instructions: [
        buildSolContributeInstruction(runtimeConfig.programId, presale, wallet.publicKey, lamports)
      ]
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const startSeconds = props.startsAt ? Math.floor(new Date(props.startsAt).getTime() / 1000) : undefined;
    const endSeconds = props.endsAt ? Math.floor(new Date(props.endsAt).getTime() / 1000) : nowSeconds;
    const weight = calculateEarlyBoostWeight({
      acceptedAmount: lamports,
      contributionTs: nowSeconds,
      presaleStartTs: startSeconds,
      presaleEndTs: endSeconds,
      raisedBefore: committed,
      hardCap: target,
      boostPreset: "Medium"
    });

    await postJson("/api/launches/contribution", {
      presaleAddress: props.presaleAddress,
      owner: wallet.publicKey.toBase58(),
      amountLamports: lamports.toString(),
      weight: weight.toString(),
      symbol: props.symbol,
      signature
    });
    return signature;
  }

  async function closeRaise() {
    const signature = await signAndSendInstructions({
      connection,
      wallet,
      sponsored: runtimeConfig.sponsoredTransactions,
      instructions: [buildClosePresaleInstruction(runtimeConfig.programId, presale)]
    });
    if (committed.lt(target)) {
      await postJson("/api/launches/status", {
        presaleAddress: props.presaleAddress,
        status: "REFUNDED",
        symbol: props.symbol,
        signature
      });
    }
    return signature;
  }

  async function claimRefund() {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    const response = await fetch(`/api/settlement/refund?presale=${props.presaleAddress}&owner=${wallet.publicKey.toBase58()}`, {
      cache: "no-store"
    });
    const refund = await response.json() as RefundResponse;
    if (!response.ok) throw new Error(refund.error ?? "Refund is not ready for this wallet.");
    if (refund.claimed) throw new Error("Refund already claimed.");
    if (refund.ready === false) throw new Error("Refunds are still opening. Try again in a few seconds.");

    const instructions = [];
    if (refund.onchainStatus === "Open") {
      instructions.push(buildClosePresaleInstruction(runtimeConfig.programId, presale));
    }
    instructions.push(buildClaimSolRefundInstruction(runtimeConfig.programId, presale, wallet.publicKey));
    return signAndSendInstructions({
      connection,
      wallet,
      sponsored: runtimeConfig.sponsoredTransactions,
      instructions
    });
  }

  async function claimAll() {
    if (!wallet.publicKey) throw new Error("Connect wallet first.");
    const response = await fetch(`/api/settlement/claim?presale=${props.presaleAddress}&owner=${wallet.publicKey.toBase58()}`, {
      cache: "no-store"
    });
    const claim = await response.json() as ClaimResponse;
    if (!response.ok) throw new Error(claim.error ?? "Claim data is not ready.");
    if (claim.claimed) throw new Error("Claim already completed.");

    const mint = mintPda(runtimeConfig.programId, presale);
    return signAndSendInstructions({
      connection,
      wallet,
      sponsored: runtimeConfig.sponsoredTransactions,
      instructions: [
        buildEnsureOwnerTokenAtaInstruction(wallet.publicKey, wallet.publicKey, mint),
        buildClaimAllInstruction({
          programId: runtimeConfig.programId,
          presale,
          owner: wallet.publicKey,
          mint,
          proof: claim.proof.map(hexToBytes),
          grossAccepted: new BN(claim.grossAccepted),
          refund: new BN(claim.refund)
        })
      ]
    });
  }

  if (props.dexScreenerUrl) {
    return (
      <a className="launchActionButton" href={props.dexScreenerUrl} target="_blank" rel="noreferrer">
        Open DexScreener
      </a>
    );
  }

  return (
    <div className="presaleActionStack">
      {props.status === "LIVE" && !ended && (
        <>
          <div className="presaleActionHeader">
            <strong>Join this raise</strong>
            <span>{projectedOversub ? "Above target: unused SOL returns after settlement." : "Commitment stays open until the timer ends."}</span>
          </div>
          <input
            className="presaleAmountInput"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.1"
          />
          <button className="launchActionButton is-live" disabled={busy} onClick={() => void runWalletAction(fund, "Contribution confirmed")} type="button">
            {busy ? "Waiting for wallet..." : wallet.publicKey ? "Fund this project" : "Connect wallet"}
          </button>
        </>
      )}
      {props.status === "LIVE" && ended && !targetMissed && (
        <>
          <div className="presaleActionHeader">
            <strong>Raise ended</strong>
            <span>Settlement is being prepared. Claim opens when the launch route is finalized.</span>
          </div>
          <button className="launchActionButton is-ended" disabled type="button">
            Ended
          </button>
        </>
      )}
      {refundMode && (
        <>
          <div className="presaleActionHeader">
            <strong>Refund available</strong>
            {refundPreviewStatus === "loading" ? (
              <span className="skeletonBlock claimPreviewSkeleton" aria-label="Checking refund entry" />
            ) : (
              <span>
                {refundPreviewStatus === "ready" && refundPreview
                  ? refundPreview.ready === false
                    ? "Refunds are opening. Try again in a few seconds."
                    : `Refund ${formatLamports(refundPreview.refund)} SOL.`
                  : wallet.publicKey
                    ? "This wallet did not join this launch."
                    : "Connect wallet to check your refund."}
              </span>
            )}
          </div>
          <button
            className={`launchActionButton${refundClaimed || (wallet.publicKey && refundPreviewStatus === "missing") ? " is-ended" : ""}`}
            disabled={refundClaimed || busy || refundPreviewStatus === "loading" || Boolean(wallet.publicKey && (refundPreviewStatus === "missing" || !refundReady))}
            onClick={() => void runWalletAction(claimRefund, "Refund claimed", async (signature) => {
              setRefundClaimed(true);
              if (wallet.publicKey) {
                await postJson("/api/settlement/claimed", {
                  presaleAddress: props.presaleAddress,
                  owner: wallet.publicKey.toBase58(),
                  symbol: props.symbol,
                  signature,
                  claimType: "refund"
                });
              }
              if (props.rawStatus === "LIVE" && ended && targetMissed) {
                await postJson("/api/launches/status", {
                  presaleAddress: props.presaleAddress,
                  status: "REFUNDED",
                  symbol: props.symbol,
                  signature
                });
              }
            })}
            type="button"
          >
            {refundButtonLabel({
              busy,
              connected: Boolean(wallet.publicKey),
              status: refundPreviewStatus,
              claimed: refundClaimed,
              ready: refundReady
            })}
          </button>
        </>
      )}
      {props.status === "COMPLETED" && !settlementPending && (
        <>
          <div className="presaleActionHeader">
            <strong>Claim is ready</strong>
            {claimPreviewStatus === "loading" ? (
              <span className="skeletonBlock claimPreviewSkeleton" aria-label="Checking settlement entry" />
            ) : (
              <span>{claimPreviewStatus === "ready" && claimPreview ? `Accepted ${formatLamports(claimPreview.grossAccepted)} SOL, refund ${formatLamports(claimPreview.refund)} SOL.` : wallet.publicKey ? "No settlement entry found for this wallet yet." : "Connect wallet to check your allocation."}</span>
            )}
          </div>
          <button
            className={`launchActionButton${tokensClaimed || (wallet.publicKey && claimPreviewStatus === "missing") ? " is-ended" : ""}`}
            disabled={tokensClaimed || busy || claimPreviewStatus === "loading" || Boolean(wallet.publicKey && claimPreviewStatus === "missing")}
            onClick={() => void runWalletAction(claimAll, "Claim confirmed", async (signature) => {
              setTokensClaimed(true);
              if (wallet.publicKey) {
                await postJson("/api/settlement/claimed", {
                  presaleAddress: props.presaleAddress,
                  owner: wallet.publicKey.toBase58(),
                  symbol: props.symbol,
                  signature,
                  claimType: "claim"
                });
              }
            })}
            type="button"
          >
            {claimButtonLabel({
              busy,
              connected: Boolean(wallet.publicKey),
              status: claimPreviewStatus,
              refund: claimPreview?.refund,
              claimed: tokensClaimed
            })}
          </button>
        </>
      )}
      {settlementPending && (
        <>
          <div className="presaleActionHeader">
            <strong>Raise ended</strong>
            <span>Settlement is being prepared. Claim opens when token routing is complete.</span>
          </div>
          <button className="launchActionButton is-ended" disabled type="button">
            Ended
          </button>
        </>
      )}
      {message && <span className="presaleActionMessage">{message}</span>}
    </div>
  );
}

function refundButtonLabel(input: { busy: boolean; connected: boolean; status: "idle" | "loading" | "ready" | "missing"; claimed: boolean; ready: boolean }) {
  if (input.claimed) return "Refund claimed";
  if (input.busy) return "Claiming refund...";
  if (!input.connected) return "Connect wallet";
  if (input.status === "loading") return "Checking...";
  if (input.status === "missing") return "Ended";
  if (!input.ready) return "Preparing refunds...";
  return "Claim refund";
}

function claimButtonLabel(input: { busy: boolean; connected: boolean; status: "idle" | "loading" | "ready" | "missing"; refund?: string; claimed: boolean }) {
  if (input.claimed) return "Claimed";
  if (input.busy) return "Claiming...";
  if (!input.connected) return "Connect wallet";
  if (input.status === "loading") return "Checking...";
  if (input.status === "missing") return "Ended";
  return input.refund && new BN(input.refund).gt(new BN(0)) ? "Claim tokens and SOL" : "Claim tokens";
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(json.error ?? `Request failed: ${url}`);
  }
}

function hexToBytes(hex: string) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(clean.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function formatLamports(value: string) {
  const numeric = Number(value) / 1_000_000_000;
  if (!Number.isFinite(numeric)) return "0";
  return numeric.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function shortSignature(signature: string) {
  return `${signature.slice(0, 6)}...${signature.slice(-6)}`;
}

function friendlyTransactionError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (raw.includes("User rejected") || raw.includes("rejected")) return "Transaction was cancelled in the wallet.";
  if (raw.includes("insufficient") || raw.includes("Attempt to debit")) return "Not enough SOL for this transaction and network fees.";
  if (raw.includes("block height exceeded") || raw.includes("expired")) return "Network confirmation expired. Try again with a fresh transaction.";
  if (raw.includes("settlement manifest") || raw.includes("Claim data")) return "Settlement is not ready for this wallet yet.";
  if (raw.includes("owner is not in settlement")) return "This wallet is not in the settlement list for this launch.";
  return raw || "Transaction failed. Try again.";
}
