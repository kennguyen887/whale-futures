// Cloudflare Pages Functions - /api/orders
// GET /api/orders?uids=1,2,3&limit=10
// Test preview from cache: GET /api/orders?testNotification=true

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
function modeFromPositionType(pt){ if(pt===1)return"long"; if(pt===2)return"short"; return"unknown"; }
function marginModeFromOpenType(ot){ if(ot===1)return"Isolated"; if(ot===2)return"Cross"; return"Unknown"; }
function leverageOf(o){ return safeNum(o.leverage ?? o.lev ?? o.openLeverage ?? o?.raw?.leverage) || 1; }
function marginUSDT(openAvgPrice, amount, lev, apiMargin){
  const m = safeNum(apiMargin);
  if (m > 0) return m;
  const n = safeNum(openAvgPrice) * safeNum(amount);
  return (safeNum(lev)||1) > 0 ? n / lev : 0;
}
function fmt3(n){
  const x = safeNum(n);
  const hasFraction = Math.abs(x - Math.trunc(x)) > 1e-9;
  return x.toLocaleString("en-US", { minimumFractionDigits: hasFraction ? 3 : 0, maximumFractionDigits: 3 });
}
function tsVNT(t){
  return t ? new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour12: false }).replace(",", "") : "";
}

// ---------- Normalize (đã thêm followers + uid) ----------
function normalizeAndCompute(rows){
  return rows.map((o)=>{
    const lev = leverageOf(o);
    const openPrice = safeNum(o.openAvgPrice);
    const amount = safeNum(o.amount);
    const margin = marginUSDT(openPrice, amount, lev, o.margin);

    return {
      id: o.orderId || o.id,
      uid: String(o._uid ?? o.uid ?? ""),                 // <--- uid giữ nguyên sau de-dup
      trader: o.traderNickName || "",
      followers: safeNum(o.followers),                    // <--- followers
      symbol: toPair(o.symbol),
      mode: modeFromPositionType(o.positionType),
      lev,
      marginMode: marginModeFromOpenType(o.openType),
      amount,
      openPrice,
      margin,
      openAt: o.openTime || 0,
      openAtStr: tsVNT(o.openTime || 0),
    };
  }).sort((a,b)=>b.openAt - a.openAt);
}
function pickSnapshotFields(n){
  return {
    id: n.id,
    uid: n.uid || "",
    trader: n.trader || "",
    followers: safeNum(n.followers || 0),
    symbol: n.symbol,
    mode: n.mode,
    lev: safeNum(n.lev),
    amount: safeNum(n.amount),
    openPrice: safeNum(n.openPrice),
    margin: safeNum(n.margin),
    marginMode: n.marginMode,
    openAt: safeNum(n.openAt),
    openAtStr: n.openAtStr || "",
  };
}

// ---------- State (Cache API, gọn nhẹ) ----------
async function readState(uid){
  const req = new Request(`https://cache.local/orders/${uid}`);
  const res = await caches.default.match(req);
  if (!res) return { orders: [], lastFP: "", bootstrapped: false };
  try {
    const d = await res.json();
    return {
      orders: Array.isArray(d.orders) ? d.orders : [],
      lastFP: d.lastFP || "",
      bootstrapped: Boolean(d.bootstrapped),
    };
  } catch {
    return { orders: [], lastFP: "", bootstrapped: false };
  }
}
async function writeState(uid, state){
  const req = new Request(`https://cache.local/orders/${uid}`);
  const payload = {
    orders: state.orders || [],
    lastFP: state.lastFP || "",
    bootstrapped: Boolean(state.bootstrapped),
  };
  const res = new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" }});
  await caches.default.put(req, res);
}

// ---------- Diff (ONLY added & changed) ----------
function diffOrders(prev, curr){
  const prevMap = new Map(prev.map(p=>[String(p.id), p]));
  const added = [];
  const changed = [];
  for (const c of curr){
    const p = prevMap.get(String(c.id));
    if (!p){ added.push(c); continue; }
    const ch = [];
    if (safeNum(p.lev) !== safeNum(c.lev)) ch.push(`lev ${p.lev}→${c.lev}`);
    if (safeNum(p.amount) !== safeNum(c.amount)) ch.push(`amount ${p.amount}→${c.amount}`);
    if (safeNum(p.openPrice) !== safeNum(c.openPrice)) ch.push(`price ${p.openPrice}→${c.openPrice}`);
    if (p.mode !== c.mode) ch.push(`mode ${p.mode}→${c.mode}`);
    if (p.marginMode !== c.marginMode) ch.push(`marginMode ${p.marginMode}→${c.marginMode}`);
    if (ch.length) changed.push({ id: c.id, symbol: c.symbol, mode: c.mode, changes: ch });
  }
  return { added, changed };
}
function fingerprintDiffs(d){
  const a = (d.added||[]).map(x=>String(x.id)).sort();
  const c = (d.changed||[]).map(x=>`${x.id}:${(x.changes||[]).join("|")}`).sort();
  return a.join(",")+"#"+c.join(",");
}

// ---------- Slack ----------
async function postSlack(env, text){
  const token = env.SLACK_BOT_TOKEN || "";
  const channel = env.SLACK_CHANNEL_ID || "C09JWCT503Y";
  if (!token || !channel || !text) return;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-type": "application/json" },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
  });
}
function fmtMode(mode){ if(mode==="long")return" *Long*"; if(mode==="short")return" *Short*"; return "❓"; }
function fmtMarginType(m){ if(m==="Isolated")return":shield: Isolated"; if(m==="Cross")return":link: Cross"; return m||""; }

function buildSlack({ uid, diffs, traderName, totalMargin, title }){
  const addedLines = (diffs.added||[]).slice(0,10).map(a =>
    `:new:${fmtMode(a.mode)} \`${a.symbol}\` x${a.lev} • amount: *${fmt3(a.amount)}* • @ *${fmt3(a.openPrice)}* • ${fmtMarginType(a.marginMode)} • margin: *${fmt3(a.margin)} USDT* • ${a.openAtStr} VNT`
  );
  const changedLines = (diffs.changed||[]).slice(0,10).map(c =>
    `:arrows_counterclockwise:${fmtMode(c.mode)} \`${c.symbol}\` — ${c.changes.join(", ")}`
  );

  if (!addedLines.length && !changedLines.length) return "";

  const headLeft = title || `:bust_in_silhouette: Trader *${traderName || ""}* (UID ${uid})`;
  const headRight = `Tổng margin: *${fmt3(totalMargin||0)} USDT*`;
  return `${headLeft} • ${headRight}\n${[...addedLines, ...changedLines].join("\n")}`;
}

// ---------- Handlers ----------
export async function onRequestOptions(){
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequest(context){
  const { request, env } = context;

  // Optional API key
  const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
  if (REQUIRED_KEY){
    const k = request.headers.get("x-api-key") || "";
    if (k !== REQUIRED_KEY){
      return new Response(JSON.stringify({ success:false, error:"Unauthorized: invalid x-api-key." }), { status:401, headers: corsHeaders() });
    }
  }

  try {
    const url = new URL(context.request.url);
    const targetUids = String(env.TARGET_UIDS || "").split(",").map(x=>(x||"").trim()).filter(Boolean);

    // ---- TEST: preview từ cache, gộp vào 1 message, phân cách "-------------" ----
    if (url.searchParams.get("testNotification") === "true"){
      if (!targetUids.length){
        await postSlack(env, ":warning: [TEST] Không có TARGET_UIDS trong env để preview cache.");
        return new Response(JSON.stringify({ success:true, message:"No TARGET_UIDS set" }), { headers: corsHeaders() });
      }
      const blocks = [];
      for (const uid of targetUids){
        const state = await readState(uid);
        const orders = (state.orders||[]).slice().sort((a,b)=>b.openAt-a.openAt);
        const traderName = orders.length ? (orders[0].trader||"") : "";
        const totalMargin = orders.reduce((s,o)=>s+safeNum(o.margin), 0);
        const diffs = { added: orders.slice(0,10), changed: [] }; // preview coi như added
        const text = buildSlack({ uid, diffs, traderName, totalMargin, title: `:mag: Preview từ cache — Trader *${traderName||""}* (UID ${uid})` }) || `:mag: Preview từ cache — Trader *${traderName||""}* (UID ${uid}) • Tổng margin: *0 USDT*\n(cache trống)`;
        blocks.push(text);
      }
      const nowVNT = tsVNT(Date.now());
      await postSlack(env, [`✅ [TEST] Preview cache lúc ${nowVNT} VNT`, ...blocks].join("\n-------------\n"));
      return new Response(JSON.stringify({ success:true, message:"Test Slack (cache preview) sent" }), { headers: corsHeaders() });
    }

    // ---- Normal flow: fetch + diff + (maybe) send ----
    const uidsStr = url.searchParams.get("uids") || DEFAULT_UIDS;
    const limit = safeNum(url.searchParams.get("limit") || 10);
    const uids = String(uidsStr||"").split(",").map(x=>(x||"").trim()).filter(Boolean);

    const perUid = {};
    const all = [];
    for (const uid of uids){
      const q = new URL(API_ORDERS);
      q.searchParams.set("limit", String(limit));
      q.searchParams.set("orderListType", "ORDER");
      q.searchParams.set("page", "1");
      q.searchParams.set("uid", uid);

      const resp = await fetch(q.toString(), { headers: BROWSER_HEADERS, cf: { cacheTtl: 10, cacheEverything: false }});
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data && data.success === true){
        const rows = (data.data?.content || []).map(r=>({ ...r, _uid: uid })); // _uid để preserve khi de-dup
        perUid[uid] = rows;
        all.push(...rows);
      }
    }

    // de-dup theo orderId mới nhất
    const byKey = new Map();
    for (const o of all){
      const key = o.orderId || o.id;
      const prev = byKey.get(key);
      const t = o.pageTime || o.openTime || 0;
      if (!prev || t > (prev.pageTime || prev.openTime || 0)) byKey.set(key, o);
    }
    // 👉 normalizedAll sẽ có cả uid + followers
    const normalizedAll = normalizeAndCompute(Array.from(byKey.values()));

    // gộp Slack cho các target uids
    const blocks = [];
    for (const uid of targetUids){
      const rows = perUid[uid] || [];
      const nowNorm = normalizeAndCompute(rows);
      const snapshotNow = nowNorm.map(pickSnapshotFields);

      const state = await readState(uid);

      // bootstrap: lần đầu chỉ lưu, không gửi
      if (!state.bootstrapped){
        await writeState(uid, { orders: snapshotNow, lastFP: "", bootstrapped: true });
        continue;
      }

      const diffs = diffOrders(state.orders || [], snapshotNow);
      const hasContent = (diffs.added && diffs.added.length) || (diffs.changed && diffs.changed.length);
      if (hasContent){
        const fp = fingerprintDiffs(diffs);
        if (fp !== state.lastFP){
          const traderName = snapshotNow[0]?.trader || state.orders[0]?.trader || "";
          const totalMargin = snapshotNow.reduce((s,o)=>s+safeNum(o.margin), 0);
          const text = buildSlack({ uid, diffs, traderName, totalMargin });
          if (text) blocks.push(text);
          state.lastFP = fp;
        }
      }

      // lưu snapshot mới
      state.orders = snapshotNow;
      await writeState(uid, state);
    }

    if (blocks.length){
      await postSlack(env, blocks.join("\n-------------\n"));
    }

    // Trả về data đã có `uid` + `followers`
    return new Response(JSON.stringify({ success:true, data: normalizedAll }), { headers: corsHeaders() });
  } catch (e){
    return new Response(JSON.stringify({ success:false, error: String(e && e.message ? e.message : e) }), { status:500, headers: corsHeaders() });
  }
}
