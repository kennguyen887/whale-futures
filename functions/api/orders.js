// /api/orders (Cloudflare Pages Functions)
const EP1 = "https://futures.mexc.com/copyFutures/api/v1/trader/orders/v2";
const EP2 = "https://www.mexc.com/api/platform/futures/copyFutures/api/v1/trader/orders/v2"; // fallback
const HDR = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

const DEFAULT_UIDS = "34988691,02058392,83769107,47991559,82721272,89920323,92798483,72432594,87698388,31866177,49787038,45227412,80813692,27337672,95927229,71925540,38063228,47395458,78481146,89070846,01249789,87698388,57343925,74785697,21810967,22247145,88833523,40133940,84277140,93640617,76459243,48673493,13290625,48131784,23747691,89989257,69454560,52543521,07867898,36267959,90901845,27012439,58298982,72486517,30339263,49140673,20393898,93765871,98086898,81873060,08796342";

const CORS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "Content-Type, X-API-Key",
};

function n(x){const v=Number(x);return Number.isFinite(v)?v:0}
function pair(s=""){return String(s).replace("_","")}
function mode(pt){return pt===1?"long":pt===2?"short":"unknown"}
function mm(ot){return ot===1?"Isolated":ot===2?"Cross":"Unknown"}
function lev(o){return n(o.leverage??o.lev??o.openLeverage??o?.raw?.leverage)||1}
function marginUSDT(p,a,l,m){const M=n(m);if(M>0)return M;const not=n(p)*n(a);return (n(l)||1)>0?not/l:0}
function tsVNT(t){return t?new Date(t).toLocaleString("en-GB",{timeZone:"Asia/Ho_Chi_Minh",hour12:false}).replace(",",""):""}

export async function onRequestOptions(){return new Response(null,{status:204,headers:CORS})}

export async function onRequest(ctx){
  try{
    const {env,request} = ctx;
    const NEED = env.INTERNAL_API_KEY||"";
    if(NEED && (request.headers.get("x-api-key")||"")!==NEED)
      return new Response(JSON.stringify({success:false,error:"Unauthorized: invalid x-api-key."}),{status:401,headers:CORS});

    const url = new URL(request.url);
    const uids = (url.searchParams.get("uids")||DEFAULT_UIDS).split(",").map(s=>s.trim()).filter(Boolean);
    const limit = n(url.searchParams.get("limit")||50);

    // pool=2 + stagger nhỏ
    const all = []; let i=0; const POOL=2;
    await Promise.all([...Array(POOL)].map(async(_,w)=>{
      for(;;){
        const idx = i++; if(idx>=uids.length) break;
        const uid = uids[idx];
        const wait = (idx%6)*70 + Math.floor(Math.random()*30); // ~nhẹ nhàng
        if(wait) await new Promise(r=>setTimeout(r,wait));

        // build URL (kèm param "t" random để tránh cache upstream)
        const build = (ep)=>{ const q=new URL(ep); q.searchParams.set("limit",String(limit)); q.searchParams.set("orderListType","ORDER"); q.searchParams.set("page","1"); q.searchParams.set("uid",uid); q.searchParams.set("t",String(Date.now()%1e7)); return q; };
        let resp = await fetch(build(EP1),{headers:HDR,cf:{cacheEverything:false}});
        if(!resp.ok && (resp.status===404||resp.status===403||resp.status===451)) resp = await fetch(build(EP2),{headers:HDR,cf:{cacheEverything:false}});
        if(!resp.ok) continue;

        let data=null; try{ data=await resp.json(); }catch{}
        const rows = data?.success===true ? (data.data?.content||[]) : [];
        rows.forEach(r=>all.push({...r,_uid:uid}));
      }
    }));

    // de-dup & normalize
    const m=new Map();
    for(const o of all){
      const k=o.orderId||o.id; const t=o.pageTime||o.openTime||0;
      const p=m.get(k); if(!p || t>(p.pageTime||p.openTime||0)) m.set(k,o);
    }
    const merged=[...m.values()].map(o=>{
      const L=lev(o), P=n(o.openAvgPrice), A=n(o.amount), M=marginUSDT(P,A,L,o.margin);
      return {
        id:o.orderId||o.id,
        trader:o.traderNickName||"",
        traderUid:String(o.uid??o.traderUid??o._uid??""),
        symbol:pair(o.symbol),
        mode:mode(o.positionType),
        lev:L,
        marginMode:mm(o.openType),
        amount:A,
        openPrice:P,
        margin:M,
        notional:P*A,
        followers:o.followers,
        openAt:o.openTime||0,
        openAtStr:tsVNT(o.openTime||0),
        marginPct:(P*A>0)?(M/(P*A))*100:0,
        raw:o,
      };
    }).sort((a,b)=>b.openAt-a.openAt);

    return new Response(JSON.stringify({success:true,data:merged}),{headers:CORS});
  }catch(e){
    return new Response(JSON.stringify({success:false,error:String(e?.message||e)}),{status:500,headers:CORS});
  }
}
