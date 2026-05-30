import { NextResponse } from "next/server";
import type { SettlementManifest } from "@fair/shared";
import { dbQuery, hasDatabaseUrl } from "@/lib/db";
import { readOnchainContributorState } from "@/lib/onchain-contributor";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const presale = url.searchParams.get("presale");
  const owner = url.searchParams.get("owner");
  const baseUrl = process.env.SETTLEMENT_MANIFEST_BASE_URL;

  if (!presale || !owner) {
    return NextResponse.json({ error: "presale and owner are required" }, { status: 400 });
  }

  if (hasDatabaseUrl()) {
    const [result, claimedResult, onchainContributor] = await Promise.all([
      dbQuery<{ manifest_json: SettlementManifest }>(
      "select manifest_json from settlement_manifests where presale_address = $1 limit 1",
      [presale]
      ).catch(() => ({ rows: [] })),
      dbQuery<{ claimed_at: Date | string | null }>(
        "select claimed_at from contributors where presale_address = $1 and owner = $2 limit 1",
        [presale, owner]
      ).catch(() => ({ rows: [] })),
      readOnchainContributorState(presale, owner).catch(() => null)
    ]);
    const manifest = result.rows[0]?.manifest_json;
    const claimed = Boolean(claimedResult.rows[0]?.claimed_at) || Boolean(onchainContributor?.settlementClaimed);
    if (manifest) {
      return manifestEntryResponse(manifest, owner, claimed);
    }
  }

  if (!baseUrl) {
    return NextResponse.json({ error: "settlement manifest source is not configured" }, { status: 404 });
  }

  const manifestUrl = new URL(`${presale}.json`, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) {
    return NextResponse.json({ error: "settlement manifest not found" }, { status: 404 });
  }

  const manifest = await response.json() as SettlementManifest;
  const onchainContributor = await readOnchainContributorState(presale, owner).catch(() => null);
  return manifestEntryResponse(manifest, owner, Boolean(onchainContributor?.settlementClaimed));
}

function manifestEntryResponse(manifest: SettlementManifest, owner: string, claimed: boolean) {
  const entry = manifest.entries.find((item) => item.owner === owner);
  if (!entry) {
    return NextResponse.json({ error: "owner is not in settlement manifest" }, { status: 404 });
  }

  return NextResponse.json({
    presale: manifest.presale,
    merkleRoot: manifest.merkleRoot,
    grossAccepted: entry.grossAccepted,
    refund: entry.refund,
    proof: entry.proof,
    claimed
  });
}
