// =============================================
// MEXC Leaders Realtime — React Frontend (Vite/CRA compatible)
// + Minimal Node.js proxy in the same file (copy out if needed)
// =============================================
// How to use (quick):
// 1) Create a small proxy server (required to bypass CORS / firewall):
//    - Copy the section marked "// ==== proxy/server.js (Express) ====\n" into server.js
//    - `npm i express axios cors dotenv`
//    - Create .env with: MEXC_LEADER_UIDS="78481146,12345678"
//    - `node server.js` (defaults to http://localhost:8787)
// 2) React app:
//    - Copy the section marked "// ==== src/App.jsx (React) ====\n" to src/App.jsx
//    - `npm i` (and Tailwind if you want the exact styles). Tailwind optional.
//    - Run dev server (Vite/CRA). Ensure PROXY_BASE points to your proxy (http://localhost:8787)
//
// Notes:
// - Columns: Trader | Symbol | Mode | Lev | Margin Mode | PNL (USDT) | ROI % | Open At (VNT) | Open Price | Amount | Margin (USDT) | Notional (USDT) | Margin % | Followers
// - Sort: Open At (newest -> oldest)
// - Colors: long=blue, short=red; PNL/ROI: green if >0, red if <0
// - Poll: 3s (configurable)


// =============================================
// ==== proxy/server.js (Express) ====
// Copy this block into its own file "server.js" if you need a CORS-friendly backend proxy

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());


const MEXC_LEADER_UIDS = '78481146,89070846,01249789,87698388,57343925,74785697,21810967,22247145,88833523,40133940,84277140,93640617,76459243,48673493,13290625,48131784'; // 
const PORT = process.env.PORT || 8787;
const API_ORDERS = "https://futures.mexc.com/copyFutures/api/v1/trader/orders/v2";
const FUTURES_TICKER_API = "https://futures.mexc.com/api/v1/contract/ticker"; // symbol: XRP_USDT
const SPOT_TICKER_API = "https://api.mexc.com/api/v3/ticker/price";            // symbol: XRPUSDT

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

function toPair(symUnderscore) {
  return (symUnderscore || "").replace("_", "");
}

// Merge + compute PNL/ROI similar to your Node script
function normalizeAndCompute(rows) {
  const TIMEZONE = "Asia/Ho_Chi_Minh";
  const fmt = (n, d = 2) =>
    typeof n === "number" && isFinite(n)
      ? Number(n).toLocaleString(undefined, { maximumFractionDigits: d })
      : n;

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
    const m = Number(o.margin || 0); const n = notional(o);
    return n > 0 ? (m / n) * 100 : 0;
  }
  const tsVNT = (t) => t ? new Date(t).toLocaleString("en-GB", { timeZone: TIMEZONE, hour12: false }).replace(",", "") : "";

  return rows.map(o => ({
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
  })).sort((a,b) => b.openAt - a.openAt);
}

app.get("/api/orders", async (req, res) => {
  try {
    const uids = String(req.query.uids || MEXC_LEADER_UIDS || "").split(",").map(s=>s.trim()).filter(Boolean);
    const limit = Number(req.query.limit || 10);

    const all = [];
    for (const uid of uids) {
      const { data } = await axios.get(API_ORDERS, {
        params: { limit, orderListType: "ORDER", page: 1, uid },
        timeout: 12000,
        headers: { ...BROWSER_HEADERS },
      });
      if (data?.success === true) {
        const rows = data.data?.content || [];
        all.push(...rows);
      }
    }

    // de-dup by orderId newest
    const byKey = new Map();
    for (const o of all) {
      const key = o.orderId || o.id;
      const prev = byKey.get(key);
      const pageTime = o.pageTime || o.openTime || 0;
      if (!prev || pageTime > (prev.pageTime || prev.openTime || 0)) byKey.set(key, o);
    }

    const merged = Array.from(byKey.values());
    res.json({ success: true, data: normalizeAndCompute(merged) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


async function priceForSymbol(symUnderscore) {
  try {
    const fut = await axios.get(FUTURES_TICKER_API, {
      params: { symbol: symUnderscore },
      headers: { ...BROWSER_HEADERS }, timeout: 8000
    });
    const obj = Array.isArray(fut.data?.data) ? fut.data.data[0] : fut.data?.data;
    const p = Number(obj?.lastPrice || obj?.fairPrice || obj?.indexPrice || 0);
    if (p > 0) return p;
  } catch(_) {}

  try {
    const spotSym = symUnderscore.replace("_",""); // XRPUSDT
    const spot = await axios.get(SPOT_TICKER_API, {
      params: { symbol: spotSym },
      headers: { ...BROWSER_HEADERS }, timeout: 8000
    });
    if (Array.isArray(spot.data)) {
      const f = spot.data.find(x => x.symbol === spotSym);
      const p = Number(f?.price || 0);
      if (p > 0) return p;
    } else {
      const p = Number(spot.data?.price || 0);
      if (p > 0) return p;
    }
  } catch(_) {}

  return 0;
}

app.get("/api/prices", async (req, res) => {
  try {
    const list = String(req.query.symbols || "").split(",").map(s=>s.trim()).filter(Boolean);
    const unique = [...new Set(list)];
    const out = {};
    await Promise.all(unique.map(async sym => {
      const p = await priceForSymbol(sym);
      if (p > 0) out[sym] = p;
    }));
    res.json({ success: true, prices: out });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Proxy up on http://localhost:${PORT}`));
