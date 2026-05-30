const BINANCE_SOLUSDT_URLS = [
  "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
  "https://api.binance.us/api/v3/ticker/price?symbol=SOLUSDT"
];
const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_500;
const SOL_USD_FALLBACK = 170;

type SolUsdtCache = {
  price: number | null;
  updatedAt: number | null;
  error?: string;
};

const cache: SolUsdtCache = {
  price: null,
  updatedAt: null
};

let refreshPromise: Promise<void> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

export function startSolUsdtRefreshLoop() {
  if (refreshTimer) return;

  refreshTimer = setInterval(() => {
    void refreshSolUsdtPrice();
  }, REFRESH_MS);
  refreshTimer.unref?.();
}

export async function getSolUsdtPrice() {
  startSolUsdtRefreshLoop();

  if (isStale()) {
    await refreshSolUsdtPrice();
  }

  return cache.price ?? SOL_USD_FALLBACK;
}

export function getSolUsdtCache() {
  return {
    ...cache,
    refreshMs: REFRESH_MS,
    source: "binance" as const
  };
}

function isStale() {
  return !cache.updatedAt || Date.now() - cache.updatedAt >= REFRESH_MS;
}

async function refreshSolUsdtPrice() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      let lastError = "Invalid Binance SOLUSDT response.";

      for (const url of BINANCE_SOLUSDT_URLS) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
          const response = await fetch(url, {
            cache: "no-store",
            headers: {
              accept: "application/json"
            },
            signal: controller.signal
          });
          const json = await response.json() as { price?: string; msg?: string };
          const price = Number(json.price);

          if (response.ok && Number.isFinite(price) && price > 0) {
            cache.price = price;
            cache.updatedAt = Date.now();
            cache.error = undefined;
            return;
          }

          lastError = json.msg ?? lastError;
        } catch (error) {
          lastError = error instanceof Error ? error.message : lastError;
        } finally {
          clearTimeout(timeout);
        }
      }

      throw new Error(lastError);
    } catch (error) {
      cache.error = error instanceof Error ? error.message : "Failed to fetch SOLUSDT price.";
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}
