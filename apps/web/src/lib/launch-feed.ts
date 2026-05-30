export type LaunchStatus = "LIVE" | "COMPLETED" | "REFUNDED";

export type LaunchCardView = {
  id: string;
  presaleAddress: string;
  name: string;
  symbol: string;
  status: LaunchStatus;
  rawStatus?: LaunchStatus;
  mode: string;
  description: string;
  committedLabel: string;
  goalLabel: string;
  progressPercent: number;
  contributorsLabel: string;
  fdvLabel?: string;
  maxWalletSupplyBps?: number;
  avatarUrl?: string;
  bannerUrl?: string;
  startsAt?: string;
  endsAt?: string;
};

export type LaunchedTokenView = {
  id: string;
  presaleAddress: string;
  name: string;
  symbol: string;
  marketCapLabel?: string;
  raisedLabel: string;
  liquidityLabel?: string;
  routeLabel: string;
  mint: string;
  dexScreenerUrl: string;
  presaleId: string;
  avatarUrl?: string;
  bannerUrl?: string;
};

export const activeLaunches: LaunchCardView[] = [];

export const launchedTokens: LaunchedTokenView[] = [];

export const liveFeedItems: string[] = [];

export const platformStats = {
  committedLabel: "$0",
  fundersLabel: "0",
  activeLabel: "0",
  launchedLabel: "0"
};
