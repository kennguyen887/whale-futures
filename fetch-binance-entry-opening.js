// positive-pnl-once.js
// Node >= 18
//
// ✅ Mở = totalPnl === 0 (theo payload mẫu)
// ✅ side = BUY/SELL ; positionSide = LONG/SHORT (đúng field)
// ✅ Giá hiện tại từ MEXC (futures -> spot)
// ✅ PNL > 0 → ghi CSV
// ✅ deltaPercent theo hướng vị thế (LONG/SHORT)
// ✅ "At VNT" (1h20 ago, 3d2 ago)
// ✅ Số: chỉ 4 chữ số thập phân
// ✅ Sort CSV: mới → cũ
// ✅ Log chi tiết tiến trình

import { setTimeout as sleep } from "node:timers/promises";
import { argv } from "node:process";
import { access, writeFile, appendFile, unlink } from "node:fs/promises";
import { constants as FS } from "node:fs";

const REQ_DELAY = 100;
const ORDER_BYS = ["PNL","ROI","COPIER_PNL","AUM","COPY_COUNT","SHARP_RATIO"];

const BINANCE_BASE = "https://www.binance.com";
const TRADERS_ENDPOINT = `${BINANCE_BASE}/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list`;
const ORDER_HIS_ENDPOINT = `${BINANCE_BASE}/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history`;

const MEXC_FUTURES_TICKER_API = "https://futures.mexc.com/api/v1/contract/ticker";
const MEXC_SPOT_TICKER_API    = "https://api.mexc.com/api/v3/ticker/price";

const HEADERS_BINANCE = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141 Safari/537.36",
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: BINANCE_BASE,
  Referer: `${BINANCE_BASE}/en/copy-trading`,
  clienttype: "web"
};
const HEADERS_MEXC = { Accept: "application/json" };

// ---------- CLI ----------
const args = Object.fromEntries(argv.slice(2).filter(a => a.startsWith("--")).map(a => a.slice(2).split("=")));
const TRADER_LIMIT = Math.max(1, Number(args.limit ?? 50));
const OUT_FILE = args.out || "positive-orders.csv";

const delay = (ms) => sleep(ms);

// ---------- helpers ----------
const toFixed4 = (n) => (isFinite(n) ? Number(n).toFixed(4) : "");

function toFuturesKey(sym="") {
  const u = String(sym).toUpperCase();
  return u.endsWith("USDT") ? `${u.slice(0,-4)}_USDT` : u;
}
function uniqBy(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = keyFn(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}
function abbreviateName(n) {
  return n?.length > 30 ? `${n.slice(0,27)}…` : n ?? "";
}
function formatAgoVNT(ts) {
  const diff = Date.now() - Number(ts);
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d${Math.floor(h % 24)} ago`;
  if (h >= 1) return `${h}h${Math.floor(m % 60)} ago`;
  if (m >= 1) return `${m}m ago`;
  return `${s}s ago`;
}

function computePnl(open, mp, qty, positionSide) {
  const ps = String(positionSide).toUpperCase();
  if (ps === "LONG")  return (mp - open) * qty;
  if (ps === "SHORT") return (open - mp) * qty;
  return null;
}
function pctDeltaSideAware(open, mp, positionSide) {
  if (!isFinite(open) || open <= 0 || !isFinite(mp)) return null;
  const ps = String(positionSide).toUpperCase();
  if (ps === "LONG")  return ((mp - open) / open) * 100;
  if (ps === "SHORT") return ((open - mp) / open) * 100;
  return null;
}

// ---------- CSV ----------
function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
async function writeCsvHeader(path) {
  const header = [
    "At VNT","orderTime","symbol","side","positionSide","qty","avgPrice","marketPrice",
    "pnl","deltaPercent","notional","trader","uid","roi_percent","copyCount",
    "portfolioId","orderId"
  ].join(",") + "\n";
  await writeFile(path, header, "utf8");
}
async function appendCsv(path, rows) {
  const sorted = [...rows].sort((a,b) => Number(b.orderTime) - Number(a.orderTime));
  const lines = sorted.map(r => [
    csvEscape(r.atVNT),
    csvEscape(r.orderTime),
    csvEscape(r.symbol),
    csvEscape(r.side),
    csvEscape(r.positionSide),
    csvEscape(toFixed4(r.qty)),
    csvEscape(toFixed4(r.avgPrice)),
    csvEscape(toFixed4(r.marketPrice)),
    csvEscape(toFixed4(r.pnl)),
    csvEscape(toFixed4(r.deltaPercent)),
    csvEscape(toFixed4(r.notional)),
    csvEscape(r.trader),
    csvEscape(r.uid),
    csvEscape(toFixed4(r.roi_percent)),
    csvEscape(r.copyCount),
    csvEscape(r.portfolioId),
    csvEscape(r.orderId)
  ].join(",")).join("\n") + "\n";
  await appendFile(path, lines, "utf8");
}

// ---------- HTTP ----------
async function postJson(url, body, headers = HEADERS_BINANCE) {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  await delay(REQ_DELAY);
  if (!res.ok) { const t = await res.text().catch(()=> ""); throw new Error(`${res.status} ${res.statusText} ${t.slice(0,200)}`); }
  return res.json();
}
async function getJson(url, headers = HEADERS_MEXC) {
  const res = await fetch(url, { headers });
  await delay(REQ_DELAY);
  if (!res.ok) { const t = await res.text().catch(()=> ""); throw new Error(`${res.status} ${res.statusText} ${t.slice(0,200)}`); }
  return res.json();
}

// ---------- Data fetch ----------
async function buildPriceMap() {
  const map = new Map();
  try {
    const [f, s] = await Promise.all([
      getJson(MEXC_FUTURES_TICKER_API),
      getJson(MEXC_SPOT_TICKER_API),
    ]);
    const futArr = Array.isArray(f?.data) ? f.data : (f?.data ? [f.data] : []);
    for (const it of futArr) {
      const sym = String(it?.symbol || "").toUpperCase(); // BTC_USDT
      const p = Number(it?.lastPrice || it?.fairPrice || it?.indexPrice || 0);
      if (sym && p > 0) map.set(sym, p);
    }
    const spotArr = Array.isArray(s) ? s : (s ? [s] : []);
    for (const it of spotArr) {
      const sym = String(it?.symbol || "").toUpperCase(); // BTCUSDT
      const p = Number(it?.price || 0);
      if (sym && p > 0 && !map.has(toFuturesKey(sym))) map.set(sym, p);
    }
  } catch (e) { console.warn("[price] build map failed:", e?.message || e); }
  return map;
}

async function fetchTraders(limit = 50) {
  const calls = ORDER_BYS.map((dataType) =>
    postJson(TRADERS_ENDPOINT, {
      pageNumber: 1,
      pageSize: Math.min(limit, 50),
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
    roi: t?.roi ?? "",
    copyCount: t?.copyUserCount ?? t?.copyCount ?? t?.copiers ?? "",
  })).filter(x => x.portfolioId);
  return uniqBy(traders, x => x.portfolioId).slice(0, limit);
}

// ---------- normalize ----------
function normalizeHistory(o, ctx) {
  const symbol = (o.symbol || "").toUpperCase();
  // side: BUY/SELL
  const side = String(o.side || "").toUpperCase();
  // positionSide: LONG/SHORT (đúng field); fallback theo side nếu thiếu
  let positionSide = String(o.positionSide || "").toUpperCase();
  if (!positionSide) {
    if (side === "BUY") positionSide = "LONG";
    else if (side === "SELL") positionSide = "SHORT";
  }

  const executedQty = Number(
    o.executedQty ?? o.cumExecQty ?? o.filledQty ?? o.volume ?? o.qty ?? o.quantity ?? 0
  );
  const avgPrice = Number(o.avgPrice ?? o.price ?? o.entryPrice ?? o.openPrice ?? 0);
  const orderTime = o.orderTime ?? o.orderUpdateTime ?? o.openTime ?? o.createTime ?? o.time ?? Date.now();
  const orderId = o.orderId ?? o.id ?? `${symbol}-${orderTime}`; // fallback để không rỗng
  const totalPnl = Number(o.totalPnl ?? 0); // dùng để xác định opening

  return {
    portfolioId: ctx.portfolioId,
    nickname: ctx.nickname,
    uid: ctx.uid,
    roi: ctx.roi ?? "",
    copyCount: ctx.copyCount ?? "",
    symbol, side, positionSide,
    executedQty, avgPrice,
    orderTime, orderId,
    totalPnl, // 0 => đang mở
  };
}

// ---------- main (single run) ----------
(async () => {
  // reset file
  try { await access(OUT_FILE, FS.F_OK); await unlink(OUT_FILE); console.log(`[init] removed ${OUT_FILE}`); } catch {}
  await writeCsvHeader(OUT_FILE);

  console.log(`[init] fetching traders (limit=${TRADER_LIMIT})`);
  const traders = await fetchTraders(TRADER_LIMIT);
  console.log(`[init] got ${traders.length} traders`);

  console.log(`[init] building MEXC price map…`);
  const priceMap = await buildPriceMap();
  console.log(`[init] price map size=${priceMap.size}`);

  const rows = [];
  let totalOrders = 0;

  for (const tr of traders) {
    const now = Date.now();
    const startTime = now - 30 * 24 * 60 * 60 * 1000;

    console.log(`[fetch] order-history | pf=${tr.portfolioId}`);
    let data;
    try {
      data = await postJson(ORDER_HIS_ENDPOINT, {
        portfolioId: String(tr.portfolioId),
        pageSize: 100,
        pageNumber: 1,
        startTime,
        endTime: now,
      });
    } catch (e) {
      console.error(`[order-history] error (pf=${tr.portfolioId}): ${e?.message || e}`);
      continue;
    }

    const list = Array.isArray(data?.data?.list) ? data.data.list : [];
    console.log(`[order-history] pf=${tr.portfolioId} items=${list.length}`);
    totalOrders += list.length;

    for (const raw of list) {
      const e = normalizeHistory(raw, tr);

      // chỉ lấy lệnh đang mở theo yêu cầu: totalPnl === 0
      if (e.totalPnl !== 0) continue;

      // dữ liệu tối thiểu
      if (!e.symbol || !isFinite(e.executedQty) || e.executedQty === 0 || !isFinite(e.avgPrice) || e.avgPrice <= 0) {
        console.log(`[skip invalid] ${e.symbol} oid=${e.orderId} qty=${e.executedQty} avg=${e.avgPrice}`);
        continue;
      }

      // giá hiện tại từ MEXC
      const futKey = toFuturesKey(e.symbol);
      const mp = priceMap.get(futKey) ?? priceMap.get(e.symbol);
      if (!(isFinite(mp) && mp > 0)) { console.log(`[skip noPrice] ${e.symbol} oid=${e.orderId}`); continue; }

      // tính PNL và delta theo hướng vị thế
      const pnl = computePnl(e.avgPrice, mp, e.executedQty, e.positionSide);
      const delta = pctDeltaSideAware(e.avgPrice, mp, e.positionSide);
      const notional = e.avgPrice * e.executedQty;

      console.log(`[process] ${e.symbol} side=${e.side} pos=${e.positionSide} qty=${toFixed4(e.executedQty)} open=${toFixed4(e.avgPrice)} mexc=${toFixed4(mp)} -> pnl=${toFixed4(pnl)} delta%=${toFixed4(delta)}`);

      if (!(pnl > 0)) { console.log(`[skip <=0] ${e.symbol} oid=${e.orderId}`); continue; }

      rows.push({
        atVNT: formatAgoVNT(e.orderTime),
        orderTime: e.orderTime,
        symbol: e.symbol,
        side: e.side,                 // BUY/SELL
        positionSide: e.positionSide, // LONG/SHORT
        qty: e.executedQty,
        avgPrice: e.avgPrice,
        marketPrice: mp,
        pnl,
        deltaPercent: delta,
        notional,
        trader: abbreviateName(tr.nickname),
        uid: tr.uid,
        roi_percent: tr.roi,
        copyCount: tr.copyCount,
        portfolioId: e.portfolioId,
        orderId: e.orderId,
      });
      console.log(`[CSV +] ${e.symbol} oid=${e.orderId} pnl=${toFixed4(pnl)}`);
    }
  }

  await appendCsv(OUT_FILE, rows);
  console.log(`[done] totalOrders=${totalOrders} saved=${rows.length} file=${OUT_FILE}`);
})();
