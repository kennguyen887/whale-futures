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

async function fetchJSON(url, { headers = {}, timeoutMs = 5000 } = {}) {
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
    // backoff ngắn để tránh 429
    await sleep(200 + Math.floor(Math.random() * 200));
    return fetchWithRetry(url, opts, retries - 1);
  }
}

// Build maps 1 lần / request
async function getFuturesMap() {
  // Không truyền symbol → trả về danh sách đầy đủ
  const json = await fetchWithRetry(FUTURES_TICKER_API, {
    headers: BROWSER_HEADERS,
    timeoutMs: 6000,
  });
  const arr = Array.isArray(json?.data) ? json.data : (json?.data ? [json.data] : []);
  const map = new Map();
  for (const it of arr) {
    // symbol dạng "BTC_USDT"
    const sym = it?.symbol;
    const p = Number(it?.lastPrice || it?.fairPrice || it?.indexPrice || 0);
    if (sym && p > 0) map.set(sym, p);
  }
  return map;
}

async function getSpotMap() {
  // Không truyền symbol → trả về toàn bộ cặp spot
  const json = await fetchWithRetry(SPOT_TICKER_API, {
    headers: BROWSER_HEADERS,
    timeoutMs: 6000,
  });
  const arr = Array.isArray(json) ? json : (json ? [json] : []);
  const map = new Map();
  for (const it of arr) {
    const sym = it?.symbol; // "BTCUSDT"
    const p = Number(it?.price || 0);
    if (sym && p > 0) map.set(sym, p);
  }
  return map;
}

function toSpotSymbol(symUnderscore = "") {
  return symUnderscore.replace("_", ""); // "XRP_USDT" -> "XRPUSDT"
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function jsonRes(status, data) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

export async function onRequest(context) {
  const { request, env } = context;

  // API key check
  const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
  if (REQUIRED_KEY) {
    const clientKey = request.headers.get("x-api-key") || "";
    if (clientKey !== REQUIRED_KEY) {
      return jsonRes(401, { success: false, error: "Unauthorized: invalid x-api-key." });
    }
  }

  try {
    const url = new URL(request.url);
    const list = (url.searchParams.get("symbols") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const unique = [...new Set(list)];

    // Batch fetch 1 lần để tránh rate limit/miss
    // Nếu 1 trong 2 API lỗi, vẫn cố dùng cái còn lại
    let futuresMap = new Map();
    let spotMap = new Map();

    try {
      futuresMap = await getFuturesMap();
    } catch (_) {
      // ignore
    }
    try {
      spotMap = await getSpotMap();
    } catch (_) {
      // ignore
    }

    const prices = {};
    for (const sym of unique) {
      // Ưu tiên futures (X_Y), fallback spot (XY)
      const f = futuresMap.get(sym);
      if (typeof f === "number" && f > 0) {
        prices[sym] = f;
        continue;
      }
      const spotSym = toSpotSymbol(sym);
      const s = spotMap.get(spotSym);
      if (typeof s === "number" && s > 0) {
        prices[sym] = s;
        continue;
      }
      // Không tìm thấy → bỏ qua (giữ API gọn: chỉ trả những cặp có giá)
    }

    return jsonRes(200, { success: true, prices });
  } catch (e) {
    return jsonRes(500, { success: false, error: String(e?.message || e) });
  }
}
