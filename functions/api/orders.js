// Cloudflare Pages Functions - /api/orders
// GET /api/orders?uids=1,2,3&limit=10
// - Không dùng cache
// - Không có testNotification

const API_ORDERS = "https://www.mexc.com/api/platform/futures/copyFutures/api/v1/trader/orders/v2";

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

const DEFAULT_UIDS =
  "34988691,02058392,83769107,47991559,82721272,89920323,92798483,72432594,87698388,31866177,49787038,45227412,80813692,27337672,95927229,71925540,38063228,47395458,78481146,89070846,01249789,87698388,57343925,74785697,21810967,22247145,88833523,40133940,84277140,93640617,76459243,48673493,13290625,48131784,23747691";

// ---------- Utils ----------
function corsHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "Content-Type, X-API-Key",
  };
}
function safeNum(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function toPair(s = "") { return String(s).replace("_", ""); }
function modeFromPositionType(pt) { if (pt === 1) return "long"; if (pt === 2) return "short"; return "unknown"; }
function marginModeFromOpenType(ot) { if (ot === 1) return "Isolated"; if (ot === 2) return "Cross"; return "Unknown"; }
function leverageOf(o) { return safeNum(o.leverage ?? o.lev ?? o.openLeverage ?? o?.raw?.leverage) || 1; }
function marginUSDT(openAvgPrice, amount, lev, apiMargin) {
  const m = safeNum(apiMargin);
  if (m > 0) return m;
  const n = safeNum(openAvgPrice) * safeNum(amount);
  return (safeNum(lev) || 1) > 0 ? n / lev : 0;
}

function tsVNT(t) {
  return t
    ? new Date(t).toLocaleString("en-GB", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour12: false
    }).replace(",", "")
    : "";
}

function notional(o) {
  return Number(o.openAvgPrice || 0) * Number(o.amount || 0);
}

function marginPct(o) {
  const m = Number(o.margin || 0);
  const n = notional(o);
  return n > 0 ? (m / n) * 100 : 0;
}

// ---------- Normalize (có traderUid, raw, notional) ----------
function normalizeAndCompute(rows) {
  return rows.map((o) => {
    const lev = leverageOf(o);
    const openPrice = safeNum(o.openAvgPrice);
    const amount = safeNum(o.amount);
    const margin = marginUSDT(openPrice, amount, lev, o.margin);
    const traderUid = String(o.uid ?? o.traderUid ?? o._uid ?? "");
    const notional = openPrice * amount;

    return {
      id: o.orderId || o.id,
      trader: o.traderNickName || "",
      traderUid,
      symbol: toPair(o.symbol),
      mode: modeFromPositionType(o.positionType),
      lev,
      marginMode: marginModeFromOpenType(o.openType),
      amount,
      openPrice,
      margin,
      notional,            // <<== thêm cột notional vào response
      followers: o.followers,
      openAt: o.openTime || 0,
      openAtStr: tsVNT(o.openTime || 0),
      marginPct: marginPct(o),
      raw: o,              // <<== trả về raw object
    };
  }).sort((a, b) => b.openAt - a.openAt);
}

// ---------- Handlers ----------
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequest(context) {
  const { request, env } = context;

  // Optional API key
  const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
  if (REQUIRED_KEY) {
    const k = request.headers.get("x-api-key") || "";
    if (k !== REQUIRED_KEY) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized: invalid x-api-key." }), {
        status: 401, headers: corsHeaders()
      });
    }
  }

  try {
    const url = new URL(context.request.url);
    const uidsStr = url.searchParams.get("uids") || DEFAULT_UIDS;
    const limit = safeNum(url.searchParams.get("limit") || 50);
    const uids = String(uidsStr || "").split(",").map((x) => (x || "").trim()).filter(Boolean);

    // fetch từng uid
    const all = [];
    const JITTER_BASE = 60; // ms; tăng nếu server nhạy

    await Promise.allSettled(
      uids.map(async (uid, i) => {
        // dàn nhịp thật mỏng, gần như không ảnh hưởng tốc độ tổng
        const wait = (i % 6) * JITTER_BASE + Math.floor(Math.random() * 40);
        if (wait) await new Promise(r => setTimeout(r, wait));

        const q = new URL(API_ORDERS);
        q.searchParams.set("limit", String(limit));
        q.searchParams.set("orderListType", "ORDER");
        q.searchParams.set("page", "1");
        q.searchParams.set("uid", uid);

        const resp = await fetch(q.toString(), { headers: BROWSER_HEADERS, cf: { cacheEverything: false } });
        if (!resp.ok) return;

        const data = await resp.json().catch(() => null);
        const rows = data?.success === true ? (data.data?.content || []) : [];
        rows.forEach(r => all.push({ ...r, _uid: uid }));
      })
    );

    // all => kết quả


    // de-dup theo orderId mới nhất (ưu tiên pageTime, fallback openTime)
    const byKey = new Map();
    for (const o of all) {
      const key = o.orderId || o.id;
      const prev = byKey.get(key);
      const t = o.pageTime || o.openTime || 0;
      if (!prev || t > (prev?.pageTime || prev?.openTime || 0)) byKey.set(key, o);
    }

    const merged = Array.from(byKey.values());
    const normalized = normalizeAndCompute(merged);

    return new Response(JSON.stringify({ success: true, data: normalized }), {
      headers: corsHeaders(),
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: String(e && e.message ? e.message : e) }), {
      status: 500, headers: corsHeaders()
    });
  }
}
