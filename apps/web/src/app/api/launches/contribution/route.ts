import { NextResponse } from "next/server";
import { dbQuery, hasDatabaseUrl } from "@/lib/db";
import { readOnchainContributorStateWithRetry } from "@/lib/onchain-contributor";

export const runtime = "nodejs";

type ContributionBody = {
  presaleAddress?: string;
  owner?: string;
  amountLamports?: string;
  weight?: string;
  symbol?: string;
  signature?: string;
};

export async function POST(request: Request) {
  if (!hasDatabaseUrl()) {
    return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 500 });
  }

  const body = await request.json() as ContributionBody;
  if (!body.presaleAddress || !body.owner || !body.amountLamports) {
    return NextResponse.json({ error: "presaleAddress, owner and amountLamports are required." }, { status: 400 });
  }
  if (!Number.isFinite(Number(body.amountLamports)) || Number(body.amountLamports) <= 0) {
    return NextResponse.json({ error: "Invalid amount." }, { status: 400 });
  }

  const onchainContributor = await readOnchainContributorStateWithRetry(body.presaleAddress, body.owner);
  if (!onchainContributor) {
    return NextResponse.json({ error: "Contribution is not confirmed on-chain yet. Retry shortly." }, { status: 409 });
  }

  await dbQuery(
    `
      insert into contributors(presale_address, owner, committed_lamports, weight)
      values ($1, $2, $3, $4)
      on conflict (presale_address, owner) do update set
        committed_lamports = excluded.committed_lamports,
        weight = excluded.weight,
        updated_at = now()
    `,
    [body.presaleAddress, body.owner, onchainContributor.acceptedAmount, onchainContributor.contributionWeight]
  );

  await dbQuery(
    `
      update launches
      set
        committed_lamports = (
          select coalesce(sum(committed_lamports), 0)::numeric from contributors where presale_address = $1
        ),
        contributors_count = (
          select count(*)::integer from contributors where presale_address = $1
        ),
        updated_at = now()
      where presale_address = $1
    `,
    [body.presaleAddress]
  );

  await dbQuery(
    `
      insert into activity_events(type, presale_address, actor, amount_lamports, symbol, message, signature)
      values ('contribution', $1, $2, $3, $4, coalesce($4, 'RAISE') || ' +' || round(($3::numeric / 1000000000), 3)::text || ' SOL', $5)
      on conflict do nothing
    `,
    [body.presaleAddress, body.owner, body.amountLamports, body.symbol ?? null, body.signature ?? null]
  );

  return NextResponse.json({ ok: true, committedLamports: onchainContributor.acceptedAmount, weight: onchainContributor.contributionWeight });
}
