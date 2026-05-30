import { NextResponse } from "next/server";
import { dbQuery, hasDatabaseUrl } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REFRESH_MS = 10_000;
const DEFAULT_LIMIT = 30;

type ActivityEventRow = {
  id: string;
  type: string;
  presale_address: string | null;
  actor: string | null;
  amount_lamports: string | null;
  symbol: string | null;
  message: string;
  signature: string | null;
  slot: string | null;
  created_at: Date | string;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = clampLimit(url.searchParams.get("limit"));

  if (!hasDatabaseUrl()) {
    return emptyResponse("DATABASE_URL is not configured.");
  }

  try {
    const result = await dbQuery<ActivityEventRow>(
      `
        select *
        from (
          select distinct on (message)
            id::text,
            type,
            presale_address,
            actor,
            amount_lamports::text,
            symbol,
            message,
            signature,
            slot::text,
            created_at
          from activity_events
          order by message, created_at desc
        ) deduped
        order by created_at desc
        limit $1
      `,
      [limit]
    );

    if (result.rows.length === 0) {
      return emptyResponse(undefined, "postgres-empty");
    }

    return NextResponse.json({
      source: "postgres",
      refreshMs: REFRESH_MS,
      items: result.rows.map((row) => row.message),
      events: result.rows.map((row) => ({
        ...row,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
      }))
    });
  } catch (error) {
    return emptyResponse(error instanceof Error ? error.message : "Failed to read activity feed.");
  }
}

function clampLimit(raw: string | null) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

function emptyResponse(error?: string, source = "empty") {
  return NextResponse.json({
    source,
    refreshMs: REFRESH_MS,
    items: [],
    events: [],
    error
  });
}
