import { NextResponse } from "next/server";
import { Keypair } from "@solana/web3.js";
import { CREATOR_FEE_MODES, type CreatorFeeMode } from "@fair/shared";
import { dbQuery, hasDatabaseUrl } from "@/lib/db";
import { readOnchainContributorStateWithRetry } from "@/lib/onchain-contributor";
import { encryptText } from "@/lib/server-secret-crypto";

export const runtime = "nodejs";

type RegisterLaunchBody = {
  presaleAddress?: string;
  mintAddress?: string;
  creator?: string;
  signature?: string;
  name?: string;
  symbol?: string;
  description?: string;
  metadataUri?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  website?: string;
  x?: string;
  telegram?: string;
  discord?: string;
  docs?: string;
  targetLamports?: string;
  devbuyLamports?: string;
  devbuyWeight?: string;
  maxWalletSupplyBps?: number;
  creatorFeeMode?: CreatorFeeMode;
  startAt?: string;
  endAt?: string;
};

export async function POST(request: Request) {
  if (!hasDatabaseUrl()) {
    return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 500 });
  }

  const body = await request.json() as RegisterLaunchBody;
  if (!body.presaleAddress || !body.creator || !body.name || !body.symbol || !body.targetLamports || !body.endAt) {
    return NextResponse.json({ error: "presaleAddress, creator, name, symbol, targetLamports and endAt are required." }, { status: 400 });
  }

  const startAt = body.startAt ? new Date(body.startAt) : new Date();
  const endAt = new Date(body.endAt);
  if (!Number.isFinite(Number(body.targetLamports)) || Number(body.targetLamports) <= 0 || Number.isNaN(endAt.getTime())) {
    return NextResponse.json({ error: "Invalid target or end date." }, { status: 400 });
  }
  if (isInlineAsset(body.avatarUrl) || isInlineAsset(body.bannerUrl)) {
    return NextResponse.json({ error: "Uploaded media must be stored as URLs, not inline data." }, { status: 400 });
  }
  const links = {
    website: normalizeOptionalUrl(body.website),
    x: normalizeOptionalUrl(body.x),
    telegram: normalizeOptionalUrl(body.telegram),
    discord: normalizeOptionalUrl(body.discord),
    docs: normalizeOptionalUrl(body.docs)
  };

  const devbuyLamports = body.devbuyLamports ?? "0";
  const maxWalletSupplyBps = normalizeMaxWalletSupplyBps(body.maxWalletSupplyBps);
  const creatorFeeMode = normalizeCreatorFeeMode(body.creatorFeeMode);
  const existingLaunch = await dbQuery<{
    creator_fee_mode: CreatorFeeMode;
    creator_fee_recipient: string | null;
    creator_fee_subwallet_public_key: string | null;
  }>(
    `
      select
        creator_fee_mode,
        creator_fee_recipient,
        creator_fee_subwallet_public_key
      from launches
      where presale_address = $1
      limit 1
    `,
    [body.presaleAddress]
  );
  const existingCreatorFee = existingLaunch.rows[0];
  if (existingCreatorFee && existingCreatorFee.creator_fee_mode !== creatorFeeMode) {
    return NextResponse.json({ error: "Creator fee mode is immutable once a presale is registered." }, { status: 409 });
  }
  if (!existingCreatorFee && creatorFeeMode !== "self" && !process.env.WALLET_ENCRYPTION_KEY) {
    return NextResponse.json({ error: "WALLET_ENCRYPTION_KEY is required for non-self creator fee modes." }, { status: 500 });
  }

  const generatedFeeWallet = !existingCreatorFee && creatorFeeMode !== "self"
    ? createEncryptedCreatorFeeWallet(creatorFeeMode)
    : null;
  const creatorFeeRecipient = existingCreatorFee?.creator_fee_recipient
    ?? generatedFeeWallet?.publicKey
    ?? body.creator;
  const creatorFeeSubwalletPublicKey = existingCreatorFee?.creator_fee_subwallet_public_key
    ?? generatedFeeWallet?.publicKey
    ?? null;

  await dbQuery(
    `
      insert into launches(
        presale_address,
        slug,
        creator,
        mint_address,
        name,
        symbol,
        status,
        description,
        metadata_uri,
        avatar_url,
        banner_url,
        website_url,
        x_url,
        telegram_url,
        discord_url,
        docs_url,
        target_lamports,
        max_wallet_supply_bps,
        creator_fee_mode,
        creator_fee_recipient,
        creator_fee_subwallet_public_key,
        committed_lamports,
        contributors_count,
        start_at,
        end_at,
        updated_at
      ) values ($1, $2, $3, $4, $5, $6, 'LIVE', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 1, $22, $23, now())
      on conflict (presale_address) do update set
        creator = excluded.creator,
        mint_address = excluded.mint_address,
        name = excluded.name,
        symbol = excluded.symbol,
        status = 'LIVE',
        description = excluded.description,
        metadata_uri = excluded.metadata_uri,
        avatar_url = excluded.avatar_url,
        banner_url = excluded.banner_url,
        website_url = excluded.website_url,
        x_url = excluded.x_url,
        telegram_url = excluded.telegram_url,
        discord_url = excluded.discord_url,
        docs_url = excluded.docs_url,
        target_lamports = excluded.target_lamports,
        max_wallet_supply_bps = excluded.max_wallet_supply_bps,
        committed_lamports = excluded.committed_lamports,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        updated_at = now()
    `,
    [
      body.presaleAddress,
      body.presaleAddress,
      body.creator,
      body.mintAddress ?? null,
      body.name,
      body.symbol.toUpperCase(),
      body.description ?? "",
      body.metadataUri ?? null,
      body.avatarUrl ?? null,
      body.bannerUrl ?? null,
      links.website,
      links.x,
      links.telegram,
      links.discord,
      links.docs,
      body.targetLamports,
      maxWalletSupplyBps,
      creatorFeeMode,
      creatorFeeRecipient,
      creatorFeeSubwalletPublicKey,
      devbuyLamports,
      startAt,
      endAt
    ]
  );

  if (generatedFeeWallet) {
    await dbQuery(
      `
        insert into creator_fee_wallets(
          presale_address,
          mode,
          public_key,
          encrypted_secret
        ) values ($1, $2, $3, $4)
        on conflict (presale_address) do nothing
      `,
      [
        body.presaleAddress,
        creatorFeeMode,
        generatedFeeWallet.publicKey,
        generatedFeeWallet.encryptedSecret
      ]
    );
  }

  if (Number(devbuyLamports) > 0) {
    const onchainDevbuy = await readOnchainContributorStateWithRetry(body.presaleAddress, body.creator);
    if (!onchainDevbuy) {
      return NextResponse.json({ error: "Creator buy-in is not confirmed on-chain yet. Retry shortly." }, { status: 409 });
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
      [body.presaleAddress, body.creator, onchainDevbuy.acceptedAmount, onchainDevbuy.contributionWeight]
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
  }

  await dbQuery(
    `
      insert into activity_events(type, presale_address, actor, amount_lamports, symbol, message, signature)
      values ('presale_opened', $1, null, $2, $3, $3 || ' presale opened', $4)
      on conflict do nothing
    `,
    [body.presaleAddress, devbuyLamports, body.symbol.toUpperCase(), body.signature ?? null]
  );

  return NextResponse.json({ ok: true });
}

function normalizeMaxWalletSupplyBps(value: number | undefined) {
  if (!Number.isInteger(value)) return 0;
  return Math.max(0, Math.min(10_000, value as number));
}

function normalizeCreatorFeeMode(value: CreatorFeeMode | undefined): CreatorFeeMode {
  if (value && CREATOR_FEE_MODES.includes(value)) return value;
  return "self";
}

function createEncryptedCreatorFeeWallet(mode: CreatorFeeMode) {
  if (mode === "self") return null;
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("WALLET_ENCRYPTION_KEY is required for non-self creator fee modes.");
  }
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toBase58(),
    encryptedSecret: encryptText(JSON.stringify(Array.from(keypair.secretKey)), encryptionKey)
  };
}

function isInlineAsset(value: string | undefined) {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("data:");
}

function normalizeOptionalUrl(value: string | undefined) {
  const trimmed = repairCommonUrlTypo(value?.trim() ?? "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function repairCommonUrlTypo(value: string) {
  return value
    .replace(/^https\/\//i, "https://")
    .replace(/^http\/\//i, "http://");
}
