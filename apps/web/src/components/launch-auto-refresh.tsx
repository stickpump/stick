"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { LaunchStatus } from "@/lib/launch-feed";

const LIVE_REFRESH_MS = 3_000;
const SETTLEMENT_REFRESH_MS = 10_000;

type LaunchAutoRefreshProps = {
  endsAt?: string;
  rawStatus: LaunchStatus;
};

export function LaunchAutoRefresh({ endsAt, rawStatus }: LaunchAutoRefreshProps) {
  const router = useRouter();

  useEffect(() => {
    if (rawStatus !== "LIVE") return;

    const interval = window.setInterval(() => router.refresh(), LIVE_REFRESH_MS);
    let settlementInterval: number | undefined;
    let timeout: number | undefined;

    if (endsAt) {
      const endMs = new Date(endsAt).getTime();
      if (Number.isFinite(endMs)) {
        const timeoutDelay = Math.max(0, endMs - Date.now() + 1_500);
        timeout = window.setTimeout(() => {
          router.refresh();
          settlementInterval = window.setInterval(() => router.refresh(), SETTLEMENT_REFRESH_MS);
        }, timeoutDelay);
      }
    }

    return () => {
      window.clearInterval(interval);
      if (timeout) window.clearTimeout(timeout);
      if (settlementInterval) window.clearInterval(settlementInterval);
    };
  }, [endsAt, rawStatus, router]);

  return null;
}
