"use client";

import { useEffect, useState } from "react";

type TickerResponse = {
  items?: string[];
  refreshMs?: number;
};

export function LiveTicker() {
  const [items, setItems] = useState<string[]>([]);

  useEffect(() => {
    let isMounted = true;
    let timeout: number | undefined;

    async function loadTicker() {
      let nextDelay = 10_000;

      try {
        const response = await fetch("/api/feed/ticker?limit=30", { cache: "no-store" });
        const json = await response.json() as TickerResponse;

        if (typeof json.refreshMs === "number" && json.refreshMs >= 5_000) {
          nextDelay = json.refreshMs;
        }

        if (isMounted && Array.isArray(json.items)) {
          setItems((current) => {
            const next = json.items!.filter(Boolean);
            return areItemsEqual(current, next) ? current : next;
          });
        }
      } catch {
        // Keep the last known feed; ticker should keep moving if the backend misses a poll.
      } finally {
        if (isMounted) {
          timeout = window.setTimeout(loadTicker, nextDelay);
        }
      }
    }

    void loadTicker();

    return () => {
      isMounted = false;
      if (timeout) {
        window.clearTimeout(timeout);
      }
    };
  }, []);

  if (items.length === 0) {
    return <section className="futardTicker is-empty" aria-label="Live activity" />;
  }

  const displayItems = normalizeTickerItems(items);

  return (
    <section className="futardTicker" aria-label="Live activity">
      <div className="tickerRail">
        <TickerGroup items={displayItems} />
        <TickerGroup items={displayItems} ariaHidden />
      </div>
    </section>
  );
}

function TickerGroup({ items, ariaHidden = false }: { items: string[]; ariaHidden?: boolean }) {
  return (
    <div className="tickerGroup" aria-hidden={ariaHidden}>
      {items.map((item, index) => (
        <span key={`${item}-${index}`}>{item}</span>
      ))}
    </div>
  );
}

function normalizeTickerItems(items: string[]) {
  const normalized = items.filter(Boolean);
  if (normalized.length === 0) return [];

  const repeated = [...normalized];
  while (repeated.length < 12) {
    repeated.push(...normalized);
  }
  return repeated.slice(0, Math.max(12, normalized.length));
}

function areItemsEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
