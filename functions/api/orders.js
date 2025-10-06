// Cloudflare Pages Functions - /api/orders
// GET /api/orders?uids=1,2,3&limit=10

const API_ORDERS = "https://futures.mexc.com/copyFutures/api/v1/trader/orders/v2";

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

const DEFAULT_UIDS = "34988691,02058392,83769107,47991559,82721272,89920323,92798483,72432594,87698388,31866177,49787038,45227412,80813692,27337672,95927229,71925540,38063228,47395458,78481146,89070846,01249789,87698388,57343925,74785697,21810967,22247145,88833523,40133940,84277140,93640617,76459243,48673493,13290625,48131784";

function corsHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "Content-Type, X-API-Key",
  };
}

function toPair(symUnderscore = "") {
  return symUnderscore.replace("_", "");
}

function modeFromPositionType(pt) {
  if (pt === 1) return "long";
  if (pt === 2) return "short";
  return "unknown";
}

function marginModeFromOpenType(ot) {
  if (ot === 1) return "Isolated";
  if (ot === 2) return "Cross";
  return "Unknown";
}

function notional(o) {
  return Number(o.openAvgPrice || 0) * Number(o.amount || 0);
}

function marginPct(o) {
  const m = Number(o.margin || 0);
  const n = notional(o);
  return n > 0 ? (m / n) * 100 : 0;
}

/** @param {Array<object>} rows */
function normalizeAndCompute(rows) {
  const TIMEZONE = "Asia/Ho_Chi_Minh";
  const tsVNT = (t) =>
    t
      ? new Date(t)
          .toLocaleString("en-GB", { timeZone: TIMEZONE, hour12: false })
          .replace(",", "")
      : "";

  return rows
    .map((o) => ({
      id: o.orderId || o.id,
      trader: o.traderNickName || "",
      symbol: toPair(o.symbol),
      mode: modeFromPositionType(o.positionType),
      lev: o.leverage,
      marginMode: marginModeFromOpenType(o.openType),
      amount: o.amount,
      openPrice: o.openAvgPrice,
      margin: o.margin,
      followers: o.followers,
      openAt: o.openTime || 0,
      openAtStr: tsVNT(o.openTime || 0),
      closePrice: o.closeAvgPrice || 0,
      notional: notional(o),
      marginPct: marginPct(o),
      raw: o,
    }))
    .sort((a, b) => b.openAt - a.openAt);
}

function pickSnapshotFields(n) {
  return {
    id: n.id,
    symbol: n.symbol,
    mode: n.mode,
    lev: Number(n.lev || 0),
    amount: Number(n.amount || 0),
    openPrice: Number(n.openPrice || 0),
    marginMode: n.marginMode,
    openAt: Number(n.openAt || 0),
    openAtStr: n.openAtStr || "",
  };
}

/**
 * @param {Array<object>} prev
 * @param {Array<object>} curr
 */
function diffOrders(prev, curr) {
  const prevMap = new Map(prev.map((p) => [p.id, p]));
  const added = curr.filter((c) => !prevMap.has(c.id));

  const changed = [];
  curr.forEach((c) => {
    const p = prevMap.get(c.id);
    if (!p) return;
    const ch = [];
    if (p.lev !== c.lev) ch.push(`lev ${p.lev}→${c.lev}`);
    if (p.amount !== c.amount) ch.push(`amount ${p.amount}→${c.amount}`);
    if (p.openPrice !== c.openPrice) ch.push(`price ${p.openPrice}→${c.openPrice}`);
    if (p.mode !== c.mode) ch.push(`mode ${p.mode}→${c.mode}`);
    if (p.marginMode !== c.marginMode) ch.push(`marginMode ${p.marginMode}→${c.marginMode}`);
    if (ch.length) changed.push({ id: c.id, symbol: c.symbol, mode: c.mode, changes: ch });
  });

  return { added, changed };
}

async function readCache(uid) {
  const req = new Request(`https://cache.local/orders/${uid}`);
  const res = await caches.default.match(req);
  if (!res) return [];
  try {
    return await res.json();
  } catch {
    return [];
  }
}

async function writeCache(uid, data) {
  const req = new Request(`https://cache.local/orders/${uid}`);
  const res = new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
  await caches.default.put(req, res);
}

/** @param {any} env */
async function postSlack(env, text) {
  const token = env.SLACK_BOT_TOKEN || "";
  const channel = env.SLACK_CHANNEL_ID || "C09JWCT503Y";
  if (!token) return;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-type": "application/json",
    },
    body: JSON.stringify({ channel, text }),
  });
}

function buildSlackMessage(uid, diffs) {
  const addLines = diffs.added.slice(0, 10).map(
    (a) => `• New ${a.symbol} ${a.mode} x${a.lev} amount ${a.amount} @ ${a.openPrice} (${a.openAtStr})`
  );
  const chLines = diffs.changed.slice(0, 10).map(
    (c) => `• ${c.symbol} ${c.mode} ${c.changes.join(", ")}`
  );
  const head = `UID ${uid} có thay đổi lệnh`;
  if (!addLines.length && !chLines.length) return "";
  const parts = [];
  if (addLines.length) parts.push(`Lệnh mới:\n${addLines.join("\n")}`);
  if (chLines.length) parts.push(`Cập nhật:\n${chLines.join("\n")}`);
  return `${head}\n${parts.join("\n\n")}`;
}

export async function onRequestOptions() {
  // preflight
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/** Cloudflare Pages Function handler (JS) */
export async function onRequest(context) {
  const { request, env } = context;

  // -------- Simple API key check (shared key for all internal APIs) --------
  const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
  if (REQUIRED_KEY) {
    const clientKey = request.headers.get("x-api-key") || "";
    if (clientKey !== REQUIRED_KEY) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized: invalid x-api-key." }),
        { status: 401, headers: corsHeaders() }
      );
    }
  }

  try {
    const url = new URL(context.request.url);
    const uidsStr = url.searchParams.get("uids") || DEFAULT_UIDS;
    const limit = Number(url.searchParams.get("limit") || 10);
    const uids = uidsStr.split(",").map((s) => s.trim()).filter(Boolean);

    const TARGET_UID = "22247145";
    const perUid = {};
    const all = [];

    for (const uid of uids) {
      const q = new URL(API_ORDERS);
      q.searchParams.set("limit", String(limit));
      q.searchParams.set("orderListType", "ORDER");
      q.searchParams.set("page", "1");
      q.searchParams.set("uid", uid);

      const resp = await fetch(q.toString(), {
        headers: BROWSER_HEADERS,
        cf: { cacheTtl: 10, cacheEverything: false },
      });
      if (!resp.ok) continue;

      const data = await resp.json();
      if (data && data.success === true) {
        const rows = (data.data && data.data.content ? data.data.content : []).map((r) => ({
          ...r,
          _uid: uid,
        }));
        perUid[uid] = rows;
        all.push(...rows);
      }
    }

    // de-dup theo orderId mới nhất
    const byKey = new Map();
    all.forEach((o) => {
      const key = o.orderId || o.id;
      const prev = byKey.get(key);
      const pageTime = o.pageTime || o.openTime || 0;
      if (!prev || pageTime > (prev.pageTime || prev.openTime || 0)) byKey.set(key, o);
    });

    const merged = Array.from(byKey.values());
    const normalized = normalizeAndCompute(merged);

    // So sánh & báo Slack cho UID 22247145
    const targetRowsRaw = perUid[TARGET_UID] || [];
    const targetNormalized = normalizeAndCompute(targetRowsRaw);
    const targetSnapshotNow = targetNormalized.map(pickSnapshotFields);
    const targetSnapshotPrev = await readCache(TARGET_UID);
    const diffs = diffOrders(targetSnapshotPrev, targetSnapshotNow);
    const slackText = buildSlackMessage(TARGET_UID, diffs);
    if (slackText) await postSlack(env, slackText);
    await writeCache(TARGET_UID, targetSnapshotNow);

    return new Response(JSON.stringify({ success: true, data: normalized }), {
      headers: corsHeaders(),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: String(e && e.message ? e.message : e) }),
      { status: 500, headers: corsHeaders() }
    );
  }
}
