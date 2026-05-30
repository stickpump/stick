import { NextResponse } from "next/server";
import { getSolUsdtCache, getSolUsdtPrice } from "@/lib/sol-price";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REFRESH_MS = 60_000;

export async function GET() {
  const price = await getSolUsdtPrice();
  const cache = getSolUsdtCache();

  if (cache.price === null) {
    return NextResponse.json(
      {
        error: cache.error ?? "SOLUSDT price is not available yet.",
        symbol: "SOLUSDT",
        source: "binance"
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    symbol: "SOLUSDT",
    price,
    updatedAt: cache.updatedAt,
    source: "binance",
    refreshMs: REFRESH_MS
  });
}
