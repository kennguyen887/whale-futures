// Cloudflare Pages Functions - /api/orders
// GET /api/orders?uids=1,2,3&limit=10
// Test Slack: GET /api/orders?testNotification=true

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

const DEFAULT_UIDS =
  "34988691,02058392,83769107,47991559,82721272,89920323,92798483,72432594,87698388,31866177,49787038,45227412,80813692,27337672,95927229,71925540,38063228,47395458,78481146,89070846,01249789,87698388,57343925,74785697,21810967,22247145,88833523,40133940,84277140,93640617,76459243,48673493,13290625,48131784";

function corsHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "Content-Type, X-API-Key",
  };
}

function toPair(symUnderscore = "") {
  return String(symUnderscore).replace("_", "");
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

function notional(order) {
  return Number(order.openAvgPrice || 0) * Number(order.amount || 0);
}

function marginPct(order) {
  const m = Number(order.margin || 0);
  const n = notional(order);
  return n > 0 ? (m / n) * 100 : 0;
}

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

function diffOrders(prev, curr) {
  const prevMap = new Map(prev.map((p) => [p.id, p]));
  const added = curr.filter((c) => !prevMap.has(c.id));

  const changed = curr.reduce((acc, c) => {
    const p = prevMap.get(c.id);
    if (!p) return acc;
    const ch = [];
    if (p.lev !== c.lev) ch.push(`lev ${p.lev}→${c.lev}`);
    if (p.amount !== c.amount) ch.push(`amount ${p.amount}→${c.amount}`);
    if (p.openPrice !== c.openPrice) ch.push(`price ${p.openPrice}→${c.openPrice}`);
    if (p.mode !== c.mode) ch.push(`mode ${p.mode}→${c.mode}`);
    if (p.marginMode !== c.marginMode) ch.push(`marginMode ${p.marginMode}→${c.marginMode}`);
    if (ch.length) acc.push({ id: c.id, symbol: c.symbol, mode: c.mode, changes: ch });
    return acc;
  }, []);

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

async function postSlack(env, text) {
  const token = env.SLACK_BOT_TOKEN || "";
  const channel = env.SLACK_CHANNEL_ID || "C09JWCT503Y";
  if (!token || !channel || !text) return;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-type": "application/json",
    },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
  });
}

/** Icons & pretty format for Slack */
function buildSlackMessage(uid, diffs, traderName) {
  const modeIcon = (mode) => {
    if (mode === "long") return "📈 *Long*";
    if (mode === "short") return "📉 *Short*";
    return "❓";
  };
  const marginIcon = (m) => {
    if (m === "Isolated") return "🛡️ Isolated";
    if (m === "Cross") return "🔗 Cross";
    return m || "";
  };

  const addedLines = diffs.added.slice(0, 10).map(
    (a) =>
      `🆕 ${modeIcon(a.mode)} \`${a.symbol}\` x${a.lev} • amount: *${a.amount}* • @ *${a.openPrice}* • ${marginIcon(
        a.marginMode
      )} • 🕒 ${a.openAtStr}`
  );

  const changedLines = diffs.changed
    .slice(0, 10)
    .map((c) => `♻️ ${modeIcon(c.mode)} \`${c.symbol}\` — ${c.changes.join(", ")}`);

  if (!addedLines.length && !changedLines.length) return "";

  const header = `👤 Trader *${traderName || "Unknown"}* (UID \`${uid}\`) có cập nhật lệnh:`;
  const sections = [];
  if (addedLines.length) sections.push(addedLines.join("\n"));
  if (changedLines.length) sections.push(changedLines.join("\n"));
  return `${header}\n${sections.join("\n")}`;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequest(context) {
  const { request, env } = context;

  // API key check (optional)
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

    // Test Slack without fetching data
    const testNotification = url.searchParams.get("testNotification");
    if (testNotification === "true") {
      await postSlack(env, "✅ [TEST] Slack notification from `/api/orders`");
      return new Response(JSON.stringify({ success: true, message: "Test Slack sent" }), {
        headers: corsHeaders(),
      });
    }

    const uidsStr = url.searchParams.get("uids") || DEFAULT_UIDS;
    const limit = Number(url.searchParams.get("limit") || 10);

    // Parse uids safely
    const uids = String(uidsStr || "")
      .split(",")
      .map((uidStr) => (uidStr || "").trim())
      .filter(Boolean);

    // Target UIDs from env
    const targetUids = String(env.TARGET_UIDS || "")
      .split(",")
      .map((uidStr) => (uidStr || "").trim())
      .filter(Boolean);

    const perUid = {};
    const all = [];

    // Fetch per UID
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
        const rows = (data.data?.content || []).map((r) => ({ ...r, _uid: uid }));
        perUid[uid] = rows;
        all.push(...rows);
      }
    }

    // De-dup by latest pageTime/openTime
    const byKey = new Map();
    all.forEach((order) => {
      const key = order.orderId || order.id;
      const prev = byKey.get(key);
      const pageTime = order.pageTime || order.openTime || 0;
      if (!prev || pageTime > (prev.pageTime || prev.openTime || 0)) {
        byKey.set(key, order);
      }
    });

    const merged = Array.from(byKey.values());
    const normalized = normalizeAndCompute(merged);

    // Notify per TARGET UID
    for (const target of targetUids) {
      const targetRowsRaw = perUid[target] || [];
      const targetNormalized = normalizeAndCompute(targetRowsRaw);
      const targetSnapshotNow = targetNormalized.map(pickSnapshotFields);

      const targetSnapshotPrev = await readCache(target);
      const diffs = diffOrders(targetSnapshotPrev, targetSnapshotNow);

      // Lấy tên trader từ danh sách hiện tại (nếu có)
      const traderName = targetNormalized.length > 0 ? targetNormalized[0].trader : "";

      const slackText = buildSlackMessage(target, diffs, traderName);
      if (slackText) {
        await postSlack(env, slackText);
      }
      await writeCache(target, targetSnapshotNow);
    }

    return new Response(JSON.stringify({ success: true, data: normalized }), {
      headers: corsHeaders(),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        success: false,
        error: String(e && e.message ? e.message : e),
      }),
      { status: 500, headers: corsHeaders() }
    );
  }
}
