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
const CONCURRENCY = Math.max(1, Number(args.concurrency ?? 1));
const INCLUDE_FOLLOWERS = args.noFollowers ? false : true;
const MAX_RPS = Number(args.rps ?? env.MAX_RPS ?? 5);
const PAGE_SLEEP_MS = Number(args.pageSleep ?? 120);

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

// ---------------- Rate limit (nhẹ) ----------------
let tokens = MAX_RPS;
let lastRefill = Date.now();
const BUCKET_SIZE = MAX_RPS;
const delay = (ms) => sleep(ms);

async function rateLimit() {
  while (true) {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    const refill = Math.floor(elapsed * MAX_RPS);
    if (refill > 0) {
      tokens = Math.min(BUCKET_SIZE, tokens + refill);
      lastRefill = now;
    }
    if (tokens > 0) {
      tokens -= 1;
      const jitter = 100 + Math.floor(Math.random() * 150); // ngắn hơn
      await delay(jitter);
      return;
    }
    await delay(30);
  }
}

async function fetchJson(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      console.log(url);          // show full URL trước khi gọi
      await rateLimit();
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (i < retries && (res.status === 429 || res.status === 403 || res.status >= 500)) {
          const base = res.status === 403 ? 900 : 600;
          await delay(base * Math.pow(1.6, i));
          continue;
        }
        throw new Error(`${res.status} ${res.statusText} - ${body.slice(0, 160)}`);
      }
      return await res.json();
    } catch (err) {
      if (i < retries) {
        await delay(500 * Math.pow(1.5, i));
        continue;
      }
      throw err;
    }
  }
}

async function pLimitAll(items, limit, worker) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        const r = await worker(item);
        if (Array.isArray(r)) out.push(...r);
        else out.push(r);
      } catch (e) {
        console.error("❌ Worker error:", e?.message || e);
      }
      await delay(100);
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
  return unique(uids);
}

/**
 * Paginate all pages using LIMIT-only rule + optional pageTime cursor.
 * - Không dựa vào totalPage (có thể = 0).
 * - Tiếp tục nếu content.length === limit.
 * - Dừng nếu < limit hoặc rỗng.
 * - Luôn log URL và kết quả.
 * - Chống lặp: nếu lastPageTime không tăng, thử page+1 một lần; nếu vẫn lặp thì dừng.
 */
async function fetchOrdersByUIDAllPages(uid) {
  let page = 1;
  let cursor;                       // pageTime cursor (optional)
  let lastCursor;                   // để phát hiện lặp cursor
  const all = [];

  while (true) {
    const u = new URL(ORDERS_HIS_ENDPOINT);
    u.searchParams.set("limit", String(ORDERS_LIMIT));
    u.searchParams.set("page", String(page));
    u.searchParams.set("uid", String(uid));
    if (cursor !== undefined) u.searchParams.set("pageTime", String(cursor));

    const urlStr = u.toString();
    const data = await fetchJson(urlStr);
    const d = data?.data || {};
    const content = Array.isArray(d.content) ? d.content : [];

    console.log(`[UID ${uid}] ← page ${page} (${content.length} items)`);

    if (!content.length) break;

    all.push(...content.map((o) => ({ uid: String(uid), ...o })));

    // chuẩn bị next cursor
    const nextCursor = content.at(-1)?.pageTime;
    const gotFull = content.length === ORDERS_LIMIT;

    // Nếu không full, khả năng cao đã hết
    if (!gotFull) break;

    // Nếu full nhưng không có pageTime -> thử page+1 một lần; nếu lần sau vẫn không đổi, dừng
    if (nextCursor == null) {
      if (page >= 2 && lastCursor == null) break; // 2 trang liên tiếp không có cursor -> dừng
      lastCursor = null;
      page += 1;
      await delay(PAGE_SLEEP_MS);
      continue;
    }

    // Nếu cursor không thay đổi (bị lặp), thử 1 trang nữa rồi dừng nếu vẫn lặp
    if (lastCursor !== undefined && String(nextCursor) === String(lastCursor)) {
      page += 1;
      await delay(PAGE_SLEEP_MS);
      const checkUrl = new URL(ORDERS_HIS_ENDPOINT);
      checkUrl.searchParams.set("limit", String(ORDERS_LIMIT));
      checkUrl.searchParams.set("page", String(page));
      checkUrl.searchParams.set("uid", String(uid));
      checkUrl.searchParams.set("pageTime", String(nextCursor));
      console.log(checkUrl.toString());
      const checkData = await fetchJson(checkUrl.toString());
      const checkContent = Array.isArray(checkData?.data?.content) ? checkData.data.content : [];
      console.log(`[UID ${uid}] ← page ${page} (${checkContent.length} items, recheck)`);
      if (!checkContent.length) break;
      all.push(...checkContent.map((o) => ({ uid: String(uid), ...o })));
      // sau recheck nếu cũng không full thì dừng; nếu full mà vẫn same cursor thì cũng dừng để tránh vòng lặp
      if (checkContent.length < ORDERS_LIMIT) break;
      break; // tránh vòng lặp vô hạn
    }

    // tiến tới trang tiếp theo bình thường
    lastCursor = nextCursor;
    cursor = nextCursor;
    page += 1;
    await delay(PAGE_SLEEP_MS);
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

function toCSV(rows, headers) {
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n") + "\n";
}

// ---------------- Normalize ----------------
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

    const csvBody = rows.map((r) => CSV_HEADERS.map((h) => esc(r[h])).join(",")).join("\n") + "\n";
    await appendFile(OUTPUT, csvBody, "utf8");
    console.log(`💾 Saved ${rows.length} orders → ${OUTPUT}`);
  } catch (e) {
    console.error("❌ Error:", e?.message || e);
    process.exit(1);
  }
})();
