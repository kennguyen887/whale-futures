// binance-copy-open-entries-to-csv.js
// Node >= 18. Lấy các lệnh "đang mở/entry" của Lead Traders (Copy Trade) thay vì history.
// Có fallback lọc từ history nếu endpoint open trả rỗng.

import { writeFile, appendFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { argv, env } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------- CLI ----------------
const args = Object.fromEntries(
  argv.slice(2).filter(a => a.startsWith("--")).map(a => a.slice(2).split("="))
);

const OUTPUT = args.out || "open_entries_binance.csv";
const TRADER_LIMIT = Number(args.traderLimit ?? 50);      // số trader lấy ở trang listing
const CONCURRENCY = Math.max(1, Number(args.concurrency ?? 3));
const START_RPS = Number(args.rps ?? env.MAX_RPS ?? 10);
const MIN_RPS = Number(args.minRps ?? 2);
const PAGE_SLEEP_MS = Number(args.pageSleep ?? 15);
const INCLUDE_FOLLOWERS = args.noFollowers ? false : true;
const VERBOSE = true;

// ---------------- API (web bapi) ----------------
// Danh sách endpoint list lead traders
const TRADERS_ENDPOINT =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list";

// Các endpoint CÓ THỂ trả lệnh đang mở (tuỳ web build). Script sẽ thử lần lượt:
const OPEN_ENTRY_ENDPOINTS = [
  // thường thấy trên web (có thể khác môi trường):
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/opening-orders",
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/open-orders",
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/positions", // đôi khi trả position đang mở
];

// Fallback: lấy history rồi lọc “đang mở”
const ORDERS_HIS_ENDPOINT =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history";

// ---------------- Headers ----------------
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Origin: "https://www.binance.com",
  Referer: "https://www.binance.com/en/copy-trading",
  clienttype: "web",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
  // Bạn có thể set thêm header/cookie nếu cần giống curl của bạn (csrftoken, device-info, cookies...),
  // nhưng nhiều khi KHÔNG cần cho các request public này.
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
  while (true) {
    refillTokens();
    if (tokens >= 1) {
      tokens -= 1;
      const jitter = Math.floor(Math.random() * 50);
      if (jitter) await delay(jitter);
      return;
    }
    await delay(5);
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

// ---------------- HTTP helpers ----------------
async function postJson(url, body, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      await rateLimit();
      if (VERBOSE) console.log("   ↳ POST", url);
      const res = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          if (i < retries) {
            onDeny(res.status, i);
            continue;
          }
        }
        throw new Error(`${res.status} ${res.statusText} - ${text.slice(0, 160)}`);
      }
      onSuccessTick();
      return await res.json();
    } catch (err) {
      if (i < retries) {
        await delay(250 * Math.pow(1.5, i));
        continue;
      }
      throw err;
    }
  }
}

// Simple concurrency pool
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

// ---------------- Traders list ----------------
const ORDER_BYS = ["PNL", "ROI", "WIN_RATE", ...(INCLUDE_FOLLOWERS ? ["FOLLOWERS"] : [])];

async function fetchPortfolioIds() {
  const calls = ORDER_BYS.map((dataType) =>
    postJson(TRADERS_ENDPOINT, {
      pageNumber: 1,
      pageSize: Math.min(TRADER_LIMIT, 50),
      timeRange: "30D",
      dataType,               // "PNL" | "ROI" | "WIN_RATE" | "FOLLOWERS"
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
    winRate: t?.winRate ?? null,
    followers: t?.follower ?? t?.followers ?? null,
  })).filter(t => t.portfolioId);

  const seen = new Set();
  const uniq = traders.filter(t => (seen.has(t.portfolioId) ? false : (seen.add(t.portfolioId), true)));
  if (VERBOSE) console.log(`✅ Collected ${uniq.length} unique portfolioIds from ${ORDER_BYS.length} sorts`);
  return uniq;
}

// ---------------- Open entries fetchers ----------------

// Chuẩn hoá mọi biến thể field của open entries về 1 format
function normalizeOpenEntry(o, ctx) {
  // Các field có thể thay đổi giữa endpoint: cố gắng map an toàn.
  const symbol = o.symbol || o.contract || o.pair || "";
  const sideRaw = o.side || o.positionSide || o.direction || "";  // "BUY"/"SELL" hoặc "LONG"/"SHORT"
  const type = o.type || o.orderType || "";
  const executedQty =
    o.executedQty ?? o.volume ?? o.qty ?? o.quantity ?? o.positionAmt ?? "";
  const avgPrice =
    o.avgPrice ?? o.price ?? o.entryPrice ?? o.openPrice ?? "";
  const pnl =
    o.totalPnl ?? o.unrealizedPnl ?? o.pnl ?? null;

  // margin/leverage/mode nếu có
  const leverage = o.leverage ?? o.lever ?? "";
  const marginMode =
    o.marginMode || o.isolated === true ? "ISOLATED" :
    o.isolated === false ? "CROSS" : (o.marginType || o.mode || "");

  // Chuẩn hoá side/positionSide
  let side = "";
  let positionSide = "";
  if (["LONG", "SHORT"].includes(String(sideRaw).toUpperCase())) {
    positionSide = String(sideRaw).toUpperCase();
    side = positionSide === "LONG" ? "BUY" : "SELL";
  } else {
    side = String(sideRaw).toUpperCase();
    positionSide = side === "BUY" ? "LONG" : (side === "SELL" ? "SHORT" : "");
  }

  const orderTime = o.orderTime ?? o.openTime ?? o.createTime ?? o.time ?? o.updateTime ?? "";

  return {
    portfolioId: ctx.portfolioId,
    uid: ctx.uid,
    nickname: ctx.nickname,
    symbol,
    side,
    positionSide,
    type,
    executedQty,
    avgPrice,
    leverage,
    marginMode,
    totalPnl: pnl,
    orderTime,
  };
}

// Thử lần lượt các endpoint open entries cho 1 trader
async function fetchOpenEntriesByPortfolio(trader) {
  for (const url of OPEN_ENTRY_ENDPOINTS) {
    try {
      const body = { portfolioId: String(trader.portfolioId), pageNumber: 1, pageSize: 50 };
      const resp = await postJson(url, body);
      const list = resp?.data?.list || resp?.data?.positions || resp?.data || [];
      if (Array.isArray(list) && list.length > 0) {
        if (VERBOSE) console.log(`[PID ${trader.portfolioId}] Open entries via ${new URL(url).pathname}: ${list.length}`);
        return list.map(o => normalizeOpenEntry(o, trader));
      }
    } catch {
      // ignore và thử endpoint tiếp theo
    }
  }
  return []; // sẽ fallback bên dưới
}

// Fallback: lấy history rồi lọc “đang mở” (totalPnl === 0 hoặc không có closed info)
async function fetchOpenEntriesFromHistory(trader) {
  // lấy 1-2 trang là đủ detect entry gần đây
  const pageSize = 50;
  let pageNumber = 1;
  const all = [];

  while (pageNumber <= 2) {
    const data = await postJson(ORDERS_HIS_ENDPOINT, {
      portfolioId: String(trader.portfolioId),
      startTime: undefined,
      endTime: undefined,
      pageSize,
      pageNumber,
    }).catch(() => null);

    const list = data?.data?.list || [];
    if (!list.length) break;

    // Điều kiện entry đang mở:
    // - totalPnl === 0 (chưa chốt) hoặc không có trường close/closed
    // - ưu tiên type MARKET (khớp ngay)
    const entries = list
      .filter(o => (o.totalPnl === 0 || o.totalPnl == null))
      .map(o => ({
        ...o,
        // nếu API history: có side/type/positionSide rồi
      }));

    all.push(...entries);
    if (list.length < pageSize) break;

    pageNumber += 1;
    if (PAGE_SLEEP_MS > 0) await delay(PAGE_SLEEP_MS);
  }

  if (VERBOSE) console.log(`[PID ${trader.portfolioId}] Fallback entries from history: ${all.length}`);
  return all.map(o => normalizeOpenEntry(o, trader));
}

// ---------------- CSV ----------------
const CSV_HEADERS = [
  "portfolioId",
  "uid",
  "nickname",
  "symbol",
  "side",
  "positionSide",
  "type",
  "executedQty",
  "avgPrice",
  "leverage",
  "marginMode",
  "totalPnl",   // thường null/0 khi đang mở
  "orderTime",
];

const esc = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---------------- Main ----------------
async function ensureHeader(file, headers) {
  try {
    await access(file, constants.F_OK);
  } catch {
    await writeFile(file, headers.join(",") + "\n", "utf8");
  }
}

(async () => {
  try {
    await ensureHeader(OUTPUT, CSV_HEADERS);

    // 1) Lấy danh sách lead traders
    const traders = await fetchPortfolioIds();
    if (!traders.length) {
      console.log("No traders found");
      process.exit(0);
    }

    // 2) Lấy open entries theo CONCURRENCY
    const entries = await pLimitAll(traders, CONCURRENCY, async (tr) => {
      // Thử endpoint open → nếu rỗng → fallback history
      const openDirect = await fetchOpenEntriesByPortfolio(tr);
      if (openDirect.length) return openDirect;
      const fallback = await fetchOpenEntriesFromHistory(tr);
      return fallback;
    });

    if (!entries.length) {
      console.log("No open entries");
      process.exit(0);
    }

    // 3) Ghi CSV
    const body =
      entries
        .map((r) => CSV_HEADERS.map((h) => esc(r[h])).join(","))
        .join("\n") + "\n";

    await appendFile(OUTPUT, body, "utf8");
    console.log(`💾 Saved ${entries.length} open entries → ${OUTPUT}`);
  } catch (e) {
    console.error("❌ Error:", e?.message || e);
    process.exit(1);
  }
})();
