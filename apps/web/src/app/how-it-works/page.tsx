import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  Clock3,
  Code2,
  Database,
  FileJson,
  LockKeyhole,
  Network,
  ReceiptText,
  Route,
  Scale,
  Sparkles,
  WalletCards
} from "lucide-react";
import { FutardHeader } from "@/components/futard-header";
import { LiveTicker } from "@/components/live-ticker";

const tableOfContents = [
  ["overview", "Overview"],
  ["model", "Raise model"],
  ["allocation", "Allocation math"],
  ["lifecycle", "Lifecycle"],
  ["settlement", "Settlement"],
  ["routing", "Pump routing"],
  ["claims", "Claims and refunds"],
  ["metadata", "Metadata"],
  ["trust", "Trust model"],
  ["operations", "Operations"]
] as const;

const lifecycle = [
  {
    title: "Create",
    body: "The creator connects a Solana wallet, writes the public project page, uploads media, sets a target, selects the raise window, and configures creator vesting."
  },
  {
    title: "Start",
    body: "One wallet signature creates the presale account, records the metadata URI, performs the creator buy-in, and opens contributions."
  },
  {
    title: "Commit",
    body: "Users can commit SOL until the timer ends. The raise does not close early when the target is reached."
  },
  {
    title: "Settle",
    body: "The keeper closes the raise, builds a public settlement manifest, and writes the Merkle root on-chain."
  },
  {
    title: "Finalize",
    body: "Accepted SOL is spent as one aggregate launch route through Pump.fun, and through PumpSwap after graduation when required."
  },
  {
    title: "Claim",
    body: "Each participant claims tokens and unused SOL from the launch page using their Merkle proof."
  }
];

const settlementRows = [
  ["Target missed", "If total committed SOL is below target, the launch does not execute. Contributors claim a full SOL refund."],
  ["Target reached", "If total committed SOL is at or below target, every participant's full commitment is accepted."],
  ["Oversubscription", "If committed SOL is above target, the accepted pool is capped at target and distributed by bounded weight. Unused SOL is claimed back."],
  ["Creator buy-in", "The creator buy-in is public, happens first, counts toward target, and uses the same allocation formula."],
  ["Vesting", "Creator allocation can unlock instantly or through the configured vesting schedule."],
  ["Double claim protection", "The program records claims so the same settlement proof cannot be used twice."]
];

const trustRows = [
  ["No early close", "Demand can exceed target, but the timer defines the contribution window."],
  ["No hidden allocation", "The public manifest shows committed, weight, accepted, and refundable amounts."],
  ["No keeper custody", "Funds stay in the presale vault. The keeper can execute guarded finalize instructions, not arbitrary withdrawals."],
  ["No per-wallet buy spam", "Finalization aggregates the accepted pool into one route instead of making one Pump buy per contributor."],
  ["No private metadata step", "Token metadata is uploaded through Pump.fun's metadata endpoint before create_v2."],
  ["No automatic user custody", "Users claim from the launch page so the wallet signs the final token/refund transfer."]
];

const routeCases = [
  ["Below graduation", "create_v2 + one Pump.fun buy", "The whole accepted pool fits before the bonding curve completes."],
  ["Crosses graduation", "Jito bundle", "Pump create+buy-to-completion, migrate/create canonical PumpSwap pool, then PumpSwap buy remainder."],
  ["Bundle not landed", "Retry bundle", "The keeper retries the atomic route instead of intentionally leaving a normal transaction gap."]
];

const PROGRAM_ID = "7JTYzCAXQjEU1n18SKKn9JuGQ5AgReqFoW2yhmkeRiPJ";
const KEEPER_ADDRESS = "8cNyWiryjmgXfH5EeBHoXdaCngmPhmeKqASCDoEXHN9b";
const FLOW_DIAGRAM = `Creator wallet
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
+-------------------------+`;

function SectionEyebrow({ children }: { children: string }) {
  return <span className="whitepaperEyebrow">{children}</span>;
}

export default function HowItWorksPage() {
  return (
    <main className="futardLanding">
      <FutardHeader />
      <LiveTicker />

      <section className="whitepaperHero">
        <div className="whitepaperHeroCopy">
          <SectionEyebrow>STICK WHITEPAPER</SectionEyebrow>
          <h1>Fair Pump.fun presales.</h1>
          <p>
            Timed raises, public terms, weighted allocation, and claimable refunds.
          </p>
          <div className="whitepaperActions">
            <Link className="fundButton live" href="/create">Launch Project <ArrowRight size={15} /></Link>
            <Link className="whitepaperGhostLink" href="/">View raises</Link>
          </div>
        </div>

      </section>

      <section className="whitepaperShell">
        <aside className="whitepaperToc">
          <strong>Contents</strong>
          <nav aria-label="Whitepaper sections">
            {tableOfContents.map(([id, label]) => (
              <a key={id} href={`#${id}`}>{label}</a>
            ))}
          </nav>
        </aside>

        <div className="whitepaperBody">
          <section id="overview" className="whitepaperSection">
            <SectionEyebrow>01 / OVERVIEW</SectionEyebrow>
            <h2>What Stick is</h2>
            <p>
              Stick is not a separate AMM or a custom trading venue. It is a launch layer around Pump.fun.
              The product gives a creator a structured page and a presale vault before launch, then routes
              the accepted raise into Pump.fun and PumpSwap when the raise settles.
            </p>
            <div className="whitepaperCallout">
              <Sparkles size={18} />
              <span>Every participant sees the target, timer, creator buy-in, vesting terms, route assumptions, and claim behavior before signing.</span>
            </div>
          </section>

          <section id="model" className="whitepaperSection">
            <SectionEyebrow>02 / RAISE MODEL</SectionEyebrow>
            <h2>One public raise model</h2>
            <p>
              Stick uses one SOL raise model for the MVP: timed oversubscription with weighted allocation.
              There is no hard stop at target. Commitments remain open until the timer ends.
            </p>
            <div className="whitepaperGrid two">
              <div className="whitepaperInfoBlock">
                <Clock3 size={18} />
                <strong>Timer first</strong>
                <span>The raise window can be configured from 1 minute to 1 day. Settlement starts only after the window closes.</span>
              </div>
              <div className="whitepaperInfoBlock">
                <Scale size={18} />
                <strong>Target capped</strong>
                <span>If demand is higher than target, only target SOL is accepted into the launch. The rest is refundable.</span>
              </div>
            </div>
          </section>

          <section id="allocation" className="whitepaperSection">
            <SectionEyebrow>03 / ALLOCATION MATH</SectionEyebrow>
            <h2>Earlier support receives more weight</h2>
            <p>
              If a raise is not oversubscribed, weight is not used to haircut anyone: accepted SOL equals
              committed SOL. If demand is above target, each commitment receives a deterministic weight.
              The weight changes how much of the capped target is accepted, not the shared launch entry price.
            </p>
            <pre className="whitepaperFormula"><code>{`remaining_seconds = presale_end_ts - contribution_ts
time_share = remaining_seconds / raise_window_seconds
fill_before = committed_before / target
fill_multiplier = 1 + boost_strength * (1 - fill_before)^2
weight_added = committed_amount * (base_weight + time_share * fill_multiplier)

if total_committed <= target:
  accepted = committed
else:
  accepted = weighted_share_of_target
  refund = committed - accepted`}</code></pre>
            <div className="whitepaperNoteList">
              <div><CheckCircle2 size={16} /><span>All accepted SOL buys one shared route, so contributors receive the same blended launch entry.</span></div>
              <div><CheckCircle2 size={16} /><span>Base weight keeps late contributions meaningful instead of pushing them toward zero.</span></div>
              <div><CheckCircle2 size={16} /><span>The creator buy-in happens first, is public, and is included in the same weighted settlement.</span></div>
              <div><CheckCircle2 size={16} /><span>Weighted settlement is capped so nobody can be accepted for more SOL than they committed.</span></div>
            </div>
          </section>

          <section id="lifecycle" className="whitepaperSection">
            <SectionEyebrow>04 / LIFECYCLE</SectionEyebrow>
            <h2>From draft to claim</h2>
            <div className="whitepaperTimeline">
              {lifecycle.map((step, index) => (
                <div key={step.title}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="settlement" className="whitepaperSection">
            <SectionEyebrow>05 / SETTLEMENT</SectionEyebrow>
            <h2>Merkle manifest and refund accounting</h2>
            <p>
              After close, the keeper builds a deterministic settlement manifest from indexed contributors.
              The manifest contains each wallet's committed amount, weight, accepted amount, and refund amount.
              The program stores the Merkle root and verifies user claims against that root.
            </p>
            <div className="whitepaperRuleTable">
              {settlementRows.map(([label, text]) => (
                <div key={label}>
                  <strong>{label}</strong>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </section>

          <section id="routing" className="whitepaperSection">
            <SectionEyebrow>06 / PUMP ROUTING</SectionEyebrow>
            <h2>One aggregate launch purchase</h2>
            <p>
              Stick does not execute 100 separate Pump.fun buys when 100 users join. The accepted pool is
              finalized as one aggregate route from the presale vault.
            </p>
            <div className="whitepaperRouteGrid">
              {routeCases.map(([title, mode, text]) => (
                <div key={title}>
                  <Route size={18} />
                  <span>{title}</span>
                  <strong>{mode}</strong>
                  <p>{text}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="claims" className="whitepaperSection">
            <SectionEyebrow>07 / CLAIMS</SectionEyebrow>
            <h2>Tokens and unused SOL in one action</h2>
            <p>
              Claiming is user initiated. The launch page requests claim data for the connected wallet,
              builds a transaction with the Merkle proof, and sends tokens plus refundable SOL according to settlement.
            </p>
            <div className="whitepaperGrid three">
              <div className="whitepaperInfoBlock">
                <ReceiptText size={18} />
                <strong>Successful raise</strong>
                <span>User claims token allocation and any unused SOL from oversubscription.</span>
              </div>
              <div className="whitepaperInfoBlock">
                <WalletCards size={18} />
                <strong>Missed target</strong>
                <span>User claims the committed SOL refund. No token launch is executed.</span>
              </div>
              <div className="whitepaperInfoBlock">
                <LockKeyhole size={18} />
                <strong>Creator vesting</strong>
                <span>Creator allocation follows the configured unlock schedule after settlement.</span>
              </div>
            </div>
          </section>

          <section id="metadata" className="whitepaperSection">
            <SectionEyebrow>08 / METADATA</SectionEyebrow>
            <h2>Project page and token metadata</h2>
            <p>
              Stick stores launch data in Postgres for the website and uploads token metadata through Pump.fun's
              metadata endpoint before token creation. The returned metadata URI is stored on the presale and
              passed to Pump create_v2 during finalization.
            </p>
            <div className="whitepaperFlow">
              <div><FileJson size={18} /><span>Create form</span></div>
              <div><Database size={18} /><span>Postgres launch record</span></div>
              <div><Network size={18} /><span>Pump metadata upload</span></div>
              <div><Code2 size={18} /><span>create_v2 URI</span></div>
            </div>
          </section>

          <section id="trust" className="whitepaperSection">
            <SectionEyebrow>09 / TRUST MODEL</SectionEyebrow>
            <h2>What the system does and does not trust</h2>
            <div className="whitepaperRuleTable">
              {trustRows.map(([label, text]) => (
                <div key={label}>
                  <strong>{label}</strong>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </section>

          <section id="operations" className="whitepaperSection">
            <SectionEyebrow>10 / OPERATIONS</SectionEyebrow>
            <h2>Keeper and production requirements</h2>
            <p>
              The keeper is an operational service. It watches expired raises, closes them, builds settlement,
              writes roots, and submits guarded finalization transactions. Production deployment requires a
              configured Postgres database, Helius RPC, funded keeper wallet, Jito endpoint, and monitoring.
            </p>
            <div className="whitepaperOps">
              <div><BadgeCheck size={17} /><span>Database schema applied and indexed</span></div>
              <div><BadgeCheck size={17} /><span>Program ID configured in frontend and keeper</span></div>
              <div><BadgeCheck size={17} /><span>Pump metadata upload reachable from backend</span></div>
              <div><BadgeCheck size={17} /><span>Jito bundle path configured for above-graduation routes</span></div>
              <div><BadgeCheck size={17} /><span>Claim API connected to settlement manifests</span></div>
              <div><BadgeCheck size={17} /><span>Monitoring for close, settlement, finalize, and claim events</span></div>
            </div>
            <div className="whitepaperRuleTable whitepaperAddressTable">
              <div>
                <strong>Smart contract</strong>
                <a href={`https://solscan.io/account/${PROGRAM_ID}`} target="_blank" rel="noreferrer">{PROGRAM_ID}</a>
              </div>
              <div>
                <strong>Keeper / sponsor</strong>
                <a href={`https://solscan.io/account/${KEEPER_ADDRESS}`} target="_blank" rel="noreferrer">{KEEPER_ADDRESS}</a>
              </div>
            </div>
            <pre className="whitepaperFormula whitepaperAscii"><code>{FLOW_DIAGRAM}</code></pre>
          </section>
        </div>
      </section>
    </main>
  );
}
