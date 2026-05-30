import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import BN from "bn.js";
import { estimatePumpRouteMarketCapLamports, SOL_DECIMALS } from "@fair/shared";
import { CopyMintButton } from "@/components/copy-mint-button";
import { FutardHeader } from "@/components/futard-header";
import { LaunchAutoRefresh } from "@/components/launch-auto-refresh";
import { LaunchCountdown } from "@/components/launch-countdown";
import { LiveTicker } from "@/components/live-ticker";
import { PresaleActions } from "@/components/presale-actions";
import { dbQuery, hasDatabaseUrl } from "@/lib/db";
import { type LaunchedTokenView, type LaunchCardView, type LaunchStatus } from "@/lib/launch-feed";
import { getSolUsdtPrice } from "@/lib/sol-price";

type PresalePageProps = {
  params: Promise<{ id: string }>;
};

export const dynamic = "force-dynamic";

export default async function PresalePage({ params }: PresalePageProps) {
  const { id } = await params;
  const dbFeed = await findPresaleInDb(id);
  const launch = dbFeed.launch;
  const token = dbFeed.token;

  if (!launch && !token) {
    notFound();
  }

  const name = launch?.name ?? token!.name;
  const symbol = launch?.symbol ?? token!.symbol;
  const status = launch?.status ?? "COMPLETED";
  const rawStatus = launch?.rawStatus ?? status;
  const committed = launch?.committedLabel ?? token!.raisedLabel.replace(" raised", "");
  const target = launch?.goalLabel ?? "Settled";
  const progress = launch?.progressPercent ?? 100;
  const description = launch?.description ?? `${token!.name} completed its Stick raise and launched through ${token!.liquidityLabel}.`;
  const progressWidth = Math.min(Math.max(progress, 0), 100);
  const progressState = status === "REFUNDED" ? "refunded" : status === "COMPLETED" ? "completed" : progress >= 100 ? "funded" : "active";
  const bannerUrl = launch?.bannerUrl ?? token?.bannerUrl;
  const avatarUrl = launch?.avatarUrl ?? token?.avatarUrl;
  const presaleAddress = launch?.presaleAddress ?? token!.presaleAddress;
  const committedLamports = dbFeed.committedLamports ?? dbFeed.raisedLamports ?? "0";
  const targetLamports = dbFeed.targetLamports ?? dbFeed.raisedLamports ?? "0";
  const devbuyLabel = dbFeed.devbuyLamports ? `${formatSol(solFromLamports(dbFeed.devbuyLamports))} SOL` : "Public";
  const maxWalletLabel = launch && (launch.maxWalletSupplyBps ?? 0) > 0 ? `${formatBpsPercent(launch.maxWalletSupplyBps ?? 0)} supply` : "Off";
  const oversubRatio = Number(targetLamports) > 0 ? Number(committedLamports) / Number(targetLamports) : 0;
  const nextStepCopy = getNextStepCopy(status, rawStatus, progress, oversubRatio);
  const launchedMint = token?.mint ?? (status === "COMPLETED" && rawStatus === "COMPLETED" ? dbFeed.mintAddress : undefined);
  const projectLinks = buildProjectLinks(dbFeed.links);

  return (
    <main className="futardLanding">
      <FutardHeader />
      <LiveTicker />
      <LaunchAutoRefresh endsAt={launch?.endsAt} rawStatus={rawStatus} />

      <section className="launchDetailShell">
        <div className="launchDetailGrid">
          <div className="launchDetailMain">
            <div className="launchBanner" style={imageBackground(bannerUrl)}>
              {!bannerUrl && <span>{symbol}</span>}
            </div>

            <div className="launchIdentityRow">
              <div className="launchDetailAvatar" style={imageBackground(avatarUrl)}>
                {!avatarUrl && symbol.slice(0, 2)}
              </div>
              <div className="launchTitleBlock">
                <div className="launchTitleLine">
                  <h1>{name}</h1>
                  <span className={`launchStatus status${status}`}>{status}</span>
                  {launch?.endsAt && <LaunchCountdown endsAt={launch.endsAt} status={status} />}
                  <span className="launchSymbol">${symbol}</span>
                </div>
                <p>{description}</p>
              </div>
            </div>

            <div className="launchLinksRow">
              {projectLinks.map((link) => (
                <LinkItem key={link.label} href={link.href} label={link.label} />
              ))}
              <Link href="/">All launches</Link>
            </div>

            <div className="launchInlineStats">
              <span>Route Pump.fun + PumpSwap</span>
              <span>{launch?.fdvLabel ?? token?.marketCapLabel ?? "FDV pending"}</span>
              <span>Supply 1B</span>
              {launch && (launch.maxWalletSupplyBps ?? 0) > 0 && <span>Max wallet {formatBpsPercent(launch.maxWalletSupplyBps ?? 0)} supply</span>}
              <span>{launch?.contributorsLabel ?? "settled"} funders</span>
            </div>

            <div className={`launchRaiseBlock launchRaise-${progressState}`}>
              <div className="launchRaiseTop">
                <span><strong>{committed}</strong> committed</span>
                <span><strong>{progress}%</strong></span>
              </div>
              <div className="launchDetailProgressTrack">
                <span className="launchDetailTick" style={{ left: "25%" }} />
                <span className="launchDetailTick" style={{ left: "50%" }} />
                <span className="launchDetailTick" style={{ left: "75%" }} />
                <div style={{ width: `${progressWidth}%` }} />
              </div>
            </div>

            <div className="launchStateNotice">
              <strong>{nextStepCopy.title}</strong>
              <span>{nextStepCopy.body}</span>
            </div>

            <article className="launchAbout">
              <h2>About</h2>
              <div className="launchMarkdown">
                <p>{description}</p>
              </div>
            </article>
          </div>

          <aside className="launchFundingPanel">
            <div className="fundingPanelTitle">
              <span>Fund this Launch</span>
              <strong>${symbol}</strong>
            </div>
            <div className="launchPanelDetails">
              <div className="launchDetailsHeader">
                <h2>Details</h2>
                {launch?.endsAt && <LaunchCountdown endsAt={launch.endsAt} status={status} />}
              </div>
              <div className="launchDetailsStats compact">
                <div><span>Implied FDV</span><strong>{launch?.fdvLabel?.replace(" FDV", "") ?? token?.marketCapLabel ?? "Pending"}</strong></div>
                <div><span>Raise Goal</span><strong>{target}</strong></div>
              </div>
            </div>
            <div className="fundingRows">
              <div><span>Committed</span><strong>{committed}</strong></div>
              <div><span>Funders</span><strong>{launch?.contributorsLabel ?? "settled"}</strong></div>
              <div><span>Raise target</span><strong>{target}</strong></div>
              <div><span>Progress</span><strong>{progress}%</strong></div>
              <div><span>Max wallet</span><strong>{maxWalletLabel}</strong></div>
              <div><span>Creator buy-in</span><strong>{devbuyLabel}</strong></div>
            </div>
            <PresaleActions
              presaleAddress={presaleAddress}
              symbol={symbol}
              status={status}
              rawStatus={rawStatus}
              startsAt={launch?.startsAt}
              endsAt={launch?.endsAt}
              committedLamports={committedLamports}
              targetLamports={targetLamports}
              dexScreenerUrl={launch ? undefined : token?.dexScreenerUrl}
            />
            {launchedMint && (
              <div className="launchMintBlock">
                <span>Token mint</span>
                <CopyMintButton className="mintCopy launchMintCopy" mint={launchedMint} />
              </div>
            )}
          </aside>
        </div>

        {token && (
          <div className="launchContentGrid">
            <aside className="launchDetailsPanel">
              <div className="launchBreakdown tokenOnly">
                <span>Token</span>
                <CopyMintButton className="mintCopy large" mint={token.mint} />
                <a href={token.dexScreenerUrl} target="_blank" rel="noreferrer">
                  Open DexScreener <ExternalLink size={14} />
                </a>
              </div>
            </aside>
          </div>
        )}
      </section>
    </main>
  );
}

type LaunchRow = {
  presale_address: string;
  slug: string | null;
  creator: string;
  name: string;
  symbol: string;
  status: LaunchStatus;
  description: string;
  avatar_url: string | null;
  banner_url: string | null;
  website_url: string | null;
  x_url: string | null;
  telegram_url: string | null;
  discord_url: string | null;
  docs_url: string | null;
  target_lamports: string;
  committed_lamports: string;
  contributors_count: number;
  max_wallet_supply_bps: number | null;
  fdv_usd: string | null;
  mint_address: string | null;
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
};

async function findPresaleInDb(id: string): Promise<{
  launch?: LaunchCardView;
  token?: LaunchedTokenView;
  committedLamports?: string;
  targetLamports?: string;
  raisedLamports?: string;
  devbuyLamports?: string;
  mintAddress?: string;
  links?: ProjectLinks;
}> {
  if (!hasDatabaseUrl()) return {};

  try {
    const [launchResult, tokenResult, solUsdPrice] = await Promise.all([
      dbQuery<LaunchRow>(
        `
          select
            presale_address,
            slug,
            creator,
            name,
            symbol,
            status,
            description,
            avatar_url,
            banner_url,
            website_url,
            x_url,
            telegram_url,
            discord_url,
            docs_url,
            target_lamports::text,
            committed_lamports::text,
            contributors_count,
            coalesce(max_wallet_supply_bps, 0) as max_wallet_supply_bps,
            fdv_usd::text,
            mint_address,
            start_at,
            end_at
          from launches
          where (presale_address = $1 or slug = $1)
            and coalesce(creator, '') <> ''
          limit 1
        `,
        [id]
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
            banner_url
          from launched_tokens
          where (presale_address = $1 or mint = $1)
            and presale_address in (
              select presale_address from launches where coalesce(creator, '') <> ''
            )
          limit 1
        `,
        [id]
      ),
      getSolUsdtPrice()
    ]);
    const launchRow = launchResult.rows[0];
    const devbuyResult = launchRow ? await dbQuery<{ committed_lamports: string }>(
      `
        select committed_lamports::text
        from contributors
        where presale_address = $1 and owner = $2
        limit 1
      `,
      [launchRow.presale_address, launchRow.creator]
    ).catch(() => ({ rows: [] })) : { rows: [] };

    return {
      launch: launchRow ? formatDbLaunch(launchRow, solUsdPrice) : undefined,
      token: tokenResult.rows[0] ? formatDbToken(tokenResult.rows[0], solUsdPrice) : undefined,
      committedLamports: launchRow?.committed_lamports,
      targetLamports: launchRow?.target_lamports,
      raisedLamports: tokenResult.rows[0]?.raised_lamports,
      devbuyLamports: devbuyResult.rows[0]?.committed_lamports,
      mintAddress: tokenResult.rows[0]?.mint ?? launchRow?.mint_address ?? undefined,
      links: launchRow ? {
        website: launchRow.website_url ?? undefined,
        x: launchRow.x_url ?? undefined,
        telegram: launchRow.telegram_url ?? undefined,
        discord: launchRow.discord_url ?? undefined,
        docs: launchRow.docs_url ?? undefined
      } : undefined
    };
  } catch {
    return {};
  }
}

type ProjectLinks = {
  website?: string;
  x?: string;
  telegram?: string;
  discord?: string;
  docs?: string;
};

function LinkItem({ href, label }: { href: string; label: string }) {
  return (
    <>
      <a href={href} target="_blank" rel="noreferrer">{label}</a>
      <span>·</span>
    </>
  );
}

function buildProjectLinks(links: ProjectLinks | undefined) {
  return [
    links?.website ? { label: "Website", href: links.website } : null,
    links?.x ? { label: "X", href: links.x } : null,
    links?.telegram ? { label: "Telegram", href: links.telegram } : null,
    links?.discord ? { label: "Discord", href: links.discord } : null,
    links?.docs ? { label: "Docs", href: links.docs } : null
  ].filter((link): link is { label: string; href: string } => Boolean(link));
}

function formatDbLaunch(row: LaunchRow, solUsdPrice: number): LaunchCardView {
  const committedSol = solFromLamports(row.committed_lamports);
  const targetSol = solFromLamports(row.target_lamports);
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
    progressPercent: targetSol > 0 ? Math.round((committedSol / targetSol) * 100) : 0,
    contributorsLabel: row.contributors_count.toLocaleString("en-US"),
    maxWalletSupplyBps: row.max_wallet_supply_bps ?? 0,
    fdvLabel: `${formatUsd(row.fdv_usd ? Number(row.fdv_usd) : estimateMarketCapUsd(row.target_lamports, solUsdPrice))} FDV`,
    avatarUrl: row.avatar_url ?? undefined,
    bannerUrl: row.banner_url ?? undefined,
    startsAt: toIso(row.start_at),
    endsAt: row.end_at ? toIso(row.end_at) : undefined
  };
}

function imageBackground(url: string | undefined) {
  return url ? { backgroundImage: `url("${url}")` } : undefined;
}

function formatBpsPercent(bps: number) {
  const value = bps / 100;
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(2)}%`;
}

function effectiveStatus(row: LaunchRow, committedSol: number, targetSol: number): LaunchStatus {
  if (row.status !== "LIVE" || !row.end_at) return row.status;
  const endMs = new Date(row.end_at).getTime();
  if (!Number.isFinite(endMs) || endMs > Date.now()) return row.status;
  return committedSol < targetSol ? "REFUNDED" : "COMPLETED";
}

function formatDbToken(row: TokenRow, solUsdPrice: number): LaunchedTokenView {
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
  return Number(value) / 1_000_000_000;
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

function getNextStepCopy(status: LaunchStatus, rawStatus: LaunchStatus, progress: number, oversubRatio: number) {
  if (status === "COMPLETED" && rawStatus === "LIVE") {
    return {
      title: "Raise ended",
      body: "The target was reached. Settlement opens after token routing is finalized."
    };
  }

  if (status === "LIVE") {
    if (progress >= 100) {
      return {
        title: "Target reached",
        body: `The raise stays open until the timer ends. Current demand is ${oversubRatio.toFixed(2)}x target; unused SOL is returned at claim.`
      };
    }
    return {
      title: "Raise live",
      body: "Commitments are open until the timer ends. If the target is missed, contributors can claim a refund."
    };
  }

  if (status === "REFUNDED") {
    return {
      title: "Refund mode",
      body: "The target was not reached. Contributors can claim their committed SOL back from the presale vault."
    };
  }

  return {
    title: "Settlement complete",
    body: "Tokens were bought through the launch route. Contributors can claim tokens and any unused SOL in one transaction."
  };
}
