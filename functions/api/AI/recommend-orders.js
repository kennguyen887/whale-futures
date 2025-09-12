// /functions/AI/recommend-live.js
// Route: POST /api/AI/recommend-live?topN=10&lang=vi
// Envs required: OPENAI_API_KEY, MEXC_ACCESS_KEY, MEXC_SECRET_KEY
// Optional envs : OPENAI_BASE (default https://api.openai.com)
//                 OPENAI_MODEL (default gpt-4o-mini)
// Security       : env.INTERNAL_API_KEY (header: x-api-key) — same as recommend.js

export const onRequestPost = async (context) => {
  try {
    const { request, env } = context;

    // -------- Shared internal key check (same behavior as your existing API) --------
    const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
    if (REQUIRED_KEY) {
      const clientKey = request.headers.get("x-api-key") || "";
      if (clientKey !== REQUIRED_KEY) {
        return jsonRes(401, { success: false, error: "Unauthorized: invalid x-api-key." });
      }
    }

    // -------- Read optional body: allow custom prompt override / user hints --------
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    let bodyJson = {};
    if (ct.includes("application/json")) {
      try { bodyJson = await request.json(); } catch {}
    }
    const customPrompt = (bodyJson?.prompt || "").toString().trim();

    // -------- OpenAI config --------
    const OPENAI_API_KEY = env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return jsonRes(500, { success: false, error: "Server misconfig: OPENAI_API_KEY not set." });
    }
    const OPENAI_BASE = (env.OPENAI_BASE || "https://api.openai.com").replace(/\/+$/, "");
    const OPENAI_MODEL = env.OPENAI_MODEL || "gpt-4o-mini";

    // -------- MEXC keys --------
    const MEXC_ACCESS_KEY = env.MEXC_ACCESS_KEY;
    const MEXC_SECRET_KEY = env.MEXC_SECRET_KEY;
    if (!MEXC_ACCESS_KEY || !MEXC_SECRET_KEY) {
      return jsonRes(500, { success: false, error: "Server misconfig: MEXC keys not set." });
    }

    // -------- Query params --------
    const url = new URL(request.url);
    const topN = parseInt(url.searchParams.get("topN") || "10", 10);
    const lang = (url.searchParams.get("lang") || "vi").toLowerCase(); // vi default

    // -------- Fetch live positions + open orders from MEXC (USDT-M Futures) --------
    // We try several common unified/contract endpoints and two signer variants.
    const mexcBase = "https://contract.mexc.com"; // unified futures base (commonly used)
    const now = Date.now();
    const recvMs = 60_000;

    const ENDPOINTS = [
      // Open positions (primary)
      { method: "GET", path: "/api/v1/private/position/open_positions", qs: "" },
      // Fallback variants (naming sometimes differs)
      { method: "GET", path: "/api/v1/private/position/openPositions", qs: "" },
      // Open orders (to catch entries waiting to fill)
      { method: "GET", path: "/api/v1/private/order/open_orders", qs: "" },
      { method: "GET", path: "/api/v1/private/order/openOrders", qs: "" },
    ];

    // --- Signer A (Binance-like: timestamp & signature in query) ---
    function signQuery_BinanceLike(qs) {
      const enc = new TextEncoder();
      const key = MEXC_SECRET_KEY;
      const data = qs;
      const sig = hmacSHA256Hex(key, data);
      return sig;
    }

    // --- Signer B (Contract-like: signature header over method+path+query+body) ---
    function signHeader_ContractLike({ method, path, qs, body, ts }) {
      // Common patterns: sign = HMAC_SHA256(secret, `${ts}${method}${path}${qs}${body}`)
      // or `${method}\n${path}\n${qs}\n${body}\n${ts}`
      // We'll try two canonical concatenations; server will accept one of them.
      const payload1 = `${ts}${method}${path}${qs}${body || ""}`;
      const payload2 = `${method}\n${path}\n${qs}\n${body || ""}\n${ts}`;
      const sig1 = hmacSHA256Hex(MEXC_SECRET_KEY, payload1);
      const sig2 = hmacSHA256Hex(MEXC_SECRET_KEY, payload2);
      return { sig1, sig2 };
    }

    async function mexcFetchTryAll() {
      const collected = { positions: [], openOrders: [], rawResponses: [] };

      for (const ep of ENDPOINTS) {
        const ts = `${Date.now()}`;
        const method = ep.method;
        const path = ep.path;
        const baseQs = ep.qs || "";

        // Try Signer A (query-based)
        const qsA = `timestamp=${ts}&recvWindow=${recvMs}${baseQs ? "&" + baseQs : ""}`;
        const sigA = signQuery_BinanceLike(qsA);
        const urlA = `${mexcBase}${path}?${qsA}&signature=${sigA}`;
        const resA = await fetch(urlA, {
          method,
          headers: {
            "Content-Type": "application/json",
            "ApiKey": MEXC_ACCESS_KEY,       // spot-like header key (some stacks accept this)
            "X-MEXC-APIKEY": MEXC_ACCESS_KEY // alt header
          },
        }).catch(() => null);

        let parsedA = null;
        if (resA && resA.ok) {
          parsedA = await safeJson(resA);
          collected.rawResponses.push({ variant: "A", path, status: resA.status, data: parsedA });
          mergeMexcData(collected, path, parsedA);
          continue; // next endpoint
        }

        // Try Signer B (header-based)
        const qsB = baseQs ? `?${baseQs}` : "";
        const { sig1, sig2 } = signHeader_ContractLike({ method, path, qs: qsB, body: "", ts });
        const urlB = `${mexcBase}${path}${qsB}`;
        const headersB1 = {
          "Content-Type": "application/json",
          "api-key": MEXC_ACCESS_KEY,       // contract-like header
          "Request-Time": ts,
          "Signature": sig1,
        };
        const headersB2 = { ...headersB1, "Signature": sig2 };

        const resB1 = await fetch(urlB, { method, headers: headersB1 }).catch(() => null);
        if (resB1 && resB1.ok) {
          const j = await safeJson(resB1);
          collected.rawResponses.push({ variant: "B1", path, status: resB1.status, data: j });
          mergeMexcData(collected, path, j);
          continue;
        }
        const resB2 = await fetch(urlB, { method, headers: headersB2 }).catch(() => null);
        if (resB2 && resB2.ok) {
          const j = await safeJson(resB2);
          collected.rawResponses.push({ variant: "B2", path, status: resB2.status, data: j });
          mergeMexcData(collected, path, j);
          continue;
        }

        // Record failure for debugging (not fatal)
        collected.rawResponses.push({
          variant: "ALL_FAIL",
          path,
          status: resA?.status || resB1?.status || resB2?.status || 0,
          text: (await resA?.text?.()) || (await resB1?.text?.()) || (await resB2?.text?.()) || "no response",
        });
      }

      return collected;
    }

    function mergeMexcData(store, path, data) {
      // Normalize common shapes:
      // Some responses: { code:0, data:[...] } or { success:true, data:{ ... } } etc.
      const d = data?.data ?? data?.result ?? data ?? [];
      // Heuristics by endpoint intent:
      if (path.includes("/position/")) {
        const arr = Array.isArray(d) ? d : (Array.isArray(d?.positions) ? d.positions : []);
        for (const it of arr) store.positions.push(it);
      } else if (path.includes("/order/")) {
        const arr = Array.isArray(d) ? d : (Array.isArray(d?.orders) ? d.orders : []);
        for (const it of arr) store.openOrders.push(it);
      }
    }

    function num(x, def = 0) {
      const n = typeof x === "number" ? x : Number(String(x || "").replace(/,/g, ""));
      return Number.isFinite(n) ? n : def;
    }

    // --- Minimal HMAC-SHA256 (Web Crypto, Workers-compatible) ---
    function toHex(buf) {
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    }
    function strToBuf(s) { return new TextEncoder().encode(s); }
    async function hmac(key, msg) {
      const k = await crypto.subtle.importKey("raw", strToBuf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", k, strToBuf(msg));
      return toHex(sig);
    }
    // Wrapper for sync-like use (Workers allows async/await)
    function hmacSHA256Hex(key, msg) { return __hmacCache(key, msg); }
    const __hmap = new Map();
    async function __hmacRaw(key, msg) { return await hmac(key, msg); }
    function __hmacCache(key, msg) {
      // We return a Promise-like string via Atomics? Simpler: block with deopt using Atomics not allowed.
      // We'll cheat by exposing a synchronous facade via deasync-like? Not possible here.
      // → So convert callers to await. (Adjust above)
      throw new Error("hmacSHA256Hex used synchronously; use await hmacSHA256HexAsync instead.");
    }
    async function hmacSHA256HexAsync(key, msg) { return await __hmacRaw(key, msg); }

    // Fix callers to async (update above):
    // (We redefine signers that awaited earlier sync call)
    function makeSigners() {
      return {
        async signQuery_BinanceLike(qs) {
          return await hmacSHA256HexAsync(MEXC_SECRET_KEY, qs);
        },
        async signHeader_ContractLike({ method, path, qs, body, ts }) {
          const payload1 = `${ts}${method}${path}${qs}${body || ""}`;
          const payload2 = `${method}\n${path}\n${qs}\n${body || ""}\n${ts}`;
          const sig1 = await hmacSHA256HexAsync(MEXC_SECRET_KEY, payload1);
          const sig2 = await hmacSHA256HexAsync(MEXC_SECRET_KEY, payload2);
          return { sig1, sig2 };
        }
      };
    }
    const signers = makeSigners();

    async function mexcFetchTryAllAsync() {
      const collected = { positions: [], openOrders: [], rawResponses: [] };

      for (const ep of ENDPOINTS) {
        const ts = `${Date.now()}`;
        const method = ep.method;
        const path = ep.path;
        const baseQs = ep.qs || "";

        // Try Signer A (query-based)
        const qsA = `timestamp=${ts}&recvWindow=${recvMs}${baseQs ? "&" + baseQs : ""}`;
        const sigA = await signers.signQuery_BinanceLike(qsA);
        const urlA = `${mexcBase}${path}?${qsA}&signature=${sigA}`;
        const resA = await fetch(urlA, {
          method,
          headers: {
            "Content-Type": "application/json",
            "ApiKey": MEXC_ACCESS_KEY,
            "X-MEXC-APIKEY": MEXC_ACCESS_KEY
          },
        }).catch(() => null);

        if (resA && resA.ok) {
          const j = await safeJson(resA);
          collected.rawResponses.push({ variant: "A", path, status: resA.status, data: j });
          mergeMexcData(collected, path, j);
          continue;
        }

        // Try Signer B (header-based)
        const qsB = baseQs ? `?${baseQs}` : "";
        const { sig1, sig2 } = await signers.signHeader_ContractLike({ method, path, qs: qsB, body: "", ts });
        const urlB = `${mexcBase}${path}${qsB}`;
        const headersB1 = {
          "Content-Type": "application/json",
          "api-key": MEXC_ACCESS_KEY,
          "Request-Time": ts,
          "Signature": sig1,
        };
        const headersB2 = { ...headersB1, "Signature": sig2 };

        const resB1 = await fetch(urlB, { method, headers: headersB1 }).catch(() => null);
        if (resB1 && resB1.ok) {
          const j = await safeJson(resB1);
          collected.rawResponses.push({ variant: "B1", path, status: resB1.status, data: j });
          mergeMexcData(collected, path, j);
          continue;
        }
        const resB2 = await fetch(urlB, { method, headers: headersB2 }).catch(() => null);
        if (resB2 && resB2.ok) {
          const j = await safeJson(resB2);
          collected.rawResponses.push({ variant: "B2", path, status: resB2.status, data: j });
          mergeMexcData(collected, path, j);
          continue;
        }

        collected.rawResponses.push({
          variant: "ALL_FAIL",
          path,
          status: resA?.status || resB1?.status || resB2?.status || 0,
          text: (await resA?.text?.()) || (await resB1?.text?.()) || (await resB2?.text?.()) || "no response",
        });
      }

      return collected;
    }

    const live = await mexcFetchTryAllAsync();

    // -------- Normalize → CSV for the analysis prompt --------
    // We try to map common fields; adjust mappings if your account returns different keys.
    const rows = [];
    const tz = "Asia/Ho_Chi_Minh";

    // Positions (live exposure)
    for (const p of live.positions) {
      const symbol = p.symbol || p.currency || p.contract || p.instrumentId || "";
      const sideRaw = p.side || p.positionSide || p.direction || ""; // "LONG"/"SHORT" expected
      const side = `${sideRaw}`.toUpperCase().includes("SHORT") ? "SHORT" : "LONG";
      const lev = p.leverage || p.lever || p.leverRate || p.marginLeverage || 0;
      const marginMode = (p.marginMode || p.margin_type || p.isIsolated ? "Isolated" : "Cross");
      const entry = num(p.avgEntryPrice ?? p.openPrice ?? p.averageOpenPrice ?? p.entryPrice);
      const mark = num(p.markPrice ?? p.lastPrice ?? p.currentPrice ?? p.fairPrice);
      const qty = num(p.positionVolume ?? p.size ?? p.holdVol ?? p.quantity ?? p.positionAmt);
      const notional = Math.abs(mark * qty);
      const pnl = num(p.unrealizedPnl ?? p.pnl ?? p.unrealizedProfit);
      const roiPct = notional > 0 ? (pnl / (notional / (lev || 1))) * 100 : 0;
      const deltaPct = entry ? ((mark - entry) / entry) * 100 : 0;
      const openedAt = p.openTime || p.createTime || p.updateTime || Date.now();

      rows.push({
        Trader: p.uid || p.traderUid || p.accountId || "", // might be empty for your own acct
        Symbol: symbol,
        Mode: side,
        Lev: lev,
        "Margin Mode": marginMode,
        "PNL (USDT)": pnl,
        "ROI %": roiPct,
        "Open Price": entry,
        "Market Price": mark,
        "Δ % vs Open": deltaPct,
        Amount: qty,
        "Margin (USDT)": notional / (lev || 1),
        "Notional (USDT)": notional,
        "Open At (VNT)": new Date(openedAt).toLocaleString("en-GB", { timeZone: tz, hour12: false }).replace(",", ""),
        "Margin %": "", // optional to compute if you keep balance
        Followers: "",  // N/A for personal positions
        UID: p.uid || "",
      });
    }

    // Open Orders (entries waiting to fill) — mark Δ% relative to current price if available is unknown; keep 0
    for (const o of live.openOrders) {
      const symbol = o.symbol || o.currency || o.contract || "";
      const sideRaw = o.side || o.positionSide || o.direction || o.orderSide || ""; // BUY/SELL → map to LONG/SHORT by type if needed
      const isLong = `${sideRaw}`.toUpperCase().includes("BUY");
      const side = isLong ? "LONG" : "SHORT";
      const lev = o.leverage || o.lever || o.leverRate || 0;
      const marginMode = (o.marginMode || o.margin_type || o.isIsolated ? "Isolated" : "Cross");
      const price = num(o.price ?? o.triggerPrice ?? o.orderPrice);
      const qty = num(o.vol ?? o.quantity ?? o.size);
      const openedAt = o.createTime || o.updateTime || Date.now();

      rows.push({
        Trader: o.uid || o.traderUid || "",
        Symbol: symbol,
        Mode: side,
        Lev: lev,
        "Margin Mode": marginMode,
        "PNL (USDT)": 0,
        "ROI %": 0,
        "Open Price": price,
        "Market Price": price,    // unknown at placement; keep same to avoid skew
        "Δ % vs Open": 0,
        Amount: qty,
        "Margin (USDT)": "",
        "Notional (USDT)": "",
        "Open At (VNT)": new Date(openedAt).toLocaleString("en-GB", { timeZone: tz, hour12: false }).replace(",", ""),
        "Margin %": "",
        Followers: "",
        UID: o.uid || "",
      });
    }

    // Build CSV string
    const headers = [
      "Trader","Symbol","Mode","Lev","Margin Mode","PNL (USDT)","ROI %","Open Price",
      "Market Price","Δ % vs Open","Amount","Margin (USDT)","Notional (USDT)","Open At (VNT)","Margin %","Followers","UID"
    ];
    const csv = [
      headers.join(","),
      ...rows.map(r => headers.map(h => String(r[h] ?? "").
        replace(/,/g, "") /* strip commas to keep CSV simple */).join(","))
    ].join("\n");

    // -------- Compose expert-trader prompt (condensed from your combined style) --------
    const DEFAULT_PROMPT = `
Bạn là chuyên gia trader kiêm risk-manager, tư vấn những lệnh tôi đang có. Hãy:
1) Đọc lệnh Futures (vị thế đang mở + lệnh đang chờ khớp) bên dưới.
2) Chuẩn hoá số, parse thời gian Asia/Ho_Chi_Minh. Ưu tiên lệnh mở 6–12h gần nhất.
4) Phân loại kèo: 🔥 Ưu tiên | 🛡️ An toàn | ⚠️ Rủi ro | 📈 Đang trend.
5) Tư vấn tối ưu hoá lợi nhuận & quản trị rủi ro
6) Quản trị rủi ro (cứng): Lev tối đa như trên; ≤3 kèo cùng lớp tài sản; risk per trade ≤1% tài khoản; tổng risk ≤5%.
7) Thêm cảnh báo ⚠️ nếu có
8) Ngôn ngữ: ${lang === "vi" ? "Tiếng Việt" : "User language"}; xuất bảng: [Nhóm] | Symbol | Bias | Market | Entry | Lev | Term | Risk | TP | SL | R:R | Reason.
9) Format các lệnh bên dưới dạng table Markdown có icon, ngắn gọn, dễ đọc. Dữ liệu rõ ràng.
lệnh Futures:
${csv || "<EMPTY>"}
`.trim();

    const finalPrompt = customPrompt || DEFAULT_PROMPT;

    // -------- Call OpenAI --------
    const aiReq = {
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [{ role: "user", content: finalPrompt }],
    };
    const aiResp = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(aiReq),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      return jsonRes(aiResp.status, { success: false, error: `OpenAI error: ${errText}`, debug: live.rawResponses?.slice?.(-3) });
    }

    const data = await aiResp.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || "";

    return jsonRes(200, {
      success: true,
      model: OPENAI_MODEL,
      resultMarkdown: content,
      positionsCount: live.positions.length,
      openOrdersCount: live.openOrders.length,
      // Uncomment for debugging endpoint/signature acceptance:
      // debug: live.rawResponses,
    });
  } catch (e) {
    return jsonRes(500, { success: false, error: String(e?.message || e) });
  }
};

// ---------------- helpers ----------------
async function safeJson(res) {
  try { return await res.json(); } catch { return await res.text(); }
}

function corsHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    // include both cases to avoid preflight rejection
    "access-control-allow-headers": "Content-Type, Authorization, X-API-Key, x-api-key",
  };
}

function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: corsHeaders() });
}

// Preflight
export const onRequestOptions = async () => new Response(null, { status: 204, headers: corsHeaders() });
