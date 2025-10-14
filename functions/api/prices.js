// Cloudflare Pages Functions - /api/prices
// GET /api/prices?symbols=XRP_USDT,BTC_USDT

const FUTURES_TICKER_API = "https://futures.mexc.com/api/v1/contract/ticker";
const SPOT_TICKER_API = "https://api.mexc.com/api/v3/ticker/price";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.mexc.com/",
  Origin: "https://www.mexc.com",
  Connection: "keep-alive",
};

function corsHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "Content-Type, X-API-Key",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, { headers = {}, timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

async function fetchWithRetry(url, opts = {}, retries = 1) {
  try {
    return await fetchJSON(url, opts);
  } catch (e) {
    if (retries <= 0) throw e;
    await sleep(200 + Math.floor(Math.random() * 200));
    return fetchWithRetry(url, opts, retries - 1);
  }
}

async function getFuturesMap() {
  const json = await fetchWithRetry(FUTURES_TICKER_API, {
    headers: BROWSER_HEADERS,
    timeoutMs: 6000,
  });
  const arr = Array.isArray(json?.data) ? json.data : json?.data ? [json.data] : [];
  const map = new Map();
  for (const it of arr) {
    const sym = it?.symbol;
    const p = Number(it?.lastPrice || it?.fairPrice || it?.indexPrice || 0);
    if (sym && p > 0) map.set(sym, p);
  }
  return map;
}

async function getSpotMap() {
  const json = await fetchWithRetry(SPOT_TICKER_API, {
    headers: BROWSER_HEADERS,
    timeoutMs: 6000,
  });
  const arr = Array.isArray(json) ? json : json ? [json] : [];
  const map = new Map();
  for (const it of arr) {
    const sym = it?.symbol;
    const p = Number(it?.price || 0);
    if (sym && p > 0) map.set(sym, p);
  }
  return map;
}

function toFuturesSymbol(s = "") {
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return `${s.slice(0, -4)}_USDT`;
  return s;
}

function toSpotSymbol(s = "") {
  return s.replace("_", "");
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function jsonRes(status, data) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

export async function onRequest(context) {
  const { request, env } = context;

  const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
  if (REQUIRED_KEY) {
    const clientKey = request.headers.get("x-api-key") || "";
    if (clientKey !== REQUIRED_KEY) {
      return jsonRes(401, { success: false, error: "Unauthorized: invalid x-api-key." });
    }
  }

  try {
    const url = new URL(request.url);
    const wantDebug = url.searchParams.get("debug") === "1";
    const list = (url.searchParams.get("symbols") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const unique = [...new Set(list)];
    if (unique.length === 0) return jsonRes(200, { success: true, prices: {} });

    let futuresMap = new Map();
    let spotMap = new Map();
    try {
      futuresMap = await getFuturesMap();
    } catch {}
    try {
      spotMap = await getSpotMap();
    } catch {}

    const prices = {};
    const notFound = [];

    for (const raw of unique) {
      const fKey = toFuturesSymbol(raw);
      const sKey = toSpotSymbol(raw);

      const f = futuresMap.get(fKey);
      if (typeof f === "number" && f > 0) {
        prices[raw] = f;
        continue;
      }

      const s = spotMap.get(sKey);
      if (typeof s === "number" && s > 0) {
        prices[raw] = s;
        continue;
      }

      const f2 = futuresMap.get(raw);
      if (typeof f2 === "number" && f2 > 0) {
        prices[raw] = f2;
        continue;
      }

      const s2 = spotMap.get(raw);
      if (typeof s2 === "number" && s2 > 0) {
        prices[raw] = s2;
        continue;
      }

      notFound.push(raw);
    }

    const payload = wantDebug ? { success: true, prices, notFound } : { success: true, prices };
    return jsonRes(200, payload);
  } catch (e) {
    return jsonRes(500, { success: false, error: String(e?.message || e) });
  }
}
