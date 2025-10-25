#!/usr/bin/env node
/**
 * binance-orders.js
 * Node.js script (no Cloudflare) — fetch Binance Copy Trade Lead Portfolio Order History
 * - Fetch 3 pages, pageSize = 30, paginate by indexValue
 * - Keep old input params: uids, limit, cursor, max, startTime, endTime
 * - Normalize to your existing DTO
 */

const API_BINANCE_ORDER_HISTORY =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history";

const API_BINANCE_PORTFOLIO_LIST =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/list";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/json",
};

// Mặc định: nhận luôn 1 portfolioId như bạn đang demo
const DEFAULT_UIDS = "4438679961865098497";

// ---------- utils ----------
function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}
function pair(s = "") {
  return String(s).replace("_", "");
}
function modeFromSide(side) {
  const s = String(side || "").toUpperCase();
  if (s === "BUY") return "long";
  if (s === "SELL") return "short";
  return "unknown";
}
function tsVNT(t) {
  return t
    ? new Date(t)
        .toLocaleString("en-GB", {
          timeZone: "Asia/Ho_Chi_Minh",
          hour12: false,
        })
        .replace(",", "")
    : "";
}
function lev(o) {
  // Không có leverage trong sample → fallback 1
  return n(o?.raw?.leverage) || 1;
}
function mUSDT(p, a, l, m) {
  const M = n(m);
  if (M > 0) return M;
  const not = n(p) * n(a);
  return (n(l) || 1) > 0 ? not / (l || 1) : 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Binance helpers ----------
async function fetchPortfolioIdsByLeadUid(leadUid) {
  try {
    const res = await fetch(API_BINANCE_PORTFOLIO_LIST, {
      method: "POST",
      headers: BROWSER_HEADERS,
      body: JSON.stringify({ leadUid: String(leadUid) }),
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    const list = json?.data?.list || json?.data || [];
    return list
      .map((it) => String(it?.portfolioId || ""))
      .filter((s) => !!s && s.length > 0);
  } catch {
    return [];
  }
}

async function fetchFirst3PagesOrderHistory(portfolioId, startTime, endTime) {
  const pageSize = 30;
  let indexValue = undefined;
  const all = [];

  for (let page = 1; page <= 3; page++) {
    await sleep(120 + Math.floor(Math.random() * 80));

    const payload = {
      portfolioId: String(portfolioId),
      startTime: n(startTime),
      endTime: n(endTime),
      pageSize,
    };
    if (indexValue) payload.indexValue = String(indexValue);

    const res = await fetch(API_BINANCE_ORDER_HISTORY, {
      method: "POST",
      headers: BROWSER_HEADERS,
      body: JSON.stringify(payload),
    });
    if (!res.ok) break;

    const json = await res.json().catch(() => null);
    const ok = json?.success === true && json?.code === "000000";
    const data = ok ? json?.data : null;
    const list = Array.isArray(data?.list) ? data.list : [];
    for (const item of list) all.push(item);

    const nextIndex = data?.indexValue || null;
    if (!nextIndex || list.length === 0) break;
    indexValue = nextIndex;
  }

  return all;
}

// ---------- CLI ----------
function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      args[k] = v === undefined ? true : v;
    }
  }
  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv);

    // input params (giữ tên cũ)
    const uids = String(args.uids || DEFAULT_UIDS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const limit = n(args.limit || 50); // không dùng cho Binance, giữ để không breaking
    const total = uids.length;
    const start = Math.max(0, n(args.cursor || 0));
    const maxPerCall = Math.max(1, Math.min(35, n(args.max || 35)));
    const end = Math.min(total, start + maxPerCall);

    const now = Date.now();
    const defaultStart = now - 7 * 24 * 60 * 60 * 1000;
    const startTime = n(args.startTime || defaultStart);
    const endTime = n(args.endTime || now);

    const all = [];

    for (let i = start; i < end; i++) {
      const uid = uids[i];
      await sleep(80 + Math.floor(Math.random() * 60));

      let portfolioIds = [];
      if (String(uid).length > 15) {
        // đã là portfolioId
        portfolioIds = [String(uid)];
      } else {
        portfolioIds = await fetchPortfolioIdsByLeadUid(uid);
        if (!portfolioIds.length) continue;
      }

      for (const pid of portfolioIds) {
        const rows = await fetchFirst3PagesOrderHistory(pid, startTime, endTime);
        for (const r of rows) {
          all.push({ ...r, _portfolioId: pid, _leadUid: uid });
        }
      }
    }

    // de-dup
    const keyOf = (o) =>
      [
        o?._portfolioId || "",
        o?.orderTime || "",
        o?.symbol || "",
        o?.avgPrice || "",
        o?.executedQty || "",
        o?.side || "",
      ].join("|");

    const byKey = new Map();
    for (const o of all) {
      const k = keyOf(o);
      const prev = byKey.get(k);
      const t = n(o?.orderUpdateTime || o?.orderTime || 0);
      const tp = n(prev?.orderUpdateTime || prev?.orderTime || 0);
      if (!prev || t > tp) byKey.set(k, o);
    }

    // normalize DTO cũ
    const data = Array.from(byKey.values())
      .map((o) => {
        const L = lev(o);
        const P = n(o?.avgPrice);
        const A = n(o?.executedQty);
        const notional = P * A;
        const M = mUSDT(P, A, L, 0);

        return {
          id: `${o?.symbol || ""}-${o?.orderTime || ""}-${o?.side || ""}`,
          trader: "",
          traderUid: String(o?._leadUid || ""),
          symbol: pair(o?.symbol || ""),
          mode: modeFromSide(o?.side),
          lev: L,
          marginMode: "Unknown",
          amount: A,
          openPrice: P,
          margin: M,
          notional,
          followers: undefined,
          openAt: n(o?.orderTime || 0),
          openAtStr: tsVNT(o?.orderTime || 0),
          marginPct: notional > 0 ? (M / notional) * 100 : 0,
          raw: o,
        };
      })
      .sort((a, b) => b.openAt - a.openAt);

    const nextCursor = end < total ? String(end) : null;

    const output = {
      success: true,
      page: { start, end, total, maxPerCall, nextCursor, limitUsed: limit },
      meta: {
        source: "binance.copy-trade.lead-portfolio.order-history",
        pagesPerPortfolio: 3,
        pageSize: 30,
        startTime,
        endTime,
      },
      data,
    };

    // In ra stdout (bạn có thể redirect > file.json nếu muốn)
    console.log(JSON.stringify(output));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: String(err?.message || err) }));
    process.exit(1);
  }
}

main();

/**
 * Cách chạy:
 *   node binance-orders.js \
 *     --uids=4438679961865098497 \
 *     --cursor=0 \
 *     --max=35 \
 *     --limit=50 \
 *     --startTime=1760806800000 \
 *     --endTime=1761411599999
 *
 * Ghi ra file:
 *   node binance-orders.js --uids=4438679961865098497 > out.json
 */
