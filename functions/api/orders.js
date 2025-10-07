// Cloudflare Pages Functions - /api/orders
// GET /api/orders?uids=1,2,3&limit=10
// Test Slack (preview cache only, no fetch): GET /api/orders?testNotification=true

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

// ---------- Common helpers ----------
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
      margin: o.margin, // <- dùng cho per-line margin & tổng margin
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
    trader: n.trader || "",            // lưu trader để preview từ cache có tên
    symbol: n.symbol,
    mode: n.mode,
    lev: Number(n.lev || 0),
    amount: Number(n.amount || 0),
    openPrice: Number(n.openPrice || 0),
    margin: Number(n.margin || 0),     // <- cần cho tổng margin / per-line
    marginMode: n.marginMode,
    openAt: Number(n.openAt || 0),
    openAtStr: n.openAtStr || "",
  };
}
function fmtUSD(n) {
  const x = Number(n || 0);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(x);
}

// ---------- Persistent state (Cache API) ----------
async function readState(uid) {
  const req = new Request(`https://cache.local/orders/${uid}`);
  const res = await caches.default.match(req);
  if (!res) return { orders: [], maxOpenAt: 0, seenIds: [] };
  try {
    const data = await res.json();
    return {
      orders: Array.isArray(data.orders) ? data.orders : [],
      maxOpenAt: Number(data.maxOpenAt || 0),
      seenIds: Array.isArray(data.seenIds) ? data.seenIds : [],
    };
  } catch {
    return { orders: [], maxOpenAt: 0, seenIds: [] };
  }
}
async function writeState(uid, state) {
  const req = new Request(`https://cache.local/orders/${uid}`);
  const body = JSON.stringify({
    orders: state.orders || [],
    maxOpenAt: Number(state.maxOpenAt || 0),
    seenIds: (state.seenIds || []).slice(-300),
  });
  const res = new Response(body, { headers: { "content-type": "application/json" } });
  await caches.default.put(req, res);
}

// ---------- Diff with anti-spam guard ----------
function diffOrdersWithGuard(prevState, curr) {
  const prev = prevState.orders || [];
  const prevMap = new Map(prev.map((p) => [String(p.id), p]));
  const seenIds = new Set((prevState.seenIds || []).map((x) => String(x)));
  const maxOpenAtPrev = Number(prevState.maxOpenAt || 0);

  // first-time bootstrap: don't send
  if (!prev.length && !seenIds.size && maxOpenAtPrev === 0) {
    return { added: [], changed: [] };
  }

  const added = [];
  const changed = [];

  for (const c of curr) {
    const idKey = String(c.id);
    const p = prevMap.get(idKey);

    if (!p) {
      if (!seenIds.has(idKey) && Number(c.openAt || 0) > maxOpenAtPrev) {
        added.push(c);
      }
      continue;
    }

    const ch = [];
    if (p.lev !== c.lev) ch.push(`lev ${p.lev}→${c.lev}`);
    if (p.amount !== c.amount) ch.push(`amount ${p.amount}→${c.amount}`);
    if (p.openPrice !== c.openPrice) ch.push(`price ${p.openPrice}→${c.openPrice}`);
    if (p.mode !== c.mode) ch.push(`mode ${p.mode}→${c.mode}`);
    if (p.marginMode !== c.marginMode) ch.push(`marginMode ${p.marginMode}→${c.marginMode}`);
    if (ch.length) changed.push({ id: c.id, symbol: c.symbol, mode: c.mode, changes: ch });
  }

  return { added, changed };
}

// ---------- Slack (single source of truth) ----------
async function postSlack(env, text) {
  const token = env.SLACK_BOT_TOKEN || "";
  const channel = env.SLACK_CHANNEL_ID || "C09JWCT503Y";
  if (!token || !channel || !text) return;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-type": "application/json" },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
  });
}
function fmtMode(mode) {
  if (mode === "long") return " *Long*";
  if (mode === "short") return " *Short*";
  return "❓";
}
function fmtMarginType(m) {
  if (m === "Isolated") return ":shield: Isolated";
  if (m === "Cross") return ":link: Cross";
  return m || "";
}
/**
 * Dùng cho cả diff & preview:
 * - header có "Tổng margin: xxx USDT"
 * - nếu có `title` sẽ dùng title làm phần đầu header (ví dụ Preview), ngược lại dùng mặc định
 */
function buildSlack({ uid, diffs, traderName, totalMargin, title }) {
  const addedLines = (diffs.added || []).slice(0, 10).map(
    (a) =>
      `:new: ${fmtMode(a.mode)} \`${a.symbol}\` x${a.lev} • amount: *${a.amount}* • @ *${a.openPrice}* • ${fmtMarginType(
        a.marginMode
      )} • margin: *${fmtUSD(a.margin)} USDT* • ${a.openAtStr} VNT`
  );
  const changedLines = (diffs.changed || [])
    .slice(0, 10)
    .map((c) => `:arrows_counterclockwise: ${fmtMode(c.mode)} \`${c.symbol}\` — ${c.changes.join(", ")}`);

  if (!addedLines.length && !changedLines.length) return "";

  const headLeft =
    title ||
    `:bust_in_silhouette: Trader *${traderName || ""}* (UID ${uid})`;
  const headRight = `Tổng margin: *${fmtUSD(totalMargin || 0)} USDT*`;
  const header = `${headLeft} • ${headRight}`;

  const sections = [];
  if (addedLines.length) sections.push(addedLines.join("\n"));
  if (changedLines.length) sections.push(changedLines.join("\n"));
  return `${header}\n${sections.join("\n")}`;
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

    // -------- TEST: preview từ cache, gộp message, phân cách bằng "-------------" --------
    const testNotification = url.searchParams.get("testNotification");
    if (testNotification === "true") {
      const targetUids = String(env.TARGET_UIDS || "")
        .split(",")
        .map((x) => (x || "").trim())
        .filter(Boolean);

      if (!targetUids.length) {
        await postSlack(env, ":warning: [TEST] Không có TARGET_UIDS trong env để preview cache.");
        return new Response(JSON.stringify({ success: true, message: "No TARGET_UIDS set" }), {
          headers: corsHeaders(),
        });
      }

      const blocks = [];
      for (const uid of targetUids) {
        const prevState = await readState(uid);
        const orders = (prevState.orders || []).slice().sort((a, b) => Number(b.openAt || 0) - Number(a.openAt || 0));
        const traderName = orders.length ? (orders[0].trader || "") : "";
        const totalMargin = orders.reduce((sum, o) => sum + Number(o.margin || 0), 0);

        // preview: đối xử snapshot như "added"; "changed" rỗng
        const diffs = { added: orders.slice(0, 10), changed: [] };
        const text = buildSlack({
          uid,
          diffs,
          traderName,
          totalMargin,
          title: `:mag: Preview từ cache — Trader *${traderName || ""}* (UID ${uid})`,
        }) || `:mag: Preview từ cache — Trader *${traderName || ""}* (UID ${uid}) • Tổng margin: *${fmtUSD(totalMargin)} USDT*\n(cache trống)`;

        blocks.push(text);
      }

      const nowVNT = new Date()
        .toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour12: false })
        .replace(",", "");
      const message = [
        `✅ [TEST] Preview cache lúc ${nowVNT} VNT`,
        ...blocks
      ].join("\n-------------\n");

      await postSlack(env, message);
      return new Response(JSON.stringify({ success: true, message: "Test Slack (cache preview) sent" }), {
        headers: corsHeaders(),
      });
    }
    // -------- END TEST --------

    const uidsStr = url.searchParams.get("uids") || DEFAULT_UIDS;
    const limit = Number(url.searchParams.get("limit") || 10);

    // Parse uids safely
    const uids = String(uidsStr || "")
      .split(",")
      .map((uidStr) => (uidStr || "").trim())
      .filter(Boolean);

    // target UIDs from env (CSV)
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

    // De-dup theo id mới nhất
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

    // Check & notify per TARGET UID — gộp message, phân cách bằng "-------------"
    const blocks = [];
    for (const uid of targetUids) {
      const targetRowsRaw = perUid[uid] || [];
      const targetNormalized = normalizeAndCompute(targetRowsRaw);
      const targetSnapshotNow = targetNormalized.map(pickSnapshotFields);

      const prevState = await readState(uid);
      const diffs = diffOrdersWithGuard(prevState, targetSnapshotNow);

      // tên trader & tổng margin từ snapshot NOW (rõ ràng hơn)
      const traderName = targetSnapshotNow.length ? (targetSnapshotNow[0].trader || "") : "";
      const totalMargin = targetSnapshotNow.reduce((sum, o) => sum + Number(o.margin || 0), 0);

      const text = buildSlack({ uid, diffs, traderName, totalMargin });
      if (text) blocks.push(text);

      // Update state
      const maxOpenAtNow = targetSnapshotNow.reduce(
        (m, r) => Math.max(m, Number(r.openAt || 0)),
        Number(prevState.maxOpenAt || 0)
      );
      const newSeen = new Set(prevState.seenIds || []);
      for (const a of diffs.added || []) newSeen.add(String(a.id));

      await writeState(uid, {
        orders: targetSnapshotNow,
        maxOpenAt: maxOpenAtNow,
        seenIds: Array.from(newSeen),
      });
    }

    if (blocks.length) {
      const message = blocks.join("\n-------------\n");
      await postSlack(env, message);
    }

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
