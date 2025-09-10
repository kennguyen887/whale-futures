// Cloudflare Pages Functions - /api/prices
// GET /api/prices?symbols=XRP_USDT,BTC_USDT

const FUTURES_TICKER_API = "https://futures.mexc.com/api/v1/contract/ticker";
const SPOT_TICKER_API = "https://api.mexc.com/api/v3/ticker/price";

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

function toSpot(symUnderscore = "") {
  return symUnderscore.replace("_", ""); // XRP_USDT -> XRPUSDT
}

async function priceForSymbol(symUnderscore) {
  // 1) thử Futures trước
  try {
    const q = new URL(FUTURES_TICKER_API);
    q.searchParams.set("symbol", symUnderscore);
    const r = await fetch(q.toString(), { headers: BROWSER_HEADERS });
    if (r.ok) {
      const json = await r.json();
      const obj = Array.isArray(json?.data) ? json.data[0] : json?.data;
      const p = Number(obj?.lastPrice || obj?.fairPrice || obj?.indexPrice || 0);
      if (p > 0) return p;
    }
  } catch {}

  // 2) fallback sang Spot
  try {
    const spotSym = toSpot(symUnderscore);
    const q = new URL(SPOT_TICKER_API);
    q.searchParams.set("symbol", spotSym);
    const r = await fetch(q.toString(), { headers: BROWSER_HEADERS });
    if (r.ok) {
      const json = await r.json();
      if (Array.isArray(json)) {
        const f = json.find((x) => x.symbol === spotSym);
        const p = Number(f?.price || 0);
        if (p > 0) return p;
      } else {
        const p = Number(json?.price || 0);
        if (p > 0) return p;
      }
    }
  } catch {}

  return 0;
}

export async function onRequest(context) {
  try {
    const url = new URL(context.request.url);
    const list = (url.searchParams.get("symbols") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const unique = [...new Set(list)];
    const entries = await Promise.all(
      unique.map(async (sym) => [sym, await priceForSymbol(sym)])
    );

    const out = {};
    for (const [sym, p] of entries) {
      if (p > 0) out[sym] = p;
    }

    return new Response(JSON.stringify({ success: true, prices: out }), {
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: String(e?.message || e) }),
      {
        status: 500,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      }
    );
  }
}
