"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { WalletButton } from "@/components/wallet-button";
import { platformStats } from "@/lib/launch-feed";

type FutardHeaderProps = {
  searchPlaceholder?: string;
};

export function FutardHeader({ searchPlaceholder = "Search project / CA" }: FutardHeaderProps) {
  const [stats, setStats] = useState<typeof platformStats>(platformStats);

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      try {
        const response = await fetch("/api/feed/launches", { cache: "no-store" });
        const json = await response.json() as { platformStats?: typeof platformStats };
        if (!cancelled && response.ok && json.platformStats) {
          setStats(json.platformStats);
        }
      } catch {
        // Header stats are informative only; keep the last visible values.
      }
    }

    void loadStats();
    const interval = window.setInterval(() => void loadStats(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <header className="futardHeader">
      <div className="futardHeaderInner">
        <Link href="/" className="futardLogo" aria-label="Stick home">
          <img className="futardLogoMark" src="/logo.png" alt="" />
          <span>STICK</span>
        </Link>
        <div className="futardStats" aria-label="Platform stats">
          <span>COMMITTED <strong>{stats.committedLabel}</strong></span>
          <span>FUNDERS <strong>{stats.fundersLabel}</strong></span>
          <span>ACTIVE <strong className="dangerText">{stats.activeLabel}</strong></span>
          <span>LAUNCHED <strong>{stats.launchedLabel}</strong></span>
        </div>
        <label className="futardSearch">
          <Search size={16} />
          <input placeholder={searchPlaceholder} />
          <kbd>/</kbd>
        </label>
        <nav className="futardNav" aria-label="Main navigation">
          <Link href="/how-it-works">How it works</Link>
          <Link href="/create">Launch Project</Link>
          <WalletButton iconOnlyWhenDisconnected />
        </nav>
      </div>
    </header>
  );
}
