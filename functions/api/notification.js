// Cloudflare Pages Functions - /api/notification
// GET  /api/notification?limit=10
// TEST /api/notification?testNotification=true   (preview từ cache, không fetch)

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
function toPairNoUnderscore(s = "") { return String(s).replace("_", ""); }
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
  return x.toLocaleString("en-US", {
    minimumFractionDigits: hasFraction ? 3 : 0,
    maximumFractionDigits: 3
  });
}
function fmt2(n){
  const x = safeNum(n);
  return x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function tsVNT(t){
  return t
    ? new Date(t).toLocaleString("en-GB", {
        timeZone: "Asia/Ho_Chi_Minh",
        hour12: false
      }).replace(",", "")
    : "";
}
function sign(n){ return n>0?"+":(n<0?"-":""); }

// ---------- Normalize (có traderUid, raw & symbolUS) ----------
function normalizeAndCompute(rows){
  return rows.map((o)=>{
    const lev = leverageOf(o);
    const openPrice = safeNum(o.openAvgPrice);
    const amount = safeNum(o.amount);
    const margin = marginUSDT(openPrice, amount, lev, o.margin);
    const traderUid = String(o.uid ?? o.traderUid ?? o._uid ?? "");
    const symbolUS = String(o.symbol || ""); // e.g. XRP_USDT

    return {
      id: o.orderId || o.id,
      trader: o.traderNickName || "",
      traderUid,
      symbol: toPairNoUnderscore(symbolUS), // XRPUSDT
      symbolUS, // XRP_USDT (phục vụ gọi /api/prices)
      mode: modeFromPositionType(o.positionType),
      lev,
      marginMode: marginModeFromOpenType(o.openType),
      amount,
      openPrice,
      margin,
      notional: openPrice * amount,
      openAt: o.openTime || 0,
      openAtStr: tsVNT(o.openTime || 0),
      raw: o, // <<== trả về raw object
    };
  }).sort((a,b)=>b.openAt - a.openAt);
}
function pickSnapshotFields(n){
  // snapshot để diff – KHÔNG chứa giá thị trường (market) để tránh spam theo biến động giá
  return {
    id: n.id,
    trader: n.trader || "",
    traderUid: String(n.traderUid || ""),
    symbol: n.symbol,
    symbolUS: n.symbolUS,
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

// ---------- State (Cache API, gộp một key) ----------
const GLOBAL_CACHE_KEY = "https://cache.local/orders/__ALL__";

async function readGlobalState(){
  const req = new Request(GLOBAL_CACHE_KEY);
  const res = await caches.default.match(req);
  if (!res) return { ordersById: {}, orderList: [], lastFP: "", bootstrapped: false };
  try {
    const d = await res.json();
    return {
      ordersById: (d.ordersById && typeof d.ordersById === "object") ? d.ordersById : {},
      orderList: Array.isArray(d.orderList) ? d.orderList : [],
      lastFP: d.lastFP || "",
      bootstrapped: Boolean(d.bootstrapped),
    };
  } catch {
    return { ordersById: {}, orderList: [], lastFP: "", bootstrapped: false };
  }
}
async function writeGlobalState(state){
  const req = new Request(GLOBAL_CACHE_KEY);
  const payload = {
    ordersById: state.ordersById || {},
    orderList: state.orderList || [],
    lastFP: state.lastFP || "",
    bootstrapped: Boolean(state.bootstrapped),
  };
  const res = new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" }
  });
  await caches.default.put(req, res);
}

// ---------- Diff (only added & changed) ----------
function diffOrders(prevList, currList){
  // prevList & currList là mảng snapshot fields (pickSnapshotFields)
  const prevMap = new Map(prevList.map(p=>[String(p.id), p]));
  const added = [];
  const changed = [];

  for (const c of currList){
    const p = prevMap.get(String(c.id));
    if (!p){ added.push(c); continue; }
    const ch = [];
    if (safeNum(p.lev) !== safeNum(c.lev)) ch.push(`lev ${p.lev}→${c.lev}`);
    if (safeNum(p.amount) !== safeNum(c.amount)) ch.push(`amount ${fmt3(p.amount)}→${fmt3(c.amount)}`);
    if (safeNum(p.openPrice) !== safeNum(c.openPrice)) ch.push(`open ${fmt3(p.openPrice)}→${fmt3(c.openPrice)}`);
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

// ---------- Prices ----------
async function getPricesForSymbols(contextUrl, symbolsUS = [], key = ""){
  if (!symbolsUS.length) return {};
  const base = new URL(contextUrl);
  const path = new URL("/api/prices", base);
  path.searchParams.set("symbols", [...new Set(symbolsUS)].join(","));
  const headers = { "Content-Type": "application/json" };
  if (key) headers["x-api-key"] = key;
  const r = await fetch(path.toString(), { headers });
  if (!r.ok) return {};
  const j = await r.json().catch(()=>null);
  return (j && j.success && j.prices) ? j.prices : {};
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

// PNL/ROI helpers
function calcPnl(mode, openPrice, marketPrice, amount){
  const diff = mode==="short" ? (openPrice - marketPrice) : (marketPrice - openPrice);
  return safeNum(diff) * safeNum(amount);
}
function calcRoiPct(pnl, margin){
  const m = safeNum(margin);
  if (m <= 0) return 0;
  return (pnl / m) * 100;
}
function pctChangeVsOpen(openPrice, marketPrice){
  const o = safeNum(openPrice);
  const m = safeNum(marketPrice);
  if (o <= 0) return 0;
  return ((m - o) / o) * 100;
}

// Build Slack lines with required metrics
function buildLinesWithMetrics(rows, priceMap){
  // rows: snapshot items; priceMap: { "XRP_USDT": 0.5, ... }
  return rows.map(r=>{
    const mp = safeNum(priceMap[r.symbolUS] || 0);
    const pnl = calcPnl(r.mode, r.openPrice, mp, r.amount);
    const roi = calcRoiPct(pnl, r.margin);
    const deltaPct = pctChangeVsOpen(r.openPrice, mp);

    return `•${fmtMode(r.mode)} \`${r.symbol}\` x${r.lev} • ${fmtMarginType(r.marginMode)} • amount: *${fmt3(r.amount)}* • Open: *${fmt3(r.openPrice)}* • Mkt: *${fmt3(mp)}* • Δ: *${sign(deltaPct)}${fmt2(Math.abs(deltaPct))}%* • Notional: *${fmt3(r.openPrice*r.amount)} USDT* • Margin: *${fmt3(r.margin)} USDT* • PNL: *${fmt3(pnl)} USDT* • ROI: *${sign(roi)}${fmt2(Math.abs(roi))}%* • ${r.openAtStr} VNT`;
  });
}

function buildSlackBlocks({ groupedByTrader, prices }){
  // groupedByTrader: Map(uid, { name, totalMargin, rowsAdded, rowsChanged })
  const blocks = [];
  for (const [uid, g] of groupedByTrader.entries()){
    const head = `:bust_in_silhouette: Trader *${g.name || ""}* (UID ${uid}) • Tổng margin: *${fmt3(g.totalMargin||0)} USDT*`;
    const lines = [];
    if (g.rowsAdded.length){
      lines.push(`:new: *Added*`);
      lines.push(...buildLinesWithMetrics(g.rowsAdded, prices));
    }
    if (g.rowsChanged.length){
      lines.push(`:arrows_counterclockwise: *Changed*`);
      // g.rowsChanged chỉ có thông tin changes; để đủ metric, kèm dòng tóm tắt + 1 dòng metric
      lines.push(...buildLinesWithMetrics(g.rowsChanged.map(x=>x._full), prices));
    }
    if (lines.length){
      blocks.push([head, ...lines].join("\n"));
    }
  }
  return blocks;
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
      return new Response(JSON.stringify({ success:false, error:"Unauthorized: invalid x-api-key." }), {
        status: 401, headers: corsHeaders()
      });
    }
  }

  try {
    const url = new URL(context.request.url);
    const targetUids = String(env.TARGET_UIDS || "")
      .split(",")
      .map(x=>(x||"").trim())
      .filter(Boolean);

    const limit = safeNum(url.searchParams.get("limit") || 10);

    // ---- TEST: preview từ cache (không fetch) ----
    if (url.searchParams.get("testNotification") === "true"){
      const state = await readGlobalState();
      if (!state.orderList.length){
        await postSlack(env, ":mag: [TEST] Cache trống (chưa bootstrapped).");
        return new Response(JSON.stringify({ success:true, message:"Empty cache" }), {
          headers: corsHeaders(),
        });
      }
      // nhóm theo traderUid để hiển thị đẹp
      const prices = await getPricesForSymbols(context.request.url, state.orderList.map(o=>o.symbolUS), REQUIRED_KEY);
      const groups = new Map();
      for (const r of state.orderList){
        const uid = r.traderUid || "unknown";
        const g = groups.get(uid) || { name: r.trader || "", totalMargin: 0, rowsAdded: [], rowsChanged: [] };
        g.name = g.name || (r.trader || "");
        g.totalMargin += safeNum(r.margin);
        g.rowsAdded.push(r); // preview như added
        groups.set(uid, g);
      }
      const nowVNT = tsVNT(Date.now());
      const blocks = buildSlackBlocks({ groupedByTrader: groups, prices });
      await postSlack(env, [`✅ [TEST] Preview cache lúc ${nowVNT} VNT`, ...blocks].join("\n-------------\n"));
      return new Response(JSON.stringify({ success:true, message:"Test Slack (cache preview) sent" }), {
        headers: corsHeaders(),
      });
    }

    // ---- Normal flow: fetch + merge + diff + notify ----
    if (!targetUids.length){
      return new Response(JSON.stringify({ success:false, error:"TARGET_UIDS is empty" }), {
        status: 400, headers: corsHeaders(),
      });
    }

    // fetch theo từng UID, gom lại
    const perUid = {};
    const all = [];
    for (const uid of targetUids){
      const q = new URL(API_ORDERS);
      q.searchParams.set("limit", String(limit));
      q.searchParams.set("orderListType", "ORDER");
      q.searchParams.set("page", "1");
      q.searchParams.set("uid", uid);

      const resp = await fetch(q.toString(), { headers: BROWSER_HEADERS, cf: { cacheTtl: 10, cacheEverything: false }});
      if (!resp.ok) continue;
      const data = await resp.json().catch(()=>null);
      if (data && data.success === true){
        const rows = (data.data?.content || []).map(r=>({ ...r, _uid: uid }));
        perUid[uid] = rows;
        all.push(...rows);
      } else {
        perUid[uid] = [];
      }
    }

    // de-dup theo orderId mới nhất
    const byKey = new Map();
    for (const o of all){
      const key = o.orderId || o.id;
      const prev = byKey.get(key);
      const t = o.pageTime || o.openTime || 0;
      if (!prev || t > (prev?.pageTime || prev?.openTime || 0)) byKey.set(key, o);
    }
    const merged = Array.from(byKey.values());
    const normalizedAll = normalizeAndCompute(merged);
    const snapshotAll = normalizedAll.map(pickSnapshotFields);

    // lấy state cũ (gộp)
    const state = await readGlobalState();

    // bootstrap: lần đầu chỉ lưu, không gửi
    if (!state.bootstrapped){
      await writeGlobalState({ ordersById: Object.fromEntries(snapshotAll.map(x=>[x.id, x])), orderList: snapshotAll, lastFP: "", bootstrapped: true });
      return new Response(JSON.stringify({ success:true, bootstrapped:true, data: normalizedAll }), { headers: corsHeaders() });
    }

    // diff tổng
    const diffs = diffOrders(state.orderList || [], snapshotAll);
    let blocks = [];
    if ((diffs.added?.length || diffs.changed?.length)){
      const fp = fingerprintDiffs(diffs);
      if (fp !== state.lastFP){
        // nhóm theo traderUid cho Slack và chuẩn bị prices
        const symbolsUS = snapshotAll.map(r=>r.symbolUS);
        const prices = await getPricesForSymbols(context.request.url, symbolsUS, REQUIRED_KEY);

        const groups = new Map();
        // map nhanh id->full snapshot
        const fullMap = new Map(snapshotAll.map(x=>[String(x.id), x]));

        for (const a of (diffs.added||[])){
          const uid = a.traderUid || "unknown";
          const g = groups.get(uid) || { name: a.trader || "", totalMargin: 0, rowsAdded: [], rowsChanged: [] };
          g.name = g.name || (a.trader || "");
          g.totalMargin += safeNum(a.margin);
          g.rowsAdded.push(a);
          groups.set(uid, g);
        }
        for (const c of (diffs.changed||[])){
          const full = fullMap.get(String(c.id));
          if (!full) continue;
          const uid = full.traderUid || "unknown";
          const g = groups.get(uid) || { name: full.trader || "", totalMargin: 0, rowsAdded: [], rowsChanged: [] };
          g.name = g.name || (full.trader || "");
          g.totalMargin += safeNum(full.margin);
          g.rowsChanged.push({ ...c, _full: full });
          groups.set(uid, g);
        }

        blocks = buildSlackBlocks({ groupedByTrader: groups, prices });

        if (blocks.length){
          await postSlack(env, blocks.join("\n-------------\n"));
        }
        state.lastFP = fp;
      }
    }

    // lưu snapshot mới (gộp)
    state.ordersById = Object.fromEntries(snapshotAll.map(x=>[x.id, x]));
    state.orderList = snapshotAll;
    await writeGlobalState(state);

    // JSON response (đã có raw object cho từng row)
    return new Response(JSON.stringify({ success:true, notified: blocks.length>0, data: normalizedAll }), {
      headers: corsHeaders(),
    });
  } catch (e){
    return new Response(JSON.stringify({ success:false, error: String(e && e.message ? e.message : e) }), {
      status: 500, headers: corsHeaders()
    });
  }
}
