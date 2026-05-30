"use client";

import { useEffect, useState } from "react";
import type { LaunchStatus } from "@/lib/launch-feed";

type LaunchCountdownProps = {
  endsAt?: string;
  status: LaunchStatus;
};

export function LaunchCountdown({ endsAt, status }: LaunchCountdownProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  if (!endsAt || status !== "LIVE") {
    return null;
  }

  const label = formatTimeLeft(new Date(endsAt).getTime() - now);
  if (!label) return null;

  return <span className="launchLiveClock is-live">{label}</span>;
}

function formatTimeLeft(remainingMs: number) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return "";
  }

  const totalSeconds = Math.ceil(remainingMs / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m ${seconds}s left`;
  return `${seconds}s left`;
}
