#!/usr/bin/env node
import { writeFile, appendFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { argv, env } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------- CLI ----------------
const args = Object.fromEntries(
  argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("="))
);

const OUTPUT = args.out || "orders.csv";
const ORDERS_LIMIT = Number(args.limit ?? 10);
const TRADER_LIMIT = Number(args.traderLimit ?? 100);
const CONCURRENCY = Math.max(1, Number(args.concurrency ?? 2)); // nhanh mặc định
const INCLUDE_FOLLOWERS = args.noFollowers ? false : true;
const START_RPS = Number(args.rps ?? env.MAX_RPS ?? 10);        // nhanh mặc định
const MIN_RPS = Number(args.minRps ?? 2);                       // không giảm thấp hơn
const PAGE_SLEEP_MS = Number(args.pageSleep ?? 15);             // rất ngắn theo yêu cầu
const VERBOSE = true;

const ORDER_BYS = ["ROI", "PNL", "WIN_RATE", ...(INCLUDE_FOLLOWERS ? ["FOLLOWERS"] : [])];

// ---------------- API ----------------
const TRADERS_ENDPOINT = "https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2";
const ORDERS_HIS_ENDPOINT = "https://www.mexc.com/api/platform/futures/copyFutures/api/v1/trader/ordersHis/v2";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.mexc.com/",
  Origin: "https://www.mexc.com",
  Connection: "keep-alive",
  ...(env.INTERNAL_API_KEY ? { "x-api-key": env.INTERNAL_API_KEY } : {}),
};

// ---------------- Adaptive limiter ----------------
// - Start fast (START_RPS), very small jitter.
// - On 403/429: cut RPS in half (not below MIN_RPS), apply cooldown.
// - Gradual recovery: every OK request, add small credit.
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
  // If in cooldown, wait out
  const now = Date.now();
  if (now < cooldownUntil) {
    await delay(cooldownUntil - now);
  }
  while (true) {
    refillTokens();
    if (tokens >= 1) {
      tokens -= 1;
      // tiny jitter 0–50ms
      const jitter = Math.floor(Math.random() * 50);
      if (jitter) await delay(jitter);
      return;
    }
    await delay(5);
  }
}

function onDeny(status, attempt) {
  // halve RPS but not below MIN_RPS
  const newRps = Math.max(MIN_RPS, Math.floor(currentRps / 2));
  if (newRps !== currentRps) {
    currentRps = newRps;
    if (VERBOSE) console.log(`⚠️  Denied (${status}). Reduce RPS → ${currentRps}`);
  }
  // cooldown increases with attempt
  const base = status === 403 ? 2000 : 1500;
  const ms = Math.min(8000, Math.floor(base * Math.pow(1.5, attempt)));
  cooldownUntil = Date.now() + ms;
}

function onSuccessTick() {
  // small recovery: every success, if below START_RPS, nudge up
  if (currentRps < START_RPS) {
    // 1% chance to increase by 1 (avoid oscillation)
    if (Math.random() < 0.03) {
      currentRps += 1;
      if (VERBOSE) console.log(`✅ Recover RPS → ${currentRps}`);
    }
  }
}

async function fetchJson(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      await rateLimit();
      if (VERBOSE) console.log("   ↳ GET", url);
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          if (i < retries) {
            onDeny(res.status, i);
            continue;
          }
        }
        throw new Error(`${res.status} ${res.statusText} - ${body.slice(0, 160)}`);
      }
      onSuccessTick();
      return await res.json();
    } catch (err) {
      // network error, backoff light, but don't globally slow unless final
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
async function fetchTraderUIDs() {
  const urls = ORDER_BYS.map((orderBy) => {
    const u = new URL(TRADERS_ENDPOINT);
    u.searchParams.set("condition", "[]");
    u.searchParams.set("limit", String(TRADER_LIMIT));
    u.searchParams.set("orderBy", orderBy);
    u.searchParams.set("page", "1");
    return u.toString();
  });
  const results = await Promise.all(urls.map((u) => fetchJson(u).catch(() => null)));
  const uids = results
    .flatMap((r) => (r?.data?.content ? r.data.content : []))
    .map((t) => t?.uid)
    .filter(Boolean)
    .map(String);
  const uniq = unique(uids);
  if (VERBOSE) console.log(`✅ Collected ${uniq.length} unique UIDs from ${ORDER_BYS.length} lists`);
  return uniq;
}

/**
 * Paginate using pageTime cursor; move fast unless denied.
 * Stop when:
 *  - content.length === 0
 *  - content.length < limit
 *  - next pageTime doesn't advance
 */
async function fetchOrdersByUIDAllPages(uid) {
  let page = 1;
  let cursor; // pageTime
  const all = [];

  while (true) {
    const u = new URL(ORDERS_HIS_ENDPOINT);
    u.searchParams.set("limit", String(ORDERS_LIMIT));
    u.searchParams.set("page", String(page));            // giữ page tăng để hợp lệ
    u.searchParams.set("uid", String(uid));
    if (cursor !== undefined) u.searchParams.set("pageTime", String(cursor));

    const urlStr = u.toString();
    const data = await fetchJson(urlStr);
    const d = data?.data || {};
    const content = Array.isArray(d.content) ? d.content : [];

    console.log(`[UID ${uid}] → page ${page} (${content.length} items)  URL=${urlStr}`);

    if (!content.length) break;

    all.push(...content.map((o) => ({ uid: String(uid), ...o })));

    const nextCursor = content.at(-1)?.pageTime;
    if (nextCursor == null || nextCursor === cursor) break;
    if (content.length < ORDERS_LIMIT) break;

    cursor = nextCursor;
    page += 1;

    // fast between pages unless you tweak pageSleep
    if (PAGE_SLEEP_MS > 0) await delay(PAGE_SLEEP_MS);
  }

  console.log(`✅ Done UID ${uid} → total ${all.length} orders`);
  return all;
}

// ---------------- CSV ----------------
const CSV_HEADERS = [
  "uid",
  "orderId",
  "symbol",
  "side",
  "leverage",
  "marginMode",
  "amount",
  "openAvgPrice",
  "closeAvgPrice",
  "margin",
  "released",
  "roiPct",
  "notional",
  "fee",
  "followers",
  "copyFollowers",
  "traderNickName",
  "positionId",
  "openTime",
  "closeTime",
  "id",
  "pageTime",
  "closeCategory",
  "stopLossRatio",
  "takeProfitRatio",
  "holdFee",
  "positionFee",
  "externalOid",
];

const esc = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function normalizeOrder(o) {
  const side = o.positionType === 1 ? "long" : o.positionType === 2 ? "short" : o.positionType;
  const marginMode = o.openType === 1 ? "isolated" : o.openType === 2 ? "cross" : o.openType;
  const roiPct =
    o.margin && Number(o.margin) !== 0
      ? ((Number(o.released || 0) / Number(o.margin)) * 100).toFixed(2)
      : "";
  const notional = Number(o.amount || 0) * Number(o.openAvgPrice || 0);
  const symbol = o.symbol ? String(o.symbol).replace(/_/g, "") : "";
  return {
    uid: o.traderUid ?? "",
    orderId: o.orderId ?? "",
    symbol,
    side,
    leverage: o.leverage ?? "",
    marginMode,
    amount: o.amount ?? "",
    openAvgPrice: o.openAvgPrice ?? "",
    closeAvgPrice: o.closeAvgPrice ?? "",
    margin: o.margin ?? "",
    released: o.released ?? "",
    roiPct,
    notional: notional || "",
    fee: o.fee ?? "",
    followers: o.followers ?? "",
    copyFollowers: o.copyFollowers ?? "",
    traderNickName: o.traderNickName ?? "",
    positionId: o.positionId ?? "",
    openTime: o.openTime ?? "",
    closeTime: o.closeTime ?? "",
    id: o.id ?? "",
    pageTime: o.pageTime ?? "",
    closeCategory: o.closeCategory ?? "",
    stopLossRatio: o.stopLossRatio ?? "",
    takeProfitRatio: o.takeProfitRatio ?? "",
    holdFee: o.holdFee ?? "",
    positionFee: o.positionFee ?? "",
    externalOid: o.externalOid ?? "",
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

    const uids = await fetchTraderUIDs();
    if (!uids.length) {
      console.log("No UIDs found");
      process.exit(0);
    }

    const orders = await pLimitAll(uids, CONCURRENCY, async (uid) => {
      return await fetchOrdersByUIDAllPages(uid);
    });

    const rows = orders.map(normalizeOrder);
    if (!rows.length) {
      console.log("No orders");
      process.exit(0);
    }

    const body =
      rows.map((r) => CSV_HEADERS.map((h) => esc(r[h])).join(",")).join("\n") + "\n";
    await appendFile(OUTPUT, body, "utf8");
    console.log(`💾 Saved ${rows.length} orders → ${OUTPUT}`);
  } catch (e) {
    console.error("❌ Error:", e?.message || e);
    process.exit(1);
  }
})();
