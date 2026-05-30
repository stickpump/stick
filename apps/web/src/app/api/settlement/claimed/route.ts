import { NextResponse } from "next/server";
import { dbQuery, hasDatabaseUrl } from "@/lib/db";

export const runtime = "nodejs";

type ClaimedBody = {
  presaleAddress?: string;
  owner?: string;
  symbol?: string;
  signature?: string;
  claimType?: "refund" | "claim";
};

export async function POST(request: Request) {
  if (!hasDatabaseUrl()) {
    return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 500 });
  }

  const body = await request.json() as ClaimedBody;
  if (!body.presaleAddress || !body.owner) {
    return NextResponse.json({ error: "presaleAddress and owner are required." }, { status: 400 });
  }

  const result = await dbQuery(
    `
      update contributors
      set claimed_at = coalesce(claimed_at, now()), updated_at = now()
      where presale_address = $1 and owner = $2
    `,
    [body.presaleAddress, body.owner]
  );

  if (result.rowCount === 0) {
    return NextResponse.json({ error: "contributor not found." }, { status: 404 });
  }

  const type = body.claimType === "refund" ? "refund" : "claim";
  await dbQuery(
    `
      insert into activity_events(type, presale_address, actor, symbol, message, signature)
      values ($1, $2, $3, $4, coalesce($4, 'RAISE') || ' claimed', $5)
      on conflict do nothing
    `,
    [type, body.presaleAddress, body.owner, body.symbol ?? null, body.signature ?? null]
  );

  return NextResponse.json({ ok: true });
}
