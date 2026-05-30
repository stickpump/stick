# Stick

Stick is a Solana launchpad for Pump.fun tokens. It runs a single, opinionated
raise model: timed SOL commitments, public creator buy-in, weighted allocation,
oversubscription refunds, and one aggregate Pump.fun/PumpSwap launch route.

Current mainnet deployment:

- Smart contract: [`7JTYzCAXQjEU1n18SKKn9JuGQ5AgReqFoW2yhmkeRiPJ`](https://solscan.io/account/7JTYzCAXQjEU1n18SKKn9JuGQ5AgReqFoW2yhmkeRiPJ)
- Keeper / sponsor: [`8cNyWiryjmgXfH5EeBHoXdaCngmPhmeKqASCDoEXHN9b`](https://solscan.io/account/8cNyWiryjmgXfH5EeBHoXdaCngmPhmeKqASCDoEXHN9b)

The project is structured as a production-oriented monorepo:

- `programs/fair_launchpad` - Anchor program that owns presale state, SOL vaults,
  settlement roots, token vaults, refund claims, vesting, and guarded route calls.
- `apps/web` - Next.js app for launch creation, public presale pages, claims,
  launched-token views, wallet login, and sponsored transaction flow.
- `services/keeper` - Node keeper/indexer that closes expired raises, builds
  settlement manifests, submits Pump/PumpSwap finalize routes, and writes the
  live feed to Postgres.
- `packages/shared` - TypeScript domain types, BN math, weighted allocation,
  Merkle settlement, and Pump FDV helpers.
- `packages/launchpad-client` - Solana instruction builders and PDA helpers for
  the launchpad program.
- `packages/pump-integration` - Official Pump.fun and PumpSwap SDK integration,
  route planning, Jito bundle assembly, and metadata/upload helpers.

## Product Model

Stick intentionally avoids many launch modes. The MVP uses one transparent model
that is easy for creators and funders to understand:

1. A creator configures a token page, raise target, raise window, creator buy-in,
   vesting, and optional max-wallet supply cap.
2. The creator starts the presale with one wallet action: create the presale,
   commit creator buy-in, and open contributions.
3. Anyone can commit SOL until the timer ends. The raise does not close early
   when the target is reached.
4. If total committed is below target, the raise becomes refund-only.
5. If total committed is at or above target, exactly the target amount is accepted
   into the launch route and the rest is refundable.
6. Accepted SOL is spent once as an aggregate buy:
   - below Pump.fun graduation: `create_v2 + buy_v2`;
   - above graduation: Pump.fun buy to completion, migration, then PumpSwap
     remainder buy through an ordered Jito bundle.
7. Contributors claim purchased tokens plus unused SOL from one claim path.

There are no per-user Pump.fun buys. A 100-person raise becomes one aggregate
route, then token allocation is distributed by settlement math.

Internal flow:

```text
Creator wallet
+ create page + buy-in
+-------------------------+
          |
          v
+-------------------------+      Contributors
+ Stick Anchor program    +<----- commit SOL until timer ends
+ presale + SOL vault     +
+-------------------------+
          |
          | close + settle
          v
+-------------------------+
+ Keeper / indexer        +
+ manifest + Merkle root  +
+-------------------------+
          |
          | guarded finalize
          v
+-------------------------+      +-------------------------+
+ Pump.fun create_v2/buy  +----->+ PumpSwap remainder buy  +
+-------------------------+      +-------------------------+
          |
          v
+-------------------------+
+ User claim              +
+ tokens + unused SOL     +
+-------------------------+
```

## Allocation Math

Stick accepts oversubscription. If the target is `1 SOL` and the pool commits
`10 SOL`, the route still buys with `1 SOL`; the remaining `9 SOL` is refunded
according to the final settlement.

Allocation is weight-based, not first-come-only:

```text
remaining_seconds = presale_end_ts - contribution_ts
time_fraction     = remaining_seconds / duration_seconds
fill_before       = committed_before / target
fill_multiplier   = 1 + boost_strength * (1 - fill_before)^2
weight_added      = amount * (2 + time_fraction * fill_multiplier)
```

The base `2x` weight keeps late contributors meaningful, while time and fill
boost reward early discovery. The keeper settles with a weighted cap and
redistribute pass:

- nobody can be charged more SOL than they committed;
- if a wallet hits its cap, unaccepted SOL stays refundable;
- any accepted SOL that cannot be assigned to capped wallets is redistributed
  across remaining eligible weights;
- if the max-wallet supply cap leaves no eligible wallet, the route can spend
  less than target and the rest remains refundable.

The settlement manifest is public JSON and committed on-chain by Merkle root.
Claims verify the Merkle proof before transferring refund SOL and token
allocation.

## On-Chain Responsibilities

The Anchor program is the trust boundary for funds. It enforces:

- SOL-only raise flow for the current MVP;
- one active launch type: `EarlyBoostBatch`;
- 1 minute to 1 day raise windows;
- creator buy-in before opening;
- creator buy-in counted inside total commitments;
- oversubscription until the timer ends;
- refund-only mode when target is missed;
- Merkle root based claims;
- double-claim prevention;
- Token-2022 token vault support for Pump.fun `create_v2`;
- guarded CPI route calls to Pump.fun, PumpSwap, and Pump fee-sharing programs;
- route state so finalize steps cannot be skipped or double-spent;
- optional creator buy-in vesting.

The keeper can close, settle, and finalize, but it does not freely withdraw vault
funds. Route instructions must move SOL through approved Pump/PumpSwap paths and
token claims are constrained by the purchased-token vault.

## Keeper Responsibilities

The keeper is an operational service, not a custodian. It:

- polls launchpad accounts and Postgres rows;
- closes expired open raises;
- detects target-missed raises and marks them refund-only;
- indexes contributor accounts;
- builds deterministic settlement manifests and Merkle roots;
- stores manifests in Postgres for API proof lookup;
- calls `set_settlement`;
- builds official Pump.fun SDK `create_v2` and `buy_v2` instructions;
- builds official PumpSwap SDK remainder buys;
- builds ordered Jito bundles for split Pump/PumpSwap routes;
- updates launched-token and activity tables for the web app.

For split routes, the intended production behavior is bundle retry. A normal
sequential fallback would leave an avoidable gap between Pump graduation and the
PumpSwap remainder buy.

## Web App

The Next.js app contains:

- Futard-style launch board and project cards adapted for Stick;
- launch creation flow with file uploads for avatar/banner;
- 3:1 banner handling and backend-served asset URLs;
- public presale pages with timer, target, committed amount, status, route info,
  max-wallet cap, creator buy-in, and claim actions;
- claim/refund APIs that load settlement data from Postgres and on-chain state;
- sponsored transaction API with a restricted fee-payer wallet;
- SOL/USDT backend cache used for estimated FDV and UI display.

## Database

Postgres is used for indexing and fast UI reads. The schema lives in
`infra/postgres/001_init.sql`.

Core tables:

- `launches` - project metadata, status, target, committed totals, timing, FDV.
- `contributors` - indexed commitments and claim state.
- `settlement_manifests` - Merkle root, public manifest JSON, accepted/refund data.
- `route_steps` - Pump/PumpSwap finalize progress.
- `launched_tokens` - post-launch token cards.
- `activity_events` - ticker and audit feed events.

Apply schema:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stick pnpm db:schema
```

## Requirements

- Node.js 20+
- pnpm 8+
- Rust stable
- Solana CLI
- Anchor CLI 0.30.1 for the current local build path
- PostgreSQL 14+
- A funded Solana keeper wallet for mainnet finalization and sponsored fees

The current SBF build is verified with:

```bash
anchor build --no-idl
```

If you need full IDL generation, use an Anchor/Rust version pair compatible with
Anchor's `idl-build` path.

## Environment

Copy the example file and fill real values:

```bash
cp .env.example .env
```

Important variables:

| Variable | Used by | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | web | Usually `mainnet-beta`. |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | web | Public Solana RPC endpoint. |
| `NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID` | web | Deployed launchpad program id. |
| `NEXT_PUBLIC_PRIVY_APP_ID` | web | Privy app id for wallet login. |
| `DATABASE_URL` | web, keeper | Postgres connection string. |
| `METADATA_UPLOAD_URL` | web, keeper | Pump.fun metadata upload endpoint. |
| `SPONSORED_TX_ENABLED` | web API | Enables server-side fee payer signing. |
| `SPONSOR_KEYPAIR_JSON` | web API | Low-balance sponsor wallet secret JSON. Never commit. |
| `RPC_URL` | keeper | Private/high-throughput RPC, usually Helius. |
| `LAUNCHPAD_PROGRAM_ID` | keeper | Same deployed program id. |
| `KEEPER_PRIVATE_KEY` / `KEEPER_KEYPAIR_JSON` | keeper | Keeper wallet. Never commit. |
| `JITO_ENDPOINT` | keeper | Comma-separated Jito block engine endpoints. |
| `JITO_TIP_LAMPORTS` | keeper | Tip used for bundles. |
| `DISABLE_AUTO_FINALIZE` | keeper | Set `true` to index/settle without route finalization. |

Never commit `.env`, keypairs, `target/deploy/*.json`, local validator ledgers,
or production wallet secrets. The `.gitignore` is intentionally strict around
these files.

## Install

```bash
pnpm install
```

## Build and Test

```bash
pnpm typecheck
pnpm test
pnpm anchor:build
pnpm --filter @fair/web build
pnpm --filter @fair/keeper build
```

Run the local smoke test:

```bash
anchor build --no-idl
solana-test-validator \
  --ledger /tmp/stick-test-ledger \
  --reset \
  --quiet \
  --bpf-program <LOCAL_PROGRAM_ID> target/deploy/fair_launchpad.so

pnpm local:smoke
```

The local smoke flow covers:

- missed target -> refund-only;
- oversubscribed settlement;
- fake-finalize rejection;
- claim/refund accounting basics.

## Local Development

Start Postgres and apply schema:

```bash
createdb stick
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stick pnpm db:schema
```

Start web:

```bash
pnpm dev
```

Start keeper:

```bash
pnpm keeper:dev
```

The web app runs on `http://localhost:3000`.

## Mainnet Deployment Checklist

1. Generate a fresh program id or choose the existing upgradeable program id.
2. Build the Anchor program:

   ```bash
   anchor build --no-idl
   ```

3. Deploy with an upgrade authority you control:

   ```bash
   solana program deploy target/deploy/fair_launchpad.so \
     --program-id target/deploy/fair_launchpad-keypair.json \
     --upgrade-authority /path/to/upgrade-authority.json \
     --keypair /path/to/payer.json \
     --url mainnet-beta
   ```

4. Verify authority:

   ```bash
   solana program show <PROGRAM_ID> --url mainnet-beta
   ```

5. Set both program id variables:

   ```bash
   NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID=<PROGRAM_ID>
   LAUNCHPAD_PROGRAM_ID=<PROGRAM_ID>
   ```

6. Run the Postgres schema migration.
7. Build and start the web app.
8. Start keeper with a funded operational wallet.
9. Test in this order:
   - below-target refund;
   - target hit without oversubscription;
   - oversubscription with two or more wallets;
   - successful claim;
   - successful Pump route;
   - fee-sharing config for creator fees;
   - split route with Jito bundle when using a large enough target.

## Production Notes

- Keep the sponsor wallet low-balance and scoped to launchpad transactions.
- Keep the program upgrade authority separate from hot operational services when
  moving beyond MVP testing.
- Do not run auto-finalization until Jito endpoints, tip account, RPC, and keeper
  balance are confirmed.
- If the route transaction creates temporary address lookup tables, close them
  after use to recover rent.
- Use database backups before truncating test data.
- Treat settlement manifests as public audit artifacts.

## GitHub Hygiene

Before pushing:

```bash
git status --short
git check-ignore -v .env apps/web/.env.local services/keeper/.env target/deploy/fair_launchpad-keypair.json
```

Expected: all secret/runtime files should be ignored.

Then initialize and push:

```bash
git init
git add .
git commit -m "Initial Stick launchpad monorepo"
git branch -M main
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
```

## License

Private MVP codebase unless a license is added explicitly.
