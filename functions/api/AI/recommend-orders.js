// /functions/AI/recommend-live.js
// Route: POST /api/AI/recommend-live?lang=vi
// Envs required: OPENAI_API_KEY, MEXC_ACCESS_KEY, MEXC_SECRET_KEY
// Optional envs : OPENAI_BASE (default https://api.openai.com)
//                 OPENAI_MODEL (default gpt-4o-mini)
// Security       : env.INTERNAL_API_KEY (header: x-api-key)

export const onRequestPost = async (context) => {
  try {
    const { request, env } = context;

    // -------- Internal key check --------
    const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
    if (REQUIRED_KEY) {
      const clientKey = request.headers.get("x-api-key") || "";
      if (clientKey !== REQUIRED_KEY) {
        return jsonRes(401, { success: false, error: "Unauthorized: invalid x-api-key." });
      }
    }

    // -------- Body (optional prompt override) --------
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
    const lang = (url.searchParams.get("lang") || "vi").toLowerCase();

    // -------- Fetch RAW data (giữ nguyên tất cả fields) --------
    const debug = [];
    const positionsResp = await safeMexcGet({
      path: "/api/v1/private/position/open_positions",
      params: {},
      accessKey: MEXC_ACCESS_KEY,
      secretKey: MEXC_SECRET_KEY,
      debug,
    });

    const ordersResp = await safeMexcGet({
      path: "/api/v1/private/order/open_orders",
      params: {},
      accessKey: MEXC_ACCESS_KEY,
      secretKey: MEXC_SECRET_KEY,
      debug,
      optional: true, // không lỗi toàn bộ nếu fail
    });

    const positionsRaw = extractArray(positionsResp || []);
    const openOrdersRaw = extractArray(ordersResp || []);

    // -------- Giá thị trường theo MEXC (futures → fallback spot) --------
    const prices = await fetchMarketPricesForPositions(positionsRaw);

    // -------- Build JSON cho AI: giữ full fields + marketPrice + direction + marginMode --------
    const positionsAI = positionsRaw.map((p) => {
      const sym = getSymbolUnderscoreFromPosition(p);
      const marketPrice = sym ? (prices[sym] ?? null) : null;

      // theo docs: positionType 1=long, 2=short
      const direction = mapPositionType(p?.positionType, p?.side, p?.positionSide, p?.holdSide);
      // theo docs: openType 1=isolated, 2=cross
      const marginMode = mapOpenType(p?.openType, p?.marginMode, p?.margin_type, p?.isIsolated);

      return { ...p, marketPrice, direction, marginMode };
    });

    const openOrdersAI = openOrdersRaw.map((o) => {
      const sym = getSymbolUnderscoreFromPosition(o);
      const marketPrice = sym ? (prices[sym] ?? null) : null;

      const direction = mapPositionType(o?.positionType, o?.side, o?.positionSide, o?.orderSide);
      const marginMode = mapOpenType(o?.openType, o?.marginMode, o?.margin_type, o?.isIsolated);

      return { ...o, marketPrice, direction, marginMode };
    });

    // Nếu không có lệnh → trả thẳng, không gọi OpenAI
    if ((!positionsAI || positionsAI.length === 0) && (!openOrdersAI || openOrdersAI.length === 0)) {
      return jsonRes(200, {
        success: true,
        model: OPENAI_MODEL,
        resultMarkdown: "chưa có lệnh nào",
        positionsCount: 0,
        openOrdersCount: 0,
        positionsRaw,
        openOrdersRaw,
        prices,
        debug,
      });
    }

    // -------- Prompt (JSON rõ nghĩa) --------
    const aiPayload = {
      timezone: "Asia/Ho_Chi_Minh",
      generatedAt: new Date().toISOString(),
      notes: "marketPrice from MEXC futures ticker, fallback to spot; direction/marginMode derived per MEXC docs (positionType, openType).",
      positions: positionsAI,
      openOrders: openOrdersAI
    };

    const DEFAULT_PROMPT = `
Bạn là chuyên gia trader kiêm risk-manager, tư vấn những lệnh tôi đang chạy. Hãy ouput lại các lệnh bên dưới dạng text dễ đọc, trình bày có icon, reaction chars, sắp xếp mức độ ưu tiên cao đến thấp, lấy giá coin này để phân tích kiểm tra rủi ro và PNLn,  Dữ liệu rõ ràng, và dự đoán những số liệu quan trọng, và thêm những column:
-  Dựa vào những gì bạn đang biết về tình hình thị trường này, tư vấn cho tôi có gì sai hay có gì cần lưu ý không.
-  Phân loại lệnh: 🔥 Ưu tiên | 🛡️ An toàn | ⚠️ Rủi ro | 📈 Đang trend.
-  Tư vấn tối ưu hoá lợi nhuận & quản trị rủi ro cho từng lệnh

Các lệnh Futures của tôi(nếu không có thì chỉ cần trả lời "chưa có lệnh nào"):

DỮ LIỆU JSON:
\`\`\`json
${JSON.stringify(aiPayload, null, 2)}
\`\`\`
`.trim();

    const finalPrompt = customPrompt || DEFAULT_PROMPT;

    // -------- Gọi OpenAI --------
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
      return jsonRes(aiResp.status, {
        success: false,
        error: `OpenAI error: ${errText}`,
        positionsRaw,
        openOrdersRaw,
        prices,
        debug,
      });
    }

    const data = await aiResp.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || "";

    return jsonRes(200, {
      success: true,
      model: OPENAI_MODEL,
      resultMarkdown: content,
      positionsCount: positionsRaw.length,
      openOrdersCount: openOrdersRaw.length,
      positionsRaw,
      openOrdersRaw,
      prices,
      debug,
    });
  } catch (e) {
    return jsonRes(500, { success: false, error: String(e?.message || e) });
  }
};

// ---------------- helpers ----------------

function corsHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, X-API-Key, x-api-key",
  };
}

function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: corsHeaders() });
}

export const onRequestOptions = async () => new Response(null, { status: 204, headers: corsHeaders() });

// ---------- MEXC Contract signing & fetch with retry ----------
const MEXC_BASE = "https://contract.mexc.com";

function buildRequestParamString(params = {}) {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/\+/g, "%20")}`);
  return entries.join("&");
}

const toHex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const strToBuf = (s) => new TextEncoder().encode(s);
async function hmacSha256Hex(key, msg) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", strToBuf(key),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, strToBuf(msg));
  return toHex(sig);
}

async function mexcGet({ path, params, accessKey, secretKey, timeoutMs = 15000 }) {
  const requestParamString = buildRequestParamString(params || {});
  const reqTime = Date.now().toString(); // ms
  const payload = `${accessKey}${reqTime}${requestParamString || ""}`;
  const signature = await hmacSha256Hex(secretKey, payload);

  const fullUrl = `${MEXC_BASE}${path}${requestParamString ? "?" + requestParamString : ""}`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    const res = await fetch(fullUrl, {
      method: "GET",
      headers: {
        "ApiKey": accessKey,
        "Request-Time": reqTime,
        "Signature": signature,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    const data = await safeJson(res);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(id);
  }
}

/** Safer fetch: retry 2 lần khi lỗi mạng/timeout */
async function safeMexcGet({ path, params, accessKey, secretKey, debug = [], optional = false }) {
  const tries = 3;
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await mexcGet({ path, params, accessKey, secretKey, timeoutMs: 15000 });
      debug.push({ ok: true, path, try: i, at: Date.now() });
      return r;
    } catch (e) {
      lastErr = e;
      debug.push({ ok: false, path, try: i, at: Date.now(), error: String(e?.message || e) });
      await sleep(300 * i); // backoff nhẹ
    }
  }
  if (optional) return null; // không phá flow nếu endpoint optional
  throw new Error(`MEXC fetch failed ${path}: ${String(lastErr?.message || lastErr)}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeJson(res) {
  try { return await res.json(); } catch { return await res.text(); }
}

/** Lấy mảng từ response MEXC mà không mất field (positions/orders/list/...) */
function extractArray(resp) {
  const root = (resp && (resp.data ?? resp.result ?? resp)) ?? [];
  if (Array.isArray(root)) return root;

  if (root && typeof root === "object") {
    const candidates = ["positions", "orders", "list", "openOrders", "items", "records", "rows"];
    for (const k of candidates) if (Array.isArray(root[k])) return root[k];
    for (const v of Object.values(root)) if (Array.isArray(v)) return v;
  }
  return [];
}

// --------- MARKET PRICE (giống get_prices.js) ----------
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

function getSymbolUnderscoreFromPosition(p) {
  const cands = [
    p?.symbol, p?.currency, p?.contract, p?.instrumentId, p?.instrument, p?.pair,
  ].filter(Boolean);
  for (const s of cands) {
    if (typeof s === "string" && s.includes("_")) return s.toUpperCase();
  }
  for (const s of cands) {
    if (typeof s === "string" && !s.includes("_") && /USDT$/i.test(s)) {
      const base = s.replace(/USDT$/i, "");
      if (base) return `${base.toUpperCase()}_USDT`;
    }
  }
  return "";
}

async function priceForSymbol(symUnderscore) {
  // 1) Futures trước
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

  // 2) Fallback spot
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

async function fetchMarketPricesForPositions(positions) {
  const set = new Set();
  for (const p of positions || []) {
    const s = getSymbolUnderscoreFromPosition(p);
    if (s) set.add(s);
  }
  const symbols = [...set];
  const entries = await Promise.all(
    symbols.map(async (sym) => [sym, await priceForSymbol(sym)])
  );
  const out = {};
  for (const [sym, price] of entries) {
    if (price > 0) out[sym] = price;
  }
  return out; // { "BTC_USDT": 62150.2, ... }
}

// --------- Mapping theo docs MEXC ---------
function mapPositionType(positionType, ...fallbacks) {
  const n = Number(positionType);
  if (n === 1) return "LONG";
  if (n === 2) return "SHORT";
  // fallback nhẹ nếu API không trả positionType
  for (const f of fallbacks) {
    const s = String(f ?? "").toUpperCase();
    if (s.includes("SHORT") || s.includes("SELL")) return "SHORT";
    if (s.includes("LONG") || s.includes("BUY")) return "LONG";
  }
  return "LONG";
}

function mapOpenType(openType, ...fallbacks) {
  const n = Number(openType);
  if (n === 1) return "Isolated";
  if (n === 2) return "Cross";
  // fallback nếu không có openType
  for (const f of fallbacks) {
    if (typeof f === "boolean") return f ? "Isolated" : "Cross";
    const s = String(f ?? "").toLowerCase();
    if (s.includes("isolated")) return "Isolated";
    if (s.includes("cross")) return "Cross";
  }
  return "Cross";
}
