// binance-copy-orders-to-csv.js
// Node >= 18 (có fetch). Giữ logic gốc từ script MEXC, đổi endpoint + mapping Binance.

import { writeFile, appendFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { argv, env } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------- CLI ----------------
const args = Object.fromEntries(
  argv.slice(2).filter(a => a.startsWith("--")).map(a => a.slice(2).split("="))
);

const OUTPUT = args.out || "orders_binance.csv";
const ORDERS_LIMIT = Number(args.limit ?? 50);           // pageSize cho history
const TRADER_LIMIT = Number(args.traderLimit ?? 50);     // mỗi lần query-list
const CONCURRENCY = Math.max(1, Number(args.concurrency ?? 3));
const INCLUDE_FOLLOWERS = args.noFollowers ? false : true;
const START_RPS = Number(args.rps ?? env.MAX_RPS ?? 10);
const MIN_RPS = Number(args.minRps ?? 2);
const PAGE_SLEEP_MS = Number(args.pageSleep ?? 15);
const VERBOSE = true;

// DataType sort trên Binance web API
const ORDER_BYS = ["PNL", "ROI", "WIN_RATE", ...(INCLUDE_FOLLOWERS ? ["FOLLOWERS"] : [])];

// ---------------- API ----------------
const TRADERS_ENDPOINT =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list";

const ORDERS_HIS_ENDPOINT =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position-history";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "Origin": "https://www.binance.com",
  "Referer": "https://www.binance.com/en/copy-trading",
  "clienttype": "web",
  "bnc-time-zone": "Asia/Saigon",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "keep-alive",
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

const unique = (arr) => [...new Set(arr)];

// ---------------- Fetchers ----------------

// Lấy danh sách traders (portfolioId) theo từng ORDER_BYS, gộp unique
async function fetchPortfolioIds() {
  const calls = ORDER_BYS.map((dataType) =>
    postJson(TRADERS_ENDPOINT, {
      pageNumber: 1,
      pageSize: Math.min(TRADER_LIMIT, 50),  // web API thường cap ~50
      timeRange: "30D",
      dataType,                              // "PNL" | "ROI" | "WIN_RATE" | "FOLLOWERS"
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
  // Chuẩn hoá trader tối thiểu
  const traders = list.map(t => ({
    portfolioId: t?.portfolioId || t?.leadPortfolioId || t?.id,
    nickname: t?.nickName || t?.nickname || "",
    uid: t?.uid || t?.userId || "",
    roi: t?.roi ?? null,
    pnl: t?.pnl ?? null,
    winRate: t?.winRate ?? null,
    followers: t?.follower ?? t?.followers ?? null,
  })).filter(t => t.portfolioId);

  // unique theo portfolioId
  const seen = new Set();
  const uniq = traders.filter(t => (seen.has(t.portfolioId) ? false : (seen.add(t.portfolioId), true)));
  if (VERBOSE) console.log(`✅ Collected ${uniq.length} unique portfolioIds from ${ORDER_BYS.length} sorts`);
  return uniq;
}

// Phân trang history orders cho 1 portfolioId (Binance: pageNumber/pageSize + total)
async function fetchOrdersByPortfolioAllPages(trader, limit = ORDERS_LIMIT) {
  let pageNumber = 1;
  const pageSize = limit;
  const all = [];

  while (true) {
    const body = {
      portfolioId: String(trader.portfolioId),
      pageNumber,
      pageSize,
    };
    const data = await postJson(ORDERS_HIS_ENDPOINT, body);
    const d = data?.data || {};
    const list = Array.isArray(d.list) ? d.list : [];
    const total = Number(d.total ?? 0);

    console.log(`[PID ${trader.portfolioId}] → page ${pageNumber} (${list.length} items)`);

    if (!list.length) break;
    all.push(...list.map(o => ({ ...o, _portfolioId: trader.portfolioId, _uid: trader.uid, _nickname: trader.nickname })));

    const got = all.length;
    if (list.length < pageSize) break;
    if (total && got >= total) break;

    pageNumber += 1;
    if (PAGE_SLEEP_MS > 0) await delay(PAGE_SLEEP_MS);
  }

  console.log(`✅ Done PID ${trader.portfolioId} → total ${all.length} orders`);
  return all;
}

// ---------------- CSV ----------------
const CSV_HEADERS = [
  "portfolioId",
  "uid",
  "nickname",
  "id",
  "symbol",
  "type",
  "side",
  "isolated",          // Cross/Isolated (string trong demo)
  "status",
  "avgCost",
  "avgClosePrice",
  "closingPnl",
  "closedVolume",
  "maxOpenInterest",
  "opened",
  "closed",
  "updateTime",
];

const esc = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Map response Binance → CSV row
function normalizeOrderBinance(o) {
  return {
    portfolioId: o._portfolioId ?? "",
    uid: o._uid ?? "",
    nickname: o._nickname ?? "",
    id: o.id ?? "",
    symbol: o.symbol ?? "",
    type: o.type ?? "",                     // UM...
    side: o.side ?? "",                     // Long | Short
    isolated: o.isolated ?? "",             // "Cross" | "Isolated"
    status: o.status ?? "",                 // All Closed / ...
    avgCost: o.avgCost ?? "",
    avgClosePrice: o.avgClosePrice ?? "",
    closingPnl: o.closingPnl ?? "",
    closedVolume: o.closedVolume ?? "",
    maxOpenInterest: o.maxOpenInterest ?? "",
    opened: o.opened ?? "",                 // epoch ms
    closed: o.closed ?? "",                 // epoch ms
    updateTime: o.updateTime ?? "",         // epoch ms
  };
}

async function ensureHeader(file, headers) {
  try {
    await access(file, constants.F_OK);
  } catch {
    await writeFile(file, headers.join(",") + "\n", "utf8");
  }
}

// ---------------- Main ----------------
(async () => {
  try {
    await ensureHeader(OUTPUT, CSV_HEADERS);

    // 1) Lấy traders (portfolioId list)
    const traders = await fetchPortfolioIds();
    if (!traders.length) {
      console.log("No traders found");
      process.exit(0);
    }

    // 2) Lấy toàn bộ orders theo CONCURRENCY
    const orders = await pLimitAll(traders, CONCURRENCY, async (tr) => {
      return await fetchOrdersByPortfolioAllPages(tr);
    });

    // 3) Chuẩn hoá & lưu CSV
    const rows = orders.map(normalizeOrderBinance);
    if (!rows.length) {
      console.log("No orders");
      process.exit(0);
    }

    const body = rows.map(r => CSV_HEADERS.map(h => esc(r[h])).join(",")).join("\n") + "\n";
    await appendFile(OUTPUT, body, "utf8");
    console.log(`💾 Saved ${rows.length} orders → ${OUTPUT}`);
  } catch (e) {
    console.error("❌ Error:", e?.message || e);
    process.exit(1);
  }
})();
