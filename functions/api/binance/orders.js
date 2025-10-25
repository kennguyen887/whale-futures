// /api/binance/orders - Cloudflare Pages Functions
// GET /api/binance/orders?uids=1,2,3&limit=10&cursor=0&max=35
// - Tuần tự (no concurrency), hạn chế subrequests bằng cursor paging
// - Auth nhẹ bằng x-api-key nếu có env.INTERNAL_API_KEY
// - ĐÃ CHUYỂN sang Binance Copy Trade (Lead Portfolio) Order History
//   → Lấy 3 trang đầu, pageSize = 30, phân trang bằng indexValue

const API_BINANCE_ORDER_HISTORY =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history";

// Thử map leadUid → danh sách portfolioId (nếu uids truyền là UID)
// Nếu uids đã là portfolioId thì dùng thẳng (dài > 15 coi như portfolioId)
const API_BINANCE_PORTFOLIO_LIST =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/list";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/json",
};

const DEFAULT_UIDS =
  "4438679961865098497";

function corsHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "Content-Type, X-API-Key",
  };
}
function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}
function pair(s = "") {
  return String(s).replace("_", "");
}
function modeFromSide(side) {
  // Binance order history có BUY/SELL (không hẳn là mở vị thế),
  // vẫn map tạm để giữ DTO cũ.
  if (String(side || "").toUpperCase() === "BUY") return "long";
  if (String(side || "").toUpperCase() === "SELL") return "short";
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
  // Binance order history sample không có leverage → fallback 1
  return n(o?.raw?.leverage) || 1;
}
function mUSDT(p, a, l, m) {
  const M = n(m);
  if (M > 0) return M;
  const not = n(p) * n(a);
  return (n(l) || 1) > 0 ? not / (l || 1) : 0;
}

// Helper: sleep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Thử lấy portfolioId theo leadUid (nếu cần)
async function fetchPortfolioIdsByLeadUid(leadUid) {
  try {
    const body = JSON.stringify({ leadUid: String(leadUid) });
    const res = await fetch(API_BINANCE_PORTFOLIO_LIST, {
      method: "POST",
      headers: BROWSER_HEADERS,
      body,
      cf: { cacheEverything: false },
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    const list = json?.data?.list || json?.data || [];
    // Trả về mảng portfolioId (string)
    return list
      .map((it) => String(it?.portfolioId || ""))
      .filter((s) => !!s && s.length > 0);
  } catch {
    return [];
  }
}

// Gọi 3 trang đầu (pageSize=30) theo portfolioId, có start/end
async function fetchFirst3PagesOrderHistory(portfolioId, startTime, endTime) {
  const pageSize = 30;
  let indexValue = undefined; // undefined ở lần 1, sau đó gán từ response
  const all = [];

  for (let page = 1; page <= 3; page++) {
    // nhẹ nhàng tránh rate-limit
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
      cf: { cacheEverything: false },
    });

    if (!res.ok) break; // dừng nếu lỗi

    const json = await res.json().catch(() => null);
    const ok = json?.success === true && json?.code === "000000";
    const data = ok ? json?.data : null;
    const list = Array.isArray(data?.list) ? data.list : [];
    for (const item of list) {
      all.push(item);
    }
    // Chuẩn bị cho trang sau
    const nextIndex = data?.indexValue || null;
    if (!nextIndex || list.length === 0) break;
    indexValue = nextIndex;
  }

  return all;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequest(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const uids = (url.searchParams.get("uids") || DEFAULT_UIDS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Tham số cũ vẫn giữ nguyên để tương thích, nhưng limit không dùng cho Binance (luôn pageSize=30 * 3 trang)
    const limit = n(url.searchParams.get("limit") || 50); // giữ để không breaking
    const total = uids.length;
    const start = Math.max(0, n(url.searchParams.get("cursor") || 0));
    const maxPerCall = Math.max(1, Math.min(35, n(url.searchParams.get("max") || 35)));
    const end = Math.min(total, start + maxPerCall);

    // Khoảng thời gian: nếu không truyền, mặc định 7 ngày gần nhất
    const now = Date.now();
    const defaultStart = now - 7 * 24 * 60 * 60 * 1000;
    const startTime = n(url.searchParams.get("startTime") || defaultStart);
    const endTime = n(url.searchParams.get("endTime") || now);

    const all = [];

    // Tuần tự qua từng "uid" (có thể là leadUid hoặc portfolioId)
    for (let i = start; i < end; i++) {
      const uid = uids[i];
      // tránh bị coi là bot
      await sleep(80 + Math.floor(Math.random() * 60));

      let portfolioIds = [];
      // Nếu chuỗi dài > 15 → coi như portfolioId đã được truyền
      if (String(uid).length > 15) {
        portfolioIds = [String(uid)];
      } else {
        // Thử lấy danh sách portfolioId theo leadUid
        portfolioIds = await fetchPortfolioIdsByLeadUid(uid);
        // Nếu không lấy được, bỏ qua uid này
        if (!portfolioIds.length) continue;
      }

      // Lấy 3 trang đầu cho từng portfolioId
      for (const pid of portfolioIds) {
        const rows = await fetchFirst3PagesOrderHistory(pid, startTime, endTime);
        for (const r of rows) {
          all.push({ ...r, _portfolioId: pid, _leadUid: uid });
        }
      }
    }

    // De-dup: key theo (portfolioId + orderTime + symbol + avgPrice + executedQty + side)
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

    // Normalize sang DTO cũ
    const data = Array.from(byKey.values())
      .map((o) => {
        const L = lev(o);
        const P = n(o?.avgPrice);
        const A = n(o?.executedQty);
        const notional = P * A;
        const M = mUSDT(P, A, L, 0); // Binance sample không có margin → tính suy ra

        return {
          id: `${o?.symbol || ""}-${o?.orderTime || ""}-${o?.side || ""}`,
          trader: "", // Binance không trả nickname trong API này
          traderUid: String(o?._leadUid || ""),
          symbol: pair(o?.symbol || ""),
          mode: modeFromSide(o?.side),
          lev: L,
          marginMode: "Unknown",
          amount: A,
          openPrice: P,
          margin: M,
          notional,
          followers: undefined, // không có trong API này
          openAt: n(o?.orderTime || 0),
          openAtStr: tsVNT(o?.orderTime || 0),
          marginPct: notional > 0 ? (M / notional) * 100 : 0,
          raw: o,
        };
      })
      .sort((a, b) => b.openAt - a.openAt);

    const nextCursor = end < total ? String(end) : null;
    return new Response(
      JSON.stringify({
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
      }),
      { headers: corsHeaders() }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: String(e?.message || e) }),
      { status: 500, headers: corsHeaders() }
    );
  }
}
