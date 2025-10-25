// /api/binance/orders - Cloudflare Pages Functions (HARDENED)
// GET /api/binance/orders?uids=...&limit=10&cursor=0&max=35&startTime=&endTime=
// - Fetch từ Binance Copy Trade Lead Portfolio Order History
// - 3 trang đầu, pageSize = 30, phân trang bằng indexValue
// - Chống firewall: header profiles + UUID, cookie, retry/backoff, optional proxy
// - Trả lỗi chi tiết khi fail

const API_BINANCE_ORDER_HISTORY_PATH =
  "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history";
const API_BINANCE_PORTFOLIO_LIST_PATH =
  "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/list";

// If you have a proxy (optional), e.g. https://vercel-openai-proxy-psi.vercel.app (example from your env)
// Set BINANCE_PROXY_BASE in your CF env to route via your own domain to reduce firewall blocks.
function apiBase(env) {
  const via = (env && env.BINANCE_PROXY_BASE) || "";
  if (via) return via.replace(/\/+$/, "");
  return "https://www.binance.com";
}

const DEFAULT_UIDS = "4438679961865098497";

// ------------------- helpers -------------------
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
  return n(o?.raw?.leverage) || 1;
}
function mUSDT(p, a, l, m) {
  const M = n(m);
  if (M > 0) return M;
  const not = n(p) * n(a);
  return (n(l) || 1) > 0 ? not / (l || 1) : 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RFC4122 v4 UUID (workers-safe)
function uuidv4() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
    16,
    20
  )}-${h.slice(20)}`;
}

// ---------- Header profiles (rotate) ----------
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function buildHeaderProfile(base, ua) {
  const bnc = uuidv4();
  const xui = uuidv4();
  return {
    ...base,
    "User-Agent": ua,
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "sec-ch-ua":
      '"Chromium";v="124", "Not-A.Brand";v="24", "Google Chrome";v="124"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-mobile": "?0",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "Origin": apiBase({ BINANCE_PROXY_BASE: "" }), // origin hợp lệ (https://www.binance.com)
    "Referer": "https://www.binance.com/",
    // UUID headers mà Binance hay kiểm tra
    "bnc-uuid": bnc,
    "x-ui-request-trace": xui,
    // Cookie nhẹ để qua một số check locale/geo
    "Cookie": "locale=en; country=VN",
  };
}

function headerProfiles() {
  // 3 profile khác nhau về UA/platform
  return [
    buildHeaderProfile({}, USER_AGENTS[0]),
    buildHeaderProfile({ "sec-ch-ua-platform": '"macOS"' }, USER_AGENTS[1]),
    buildHeaderProfile({ "sec-ch-ua-platform": '"Linux"' }, USER_AGENTS[2]),
  ];
}

// ---------- Robust fetch with retries & profiles ----------
async function robustFetchJson(url, init, { attempts = 4, env } = {}) {
  const profiles = headerProfiles();
  const errors = [];
  for (let tryNo = 0; tryNo < attempts; tryNo++) {
    const profile = profiles[tryNo % profiles.length];
    const headers = { ...(init?.headers || {}), ...profile };

    // jitter backoff: 150ms, 350ms, 800ms...
    if (tryNo > 0) {
      const delay = Math.min(1000 + tryNo * 500, 2500);
      await sleep(delay + Math.floor(Math.random() * 250));
    }

    try {
      const resp = await fetch(url, {
        ...init,
        headers,
        redirect: "follow",
        cf: {
          cacheEverything: false,
          cacheTtl: 0,
        },
      });

      const status = resp.status;
      const text = await resp.text(); // đọc text trước để log nếu JSON fail
      // cố gắng parse JSON
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (e) {
        // keep json=null; fall through
      }

      // thành công Binance
      if (resp.ok && json && json.code === "000000" && json.success === true) {
        return { ok: true, json, status };
      }

      // Một số lỗi 403/451/444 là do firewall
      errors.push({
        tryNo,
        status,
        bodySample: text?.slice(0, 300),
        profile: headers["sec-ch-ua-platform"],
      });

      // Nếu là 4xx không retry quá sâu
      if (status === 400 || status === 401 || status === 403 || status === 404) {
        continue;
      }
      // 5xx thì retry tiếp
      continue;
    } catch (e) {
      errors.push({ tryNo, error: String(e?.message || e) });
      continue;
    }
  }
  return { ok: false, errors };
}

// ---------- Binance API wrappers ----------
async function fetchPortfolioIdsByLeadUid(env, leadUid) {
  // Nếu uid có vẻ đã là portfolioId (length>15) thì return thẳng
  if (String(leadUid).length > 15) return [String(leadUid)];

  const url = apiBase(env) + API_BINANCE_PORTFOLIO_LIST_PATH;
  const res = await robustFetchJson(
    url,
    {
      method: "POST",
      body: JSON.stringify({ leadUid: String(leadUid) }),
    },
    { attempts: 4, env }
  );

  if (!res.ok) return [];
  const data = res.json?.data;
  const list = data?.list || data || [];
  return list
    .map((it) => String(it?.portfolioId || ""))
    .filter((s) => !!s && s.length > 0);
}

async function fetchFirst3PagesOrderHistory(env, portfolioId, startTime, endTime) {
  const pageSize = 30;
  let indexValue = undefined;
  const all = [];

  for (let page = 1; page <= 3; page++) {
    // nhẹ nhàng tránh rate-limit
    await sleep(150 + Math.floor(Math.random() * 120));

    const payload = {
      portfolioId: String(portfolioId),
      startTime: n(startTime),
      endTime: n(endTime),
      pageSize,
    };
    if (indexValue) payload.indexValue = String(indexValue);

    const url = apiBase(env) + API_BINANCE_ORDER_HISTORY_PATH;
    const res = await robustFetchJson(
      url,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      { attempts: 4, env }
    );

    if (!res.ok) {
      // dừng sớm, trả kèm lỗi để hiển thị
      return { rows: all, error: { where: "order-history", portfolioId, attemptsErrors: res.errors } };
    }

    const data = res.json?.data || {};
    const list = Array.isArray(data?.list) ? data.list : [];
    for (const item of list) all.push(item);

    const nextIndex = data?.indexValue || null;
    if (!nextIndex || list.length === 0) break;
    indexValue = nextIndex;
  }

  return { rows: all };
}

// -------------- CF handlers --------------
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

    // giữ tham số cũ để không breaking
    const limit = n(url.searchParams.get("limit") || 50);
    const total = uids.length;
    const start = Math.max(0, n(url.searchParams.get("cursor") || 0));
    const maxPerCall = Math.max(1, Math.min(35, n(url.searchParams.get("max") || 35)));
    const end = Math.min(total, start + maxPerCall);

    const now = Date.now();
    const defaultStart = now - 7 * 24 * 60 * 60 * 1000;
    const startTime = n(url.searchParams.get("startTime") || defaultStart);
    const endTime = n(url.searchParams.get("endTime") || now);

    const all = [];
    const errors = [];

    for (let i = start; i < end; i++) {
      const uid = uids[i];
      await sleep(90 + Math.floor(Math.random() * 80));

      let portfolioIds = [];
      if (String(uid).length > 15) {
        portfolioIds = [String(uid)];
      } else {
        const pids = await fetchPortfolioIdsByLeadUid(env, uid);
        if (!pids.length) {
          errors.push({ uid, error: "Cannot resolve portfolioId from leadUid" });
          continue;
        }
        portfolioIds = pids;
      }

      for (const pid of portfolioIds) {
        const { rows, error } = await fetchFirst3PagesOrderHistory(env, pid, startTime, endTime);
        if (error) {
          errors.push({ uid, portfolioId: pid, ...error });
        }
        for (const r of rows) all.push({ ...r, _portfolioId: pid, _leadUid: uid });
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

    // Nếu không lấy được item nào và có errors, trả lỗi rõ ràng (nhưng không 500)
    if (data.length === 0 && errors.length > 0) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Upstream blocked or empty. See errors for details.",
          page: { start, end, total, maxPerCall, nextCursor, limitUsed: limit },
          meta: {
            source: (env && env.BINANCE_PROXY_BASE) ? "proxy->binance" : "binance",
            pagesPerPortfolio: 3,
            pageSize: 30,
            startTime,
            endTime,
          },
          errors,
        }),
        { status: 200, headers: corsHeaders() }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        page: { start, end, total, maxPerCall, nextCursor, limitUsed: limit },
        meta: {
          source: (env && env.BINANCE_PROXY_BASE) ? "proxy->binance" : "binance",
          pagesPerPortfolio: 3,
          pageSize: 30,
          startTime,
          endTime,
        },
        data,
        // kèm các lỗi không chí mạng để debug
        errors: errors.length ? errors : undefined,
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
