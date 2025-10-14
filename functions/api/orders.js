// Cloudflare Pages Functions - /api/orders
// GET /api/orders?uids=1,2,3&limit=10&cursor=0&max=35
// - Tuần tự (no concurrency), không retry, không cache
// - Phân trang bằng cursor để không vượt "Too many subrequests"

const API_ORDERS = "https://futures.mexc.com/copyFutures/api/v1/trader/orders/v2";
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

const DEFAULT_UIDS =
  "34988691,02058392,83769107,47991559,82721272,89920323,92798483,72432594,87698388,31866177,49787038,45227412,80813692,27337672,95927229,71925540,38063228,47395458,78481146,89070846,01249789,87698388,57343925,74785697,21810967,22247145,88833523,40133940,84277140,93640617,76459243,48673493,13290625,48131784,23747691,89989257,69454560,52543521,07867898,36267959,90901845,27012439,58298982,72486517,30339263,49140673,20393898,93765871,98086898,81873060,08796342";

function corsHeaders(){
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "Content-Type, X-API-Key",
  };
}
function n(x){const v=Number(x);return Number.isFinite(v)?v:0}
function pair(s=""){return String(s).replace("_","")}
function mode(pt){return pt===1?"long":pt===2?"short":"unknown"}
function mm(ot){return ot===1?"Isolated":ot===2?"Cross":"Unknown"}
function lev(o){return n(o.leverage??o.lev??o.openLeverage??o?.raw?.leverage)||1}
function mUSDT(p,a,l,m){const M=n(m);if(M>0)return M;const not=n(p)*n(a);return (n(l)||1)>0?not/l:0}
function tsVNT(t){return t?new Date(t).toLocaleString("en-GB",{timeZone:"Asia/Ho_Chi_Minh",hour12:false}).replace(",",""):""}

export async function onRequestOptions(){
  return new Response(null,{status:204,headers:corsHeaders()});
}

export async function onRequest(context){
  const { request, env } = context;

  // Optional API key
  const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
  if (REQUIRED_KEY) {
    const k = request.headers.get("x-api-key") || "";
    if (k !== REQUIRED_KEY) {
      return new Response(JSON.stringify({ success:false, error:"Unauthorized: invalid x-api-key." }), { status:401, headers:corsHeaders() });
    }
  }

  try{
    const url = new URL(request.url);
    const uids = (url.searchParams.get("uids") || DEFAULT_UIDS)
      .split(",").map(s=>s.trim()).filter(Boolean);
    const limit = n(url.searchParams.get("limit") || 50);

    // Phân trang để không vượt subrequests
    const total = uids.length;
    const start = Math.max(0, n(url.searchParams.get("cursor") || 0));
    const maxPerCall = Math.max(1, Math.min(35, n(url.searchParams.get("max") || 35))); // <= 35 UID/lần
    const end = Math.min(total, start + maxPerCall);

    const all = [];
    // tuần tự + giãn rất nhẹ (không cần tốc độ)
    for (let i = start; i < end; i++){
      const uid = uids[i];
      const wait = 80 + Math.floor(Math.random()*60); // 80–140ms
      await new Promise(r=>setTimeout(r, wait));

      const q = new URL(API_ORDERS);
      q.searchParams.set("limit", String(limit));
      q.searchParams.set("orderListType", "ORDER");
      q.searchParams.set("page", "1");
      q.searchParams.set("uid", uid);
      q.searchParams.set("t", String(Date.now()%1e7)); // tránh cache upstream

      const resp = await fetch(q.toString(), { headers: BROWSER_HEADERS, cf: { cacheEverything: false } });
      if (!resp.ok) continue;

      let data = null;
      try { data = await resp.json(); } catch { data = null; }
      const rows = data?.success === true ? (data.data?.content || []) : [];
      for (const r of rows) all.push({ ...r, _uid: uid });
    }

    // de-dup theo orderId/id (ưu tiên thời gian mới nhất)
    const byKey = new Map();
    for (const o of all) {
      const key = o.orderId || o.id;
      const prev = byKey.get(key);
      const t = o.pageTime || o.openTime || 0;
      if (!prev || t > (prev?.pageTime || prev?.openTime || 0)) byKey.set(key, o);
    }

    // normalize
    const data = Array.from(byKey.values()).map(o=>{
      const L = lev(o), P = n(o.openAvgPrice), A = n(o.amount), M = mUSDT(P,A,L,o.margin);
      const notional = P*A;
      return {
        id:o.orderId || o.id,
        trader:o.traderNickName || "",
        traderUid:String(o.uid ?? o.traderUid ?? o._uid ?? ""),
        symbol:pair(o.symbol),
        mode:mode(o.positionType),
        lev:L,
        marginMode:mm(o.openType),
        amount:A,
        openPrice:P,
        margin:M,
        notional,
        followers:o.followers,
        openAt:o.openTime || 0,
        openAtStr:tsVNT(o.openTime || 0),
        marginPct:(notional>0)?(M/notional)*100:0,
        raw:o,
      };
    }).sort((a,b)=>b.openAt-a.openAt);

    // Trả kèm thông tin phân trang
    const nextCursor = end < total ? String(end) : null;
    return new Response(JSON.stringify({
      success: true,
      page: { start, end, total, maxPerCall, nextCursor },
      data
    }), { headers: corsHeaders() });

  }catch(e){
    return new Response(JSON.stringify({ success:false, error:String(e?.message||e) }), {
      status:500, headers:corsHeaders()
    });
  }
}
