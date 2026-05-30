import { NextResponse } from "next/server";
import { dbQuery, hasDatabaseUrl } from "@/lib/db";
import { readOnchainPresaleState } from "@/lib/onchain-presale";

export const runtime = "nodejs";

const REFUND_OPEN_BUFFER_SECONDS = 8;

type RefundRow = {
  committed_lamports: string;
  claimed_at: Date | string | null;
  status: string;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const presale = url.searchParams.get("presale");
  const owner = url.searchParams.get("owner");

  if (!presale || !owner) {
    return NextResponse.json({ error: "presale and owner are required" }, { status: 400 });
  }
  if (!hasDatabaseUrl()) {
    return NextResponse.json({ error: "DATABASE_URL is not configured" }, { status: 404 });
  }

  const result = await dbQuery<RefundRow>(
    `
      select c.committed_lamports::text, c.claimed_at, l.status
      from contributors c
      join launches l on l.presale_address = c.presale_address
      where c.presale_address = $1 and c.owner = $2
      limit 1
    `,
    [presale, owner]
  ).catch(() => ({ rows: [] }));

  const row = result.rows[0];
  if (!row || BigInt(row.committed_lamports) <= 0n) {
    return NextResponse.json({ error: "wallet has no refundable commitment" }, { status: 404 });
  }

  const onchain = await readOnchainPresaleState(presale).catch(() => null);
  const clusterUnixTs = onchain?.clusterUnixTs ?? null;
  const canCloseNow = onchain?.status === "Open" && clusterUnixTs !== null && clusterUnixTs >= onchain.endTs + REFUND_OPEN_BUFFER_SECONDS;
  const ready = onchain?.status === "RefundOnly" || canCloseNow;
  const secondsUntilReady = onchain?.status === "Open" && clusterUnixTs !== null
    ? Math.max(0, onchain.endTs + REFUND_OPEN_BUFFER_SECONDS - clusterUnixTs)
    : 0;

  return NextResponse.json({
    presale,
    owner,
    refund: row.committed_lamports,
    claimed: Boolean(row.claimed_at),
    status: row.status,
    onchainStatus: onchain?.status ?? null,
    ready,
    secondsUntilReady
  });
}
