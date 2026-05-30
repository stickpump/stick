"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Select from "@radix-ui/react-select";
import * as Slider from "@radix-ui/react-slider";
import * as Switch from "@radix-ui/react-switch";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import * as Tooltip from "@radix-ui/react-tooltip";
import BN from "bn.js";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  BarChart3,
  ChevronDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Coins,
  FileText,
  Globe2,
  Image,
  Info,
  Link2,
  LockKeyhole,
  ShieldCheck,
  TextCursorInput,
} from "lucide-react";
import {
  buildCreatePresaleInstruction,
  buildOpenPresaleInstruction,
  buildSolDevbuyInstruction,
  mintPda,
  presalePda,
  quoteMintForAsset
} from "@fair/launchpad-client";
import {
  SOL_DECIMALS,
  calculateDevbuyWeight,
  calculatePumpCurveCompletion,
  calculatePumpSpendFromTarget,
  estimatePumpRouteMarketCapLamports,
  quoteDecimals,
  quoteFinalizePlan,
  toBaseUnits,
  type ProjectMetadata
} from "@fair/shared";
import { FutardHeader } from "@/components/futard-header";
import { LiveTicker } from "@/components/live-ticker";
import { WalletButton } from "@/components/wallet-button";
import { assertMainnetProgramConfigured, getRuntimeConfig } from "@/lib/mainnet-config";
import { publishProjectAsset, publishProjectMetadata } from "@/lib/project-metadata";
import { signAndSendInstructions } from "@/lib/transaction-runner";
import { useStickWallet } from "@/hooks/use-stick-wallet";

const FAIR_LAUNCH_TYPE = "EarlyBoostBatch" as const;
const QUOTE_ASSET = "SOL" as const;
const REWARD_PRESET = "Community" as const;
const BOOST_PRESET = "Medium" as const;
const DEFAULT_CREATOR_BUY_IN = "0.1";
const MIN_CREATOR_BUY_IN = "0.01";
const SOL_USD_FALLBACK = 170;
const TOKEN_DECIMALS = 6;

const createRequirements = [
  { icon: TextCursorInput, label: "Project name and ticker" },
  { icon: Image, label: "Logo and 3:1 launch banner" },
  { icon: FileText, label: "Short pitch and project story" },
  { icon: Coins, label: "SOL target for the raise" },
  { icon: Clock3, label: "Raise window and creator vesting" },
  { icon: Link2, label: "Website and social links" },
  { icon: ShieldCheck, label: "Public creator buy-in" },
  { icon: Globe2, label: "Public launch page details" }
];

const postPaySteps = [
  ["1", "Connect wallet", "Your launch is created from your Solana wallet."],
  ["2", "Build the page", "Add the story, target, timer, images, and links."],
  ["3", "Review the terms", "Buyers see the same raise rules before joining."],
  ["4", "Start presale", "Your creator buy-in opens the raise."],
  ["5", "Go live", "The launch appears once the indexer syncs it."]
] as const;

const wizardSteps = [
  {
    title: "Project",
    eyebrow: "Public identity"
  },
  {
    title: "Raise",
    eyebrow: "Target and timing"
  },
  {
    title: "Vesting",
    eyebrow: "Creator allocation"
  },
  {
    title: "Publish",
    eyebrow: "Mainnet"
  }
];

const durationMarks = [
  ["1m", "60"],
  ["1h", "3600"],
  ["6h", "21600"],
  ["12h", "43200"],
  ["1d", "86400"]
] as const;

const DURATION_SLIDER_MAX = 87;

const categoryOptions = [
  "Meme / community",
  "DeFi",
  "AI",
  "Gaming",
  "Social",
  "Infrastructure",
  "NFT / culture",
  "Other"
] as const;

const vestingPresets = [
  { label: "Instant", initial: "100", cliff: "0", linear: "0" },
  { label: "7d linear", initial: "0", cliff: "0", linear: "604800" },
  { label: "30d linear", initial: "0", cliff: "0", linear: "2592000" },
  { label: "1d cliff + 30d", initial: "0", cliff: "86400", linear: "2592000" }
] as const;

function formatAmount(amount: BN, decimals: number) {
  const base = new BN(10).pow(new BN(decimals));
  const whole = amount.div(base).toString();
  const fraction = amount.mod(base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction.slice(0, 4)}` : whole;
}

function clampNumber(value: string, fallback: string) {
  return value.trim() === "" ? fallback : value;
}

function sanitizeDecimalInput(value: string) {
  const normalized = value.replace(",", ".").replace(/[^\d.]/g, "");
  const [whole = "", ...fractionParts] = normalized.split(".");
  const fraction = fractionParts.join("");
  return fractionParts.length > 0 ? `${whole}.${fraction}` : whole;
}

function safeBaseUnits(amount: string, decimals: number) {
  try {
    return toBaseUnits(amount, decimals);
  } catch {
    return new BN(0);
  }
}

function formatDuration(seconds: number) {
  if (seconds <= 0) return "Instant";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts = [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes && !days ? `${minutes}m` : ""
  ].filter(Boolean);
  return parts.join(" ") || `${seconds}s`;
}

function durationTickToSeconds(tick: number) {
  const clamped = Math.max(0, Math.min(DURATION_SLIDER_MAX, Math.round(tick)));
  if (clamped <= 59) {
    return (clamped + 1) * 60;
  }
  if (clamped <= 69) {
    return (60 + (clamped - 59) * 30) * 60;
  }
  return (360 + (clamped - 69) * 60) * 60;
}

function secondsToDurationTick(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes <= 60) {
    return minutes - 1;
  }
  if (minutes <= 360) {
    return 59 + Math.round((minutes - 60) / 30);
  }
  return Math.max(0, Math.min(DURATION_SLIDER_MAX, 69 + Math.round((minutes - 360) / 60)));
}

function normalizeDurationSeconds(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 3600;
  return Math.max(60, Math.min(86_400, Math.round(parsed)));
}

function percentToBps(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(10_000, Math.round(parsed * 100)));
}

function formatSliderPercent(value: number) {
  const rounded = Math.max(0.5, Math.min(10, Math.round(value * 2) / 2));
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: value >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000_000 ? 2 : 0
  }).format(value);
}

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className="fieldHelp" tabIndex={0} aria-label={text}>
          <CircleHelp size={14} />
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="uxTooltip" sideOffset={8}>
          {text}
          <Tooltip.Arrow className="uxTooltipArrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function FieldLabel({ children, help }: { children: string; help: string }) {
  return (
    <span className="fieldLabelText">
      {children}
      <InfoTip text={help} />
    </span>
  );
}

function OptionalFieldLabel({ children }: { children: string }) {
  return (
    <span className="optionalFieldLabel">
      <span>{children}</span>
      <small>optional</small>
    </span>
  );
}

function CategorySelect({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) {
  return (
    <Select.Root value={value} onValueChange={onValueChange}>
      <Select.Trigger className="uxSelectTrigger" aria-label="Project category">
        <Select.Value />
        <Select.Icon><ChevronDown size={16} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="uxSelectContent" position="popper" sideOffset={8}>
          <Select.Viewport>
            {categoryOptions.map((option) => (
              <Select.Item className="uxSelectItem" key={option} value={option}>
                <Select.ItemText>{option}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export function LaunchConsole() {
  const router = useRouter();
  const [activeStep, setActiveStep] = useState(0);
  const [projectName, setProjectName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [shortPitch, setShortPitch] = useState("");
  const [longDescription, setLongDescription] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [bannerUrl, setBannerUrl] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [logoFileName, setLogoFileName] = useState("");
  const [bannerFileName, setBannerFileName] = useState("");
  const [website, setWebsite] = useState("");
  const [xUrl, setXUrl] = useState("");
  const [telegram, setTelegram] = useState("");
  const [discord, setDiscord] = useState("");
  const [docs, setDocs] = useState("");
  const [category, setCategory] = useState("Meme / community");
  const [tags, setTags] = useState("pump.fun, fair launch, creator buy-in");
  const [durationTick, setDurationTick] = useState(() => secondsToDurationTick(3600));
  const [targetRaise, setTargetRaise] = useState("100");
  const [creatorBuyIn, setCreatorBuyIn] = useState(DEFAULT_CREATOR_BUY_IN);
  const [maxWalletCapEnabled, setMaxWalletCapEnabled] = useState(true);
  const [maxWalletSupplyPercent, setMaxWalletSupplyPercent] = useState("3");
  const [vestingEnabled, setVestingEnabled] = useState(true);
  const [initialUnlockPercent, setInitialUnlockPercent] = useState("0");
  const [cliffSeconds, setCliffSeconds] = useState("86400");
  const [linearSeconds, setLinearSeconds] = useState("604800");
  const [createdPresale, setCreatedPresale] = useState<string | null>(null);
  const [lastSignature, setLastSignature] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string>("Ready when you are.");
  const [publishStage, setPublishStage] = useState<"idle" | "media" | "metadata" | "wallet" | "register" | "done" | "error">("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [solUsdPrice, setSolUsdPrice] = useState(SOL_USD_FALLBACK);
  const logoPreviewUrlRef = useRef<string | null>(null);
  const bannerPreviewUrlRef = useRef<string | null>(null);
  const durationSecondsRef = useRef(3600);
  const { connection } = useConnection();
  const wallet = useStickWallet();
  const runtimeConfig = useMemo(() => getRuntimeConfig(), []);

  useEffect(() => {
    return () => {
      if (logoPreviewUrlRef.current) URL.revokeObjectURL(logoPreviewUrlRef.current);
      if (bannerPreviewUrlRef.current) URL.revokeObjectURL(bannerPreviewUrlRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchSolUsdtPrice() {
      try {
        const response = await fetch("/api/market/sol-usdt", { cache: "no-store" });
        const json = await response.json() as { price?: number };
        if (!cancelled && response.ok && typeof json.price === "number" && Number.isFinite(json.price)) {
          setSolUsdPrice(json.price);
        }
      } catch {
        // Keep the last known price; UI estimates should not block launch creation.
      }
    }

    void fetchSolUsdtPrice();
    const interval = window.setInterval(() => void fetchSolUsdtPrice(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const decimals = quoteDecimals(QUOTE_ASSET);
  const durationSeconds = durationTickToSeconds(durationTick);
  const targetRaiseUnits = useMemo(() => safeBaseUnits(clampNumber(targetRaise, "0"), decimals), [targetRaise, decimals]);
  const devbuyUnits = useMemo(() => safeBaseUnits(clampNumber(creatorBuyIn, "0"), decimals), [creatorBuyIn, decimals]);
  const minDevbuyUnits = useMemo(() => toBaseUnits(MIN_CREATOR_BUY_IN, decimals), [decimals]);
  const maxWalletSupplyBps = maxWalletCapEnabled ? percentToBps(maxWalletSupplyPercent) : 0;
  const pumpSpendUnits = useMemo(() => calculatePumpSpendFromTarget(targetRaiseUnits), [targetRaiseUnits]);
  const minContributionUnits = useMemo(() => toBaseUnits("0.01", decimals), [decimals]);
  const simulatedRaised = useMemo(() => toBaseUnits("18.42", decimals), [decimals]);
  const pumpCompletion = useMemo(() => calculatePumpCurveCompletion(), []);

  const finalizePlan = quoteFinalizePlan({
    totalQuote: pumpSpendUnits.gt(new BN(0)) ? pumpSpendUnits : simulatedRaised,
    curve: {
      quoteRemainingToGraduate: pumpCompletion.realSolReserves,
      expectedTokensBeforeMigration: new BN("720000000000000"),
      expectedTokensAfterMigration: new BN("180000000000000"),
      migrationRequired: true
    }
  });

  const previewName = projectName.trim() || "Unnamed Launch";
  const previewSymbol = symbol.trim() || "TOKEN";
  const estimatedRouteSol = Number(formatAmount(pumpSpendUnits, decimals));
  const estimatedMarketCapLamports = useMemo(
    () => estimatePumpRouteMarketCapLamports({
      totalQuoteLamports: pumpSpendUnits.gt(new BN(0)) ? pumpSpendUnits : simulatedRaised
    }),
    [pumpSpendUnits, simulatedRaised]
  );
  const estimatedMarketCapUsd = Number(formatAmount(estimatedMarketCapLamports, SOL_DECIMALS)) * solUsdPrice;
  const completionItems = [
    { label: "Project identity", done: Boolean(projectName && symbol && shortPitch) },
    { label: "Logo and 3:1 banner", done: Boolean(logoUrl && bannerUrl) },
    { label: "Target configured", done: targetRaiseUnits.gt(new BN(0)) },
    { label: "Creator buy-in set", done: devbuyUnits.gte(minDevbuyUnits) },
    { label: "Max wallet cap reviewed", done: true },
    { label: "Vesting reviewed", done: true },
    { label: "Settlement route visible", done: true }
  ];
  const missingRequiredItems = completionItems.filter((item) => !item.done).map((item) => item.label);
  const canPublish = missingRequiredItems.length === 0 && targetRaiseUnits.gt(new BN(0)) && devbuyUnits.gte(minDevbuyUnits) && !isSubmitting;
  const activeVestingPreset = useMemo(() => {
    return vestingPresets.find((preset) =>
      initialUnlockPercent === preset.initial &&
      cliffSeconds === preset.cliff &&
      linearSeconds === preset.linear
    )?.label ?? "";
  }, [cliffSeconds, initialUnlockPercent, linearSeconds]);

  function setRaiseDurationFromTick(nextTick: number) {
    const normalizedTick = Math.max(0, Math.min(DURATION_SLIDER_MAX, Math.round(nextTick)));
    const nextSeconds = durationTickToSeconds(normalizedTick);
    durationSecondsRef.current = nextSeconds;
    setDurationTick(normalizedTick);
  }

  function setRaiseDurationFromSeconds(nextSeconds: string | number) {
    setRaiseDurationFromTick(secondsToDurationTick(normalizeDurationSeconds(nextSeconds)));
  }

  async function handleImageUpload(file: File | undefined, target: "logo" | "banner") {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setActionStatus("Upload an image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setActionStatus("Image file must be 5MB or smaller.");
      return;
    }
    try {
      const previewUrl = URL.createObjectURL(file);
      if (target === "logo") {
        if (logoPreviewUrlRef.current) URL.revokeObjectURL(logoPreviewUrlRef.current);
        logoPreviewUrlRef.current = previewUrl;
        setLogoUrl(previewUrl);
        setLogoFile(file);
        setLogoFileName(file.name);
      } else {
        if (bannerPreviewUrlRef.current) URL.revokeObjectURL(bannerPreviewUrlRef.current);
        bannerPreviewUrlRef.current = previewUrl;
        setBannerUrl(previewUrl);
        setBannerFile(file);
        setBannerFileName(file.name);
      }
      setActionStatus(`${target === "logo" ? "Logo" : "Banner"} loaded from file.`);
    } catch {
      setActionStatus("Image preview failed.");
    }
  }

  async function startPresale() {
    if (!wallet.publicKey) {
      await wallet.connect();
      setActionStatus("Connect your wallet, then start the presale.");
      return;
    }
    if (missingRequiredItems.length > 0) {
      setPublishStage("error");
      setActionStatus(`Complete before launch: ${missingRequiredItems.join(", ")}.`);
      return;
    }
    if (targetRaiseUnits.lte(new BN(0))) {
      setPublishStage("error");
      setActionStatus("Target must be greater than zero.");
      return;
    }
    if (devbuyUnits.lt(minDevbuyUnits) || devbuyUnits.gt(targetRaiseUnits)) {
      setPublishStage("error");
      setActionStatus(`Creator buy-in must be at least ${MIN_CREATOR_BUY_IN} SOL and no larger than the target.`);
      return;
    }
    setIsSubmitting(true);
    try {
      assertMainnetProgramConfigured(runtimeConfig);
      setPublishStage("media");
      setActionStatus("Uploading logo and banner...");
      const [logoAsset, bannerAsset] = await Promise.all([
        logoFile ? publishProjectAsset(logoFile) : Promise.resolve(null),
        bannerFile ? publishProjectAsset(bannerFile) : Promise.resolve(null)
      ]);
      const uploadedLogoUrl = logoAsset?.gatewayUrl ?? "";
      const uploadedBannerUrl = bannerAsset?.gatewayUrl ?? "";
      const websiteUrl = normalizeOptionalProjectUrl(website) ?? "";
      const xProjectUrl = normalizeOptionalProjectUrl(xUrl) ?? "";
      const telegramUrl = normalizeOptionalProjectUrl(telegram) ?? "";
      const discordUrl = normalizeOptionalProjectUrl(discord) ?? "";
      const docsUrl = normalizeOptionalProjectUrl(docs) ?? "";
      const metadata: ProjectMetadata = {
        name: previewName,
        symbol: previewSymbol,
        logoUrl: uploadedLogoUrl,
        bannerUrl: uploadedBannerUrl,
        shortPitch,
        longDescription,
        website: websiteUrl,
        x: xProjectUrl,
        telegram: telegramUrl,
        discord: discordUrl,
        docs: docsUrl,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        category,
        riskNotes: [],
        tokenomics: {
          presaleBps: 7_000,
          devbuyBps: 500,
          rewardsBps: 4_000,
          buybackBps: 2_500,
          liquidityBps: 2_000
        }
      };
      setPublishStage("metadata");
      setActionStatus("Uploading token metadata through Pump.fun...");
      const published = await publishProjectMetadata(metadata, logoFile);
      const presaleId = new BN(Date.now());
      const presale = presalePda(runtimeConfig.programId, wallet.publicKey, presaleId);
      const mint = mintPda(runtimeConfig.programId, presale);
      const launchDurationSeconds = durationSecondsRef.current;
      const devbuyWeight = calculateDevbuyWeight({
        devbuyAmount: devbuyUnits,
        durationSeconds: launchDurationSeconds,
        hardCap: targetRaiseUnits,
        boostPreset: BOOST_PRESET
      });

      const createIx = buildCreatePresaleInstruction({
        programId: runtimeConfig.programId,
        creator: wallet.publicKey,
        presaleId,
        input: {
          launchType: FAIR_LAUNCH_TYPE,
          quoteAsset: QUOTE_ASSET,
          boostPreset: BOOST_PRESET,
          mint,
          quoteMint: quoteMintForAsset(QUOTE_ASSET, runtimeConfig.cluster),
          durationSeconds: launchDurationSeconds,
          minContribution: minContributionUnits,
          devbuyRequiredAmount: devbuyUnits,
          devVestingCliffSeconds: vestingEnabled ? Number(clampNumber(cliffSeconds, "0")) : 0,
          devVestingLinearSeconds: vestingEnabled ? Number(clampNumber(linearSeconds, "0")) : 0,
          devVestingInitialUnlockBps: vestingEnabled ? percentToBps(initialUnlockPercent) : 10_000,
          softCap: targetRaiseUnits,
          hardCap: targetRaiseUnits,
          maxWalletContribution: new BN(0),
          ticketSize: new BN(0),
          maxTicketsPerWallet: 0
        },
        metadataUri: published.uri,
        rewardPreset: REWARD_PRESET,
        vestingPreset: vestingEnabled ? "Linear7Days" : "Instant"
      });
      setPublishStage("wallet");
      setActionStatus("Open your wallet to start the presale and pay the creator buy-in.");
      const signature = await signAndSendInstructions({
        connection,
        wallet,
        sponsored: runtimeConfig.sponsoredTransactions,
        instructions: [
          createIx,
          buildSolDevbuyInstruction(runtimeConfig.programId, presale, wallet.publicKey, devbuyUnits),
          buildOpenPresaleInstruction(runtimeConfig.programId, presale, wallet.publicKey)
        ]
      });
      setPublishStage("register");
      setActionStatus("Registering the public launch page...");
      await fetch("/api/launches/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          presaleAddress: presale.toBase58(),
          mintAddress: mint.toBase58(),
          creator: wallet.publicKey.toBase58(),
          signature,
          name: previewName,
          symbol: previewSymbol,
          description: shortPitch,
          metadataUri: published.uri,
          avatarUrl: uploadedLogoUrl,
          bannerUrl: uploadedBannerUrl,
          website: websiteUrl,
          x: xProjectUrl,
          telegram: telegramUrl,
          discord: discordUrl,
          docs: docsUrl,
          targetLamports: targetRaiseUnits.toString(),
          devbuyLamports: devbuyUnits.toString(),
          devbuyWeight: devbuyWeight.toString(),
          maxWalletSupplyBps,
          startAt: new Date().toISOString(),
          endAt: new Date(Date.now() + launchDurationSeconds * 1000).toISOString()
        })
      }).then(async (response) => {
        if (!response.ok) {
          const json = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(json.error ?? "Presale started, but database registration failed.");
        }
      });
      setCreatedPresale(presale.toBase58());
      setLastSignature(signature);
      setPublishStage("done");
      setActionStatus("Presale started. Opening the public launch page...");
      window.setTimeout(() => router.push(`/presale/${presale.toBase58()}`), 700);
    } catch (error) {
      setPublishStage("error");
      setActionStatus(friendlyLaunchError(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Tooltip.Provider delayDuration={160}>
    <main className="futardLanding createFutardShell">
      <FutardHeader />

      <LiveTicker />

      {!wallet.publicKey ? (
        <section className="createGate">
          <div className="createGateHero">
            <div className="createGateCopy">
              <h1>Open your presale</h1>
              <p>
                Connect your wallet to create a public launch page, set your raise terms,
                and start with a visible creator buy-in.
              </p>
              <ul>
                <li><strong>Public creator buy-in</strong> — configured by you and paid when the presale starts</li>
                <li><strong>One public page</strong> — images, links, target, timer, and vesting in one place</li>
                <li><strong>Claim refunds</strong> — buyers claim tokens and unused SOL after settlement</li>
              </ul>
            </div>
            <div className="createConnectPanel">
              <WalletButton />
            </div>
          </div>

          <div className="createGateGrid">
            <section>
              <h2>What you'll need</h2>
              <p>Before you begin, have these ready:</p>
              <div className="createNeedList">
                {createRequirements.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label}>
                      <span><Icon size={18} /></span>
                      <strong>{item.label}</strong>
                    </div>
                  );
                })}
              </div>
            </section>

            <section>
              <h2>What happens after you connect</h2>
              <ol className="createTimeline">
                {postPaySteps.map(([number, title, text]) => (
                  <li key={number}>
                    <span>{number}</span>
                    <div>
                      <strong>{title}</strong>
                      <p>{text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </section>
      ) : (
        <section className="createStudio">
          <div className="createStudioHeader">
            <div>
              <h1>Create your launch</h1>
            </div>
          </div>

          <div className="createStudioLayout">
            <section className="createBuilder">
              <nav className="createStepper" aria-label="Create flow">
                {wizardSteps.map((step, index) => (
                  <button
                    key={step.title}
                    className={index === activeStep ? "createStep active" : index < activeStep ? "createStep done" : "createStep"}
                    onClick={() => setActiveStep(index)}
                    type="button"
                  >
                    <span>{index + 1}</span>
                    <strong>{step.title}</strong>
                  </button>
                ))}
              </nav>

              <div className="createFormSurface">
                {activeStep === 0 && (
                  <div className="createSection">
                    <div className="createSectionHeader">
                      <div>
                        <h3>Project profile</h3>
                      </div>
                    </div>
                    <div className="createGrid two">
                      <label>
                        <FieldLabel help="Use the public name buyers will recognize.">Project name</FieldLabel>
                        <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Project name" />
                      </label>
                      <label>
                        <FieldLabel help="Keep it short and easy to remember.">Ticker</FieldLabel>
                        <input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="TOKEN" maxLength={12} />
                      </label>
                    </div>
                    <label>
                      <FieldLabel help="One clear sentence for cards and the launch page.">Short pitch</FieldLabel>
                      <input value={shortPitch} onChange={(event) => setShortPitch(event.target.value)} placeholder="A short reason people should care about the launch." />
                    </label>
                    <label>
                      <FieldLabel help="Tell buyers what the project is, why it exists, and what happens next.">Description</FieldLabel>
                      <textarea value={longDescription} onChange={(event) => setLongDescription(event.target.value)} placeholder="Describe the project, the community, and the launch plan." />
                    </label>
                    <div className="createGrid two">
                      <label className="fileUploadField">
                        <FieldLabel help="Upload a square token logo. PNG, JPG, GIF or WebP up to 5MB.">Logo file</FieldLabel>
                        <span className="fileUploadBox">
                          <Image size={18} />
                          <strong>{logoFileName || "Upload logo"}</strong>
                          <small>Square image, max 5MB</small>
                        </span>
                        <input
                          accept="image/*"
                          onChange={(event) => void handleImageUpload(event.target.files?.[0], "logo")}
                          type="file"
                        />
                      </label>
                      <label className="fileUploadField">
                        <FieldLabel help="Upload a 3:1 banner. It is cropped consistently anywhere a banner appears. PNG, JPG, GIF or WebP up to 5MB.">Banner file</FieldLabel>
                        <span className="fileUploadBox">
                          <Image size={18} />
                          <strong>{bannerFileName || "Upload 3:1 banner"}</strong>
                          <small>3:1 image, max 5MB</small>
                        </span>
                        <input
                          accept="image/*"
                          onChange={(event) => void handleImageUpload(event.target.files?.[0], "banner")}
                          type="file"
                        />
                      </label>
                    </div>
                    <div className="createGrid three">
                      <label><OptionalFieldLabel>Website</OptionalFieldLabel><input value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://..." /></label>
                      <label><OptionalFieldLabel>X</OptionalFieldLabel><input value={xUrl} onChange={(event) => setXUrl(event.target.value)} placeholder="https://x.com/..." /></label>
                      <label><OptionalFieldLabel>Telegram</OptionalFieldLabel><input value={telegram} onChange={(event) => setTelegram(event.target.value)} placeholder="https://t.me/..." /></label>
                      <label><OptionalFieldLabel>Discord</OptionalFieldLabel><input value={discord} onChange={(event) => setDiscord(event.target.value)} placeholder="https://discord.gg/..." /></label>
                      <label><OptionalFieldLabel>Docs</OptionalFieldLabel><input value={docs} onChange={(event) => setDocs(event.target.value)} placeholder="https://docs..." /></label>
                      <label><OptionalFieldLabel>Category</OptionalFieldLabel><CategorySelect value={category} onValueChange={setCategory} /></label>
                    </div>
                  </div>
                )}

                {activeStep === 1 && (
                  <div className="createSection">
                    <div className="createSectionHeader">
                      <div>
                        <h3>Raise settings</h3>
                      </div>
                    </div>
                    <div className="createModelPanel">
                      <div>
                        <span>STICK RAISE</span>
                        <strong>Open until the timer ends</strong>
                      <p>Buyers can join for the full window. If demand goes above target, unused SOL is returned when they claim.</p>
                      </div>
                      <code>Earlier support receives more allocation weight.</code>
                    </div>
                    <div className="createGrid two raiseControls">
                      <div className="rangeField">
                        <FieldLabel help="How long the presale stays open. Shorter windows create urgency; longer windows give more people time to join.">Raise window</FieldLabel>
                        <div className="rangeValueLine">
                          <strong>{formatDuration(durationSeconds)}</strong>
                          <span>1 minute - 1 day</span>
                        </div>
                        <Slider.Root
                          aria-label="Raise window"
                          className="uxSlider"
                          max={DURATION_SLIDER_MAX}
                          min={0}
                          onValueChange={([value]) => setRaiseDurationFromTick(value ?? 0)}
                          step={1}
                          value={[durationTick]}
                        >
                          <Slider.Track className="uxSliderTrack">
                            <Slider.Range className="uxSliderRange" />
                          </Slider.Track>
                          <Slider.Thumb className="uxSliderThumb" />
                        </Slider.Root>
                        <div className="rangeMarks">
                          {durationMarks.map(([label, value]) => (
                            <button
                              aria-pressed={secondsToDurationTick(Number(value)) === durationTick}
                              className={secondsToDurationTick(Number(value)) === durationTick ? "active" : undefined}
                              key={value}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setRaiseDurationFromSeconds(value);
                              }}
                              type="button"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label>
                        <FieldLabel help="The SOL amount used for launch if the raise succeeds. The creator buy-in counts toward this number.">Target</FieldLabel>
                        <div className="amountInput"><input value={targetRaise} onChange={(event) => setTargetRaise(sanitizeDecimalInput(event.target.value))} inputMode="decimal" /><span>SOL</span></div>
                      </label>
                      <label>
                        <FieldLabel help="Your first commitment. It is public, counts toward target, and uses the same allocation rules as everyone else.">Creator buy-in</FieldLabel>
                        <div className={`amountInput ${creatorBuyIn && devbuyUnits.lt(minDevbuyUnits) ? "invalid" : ""}`}>
                          <input
                            aria-invalid={creatorBuyIn ? devbuyUnits.lt(minDevbuyUnits) : undefined}
                            min={MIN_CREATOR_BUY_IN}
                            onBlur={() => {
                              if (devbuyUnits.lt(minDevbuyUnits)) {
                                setCreatorBuyIn(MIN_CREATOR_BUY_IN);
                              }
                            }}
                            onChange={(event) => setCreatorBuyIn(sanitizeDecimalInput(event.target.value))}
                            inputMode="decimal"
                            value={creatorBuyIn}
                          />
                          <span>SOL</span>
                        </div>
                        <small>Minimum {MIN_CREATOR_BUY_IN} SOL. This buy-in is public and counts toward target.</small>
                      </label>
                    </div>
                    <label className="createToggleLine">
                      <Switch.Root className="uxSwitch" checked={maxWalletCapEnabled} onCheckedChange={setMaxWalletCapEnabled}>
                        <Switch.Thumb className="uxSwitchThumb" />
                      </Switch.Root>
                      <span>
                        Max wallet cap
                        <small>Limits final allocation per wallet by total token supply. Turn it off for unrestricted weighted settlement.</small>
                      </span>
                    </label>
                    <div className="createGrid two sliderGrid">
                      <label className="rangeField">
                        <FieldLabel help="Maximum launched token supply one wallet can receive after settlement. If the cap prevents using the full target, less SOL is routed and the rest stays refundable.">Max allocation per wallet</FieldLabel>
                        <div className="rangeValueLine">
                          <strong>{maxWalletCapEnabled ? `${maxWalletSupplyPercent || "0"}%` : "Off"}</strong>
                          <span>{maxWalletCapEnabled ? "0.5-10% supply" : "No supply cap"}</span>
                        </div>
                        <Slider.Root
                          aria-label="Max wallet allocation"
                          className="uxSlider"
                          disabled={!maxWalletCapEnabled}
                          max={10}
                          min={0.5}
                          onValueChange={([value]) => setMaxWalletSupplyPercent(formatSliderPercent(value ?? 3))}
                          step={0.5}
                          value={[Number(maxWalletSupplyPercent || 3)]}
                        >
                          <Slider.Track className="uxSliderTrack"><Slider.Range className="uxSliderRange" /></Slider.Track>
                          <Slider.Thumb className="uxSliderThumb" />
                        </Slider.Root>
                      </label>
                    </div>
                    <div className="createNotice">
                      <Info size={17} />
                      <span>If the raise goes above target, allocation is weighted and unused SOL is returned at claim.{maxWalletCapEnabled ? ` No wallet can settle above ${maxWalletSupplyPercent}% of supply.` : ""}</span>
                    </div>
                  </div>
                )}

                {activeStep === 2 && (
                  <div className="createSection">
                    <div className="createSectionHeader">
                      <div>
                        <h3>Creator vesting</h3>
                      </div>
                    </div>
                    <label className="createToggleLine">
                      <Switch.Root className="uxSwitch" checked={vestingEnabled} onCheckedChange={setVestingEnabled}>
                        <Switch.Thumb className="uxSwitchThumb" />
                      </Switch.Root>
                      <span>
                        Vest creator allocation
                        <small>Choose how your creator buy-in unlocks after launch.</small>
                      </span>
                    </label>
                    <ToggleGroup.Root
                      className="vestingPresetRow"
                      disabled={!vestingEnabled}
                      onValueChange={(value) => {
                        const preset = vestingPresets.find((item) => item.label === value);
                        if (!preset) return;
                        setInitialUnlockPercent(preset.initial);
                        setCliffSeconds(preset.cliff);
                        setLinearSeconds(preset.linear);
                      }}
                      type="single"
                      value={activeVestingPreset}
                    >
                      {vestingPresets.map((preset) => {
                        return <ToggleGroup.Item className="vestingPresetItem" key={preset.label} value={preset.label}>{preset.label}</ToggleGroup.Item>;
                      })}
                    </ToggleGroup.Root>
                    <div className="createGrid three sliderGrid">
                      <label className="rangeField">
                        <FieldLabel help="Percent of creator allocation available immediately after settlement.">Initial unlock</FieldLabel>
                        <div className="rangeValueLine"><strong>{initialUnlockPercent || "0"}%</strong><span>0-100%</span></div>
                        <Slider.Root
                          className="uxSlider"
                          disabled={!vestingEnabled}
                          max={100}
                          min={0}
                          onValueChange={([value]) => setInitialUnlockPercent(String(value ?? 0))}
                          step={5}
                          value={[Number(initialUnlockPercent || 0)]}
                        >
                          <Slider.Track className="uxSliderTrack"><Slider.Range className="uxSliderRange" /></Slider.Track>
                          <Slider.Thumb className="uxSliderThumb" />
                        </Slider.Root>
                      </label>
                      <label className="rangeField">
                        <FieldLabel help="Waiting period before linear unlock begins.">Cliff</FieldLabel>
                        <div className="rangeValueLine"><strong>{formatDuration(Number(cliffSeconds))}</strong><span>0-7 days</span></div>
                        <Slider.Root
                          className="uxSlider"
                          disabled={!vestingEnabled}
                          max={604_800}
                          min={0}
                          onValueChange={([value]) => setCliffSeconds(String(value ?? 0))}
                          step={3_600}
                          value={[Number(cliffSeconds || 0)]}
                        >
                          <Slider.Track className="uxSliderTrack"><Slider.Range className="uxSliderRange" /></Slider.Track>
                          <Slider.Thumb className="uxSliderThumb" />
                        </Slider.Root>
                      </label>
                      <label className="rangeField">
                        <FieldLabel help="Length of the linear unlock after the cliff.">Linear unlock</FieldLabel>
                        <div className="rangeValueLine"><strong>{formatDuration(Number(linearSeconds))}</strong><span>0-90 days</span></div>
                        <Slider.Root
                          className="uxSlider"
                          disabled={!vestingEnabled}
                          max={7_776_000}
                          min={0}
                          onValueChange={([value]) => setLinearSeconds(String(value ?? 0))}
                          step={86_400}
                          value={[Number(linearSeconds || 0)]}
                        >
                          <Slider.Track className="uxSliderTrack"><Slider.Range className="uxSliderRange" /></Slider.Track>
                          <Slider.Thumb className="uxSliderThumb" />
                        </Slider.Root>
                      </label>
                    </div>
                    <div className="createNotice">
                      <LockKeyhole size={17} />
                      <span>{vestingEnabled ? `Current schedule: ${initialUnlockPercent || "0"}% upfront, ${formatDuration(Number(cliffSeconds))} cliff, ${formatDuration(Number(linearSeconds))} linear unlock.` : "Vesting is off: creator allocation is available after settlement."}</span>
                    </div>
                  </div>
                )}

                {activeStep === 3 && (
                  <div className="createSection">
                    <div className="createSectionHeader">
                      <div>
                        <h3>Publish checklist</h3>
                      </div>
                    </div>
                    <div className="publishChecklist">
                      {completionItems.map((item) => (
                        <div key={item.label} className={item.done ? "done" : ""}>
                          <CheckCircle2 size={17} />
                          <span>{item.label}</span>
                        </div>
                      ))}
                    </div>
                    <div className="publishStageList" aria-live="polite">
                      {([
                        ["media", "Upload media"],
                        ["metadata", "Publish metadata"],
                        ["wallet", "Wallet signature"],
                        ["register", "Create public page"]
                      ] as const).map(([stage, label]) => (
                        <span
                          className={
                            publishStage === stage
                              ? "active"
                              : publishStage === "done" || publishStageOrder(publishStage) > publishStageOrder(stage)
                                ? "done"
                                : ""
                          }
                          key={stage}
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                    <div className="publishActions">
                      <button disabled={!canPublish} onClick={startPresale} type="button">
                        {isSubmitting ? "Starting..." : missingRequiredItems.length > 0 ? "Complete required fields" : "Start presale"}
                      </button>
                    </div>
                    <div className="transactionStatus">
                      <strong>Status</strong>
                      <span>{actionStatus}</span>
                      {createdPresale && (
                        <span>
                          Presale: {createdPresale} · <Link href={`/presale/${createdPresale}`}>Open public page</Link>
                        </span>
                      )}
                      {lastSignature && <span>Last transaction: {lastSignature}</span>}
                    </div>
                  </div>
                )}
              </div>

              <div className="createFooterNav">
                <button disabled={activeStep === 0} onClick={() => setActiveStep((step) => Math.max(0, step - 1))} type="button">
                  <ChevronLeft size={16} /> Back
                </button>
                <button disabled={activeStep === wizardSteps.length - 1} onClick={() => setActiveStep((step) => Math.min(wizardSteps.length - 1, step + 1))} type="button">
                  Continue <ChevronRight size={16} />
                </button>
              </div>
            </section>

            <aside className="createPreviewRail">
              <section className="createPreviewCard">
                <div className="previewMedia" style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined}>
                  <div className="previewAvatar" style={logoUrl ? { backgroundImage: `url(${logoUrl})` } : undefined}>
                    {!logoUrl && previewSymbol.slice(0, 2)}
                  </div>
                </div>
                <div className="previewBody">
                  <div className="previewTokenHeader">
                    <div>
                      <strong>{previewName}</strong>
                      <span>${previewSymbol} / SOL</span>
                    </div>
                    <span className="previewStatus">Draft</span>
                  </div>
                  <p>{shortPitch || "A concise project pitch will appear here."}</p>
                  <div className="previewFacts">
                    <div><span>Type</span><strong>Timed weighted raise</strong></div>
                    <div><span>Window</span><strong>{formatDuration(durationSeconds)}</strong></div>
                    <div><span>Target</span><strong>{formatAmount(targetRaiseUnits, decimals)} SOL</strong></div>
                    <div><span>Creator buy-in</span><strong>{formatAmount(devbuyUnits, decimals)} SOL</strong></div>
                    <div><span>Max wallet</span><strong>{maxWalletCapEnabled ? `${maxWalletSupplyPercent}% supply` : "Off"}</strong></div>
                    <div><span>Est. FDV</span><strong>{formatUsd(estimatedMarketCapUsd)}</strong></div>
                  </div>
                </div>
              </section>

              <section className="createSidePanel">
                <div className="sidePanelHeader">
                  <BarChart3 size={17} />
                  <strong>Launch estimate</strong>
                </div>
                <div className="sideRows">
                  <div><span>Launch path</span><strong>{finalizePlan.strategy === "PumpThenPumpSwap" ? "Pump.fun + PumpSwap" : "Pump.fun only"}</strong></div>
                  <div><span>SOL price</span><strong>{formatUsd(solUsdPrice)}</strong></div>
                  <div><span>Total target</span><strong>{formatAmount(targetRaiseUnits, decimals)} SOL</strong></div>
                  <div><span>Creator buy-in</span><strong>{formatAmount(devbuyUnits, decimals)} SOL</strong></div>
                  <div><span>Max wallet</span><strong>{maxWalletCapEnabled ? `${maxWalletSupplyPercent}% supply` : "Off"}</strong></div>
                  <div><span>Launch spend</span><strong>{estimatedRouteSol.toFixed(2)} SOL</strong></div>
                  <div><span>Est. FDV</span><strong>{formatUsd(estimatedMarketCapUsd)}</strong></div>
                </div>
              </section>
            </aside>
          </div>
        </section>
      )}
    </main>
    </Tooltip.Provider>
  );
}

function publishStageOrder(stage: string) {
  return {
    idle: 0,
    media: 1,
    metadata: 2,
    wallet: 3,
    register: 4,
    done: 5,
    error: 0
  }[stage] ?? 0;
}

function normalizeOptionalProjectUrl(value: string) {
  const repaired = value.trim()
    .replace(/^https\/\//i, "https://")
    .replace(/^http\/\//i, "http://");
  if (!repaired) return "";
  try {
    const url = new URL(repaired);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function friendlyLaunchError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (raw.includes("User rejected") || raw.includes("rejected")) return "Launch was cancelled in the wallet.";
  if (raw.includes("insufficient") || raw.includes("Attempt to debit")) return "Not enough SOL for the creator buy-in and network fees.";
  if (raw.includes("Image file")) return raw;
  if (raw.includes("IPFS") || raw.includes("metadata")) return "Project metadata could not be published. Check the IPFS configuration and try again.";
  if (raw.includes("database") || raw.includes("registration")) return "The presale transaction landed, but the public page was not registered. Check the indexer/database.";
  if (raw.includes("block height exceeded") || raw.includes("expired")) return "Network confirmation expired. Try again with a fresh transaction.";
  return raw || "Start presale failed. Try again.";
}
