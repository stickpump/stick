import { NextResponse } from "next/server";
import { dbQuery, hasDatabaseUrl } from "@/lib/db";
import type { LaunchStatus } from "@/lib/launch-feed";

export const runtime = "nodejs";

type StatusBody = {
  presaleAddress?: string;
  status?: LaunchStatus;
  signature?: string;
  symbol?: string;
};

const allowed = new Set<LaunchStatus>(["LIVE", "COMPLETED", "REFUNDED"]);

export async function POST(request: Request) {
  if (!hasDatabaseUrl()) {
    return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 500 });
  }

  const body = await request.json() as StatusBody;
  if (!body.presaleAddress || !body.status || !allowed.has(body.status)) {
    return NextResponse.json({ error: "presaleAddress and valid status are required." }, { status: 400 });
  }

  await dbQuery(
    "update launches set status = $2, updated_at = now() where presale_address = $1",
    [body.presaleAddress, body.status]
  );

  const eventType = body.status === "REFUNDED" ? "refund" : body.status === "COMPLETED" ? "settlement_ready" : "presale_opened";
  await dbQuery(
    `
      insert into activity_events(type, presale_address, symbol, message, signature)
      values ($1, $2, $3, coalesce($3, 'RAISE') || ' status ' || $4, $5)
      on conflict do nothing
    `,
    [eventType, body.presaleAddress, body.symbol ?? null, body.status.toLowerCase(), body.signature ?? null]
  );

  return NextResponse.json({ ok: true });
}
