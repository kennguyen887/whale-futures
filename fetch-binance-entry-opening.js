// binance-copy-open-entries-to-csv.js
// Node >= 18
// Rút gọn API: chỉ dùng Binance order-history với time range 30 ngày (pageSize=100, 1 call/trader)
// Quy trình: (1) Lấy traders -> (2) Gọi order-history 30D/lấy entry đang mở
//           (3) Gom symbol -> (4) Gọi giá MEXC 1 lần -> (5) Tính PNL/Δ%
//           (6) SORT theo At VNT (mới -> cũ) và ghi CSV

import { writeFile, appendFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { argv, env } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------- CLI ----------------
const args = Object.fromEntries(
  argv.slice(2).filter(a => a.startsWith("--")).map(a => a.slice(2).split("="))
);

// QUICK3 flags
const QUICK3 =
  args.t3 !== undefined ||
  args.quick3 !== undefined ||
  Number(args.quick) === 3;

// Configs
const OUTPUT = args.out || "open_entries_binance.csv";
const TRADER_LIMIT = Number(args.traderLimit ?? (QUICK3 ? 3 : 50)); // có thể --traderLimit=10 để test nhanh
const CONCURRENCY = Math.max(1, Number(args.concurrency ?? 3));
const START_RPS = Number(args.rps ?? env.MAX_RPS ?? 8);
const MIN_RPS = Number(args.minRps ?? 2);
const VERBOSE = true;

// ---------------- Endpoints ----------------
const TRADERS_ENDPOINT =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list";

const ORDERS_HIS_ENDPOINT =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history";

// MEXC public prices
const MEXC_FUTURES_TICKER_API = "https://futures.mexc.com/api/v1/contract/ticker";
const MEXC_SPOT_TICKER_API    = "https://api.mexc.com/api/v3/ticker/price";

const MEXC_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.mexc.com/",
  Origin: "https://www.mexc.com",
  Connection: "keep-alive",
};

const BINANCE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Origin: "https://www.binance.com",
  Referer: "https://www.binance.com/en/copy-trading",
  clienttype: "web",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
};

// ---------------- Adaptive limiter ----------------
let currentRps = START_RPS;
let tokens = currentRps;
let lastRefill = Date.now();
let cooldownUntil = 0;

const delay = (ms) => sleep(ms);
function refillTokens() {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  const add = elapsed * currentRps;
  if (add > 0) {
    tokens = Math.min(currentRps, tokens + add);
    lastRefill = now;
  }
}
async function rateLimit() {
  const now = Date.now();
  if (now < cooldownUntil) await delay(cooldownUntil - now);
  for (;;) {
    refillTokens();
    if (tokens >= 1) {
      tokens -= 1;
      const jitter = Math.floor(Math.random() * 40);
      if (jitter) await delay(jitter);
      return;
    }
    await delay(4);
  }
}
function onDeny(status, attempt) {
  const newRps = Math.max(MIN_RPS, Math.floor(currentRps / 2));
  if (newRps !== currentRps) {
    currentRps = newRps;
    if (VERBOSE) console.log(`⚠️  Denied (${status}). Reduce RPS → ${currentRps}`);
  }
  const base = status === 403 ? 2000 : 1500;
  const ms = Math.min(8000, Math.floor(base * Math.pow(1.5, attempt)));
  cooldownUntil = Date.now() + ms;
}
function onSuccessTick() {
  if (currentRps < START_RPS && Math.random() < 0.03) {
    currentRps += 1;
    if (VERBOSE) console.log(`✅ Recover RPS → ${currentRps}`);
  }
}

// ---------------- HTTP ----------------
async function postJson(url, body, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      await rateLimit();
      if (VERBOSE) console.log("   ↳ POST", url);
      const res = await fetch(url, { method: "POST", headers: BINANCE_HEADERS, body: JSON.stringify(body) });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          if (i < retries) { onDeny(res.status, i); continue; }
        }
        throw new Error(`${res.status} ${res.statusText} - ${text.slice(0, 160)}`);
      }
      onSuccessTick();
      return await res.json();
    } catch (err) {
      if (i < retries) { await delay(220 * Math.pow(1.5, i)); continue; }
      throw err;
    }
  }
}
async function getJson(url, headers = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      await rateLimit();
      if (VERBOSE) console.log("   ↳ GET", url);
      const res = await fetch(url, { method: "GET", headers });
      if (!res.ok) {
        if (i < retries && (res.status === 429 || res.status >= 500)) { onDeny(res.status, i); continue; }
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText} - ${text.slice(0, 160)}`);
      }
      onSuccessTick();
      return await res.json();
    } catch (err) {
      if (i < retries) { await delay(180 + Math.floor(Math.random() * 200)); continue; }
      throw err;
    }
  }
}

// ---------------- Simple pool ----------------
async function pLimitAll(items, limit, worker) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        const r = await worker(item);
        if (Array.isArray(r)) out.push(...r);
      } catch (e) {
        console.error("❌ Worker error:", e?.message || e);
      }
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------------- Traders (unique) ----------------
const ORDER_BYS = ["PNL", "ROI", "COPIER_PNL", "AUM", "COPY_COUNT", "SHARP_RATIO"];

async function fetchPortfolioIds() {
  const calls = ORDER_BYS.map((dataType) =>
    postJson(TRADERS_ENDPOINT, {
      pageNumber: 1,
      pageSize: Math.min(TRADER_LIMIT, 50),
      timeRange: "30D",
      dataType,
      favoriteOnly: false,
      hideFull: false,
      nickname: "",
      order: "DESC",
      userAsset: 0,
      portfolioType: "ALL",
      useAiRecommended: true,
    }).catch(() => null)
  );

  const results = await Promise.all(calls);
  const list = results.flatMap(r => (r?.data?.list ? r.data.list : []));
  const traders = list.map(t => ({
    portfolioId: t?.portfolioId || t?.leadPortfolioId || t?.id,
    nickname: t?.nickName || t?.nickname || "",
    uid: t?.uid || t?.userId || "",
    roi: t?.roi ?? null,
    pnl: t?.pnl ?? null,
    copyCount: t?.copyUserCount ?? t?.copyCount ?? t?.copierCount ?? t?.copiers ?? t?.copyNumber ?? null, // Flrs
  })).filter(t => t.portfolioId);

  const seen = new Set();
  const uniq = traders
    .filter(t => (seen.has(t.portfolioId) ? false : (seen.add(t.portfolioId), true)))
    .slice(0, TRADER_LIMIT);

  if (VERBOSE) console.log(`✅ Collected ${uniq.length} unique portfolioIds from ${ORDER_BYS.length} sorts`);
  return uniq;
}

// ---------------- Normalize & filter (HISTORY ONLY, 30D range) ----------------
function normalizeHistory(o, ctx) {
  const symbol = o.symbol || o.contract || o.pair || "";
  const sideRaw = o.side || o.positionSide || o.direction || "";
  const executedQty = o.executedQty ?? o.cumExecQty ?? o.filledQty ?? o.volume ?? o.qty ?? o.quantity ?? "";
  const avgPrice = o.avgPrice ?? o.price ?? o.entryPrice ?? o.openPrice ?? o.avgFillPrice ?? "";
  const leverage = o.leverage ?? o.lever ?? ""; // có thể trống do API
  const mmode =
    (o.marginMode ? o.marginMode :
      (o.isolated === true ? "ISOLATED" : (o.isolated === false ? "CROSS" : (o.marginType || o.mode || ""))));
  let side = "", positionSide = "";
  if (["LONG", "SHORT"].includes(String(sideRaw).toUpperCase())) {
    positionSide = String(sideRaw).toUpperCase();
    side = positionSide === "LONG" ? "BUY" : "SELL";
  } else {
    side = String(sideRaw).toUpperCase();
    positionSide = side === "BUY" ? "LONG" : (side === "SELL" ? "SHORT" : "");
  }
  const orderTime = o.orderTime ?? o.orderUpdateTime ?? o.openTime ?? o.createTime ?? o.time ?? o.updateTime ?? "";
  const orderId = o.orderId ?? o.id ?? o.origClientOrderId ?? o.clientOrderId ?? "";
  const positionId = o.positionId ?? o.posId ?? o.positionID ?? "";
  const status = (o.status || o.orderStatus || "").toString().toUpperCase();

  return {
    portfolioId: ctx.portfolioId,
    uid: ctx.uid,
    nickname: ctx.nickname,
    roi: ctx.roi ?? null,
    copyCount: ctx.copyCount ?? null, // Flrs = COPY_COUNT
    symbol,
    side,
    positionSide,
    type: o.type || o.orderType || o.execType || "",
    executedQty,
    avgPrice,
    leverage,
    marginMode: mmode,
    totalPnl: o.unrealizedPnl ?? o.totalPnl ?? null,
    orderTime,         // timestamp ms
    orderId,
    positionId,
    status,
  };
}

function isClosedOrderLike(o) {
  const status = String(o?.status || o?.orderStatus || "").toUpperCase();
  const realized = o?.realizedPnl != null && Number.isFinite(Number(o.realizedPnl));
  const hasCloseFields = !!(o?.closeTime || o?.closeOrderId || o?.closeType || o?.close === true);
  const reduceOnly = o?.reduceOnly === true || o?.closePosition === true;
  const statusClosed = ["FILLED","CLOSED","EXPIRED","CANCELED","REJECTED"].includes(status);
  return realized || hasCloseFields || reduceOnly || statusClosed;
}
function isOpenStatusLike(status) {
  const s = String(status || "").toUpperCase();
  return s === "" || ["NEW","PARTIALLY_FILLED","OPEN","ENTRY_OPENING","TRIGGERED","ACCEPTED"].includes(s);
}
// Entry đang mở từ history 30D: chưa đóng + status mở + đã khớp (executedQty>0 hoặc avgPrice>0)
function isEntryOpeningFromHistory(n, raw) {
  if (isClosedOrderLike(raw || {})) return false;
  if (!isOpenStatusLike(n.status)) return false;
  const filled = Number(raw?.executedQty ?? raw?.cumExecQty ?? raw?.filledQty ?? 0) > 0;
  const priced = Number(n.avgPrice ?? 0) > 0;
  return filled || priced;
}

// Lấy entries mở: 1 call duy nhất với startTime 30D, endTime now, pageSize 100
async function fetchOpenEntriesHistoryOnly_30D(trader) {
  const now = Date.now();
  const THIRTY_D_MS = 30 * 24 * 60 * 60 * 1000;
  const startTime = now - THIRTY_D_MS;
  const endTime = now;

  const data = await postJson(ORDERS_HIS_ENDPOINT, {
    portfolioId: String(trader.portfolioId),
    pageSize: 100,
    pageNumber: 1,
    startTime,
    endTime,
  }).catch(() => null);

  const list = data?.data?.list || [];
  if (!list.length) {
    if (VERBOSE) console.log(`[PID ${trader.portfolioId}] history 30D: 0 items`);
    return [];
  }

  // index “đã đóng” trong range 30D
  const byOrderId = new Set();
  const byPositionId = new Set();
  for (const o of list) {
    if (isClosedOrderLike(o)) {
      const oid = o.orderId ?? o.id ?? o.origClientOrderId ?? o.clientOrderId;
      const pid = o.positionId ?? o.posId ?? o.positionID;
      if (oid) byOrderId.add(String(oid));
      if (pid) byPositionId.add(String(pid));
    }
  }

  const collected = [];
  for (const o of list) {
    const n = normalizeHistory(o, trader);
    const oid = n.orderId ? String(n.orderId) : null;
    const pid = n.positionId ? String(n.positionId) : null;
    const closedById = oid ? byOrderId.has(oid) : false;
    const closedByPos = pid ? byPositionId.has(pid) : false;
    if (closedById || closedByPos) continue;
    if (!isEntryOpeningFromHistory(n, o)) continue;
    collected.push(n);
  }

  if (VERBOSE) console.log(`[PID ${trader.portfolioId}] history 30D → open entries: ${collected.length}`);
  return collected;
}

// ---------------- MEXC Prices ----------------
async function getMexcFuturesMap() {
  const json = await getJson(MEXC_FUTURES_TICKER_API, MEXC_BROWSER_HEADERS, 2);
  const arr = Array.isArray(json?.data) ? json.data : (json?.data ? [json.data] : []);
  const map = new Map();
  for (const it of arr) {
    const sym = it?.symbol;
    const p = Number(it?.lastPrice || it?.fairPrice || it?.indexPrice || 0);
    if (sym && p > 0) map.set(String(sym).toUpperCase(), p);
  }
  return map;
}
async function getMexcSpotMap() {
  const json = await getJson(MEXC_SPOT_TICKER_API, MEXC_BROWSER_HEADERS, 2);
  const arr = Array.isArray(json) ? json : (json ? [json] : []);
  const map = new Map();
  for (const it of arr) {
    const sym = it?.symbol;
    const p = Number(it?.price || 0);
    if (sym && p > 0) map.set(String(sym).toUpperCase(), p);
  }
  return map;
}
function toMexcFuturesKey(binanceSymbol = "") {
  const s = String(binanceSymbol || "").toUpperCase();
  if (!s.endsWith("USDT")) return s;
  return `${s.slice(0, -4)}_USDT`;
}
function toMexcSpotKey(binanceSymbol = "") {
  return String(binanceSymbol || "").toUpperCase();
}
async function getPricesFromMexc(binanceSymbols /* array */) {
  let fut = new Map(), spot = new Map();
  try { fut = await getMexcFuturesMap(); } catch {}
  try { spot = await getMexcSpotMap(); } catch {}

  const out = new Map();
  for (const sym of new Set(binanceSymbols.map(s => String(s).toUpperCase()))) {
    const fKey = toMexcFuturesKey(sym); // BTC_USDT
    const sKey = toMexcSpotKey(sym);    // BTCUSDT
    const f = fut.get(fKey);
    if (typeof f === "number" && f > 0) { out.set(sym, f); continue; }
    const s = spot.get(sKey);
    if (typeof s === "number" && s > 0) { out.set(sym, s); continue; }
    const f2 = fut.get(sym);
    if (typeof f2 === "number" && f2 > 0) { out.set(sym, f2); continue; }
    const s2 = spot.get(sym);
    if (typeof s2 === "number" && s2 > 0) { out.set(sym, s2); continue; }
  }
  return out;
}

// ---------------- Format helpers ----------------
function fmtNumAbbr(n, digits = 2) {
  if (n == null || !isFinite(n)) return "";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(digits) + "T";
  if (abs >= 1e9)  return sign + (abs / 1e9).toFixed(digits)  + "B";
  if (abs >= 1e6)  return sign + (abs / 1e6).toFixed(digits)  + "M";
  if (abs >= 1e3)  return sign + (abs / 1e3).toFixed(digits)  + "k";
  return sign + abs.toFixed(digits);
}
function fmtPercentRaw(n, digits = 2) {
  if (n == null || !isFinite(n)) return "";
  return `${n.toFixed(digits)}%`;
}
function fmtName(nickname, copyCount, roi) {
  if (!nickname) return "";
  const short = nickname.length > 6 ? nickname.slice(0, 4) + "…" + nickname.slice(-1) : nickname;
  const heart = copyCount != null && Number(copyCount) > 1000 ? " ❤️" : "";
  const star = roi != null && Number(roi) > 0 ? " ⭐" : "";
  return `${short}${heart}${star}`.trim();
}
function fmtMode(positionSide) {
  const s = String(positionSide || "").toLowerCase();
  return s === "long" || s === "short" ? s : "";
}
// >>> Time display (gọn, dễ đọc): "3d ago", "4h ago", "1m ago"
function msAgoToVNTText(ts) {
  if (!ts) return "";
  const now = Date.now();
  const diff = Math.max(0, now - Number(ts));
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day >= 1) return `${day}d ago`;
  if (hr >= 1) return `${hr}h ago`;
  if (min >= 1) return `${min}m ago`;
  return `${sec}s ago`;
}
function renderMarginModeLower(marginModeRaw) {
  const mm = String(marginModeRaw || "").toUpperCase();
  if (mm === "ISOLATED") return "isolate";
  if (mm === "CROSS") return "cross";
  return (mm || "").toLowerCase();
}

// ---------------- CSV headers (pretty) ----------------
const CSV_HEADERS = [
  "Symbol",
  "Mode",
  "Margin",
  "PNL",
  "Lev",
  "At VNT",
  "Trader",
  "Flrs",
  "ROI %",
  "M/Mode",
  "Notional",
  "Open Price",
  "Market Price",
  "Δ % vs Open",
  "Amount",
  "Margin %",
  "UID",
  "ID",
];

const esc = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
async function ensureHeader(file, headers) {
  try { await access(file, constants.F_OK); }
  catch { await writeFile(file, headers.join(",") + "\n", "utf8"); }
}
async function writeRows(file, rows) {
  if (!rows.length) return;
  const body = rows.map(r => CSV_HEADERS.map(h => esc(r[h])).join(",")).join("\n") + "\n";
  await appendFile(file, body, "utf8");
}

// ---------------- Build rows ----------------
function toNumberSafe(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function sideSign(positionSide) {
  const ps = String(positionSide || "").toUpperCase();
  if (ps === "LONG") return +1;
  if (ps === "SHORT") return -1;
  return 0;
}
function rowFromEntry(e, marketPrice) {
  const sym = String(e.symbol || "").toUpperCase();
  const open = toNumberSafe(e.avgPrice);
  const qty = toNumberSafe(e.executedQty);
  const lev = toNumberSafe(e.leverage);
  const copyCount = e.copyCount != null ? Number(e.copyCount) : null;
  const roi = e.roi != null ? Number(e.roi) : null;

  const ts = Number(e.orderTime) || 0;          // sort key (mới -> cũ)
  const mp = marketPrice ?? open ?? null;
  const notional = (qty != null && mp != null) ? qty * mp : null;
  const deltaPct = (open && mp) ? ((mp - open) / open) * 100 : null;

  let pnl = null;
  const ss = sideSign(e.positionSide);
  if (ss !== 0 && qty != null && open != null && mp != null) {
    pnl = (mp - open) * qty * ss;
  } else if (e.totalPnl != null) {
    pnl = Number(e.totalPnl);
  }

  const marginPct = (lev && lev > 0) ? (100 / lev) : null;

  return {
    "__ts": ts,                                                     // <--- dùng để sort, không ghi CSV
    "Symbol": sym,
    "Mode": fmtMode(e.positionSide),
    "Margin": pnl != null ? fmtNumAbbr(Math.abs(pnl)) : "",
    "PNL": pnl != null ? fmtNumAbbr(pnl) : "",
    "Lev": lev ? `${lev}x` : "",
    "At VNT": msAgoToVNTText(ts),
    "Trader": fmtName(e.nickname, copyCount, roi),
    "Flrs": copyCount != null ? String(copyCount) : "",             // COPY_COUNT
    "ROI %": roi != null ? fmtPercentRaw(roi, 2) : "",
    "M/Mode": renderMarginModeLower(e.marginMode),                  // cross / isolate (nếu API có)
    "Notional": notional != null ? fmtNumAbbr(notional, 2) : "",
    "Open Price": open != null ? (open >= 100 ? open.toFixed(2) : open.toPrecision(6)) : "",
    "Market Price": mp != null ? (mp >= 100 ? mp.toFixed(2) : mp.toPrecision(6)) : "",
    "Δ % vs Open": deltaPct != null ? (deltaPct >= 0 ? `+${deltaPct.toFixed(2)}%` : `${deltaPct.toFixed(2)}%`) : "",
    "Amount": qty != null ? (qty >= 100 ? fmtNumAbbr(qty, 2) : qty.toPrecision(6)) : "",
    "Margin %": marginPct != null ? `${marginPct.toFixed(2)}%` : "",// 100/leverage
    "UID": e.uid || "",                                             // trader id
    "ID": e.orderId || "",                                          // order id
  };
}

// ---------------- Main ----------------
(async () => {
  try {
    if (QUICK3) console.log("⚡ QUICK3 mode: limiting traders to 3");

    await ensureHeader(OUTPUT, CSV_HEADERS);

    // 1) Traders
    const traders = await fetchPortfolioIds();
    if (!traders.length) { console.log("No traders found"); process.exit(0); }

    // 2) Entries mở từ HISTORY 30 ngày (pageSize=100, 1 call/trader)
    const allOpenEntries = await pLimitAll(traders, CONCURRENCY, async (tr) => {
      const entries = await fetchOpenEntriesHistoryOnly_30D(tr);
      return entries;
    });
    if (!allOpenEntries.length) { console.log("No open entries"); process.exit(0); }

    // 3) Giá MEXC một lần cho toàn bộ symbol
    const uniqueSymbols = Array.from(new Set(allOpenEntries.map(e => String(e.symbol || "").toUpperCase()).filter(Boolean)));
    const mexcPrices = await getPricesFromMexc(uniqueSymbols);

    // 4) Build rows
    let rows = allOpenEntries.map(e =>
      rowFromEntry(e, mexcPrices.get(String(e.symbol || "").toUpperCase()) ?? null)
    );

    // 5) SORT theo At VNT (mới -> cũ) dựa trên __ts
    rows.sort((a, b) => (b.__ts || 0) - (a.__ts || 0));

    // loại bỏ khóa nội bộ trước khi ghi (writeRows chỉ pick CSV_HEADERS nên không cần xoá)
    await writeRows(OUTPUT, rows);

    if (VERBOSE) console.log(`✅ Done. Wrote ${rows.length} rows → ${OUTPUT}`);
  } catch (e) {
    console.error("❌ Error:", e?.message || e);
    process.exit(1);
  }
})();
