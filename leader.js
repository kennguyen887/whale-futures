// app-mexc.js
// Realtime MEXC Copy-Futures — Leaders' Orders (poll every 3s) with live ROI & PNL (colored)
// deps: dotenv, cli-table3, chalk, axios (optional), node >=18 for fetch fallback



const Table = require("cli-table3");
const https = require("https");
let chalk;
let axios;
try { axios = require("axios"); } catch (_) { /* optional */ }
require("dotenv").config();
// ======= CONFIG =======
const UIDS = (process.env.MEXC_LEADER_UIDS || "78481146")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const POLL_MS = Number(process.env.POLL_MS || 3000);
const LIMIT = Number(process.env.LIMIT || 10);
const TIMEZONE = "Asia/Ho_Chi_Minh";

const API_ORDERS = "https://futures.mexc.com/copyFutures/api/v1/trader/orders/v2";
const ORDER_LIST_TYPE = "ORDER"; 
const FUTURES_TICKER_API = "https://futures.mexc.com/api/v1/contract/ticker"; 
const SPOT_TICKER_API = "https://api.mexc.com/api/v3/ticker/price";           

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.mexc.com/",
  "Origin": "https://www.mexc.com",
  "Connection": "keep-alive",
};

const HTTPS_AGENT = new https.Agent({ keepAlive: true });

// ======= HELPERS =======
const tsVNT = (t) =>
  t ? new Date(t).toLocaleString("en-GB", { timeZone: TIMEZONE, hour12: false }).replace(",", "") : "";

const fmt = (n, d = 2) =>
  typeof n === "number" && isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: d })
    : n;

const toPair = (sym) => (sym || "").replace("_", "");

function modeFromPositionType(positionType) {
  if (positionType === 1) return "long";
  if (positionType === 2) return "short";
  return "unknown";
}

function marginModeFromOpenType(openType) {
  if (openType === 1) return "Isolated";
  if (openType === 2) return "Cross";
  return "Unknown";
}

function calcNotionalUSDT(o) {
  const price = Number(o.openAvgPrice || 0);
  const qty = Number(o.amount || 0);
  return price * qty;
}

function calcMarginPct(o) {
  const margin = Number(o.margin || 0);
  const notional = calcNotionalUSDT(o);
  return notional > 0 ? (margin / notional) * 100 : 0;
}

// ======= HTTP =======
async function httpGetWithBypass(url, params) {
  if (axios) {
    try {
      const res = await axios.get(url, {
        params,
        timeout: 12_000,
        headers: { ...BROWSER_HEADERS },
        httpsAgent: HTTPS_AGENT,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      return { ok: true, json: res.data };
    } catch (_) {}
  }
  const qs = params ? ("?" + new URLSearchParams(params).toString()) : "";
  const res = await fetch(url + qs, { headers: { ...BROWSER_HEADERS } });
  if (!res.ok) return { ok: false };
  return { ok: true, json: await res.json() };
}

// ======= DATA: Orders =======
async function fetchOrdersByUid(uid) {
  const params = { limit: LIMIT, orderListType: ORDER_LIST_TYPE, page: 1, uid };
  const res = await httpGetWithBypass(API_ORDERS, params);
  if (!res.ok) return [];
  const payload = res.json || {};
  if (payload.success !== true) return [];
  const content = payload.data?.content || [];
  return content.map((o) => ({
    ...o,
    __pair: toPair(o.symbol),
    __mode: modeFromPositionType(o.positionType),
    __marginMode: marginModeFromOpenType(o.openType),
    __notional: calcNotionalUSDT(o),
    __marginPct: calcMarginPct(o),
    __openAt: o.openTime || 0,
    __pageTime: o.pageTime || o.openTime || 0,
  }));
}

// ======= DATA: Live Prices =======
const priceCache = new Map();
const PRICE_TTL_MS = 2000;

async function getLivePrice(symbolUnderscore) {
  const now = Date.now();
  const cached = priceCache.get(symbolUnderscore);
  if (cached && now - cached.ts < PRICE_TTL_MS) return cached.price;

  try {
    const fut = await httpGetWithBypass(FUTURES_TICKER_API, { symbol: symbolUnderscore });
    if (fut.ok) {
      const obj = Array.isArray(fut.json?.data) ? fut.json.data[0] : fut.json?.data;
      const p = Number(obj?.lastPrice || obj?.fairPrice || obj?.indexPrice);
      if (p > 0) {
        priceCache.set(symbolUnderscore, { price: p, ts: now });
        return p;
      }
    }
  } catch (_) {}
  try {
    const spotSym = symbolUnderscore.replace("_", "");
    const spot = await httpGetWithBypass(SPOT_TICKER_API, { symbol: spotSym });
    if (spot.ok) {
      const p = Number(Array.isArray(spot.json) ? spot.json.find(x => x.symbol === spotSym)?.price : spot.json?.price);
      if (p > 0) {
        priceCache.set(symbolUnderscore, { price: p, ts: now });
        return p;
      }
    }
  } catch (_) {}
  return 0;
}

async function getLivePricesForSymbols(symbolsUnderscore) {
  const out = new Map();
  await Promise.all(symbolsUnderscore.map(async (sym) => {
    const p = await getLivePrice(sym);
    if (p > 0) out.set(sym, p);
  }));
  return out;
}

// ======= ROI & PNL =======
function calcClosedPNL(o) {
  const openP = Number(o.openAvgPrice || 0);
  const closeP = Number(o.closeAvgPrice || 0);
  const qty = Number(o.amount || 0);
  if (openP === 0 || qty === 0 || closeP === 0) return "";
  const dir = o.positionType === 1 ? 1 : -1;
  return (closeP - openP) * dir * qty;
}
function calcOpenPNL(o, livePrice) {
  const openP = Number(o.openAvgPrice || 0);
  const qty = Number(o.amount || 0);
  const live = Number(livePrice || 0);
  if (openP === 0 || qty === 0 || live === 0) return "";
  const dir = o.positionType === 1 ? 1 : -1;
  return (live - openP) * dir * qty;
}
function calcROIFromPNL(pnl, margin) {
  if (pnl === "" || margin === 0) return "";
  return (pnl / margin) * 100;
}

// ======= POLL & RENDER =======
async function pollOnce() {
  const lists = await Promise.allSettled(UIDS.map(fetchOrdersByUid));
  const rows = [];
  for (const r of lists) if (r.status === "fulfilled") rows.push(...r.value);

  const byKey = new Map();
  for (const o of rows) {
    const key = o.orderId || o.id;
    const prev = byKey.get(key);
    if (!prev || o.__pageTime > prev.__pageTime) byKey.set(key, o);
  }

  const merged = Array.from(byKey.values())
    .sort((a, b) => b.__openAt - a.__openAt) // sort theo OpenAt mới nhất
    .slice(0, 50);

  const symbolsNeeded = Array.from(new Set(merged
    .filter(o => !o.closeAvgPrice || o.closeAvgPrice === 0)
    .map(o => o.symbol)));

  const livePriceMap = await getLivePricesForSymbols(symbolsNeeded);

  for (const o of merged) {
    let pnl = "";
    if (o.closeAvgPrice && o.closeAvgPrice > 0) {
      pnl = calcClosedPNL(o);
    } else {
      const live = livePriceMap.get(o.symbol) || 0;
      pnl = calcOpenPNL(o, live);
    }
    o.__pnl = pnl;
    const roi = calcROIFromPNL(pnl, Number(o.margin || 0));
    o.__roi = roi;
  }

  renderTable(merged);
}

function renderTable(data) {
  console.clear();
  console.log("🐳 MEXC Copy Futures — Leaders' Orders (Realtime) — VNT\n");

  const t = new Table({
    head: [
      "Trader",
      "Symbol",
      "Mode",
      "Lev",
      "Margin Mode",
      "PNL (USDT)",
      "ROI %",
      "Open At (VNT)",
      "Open Price",
      "Amount",
      "Margin (USDT)",
      "Notional (USDT)",
      "Margin %",
      "Followers",
    ],
    style: { head: ["green"] },
  });

  for (const o of data) {
    // mode màu
    let modeStr = o.__mode;
    if (modeStr === "long") modeStr = chalk.blue(modeStr);
    if (modeStr === "short") modeStr = chalk.red(modeStr);

    // PNL màu
    let pnlStr = "";
    if (o.__pnl !== "") {
      const val = Number(o.__pnl);
      pnlStr = val >= 0 ? chalk.green(fmt(val, 2)) : chalk.red(fmt(val, 2));
    }

    // ROI màu
    let roiStr = "";
    if (o.__roi !== "") {
      const val = Number(o.__roi);
      roiStr = val >= 0 ? chalk.green(fmt(val, 2) + "%") : chalk.red(fmt(val, 2) + "%");
    }

    t.push([
      o.traderNickName || "",
      o.__pair,
      modeStr,
      fmt(o.leverage, 0) + "x",
      o.__marginMode,
      pnlStr,
      roiStr,
      tsVNT(o.__openAt),
      fmt(o.openAvgPrice, 6),
      fmt(o.amount, 4),
      fmt(o.margin, 4),
      fmt(o.__notional, 2),
      fmt(o.__marginPct, 2) + "%",
      o.followers ?? "",
    ]);
  }

  console.log(t.toString());
  console.log(`\n⏱️ Refresh ${POLL_MS / 1000}s — ${API_ORDERS}`);
}

// ======= BOOT =======
(async () => {
  if (!UIDS.length) {
    console.error('Missing MEXC_LEADER_UIDS env. Ví dụ: MEXC_LEADER_UIDS="78481146,12345678"');
    process.exit(1);
  }
  chalk = (await import('chalk')).default;
  await pollOnce();
  setInterval(pollOnce, POLL_MS);
})();
