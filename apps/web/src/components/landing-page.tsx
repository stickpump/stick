"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { Check, Clock3, Copy, Users } from "lucide-react";
import { FutardHeader } from "@/components/futard-header";
import { LiveTicker } from "@/components/live-ticker";
import {
  platformStats as defaultPlatformStats,
  type LaunchedTokenView,
  type LaunchCardView
} from "@/lib/launch-feed";

const modeTabs = ["Hot", "Most Committed"] as const;
const statusTabs = ["All", "Live", "Completed", "Refunded"] as const;
const LIVE_FEED_REFRESH_MS = 3_000;
const IDLE_FEED_REFRESH_MS = 12_000;

type ModeTab = (typeof modeTabs)[number];
type StatusTab = (typeof statusTabs)[number];
type PlatformStatsView = typeof defaultPlatformStats;

type LaunchFeedResponse = {
  launches?: LaunchCardView[];
  launchedTokens?: LaunchedTokenView[];
  platformStats?: PlatformStatsView;
};

function initials(symbol: string) {
  return symbol.slice(0, 2).toUpperCase() || "--";
}

function statusClass(status: LaunchCardView["status"]) {
  return `launchStatus status${status}`;
}

function parseCompactUsd(label?: string) {
  if (!label) return 0;
  const normalized = label.replace(/[$,\s]/g, "").toUpperCase();
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return 0;
  if (normalized.endsWith("M")) return value * 1_000_000;
  if (normalized.endsWith("K")) return value * 1_000;
  return value;
}

function parseSolAmount(label: string) {
  const value = Number.parseFloat(label.replace(/[^\d.]/g, ""));
  return Number.isFinite(value) ? value : 0;
}

function parseCount(label: string) {
  const value = Number.parseInt(label.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(value) ? value : 0;
}

function formatCompactUsd(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function presaleHref(presaleAddress: string) {
  return `/presale/${presaleAddress}`;
}

function imageBackground(url: string | undefined) {
  return url ? { backgroundImage: `url("${url}")` } : undefined;
}

function formatTimeLeft(endsAt: string | undefined, now: number, status: LaunchCardView["status"]) {
  if (!endsAt || status !== "LIVE") return "";
  const remainingMs = new Date(endsAt).getTime() - now;
  if (!Number.isFinite(remainingMs)) return "";
  if (remainingMs <= 0) return "";

  const totalSeconds = Math.ceil(remainingMs / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d left`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m left` : `${hours}h left`;
  if (minutes > 0) return `${minutes}m ${seconds}s left`;
  return `${seconds}s left`;
}

function effectiveCardStatus(launch: LaunchCardView, now: number): LaunchCardView["status"] {
  if (launch.status !== "LIVE" || !launch.endsAt) return launch.status;
  const endMs = new Date(launch.endsAt).getTime();
  if (!Number.isFinite(endMs) || endMs > now) return launch.status;
  return parseSolAmount(launch.committedLabel) < parseSolAmount(launch.goalLabel) ? "REFUNDED" : "COMPLETED";
}

function LaunchCard({ launch, now }: { launch: LaunchCardView; now: number }) {
  const router = useRouter();
  const displayStatus = effectiveCardStatus(launch, now);
  const isLive = displayStatus === "LIVE";
  const href = presaleHref(launch.presaleAddress);
  const timeLeft = formatTimeLeft(launch.endsAt, now, displayStatus);
  const progressPercent = Math.min(Math.max(launch.progressPercent, 0), 100);
  const progressBadgeLeft = progressPercent <= 0 ? 0 : Math.min(Math.max(progressPercent, 2), 100);
  const progressState = displayStatus === "COMPLETED"
    ? "completed"
    : displayStatus === "REFUNDED"
      ? "refunded"
      : launch.progressPercent >= 100
      ? "funded"
      : "active";
  const cardState = displayStatus.toLowerCase();
  const buttonClass = displayStatus === "REFUNDED"
    ? "fundButton refunding"
    : isLive
      ? "fundButton live"
      : "fundButton";
  const buttonLabel = displayStatus === "REFUNDED" ? "Claim refund" : isLive ? "Fund this project" : "View project";

  return (
    <article
      className={`launchCard is-${cardState}`}
      onClick={() => router.push(href)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          router.push(href);
        }
      }}
      role="link"
      tabIndex={0}
    >
      <div className="cardTopLine">
        <div className="launchAvatar" style={imageBackground(launch.avatarUrl)}>
          {!launch.avatarUrl && initials(launch.symbol)}
        </div>
        <span className={statusClass(displayStatus)}>{displayStatus}</span>
        <span className="miniMetric"><Users size={12} />{launch.contributorsLabel}</span>
        {launch.fdvLabel && <span className="miniMetric fdvMetric">{launch.fdvLabel}</span>}
      </div>

      <div className="launchTitleRow">
        <h2>{launch.name}</h2>
        {timeLeft && (
          <span className="cardTimePill">
            <Clock3 size={13} />
            {timeLeft}
          </span>
        )}
      </div>
      <p>{launch.description}</p>

      <div className={`progressShell progress-${progressState}`}>
        <div className="progressTrackWrap">
          <div className="progressTrack">
            <span className="progressTick" style={{ left: "25%" }} />
            <span className="progressTick" style={{ left: "50%" }} />
            <span className="progressTick" style={{ left: "75%" }} />
            <div style={{ width: `${progressPercent}%` }} />
          </div>
          <span className={progressPercent === 0 ? "progressBadge at-start" : "progressBadge"} style={{ left: `${progressBadgeLeft}%` }}>
            {launch.progressPercent}%
          </span>
        </div>
        <div className="amountLine">
          <span><strong>{launch.committedLabel}</strong> committed</span>
          <span><strong>{launch.goalLabel}</strong> raise target</span>
        </div>
      </div>

      <Link className={buttonClass} href={href} onClick={(event) => event.stopPropagation()}>
        {buttonLabel}
      </Link>
    </article>
  );
}

function LaunchCardSkeleton() {
  return (
    <article className="launchCard skeletonCard" aria-hidden="true">
      <div className="cardTopLine">
        <span className="skeletonBlock launchAvatar" />
        <span className="skeletonBlock skeletonPill" />
        <span className="skeletonBlock skeletonPill small" />
        <span className="skeletonBlock skeletonPill fdvMetric" />
      </div>
      <div className="skeletonStack">
        <span className="skeletonBlock skeletonTitle" />
        <span className="skeletonBlock skeletonLine wide" />
        <span className="skeletonBlock skeletonLine medium" />
      </div>
      <div className="progressShell">
        <div className="skeletonBlock skeletonProgress" />
        <div className="amountLine">
          <span className="skeletonBlock skeletonAmount" />
          <span className="skeletonBlock skeletonAmount" />
        </div>
      </div>
      <span className="skeletonBlock skeletonButton" />
    </article>
  );
}

export function TokenCard({ token }: { token: LaunchedTokenView }) {
  const [copied, setCopied] = useState(false);
  const baseCap = useMemo(() => parseCompactUsd(token.marketCapLabel), [token.marketCapLabel]);
  const [marketCap, setMarketCap] = useState(baseCap);

  useEffect(() => {
    if (!baseCap) return;
    const update = () => {
      const seed = token.id.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
      const wave = Math.sin(Date.now() / 9000 + seed) * 0.018;
      setMarketCap(Math.max(1, baseCap * (1 + wave)));
    };
    update();
    const timer = window.setInterval(update, 5000);
    return () => window.clearInterval(timer);
  }, [baseCap, token.id]);

  const copyMint = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    await navigator.clipboard.writeText(token.mint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <article
      className="tokenCard"
      onClick={() => window.open(token.dexScreenerUrl, "_blank", "noopener,noreferrer")}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          window.open(token.dexScreenerUrl, "_blank", "noopener,noreferrer");
        }
      }}
      role="link"
      tabIndex={0}
    >
      <div className="tokenAvatar" style={imageBackground(token.avatarUrl)}>
        {!token.avatarUrl && initials(token.symbol)}
      </div>
      <div className="tokenIdentity">
        <strong>{token.name}</strong>
        <span>${token.symbol}</span>
      </div>
      <div className="tokenCardStats">
        <span>{marketCap ? `${formatCompactUsd(marketCap)} MC` : "MC pending"}</span>
        <span>{token.raisedLabel}</span>
      </div>
      <button className="mintCopy" type="button" onClick={copyMint}>
        <span>{token.mint.slice(0, 4)}...{token.mint.slice(-5)}</span>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <Link
        className="tokenInfoButton"
        href={presaleHref(token.presaleAddress)}
        onClick={(event) => event.stopPropagation()}
      >
        View project
      </Link>
    </article>
  );
}

export function TokenCardSkeleton() {
  return (
    <article className="tokenCard skeletonCard" aria-hidden="true">
      <span className="skeletonBlock tokenAvatar" />
      <div className="skeletonStack compact">
        <span className="skeletonBlock skeletonLine medium" />
        <span className="skeletonBlock skeletonLine short" />
      </div>
      <div className="tokenCardStats">
        <span className="skeletonBlock skeletonStat" />
        <span className="skeletonBlock skeletonStat" />
      </div>
      <span className="skeletonBlock skeletonButton small" />
      <span className="skeletonBlock skeletonButton small" />
    </article>
  );
}

function StickFooter({ stats, launchCount }: { stats: PlatformStatsView; launchCount: number }) {
  return (
    <footer className="stickFooter">
      <div className="colorCycleBar" />
      <div className="stickFooterInner">
        <div className="stickFooterGrid">
          <div>
            <h4 className="footerTitle blue">Product</h4>
            <ul>
              <li><Link href="/">Raises</Link></li>
              <li><Link href="/create">Create Launch</Link></li>
              <li><Link href="/tokens">Launched</Link></li>
              <li><Link href="/how-it-works">How it works</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="footerTitle lavender">Resources</h4>
            <ul>
              <li><Link href="/how-it-works">Documentation</Link></li>
              <li><a href="https://github.com/stickonpump" target="_blank" rel="noreferrer">GitHub</a></li>
            </ul>
          </div>

          <div>
            <h4 className="footerTitle coral">Community</h4>
            <ul>
              <li><a href="https://x.com/i/communities/2034682633137889666" target="_blank" rel="noreferrer">X / Twitter</a></li>
            </ul>
          </div>

          <div>
            <h4 className="footerTitle yellow">Platform</h4>
            <ul>
              <li><span>{launchCount}</span> Total Launches</li>
              <li><span>{stats.committedLabel}</span> Total Committed</li>
              <li><span>{stats.fundersLabel}</span> Funders</li>
            </ul>
          </div>
        </div>

        <div className="stickFooterBottom">
          <div className="footerBrandLine">
            <Link href="/" className="futardLogo" aria-label="Stick home">
              <img className="futardLogoMark" src="/logo.png" alt="" />
              <span>STICK</span>
            </Link>
          </div>

          <div className="footerBottomLinks">
            <a href="https://x.com/i/communities/2034682633137889666" target="_blank" rel="noreferrer" aria-label="X / Twitter">
              <svg fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
            </a>
            <a href="https://github.com/stickonpump" target="_blank" rel="noreferrer" aria-label="GitHub">
              <svg fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" /></svg>
            </a>
            <span>© 2026 Stick</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

export function LandingPage() {
  const [modeTab, setModeTab] = useState<ModeTab>("Hot");
  const [statusTab, setStatusTab] = useState<StatusTab>("All");
  const [launchItems, setLaunchItems] = useState<LaunchCardView[]>([]);
  const [tokenItems, setTokenItems] = useState<LaunchedTokenView[]>([]);
  const [stats, setStats] = useState(defaultPlatformStats);
  const [now, setNow] = useState(() => Date.now());
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | undefined;

    async function loadLaunchFeed() {
      let nextRefreshMs = IDLE_FEED_REFRESH_MS;

      try {
        const response = await fetch("/api/feed/launches", { cache: "no-store" });
        const json = await response.json() as LaunchFeedResponse;
        const nextLaunches = Array.isArray(json.launches) ? json.launches : launchItems;
        nextRefreshMs = nextLaunches.some((launch) => effectiveCardStatus(launch, Date.now()) === "LIVE")
          ? LIVE_FEED_REFRESH_MS
          : IDLE_FEED_REFRESH_MS;

        if (!cancelled) {
          if (Array.isArray(json.launches)) {
            setLaunchItems(json.launches);
          }
          if (Array.isArray(json.launchedTokens)) {
            setTokenItems(json.launchedTokens);
          }
          if (json.platformStats) {
            setStats(json.platformStats);
          }
        }
      } catch {
        setStats(defaultPlatformStats);
      } finally {
        if (!cancelled) {
          setInitialLoading(false);
          timeout = window.setTimeout(loadLaunchFeed, nextRefreshMs);
        }
      }
    }

    void loadLaunchFeed();
    return () => {
      cancelled = true;
      if (timeout) window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const visibleLaunches = useMemo(() => {
    const filtered = launchItems.filter((launch) => {
      if (statusTab === "All") return true;
      return effectiveCardStatus(launch, now) === statusTab.toUpperCase();
    });

    return [...filtered].sort((a, b) => {
      if (modeTab === "Most Committed") {
        return parseSolAmount(b.committedLabel) - parseSolAmount(a.committedLabel);
      }

      const statusWeight = (launch: LaunchCardView) => {
        const status = effectiveCardStatus(launch, now);
        if (status === "LIVE") return 3;
        if (status === "COMPLETED") return 2;
        return 1;
      };

      return (
        statusWeight(b) - statusWeight(a)
        || b.progressPercent - a.progressPercent
        || parseCount(b.contributorsLabel) - parseCount(a.contributorsLabel)
      );
    });
  }, [launchItems, modeTab, now, statusTab]);

  return (
    <main className="futardLanding">
      <FutardHeader />

      <LiveTicker />

      <section className="futardWelcome" id="how">
        <div>
          <h1>Launch before the market opens</h1>
          <p>
            Run a timed Pump.fun presale with public creator buy-in, weighted allocation,
            and automatic refunds for unused SOL at claim.
          </p>
        </div>
        <Link href="/create" className="futardBlueButton">Launch Project</Link>
      </section>

      <section className="futardLaunched featured" id="launched">
        <div className="sectionBar">
          <div>
            <span>LAUNCHED</span>
            <strong>Graduated tokens</strong>
          </div>
          <Link href="/tokens">View all</Link>
        </div>

        {initialLoading && tokenItems.length === 0 ? (
          <div className="tokenGrid oneLine">
            {Array.from({ length: 4 }).map((_, index) => <TokenCardSkeleton key={index} />)}
          </div>
        ) : tokenItems.length > 0 ? (
          <div className="tokenGrid oneLine">
            {tokenItems.slice(0, 6).map((token) => <TokenCard token={token} key={token.id} />)}
          </div>
        ) : (
          <div className="futardEmptyState compact">
            <span>NO LAUNCHED TOKENS YET</span>
            <strong>Graduated launches will appear here once they settle on Pump.fun or PumpSwap.</strong>
          </div>
        )}
      </section>

      <section className="futardBoard">
        <div className="sectionBar">
          <div>
            <span>PRESALES</span>
            <strong>Presales</strong>
          </div>
        </div>
        <div className="futardControls">
          <div className="tabGroup">
            {modeTabs.map((tab) => (
              <button
                className={modeTab === tab ? "active" : ""}
                key={tab}
                onClick={() => setModeTab(tab)}
                type="button"
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="tabGroup right">
            {statusTabs.map((tab) => (
              <button
                className={statusTab === tab ? "active neutral" : ""}
                key={tab}
                onClick={() => setStatusTab(tab)}
                type="button"
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {initialLoading && launchItems.length === 0 ? (
          <div className="launchGrid">
            {Array.from({ length: 6 }).map((_, index) => <LaunchCardSkeleton key={index} />)}
          </div>
        ) : visibleLaunches.length > 0 ? (
          <div className="launchGrid">
            {visibleLaunches.map((launch) => <LaunchCard launch={launch} key={launch.id} now={now} />)}
          </div>
        ) : (
          <div className="futardEmptyState">
            <span>NO MATCHING PRESALES</span>
            <strong>{statusTab === "All" ? "There are no launches in this view." : `There are no ${statusTab.toLowerCase()} launches in this view.`}</strong>
          </div>
        )}
      </section>

      <StickFooter stats={stats} launchCount={launchItems.length} />
    </main>
  );
}
