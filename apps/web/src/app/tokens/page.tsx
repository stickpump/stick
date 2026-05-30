import Link from "next/link";
import BN from "bn.js";
import { estimatePumpRouteMarketCapLamports, SOL_DECIMALS } from "@fair/shared";
import { FutardHeader } from "@/components/futard-header";
import { TokenCard } from "@/components/landing-page";
import { dbQuery, hasDatabaseUrl } from "@/lib/db";
import type { LaunchedTokenView } from "@/lib/launch-feed";
import { getSolUsdtPrice } from "@/lib/sol-price";

export const dynamic = "force-dynamic";

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
};

export default async function TokensPage() {
  const tokens = await readLaunchedTokens();

  return (
    <main className="futardLanding">
      <FutardHeader searchPlaceholder="Search token / CA" />

      <section className="tokenDirectory">
        <div className="sectionBar">
          <div>
            <span>ALL LAUNCHED</span>
            <strong>Graduated tokens</strong>
          </div>
          <Link href="/">Back to presales</Link>
        </div>

        {tokens.length > 0 ? (
          <div className="tokenGrid directory">
            {tokens.map((token) => <TokenCard token={token} key={token.id} />)}
          </div>
        ) : (
          <div className="futardEmptyState compact">
            <span>NO LAUNCHED TOKENS YET</span>
            <strong>Graduated launches will appear here once they settle.</strong>
          </div>
        )}
      </section>
    </main>
  );
}

async function readLaunchedTokens(): Promise<LaunchedTokenView[]> {
  if (!hasDatabaseUrl()) return [];
  try {
    const [result, solUsdPrice] = await Promise.all([
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
          banner_url
        from launched_tokens
        where presale_address in (
          select presale_address from launches where coalesce(creator, '') <> ''
        )
        order by launched_at desc
        limit 120
      `
      ),
      getSolUsdtPrice()
    ]);
    return result.rows.map((row) => formatToken(row, solUsdPrice));
  } catch {
    return [];
  }
}

function formatToken(row: TokenRow, solUsdPrice: number): LaunchedTokenView {
  return {
    id: row.presale_address ?? row.mint,
    presaleAddress: row.presale_address ?? row.mint,
    name: row.name,
    symbol: row.symbol,
    marketCapLabel: formatUsd(row.market_cap_usd ? Number(row.market_cap_usd) : estimateMarketCapUsd(row.raised_lamports, solUsdPrice)),
    raisedLabel: `${formatSol(Number(row.raised_lamports) / 1_000_000_000)} SOL raised`,
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
