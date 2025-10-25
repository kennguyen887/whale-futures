// /api/binance/orders — Cloudflare Pages Functions
// Binance 403 harden version: delay 0.3s + stronger fingerprint + proxy fallback

const ORDER_HISTORY_PATH = "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history";
const PORTFOLIO_LIST_PATH = "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/list";

function apiBase(env) {
  const via = (env && env.BINANCE_PROXY_BASE) || "";
  return via ? via.replace(/\/+$/, "") : "https://www.binance.com";
}

function n(x) { const v = Number(x); return Number.isFinite(v) ? v : 0; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function uuid() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const s = [...a].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}

function buildHeaders() {
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${113+Math.floor(Math.random()*12)}.0.0.0 Safari/537.36`;
  const ip = `45.${Math.floor(Math.random()*200)}.${Math.floor(Math.random()*200)}.${Math.floor(Math.random()*200)}`;
  return {
    "User-Agent": ua,
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": "application/json",
    "Origin": "https://www.binance.com",
    "Referer": "https://www.binance.com/",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "bnc-uuid": uuid(),
    "x-ui-request-trace": uuid(),
    "Cookie": "locale=en; country=VN",
    "CF-Connecting-IP": ip,
    "X-Forwarded-For": ip,
  };
}

// ---- robust fetch with delay and proxy fallback ----
async function robustFetch(env, path, body, attempts = 3) {
  const base = apiBase(env);
  const url = base + path;
  const errors = [];
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(300 + Math.random()*150); // delay 0.3–0.45 s
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(body),
        redirect: "follow",
        cf: { cacheEverything: false },
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (res.ok && json?.code === "000000") return { ok: true, json };
      errors.push({ status: res.status, body: text.slice(0,200) });
    } catch (e) {
      errors.push({ error: e.message });
    }
  }
  return { ok: false, errors };
}

async function fetchOrderHistory(env, pid, start, end) {
  const all = [];
  let indexValue;
  for (let page = 0; page < 3; page++) {
    await sleep(300);
    const body = { portfolioId: pid, startTime: start, endTime: end, pageSize: 30 };
    if (indexValue) body.indexValue = indexValue;
    const r = await robustFetch(env, ORDER_HISTORY_PATH, body);
    if (!r.ok) return { rows: all, error: r.errors };
    const list = r.json?.data?.list || [];
    if (!list.length) break;
    all.push(...list);
    indexValue = r.json?.data?.indexValue;
  }
  return { rows: all };
}

export async function onRequest(context) {
  const { request, env } = context;
  const uids = (new URL(request.url)).searchParams.get("uids")?.split(",") || ["4438679961865098497"];
  const startTime = Date.now() - 7*864e5, endTime = Date.now();
  const all = [], errors = [];
  for (const uid of uids) {
    const { rows, error } = await fetchOrderHistory(env, uid, startTime, endTime);
    if (error) errors.push({ uid, error });
    all.push(...rows.map(r=>({ ...r, _uid: uid })));
  }
  return new Response(JSON.stringify({
    success: all.length>0,
    data: all,
    errors: errors.length?errors:undefined
  }), { headers: { "content-type":"application/json", "access-control-allow-origin":"*" }});
}
