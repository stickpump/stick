create table if not exists launches (
  presale_address text primary key,
  slug text unique,
  creator text,
  mint_address text,
  name text not null,
  symbol text not null,
  status text not null check (status in ('LIVE', 'COMPLETED', 'REFUNDED', 'UPCOMING')),
  description text not null default '',
  metadata_uri text,
  avatar_url text,
  banner_url text,
  website_url text,
  x_url text,
  telegram_url text,
  discord_url text,
  docs_url text,
  target_lamports numeric(40, 0) not null default 0,
  committed_lamports numeric(40, 0) not null default 0,
  contributors_count integer not null default 0,
  max_wallet_supply_bps integer not null default 0,
  fdv_usd numeric(20, 2),
  start_at timestamptz not null default now(),
  end_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table launches add column if not exists start_at timestamptz not null default now();
alter table launches add column if not exists end_at timestamptz;
alter table launches add column if not exists creator text;
alter table launches add column if not exists mint_address text;
alter table launches add column if not exists max_wallet_supply_bps integer not null default 0;
alter table launches add column if not exists website_url text;
alter table launches add column if not exists x_url text;
alter table launches add column if not exists telegram_url text;
alter table launches add column if not exists discord_url text;
alter table launches add column if not exists docs_url text;
alter table launches add column if not exists creator_fee_mode text not null default 'self';
alter table launches add column if not exists creator_fee_recipient text;
alter table launches add column if not exists creator_fee_subwallet_public_key text;
alter table launches alter column max_wallet_supply_bps set default 0;
update launches set max_wallet_supply_bps = 0 where max_wallet_supply_bps is null;
update launches set creator_fee_mode = 'self' where creator_fee_mode is null;
update launches set creator_fee_recipient = creator where creator_fee_recipient is null and coalesce(creator, '') <> '';

alter table launches drop constraint if exists launches_creator_fee_mode_check;
alter table launches add constraint launches_creator_fee_mode_check check (
  creator_fee_mode in ('self', 'buyback_burn', 'coinflip', 'flywheel')
);

create index if not exists launches_status_updated_idx on launches (status, updated_at desc);

create table if not exists launched_tokens (
  mint text primary key,
  presale_address text references launches(presale_address) on delete set null,
  name text not null,
  symbol text not null,
  market_cap_usd numeric(20, 2),
  raised_lamports numeric(40, 0) not null default 0,
  liquidity_label text,
  dex_screener_url text,
  avatar_url text,
  banner_url text,
  launched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists launched_tokens_launched_idx on launched_tokens (launched_at desc);

create table if not exists creator_fee_wallets (
  presale_address text primary key references launches(presale_address) on delete cascade,
  mode text not null check (mode in ('buyback_burn', 'coinflip', 'flywheel')),
  public_key text not null unique,
  encrypted_secret text not null,
  funded_lamports numeric(40, 0) not null default 0,
  funded_at timestamptz,
  funding_signature text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists creator_fee_wallets_public_key_idx on creator_fee_wallets (public_key);

create table if not exists creator_fee_cycles (
  id bigserial primary key,
  presale_address text not null references launches(presale_address) on delete cascade,
  mint text,
  mode text not null check (mode in ('buyback_burn', 'coinflip', 'flywheel')),
  wallet_public_key text,
  claimed_lamports numeric(40, 0) not null default 0,
  action_lamports numeric(40, 0) not null default 0,
  result text not null,
  holder_count integer,
  burned_raw_amount numeric(40, 0),
  signatures jsonb not null default '{}'::jsonb,
  recipients jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists creator_fee_cycles_presale_created_idx on creator_fee_cycles (presale_address, created_at desc);
create index if not exists creator_fee_cycles_created_idx on creator_fee_cycles (created_at desc);

create table if not exists activity_events (
  id bigserial primary key,
  type text not null check (type in (
    'contribution',
    'presale_created',
    'presale_opened',
    'settlement_ready',
    'finalized',
    'claim',
    'refund',
    'graduated',
    'fee_claim',
    'buyback_burn',
    'coinflip',
    'flywheel'
  )),
  presale_address text references launches(presale_address) on delete set null,
  actor text,
  amount_lamports numeric(40, 0),
  symbol text,
  message text not null,
  signature text,
  slot bigint,
  created_at timestamptz not null default now()
);

alter table activity_events drop constraint if exists activity_events_type_check;
alter table activity_events add constraint activity_events_type_check check (type in (
  'contribution',
  'presale_created',
  'presale_opened',
  'settlement_ready',
  'finalized',
  'claim',
  'refund',
  'graduated',
  'fee_claim',
  'buyback_burn',
  'coinflip',
  'flywheel'
));

create index if not exists activity_events_created_idx on activity_events (created_at desc);
create index if not exists activity_events_presale_created_idx on activity_events (presale_address, created_at desc);
create unique index if not exists activity_events_signature_unique_idx on activity_events (signature) where signature is not null;

create table if not exists contributors (
  presale_address text not null references launches(presale_address) on delete cascade,
  owner text not null,
  committed_lamports numeric(40, 0) not null default 0,
  weight numeric(60, 0) not null default 0,
  gross_accepted_lamports numeric(40, 0),
  refund_lamports numeric(40, 0),
  claimed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (presale_address, owner)
);

create table if not exists settlement_manifests (
  presale_address text primary key references launches(presale_address) on delete cascade,
  target_lamports numeric(40, 0) not null,
  pump_spend_lamports numeric(40, 0) not null,
  merkle_root text not null,
  manifest_uri text not null,
  manifest_json jsonb not null,
  created_at timestamptz not null default now()
);

alter table settlement_manifests drop column if exists launch_fee_lamports;

create table if not exists route_steps (
  id bigserial primary key,
  presale_address text not null references launches(presale_address) on delete cascade,
  step text not null check (step in ('pump_create_buy', 'migrate', 'pumpswap_buy')),
  status text not null check (status in ('planned', 'submitted', 'landed', 'failed')),
  quote_lamports numeric(40, 0) not null default 0,
  tokens_out numeric(40, 0) not null default 0,
  bundle_id text,
  signature text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contributors_owner_idx on contributors (owner);
create index if not exists route_steps_presale_idx on route_steps (presale_address, created_at);
