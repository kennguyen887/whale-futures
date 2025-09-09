// app.js
// Realtime Binance: Big Trades TOP 30 (Spot + Futures) — Mode (long/short)
// deps: ws, cli-table3, axios, crypto
const WebSocket = require("ws");
const Table = require("cli-table3");
const axios = require("axios");
const crypto = require("crypto");

// ======= CONFIG =======
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]; // cặp để theo dõi aggTrade
const TOP_N = 30;                 // giữ Top N notional lớn nhất
const REFRESH_MS = 2000;          // tần suất refresh bảng
const TRACK_SPOT = true;          // bật thêm stream Spot
// (đã bỏ UI vị thế & liquidations khỏi render)
// ======================

// Streams
const lower = s => s.toLowerCase();
const FUTURES_STREAMS = [
  ...SYMBOLS.map(s => `${lower(s)}@aggTrade`),
  "!forceOrder@arr", // vẫn nghe để sau này dùng nếu cần, nhưng không render
];
const FUTURES_WS = `wss://fstream.binance.com/stream?streams=${FUTURES_STREAMS.join("/")}`;

const SPOT_STREAMS = TRACK_SPOT ? SYMBOLS.map(s => `${lower(s)}@aggTrade`) : [];
const SPOT_WS = TRACK_SPOT && SPOT_STREAMS.length
  ? `wss://stream.binance.com:9443/stream?streams=${SPOT_STREAMS.join("/")}`
  : null;

// State
const bigTradesTop = [];    // [{ts, market:'Futures'|'Spot', symbol, mode, price, qty, notional}]

// Helpers
const fmt = (n, d = 2) => typeof n === "number"
  ? n.toLocaleString(undefined, { maximumFractionDigits: d })
  : n;

const tsUTC = t => new Date(t).toISOString().replace("T", " ").replace(".000Z", " UTC");

/** Insert into top array by notional (desc). Keep max TOP_N. */
function insertTop(arr, item, topN) {
  arr.push(item);
  arr.sort((a, b) => (b.notional - a.notional) || (b.ts - a.ts));
  if (arr.length > topN) arr.length = topN;
}

// ===== UI =====
async function render() {
  console.clear();
  console.log("🐳 Binance Realtime — Big Trades TOP 30 (Spot+Futures) — Mode (long/short)\n");

  // (Only) Big Trades — Spot + Futures (TOP 30)
  const t1 = new Table({
    head: ["Time (UTC)", "Market", "Symbol", "Mode (long/short)", "Price", "Qty", "Notional (USDT)"],
    style: { head: ["green"] },
  });
  bigTradesTop.forEach(t => {
    t1.push([
      tsUTC(t.ts),
      t.market,
      t.symbol,
      t.mode,
      fmt(t.price, 4),
      fmt(t.qty, 4),
      fmt(t.notional, 0),
    ]);
  });
  console.log(`💥 Big Trades — TOP ${TOP_N} lớn nhất (tích lũy theo phiên)`);
  console.log(t1.toString());

  console.log(`\n⏱️ Update ${REFRESH_MS/1000}s — Streams: Futures aggTrade${TRACK_SPOT ? " + Spot aggTrade" : ""} — Ctrl+C to exit`);
}

// ===== WebSockets =====
let wsFut, wsSpot;

function connectFutures() {
  wsFut = new WebSocket(FUTURES_WS);
  wsFut.on("open", () => console.log("Futures WS connected"));
  wsFut.on("message", raw => {
    try {
      const { stream, data } = JSON.parse(raw.toString());

      // Futures aggTrade
      if (stream && stream.endsWith("@aggTrade")) {
        const symbol = data.s;
        const price = parseFloat(data.p);
        const qty = parseFloat(data.q);
        const notional = price * qty;

        // Heuristic cũ suy ra BUY/SELL từ m; sau đó map sang mode long/short
        const side = data.m ? "SELL" : "BUY";
        const mode = side === "BUY" ? "long" : "short";

        insertTop(bigTradesTop, {
          ts: Date.now(),
          market: "Futures",
          symbol, mode, price, qty, notional,
        }, TOP_N);
        return;
      }

      // Liquidations vẫn lắng nghe nhưng không render (để mở rộng về sau)
      if (stream === "!forceOrder@arr" && Array.isArray(data)) {
        // no-op for UI (giữ chỗ nếu bạn muốn bật lại sau)
      }
    } catch (_) {}
  });
  wsFut.on("close", () => { console.log("Futures WS closed. Reconnecting…"); setTimeout(connectFutures, 3000); });
  wsFut.on("error", err => console.error("Futures WS error:", err.message));
}

function connectSpot() {
  if (!SPOT_WS) return;
  wsSpot = new WebSocket(SPOT_WS);
  wsSpot.on("open", () => console.log("Spot WS connected"));
  wsSpot.on("message", raw => {
    try {
      const { stream, data } = JSON.parse(raw.toString());
      if (stream && stream.endsWith("@aggTrade")) {
        const symbol = data.s;
        const price = parseFloat(data.p);
        const qty = parseFloat(data.q);
        const notional = price * qty;

        const side = data.m ? "SELL" : "BUY";
        const mode = side === "BUY" ? "long" : "short";

        insertTop(bigTradesTop, {
          ts: Date.now(),
          market: "Spot",
          symbol, mode, price, qty, notional,
        }, TOP_N);
      }
    } catch (_) {}
  });
  wsSpot.on("close", () => { console.log("Spot WS closed. Reconnecting…"); setTimeout(connectSpot, 3000); });
  wsSpot.on("error", err => console.error("Spot WS error:", err.message));
}

// Kick off
console.log("Starting…");
console.log("Futures streams:", FUTURES_STREAMS.join(", "));
if (TRACK_SPOT) console.log("Spot streams:", SPOT_STREAMS.join(", "));
connectFutures();
connectSpot();
setInterval(render, REFRESH_MS);
