import { NextResponse } from "next/server";
import BN from "bn.js";
import { estimatePumpRouteMarketCapLamports, SOL_DECIMALS } from "@fair/shared";
import { dbQuery, hasDatabaseUrl } from "@/lib/db";
import {
  platformStats,
  type LaunchStatus
} from "@/lib/launch-feed";
import { getSolUsdtPrice } from "@/lib/sol-price";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LAMPORTS_PER_SOL = 1_000_000_000;

type LaunchRow = {
  presale_address: string;
  slug: string | null;
  name: string;
  symbol: string;
  status: LaunchStatus;
  description: string;
  avatar_url: string | null;
  banner_url: string | null;
  target_lamports: string;
  committed_lamports: string;
  contributors_count: number;
  max_wallet_supply_bps: number | null;
  fdv_usd: string | null;
  start_at: Date | string;
  end_at: Date | string | null;
};

type TokenRow = {
  mint: string;
  presale_address: string | null;
  name: string;
  symbol: string;
  market_cap_usd: string | null;
  raised_lamports: string;
  liquidity_label: string | null;
  dex_screener_url: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  launched_at: Date | string;
};

type StatsRow = {
  launch_count: string;
  committed_lamports: string;
  funders: string;
};

export async function GET() {
  if (!hasDatabaseUrl()) {
    return emptyResponse("DATABASE_URL is not configured.");
  }

  try {
    const [launchResult, tokenResult, statsResult, solUsdPrice] = await Promise.all([
      dbQuery<LaunchRow>(
        `
          select
            presale_address,
            slug,
            name,
            symbol,
            status,
            description,
            avatar_url,
            banner_url,
            target_lamports::text,
            committed_lamports::text,
            contributors_count,
            coalesce(max_wallet_supply_bps, 0) as max_wallet_supply_bps,
            fdv_usd::text,
            start_at,
            end_at
          from launches
          where status in ('LIVE', 'COMPLETED', 'REFUNDED')
            and coalesce(creator, '') <> ''
          order by
            case status when 'LIVE' then 0 when 'COMPLETED' then 1 else 2 end,
            updated_at desc
          limit 60
        `
      ),
      dbQuery<TokenRow>(
        `
          select
            mint,
            presale_address,
            name,
            symbol,
            market_cap_usd::text,
            raised_lamports::text,
            liquidity_label,
            dex_screener_url,
            avatar_url,
            banner_url,
            launched_at
          from launched_tokens
          where presale_address in (
            select presale_address from launches where coalesce(creator, '') <> ''
          )
          order by launched_at desc
          limit 24
        `
      ),
      dbQuery<StatsRow>(
        `
          select
            count(*)::text as launch_count,
            coalesce(sum(committed_lamports), 0)::text as committed_lamports,
            coalesce(sum(contributors_count), 0)::text as funders
          from launches
          where coalesce(creator, '') <> ''
        `
      ),
      getSolUsdtPrice()
    ]);

    if (launchResult.rows.length === 0 && tokenResult.rows.length === 0) {
      return emptyResponse(undefined, "postgres-empty");
    }

    const stats = statsResult.rows[0];
    return NextResponse.json({
      source: "postgres",
      launches: launchResult.rows.map((row) => formatLaunch(row, solUsdPrice)),
      launchedTokens: tokenResult.rows.map((row) => formatToken(row, solUsdPrice)),
      platformStats: stats
        ? {
          committedLabel: formatUsd(solFromLamports(stats.committed_lamports) * solUsdPrice),
          fundersLabel: Number(stats.funders).toLocaleString("en-US"),
          activeLabel: launchResult.rows.filter((row) => row.status === "LIVE").length.toString(),
          launchedLabel: stats.launch_count
        }
        : platformStats
    });
  } catch (error) {
    return emptyResponse(error instanceof Error ? error.message : "Failed to read launches.");
  }
}

function emptyResponse(error?: string, source = "empty") {
  return NextResponse.json({
    source,
    launches: [],
    launchedTokens: [],
    platformStats,
    error
  });
}

function formatLaunch(row: LaunchRow, solUsdPrice: number) {
  const committedSol = solFromLamports(row.committed_lamports);
  const targetSol = solFromLamports(row.target_lamports);
  const progressPercent = targetSol > 0 ? Math.round((committedSol / targetSol) * 100) : 0;
  const status = effectiveStatus(row, committedSol, targetSol);

  return {
    id: row.slug ?? row.presale_address,
    presaleAddress: row.presale_address,
    name: row.name,
    symbol: row.symbol,
    status,
    rawStatus: row.status,
    mode: "Stick raise",
    description: row.description,
    committedLabel: `${formatSol(committedSol)} SOL`,
    goalLabel: `${formatSol(targetSol)} SOL`,
    progressPercent,
    contributorsLabel: row.contributors_count.toLocaleString("en-US"),
    maxWalletSupplyBps: row.max_wallet_supply_bps ?? 0,
    fdvLabel: `${formatUsd(row.fdv_usd ? Number(row.fdv_usd) : estimateMarketCapUsd(row.target_lamports, solUsdPrice))} FDV`,
    avatarUrl: row.avatar_url ?? undefined,
    bannerUrl: row.banner_url ?? undefined,
    startsAt: toIso(row.start_at),
    endsAt: row.end_at ? toIso(row.end_at) : undefined
  };
}

function effectiveStatus(row: LaunchRow, committedSol: number, targetSol: number): LaunchStatus {
  if (row.status !== "LIVE" || !row.end_at) return row.status;
  const endMs = new Date(row.end_at).getTime();
  if (!Number.isFinite(endMs) || endMs > Date.now()) return row.status;
  return committedSol < targetSol ? "REFUNDED" : "COMPLETED";
}

function formatToken(row: TokenRow, solUsdPrice: number) {
  return {
    id: row.presale_address ?? row.mint,
    presaleAddress: row.presale_address ?? row.mint,
    name: row.name,
    symbol: row.symbol,
    marketCapLabel: formatUsd(row.market_cap_usd ? Number(row.market_cap_usd) : estimateMarketCapUsd(row.raised_lamports, solUsdPrice)),
    raisedLabel: `${formatSol(solFromLamports(row.raised_lamports))} SOL raised`,
    liquidityLabel: row.liquidity_label ?? undefined,
    routeLabel: row.liquidity_label ? `Launched via ${row.liquidity_label}` : "Launched",
    mint: row.mint,
    dexScreenerUrl: row.dex_screener_url ?? `https://dexscreener.com/solana/${row.mint}`,
    presaleId: row.presale_address ?? row.mint,
    avatarUrl: row.avatar_url ?? undefined,
    bannerUrl: row.banner_url ?? undefined
  };
}

function estimateMarketCapUsd(quoteLamports: string, solUsdPrice: number) {
  const marketCapLamports = estimatePumpRouteMarketCapLamports({
    totalQuoteLamports: new BN(quoteLamports || "0")
  });
  return Number(formatBaseUnits(marketCapLamports, SOL_DECIMALS)) * solUsdPrice;
}

function formatBaseUnits(amount: BN, decimals: number) {
  const base = new BN(10).pow(new BN(decimals));
  const whole = amount.div(base).toString();
  const fraction = amount.mod(base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function solFromLamports(value: string) {
  return Number(value) / LAMPORTS_PER_SOL;
}

function formatSol(value: number) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 100) return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "$0";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}
