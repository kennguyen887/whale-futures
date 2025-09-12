// /functions/AI/recommend-live.js
// Route: POST /api/AI/recommend-live?topN=10&lang=vi
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
    const topN = parseInt(url.searchParams.get("topN") || "10", 10);
    const lang = (url.searchParams.get("lang") || "vi").toLowerCase(); // vi default

    // -------- MEXC helpers (Contract signing) --------
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

    async function mexcGet(path, params = {}) {
      const requestParamString = buildRequestParamString(params);
      const reqTime = Date.now().toString();
      const payload = `${MEXC_ACCESS_KEY}${reqTime}${requestParamString || ""}`;
      const signature = await hmacSha256Hex(MEXC_SECRET_KEY, payload);

      const fullUrl = `${MEXC_BASE}${path}${requestParamString ? "?" + requestParamString : ""}`;
      const res = await fetch(fullUrl, {
        method: "GET",
        headers: {
          "ApiKey": MEXC_ACCESS_KEY,
          "Request-Time": reqTime,
          "Signature": signature,
          "Content-Type": "application/json",
        }
      });

      const data = await safeJson(res);
      if (!res.ok) {
        throw new Error(`MEXC ${path} HTTP ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
      }
      return data;
    }

    // -------- Fetch RAW data (giữ nguyên tất cả fields) --------
    const [posResp, ordResp] = await Promise.all([
      mexcGet("/api/v1/private/position/open_positions", {}),
      mexcGet("/api/v1/private/order/open_orders", {}),
    ]);

    // Lấy mảng "positions" đúng như backend trả (không sửa key, không rename)
    const positionsRaw = extractArray(posResp);   // => array of objects, raw
    const openOrdersRaw = extractArray(ordResp);  // vẫn raw cho đồng nhất

    // -------- CSV động từ positions (tự gom tất cả keys) --------
    const positionsCsv = buildDynamicCsv(positionsRaw);

    // -------- Prompt cho AI (dùng CSV động). Có thể dùng positionsRaw nếu bạn muốn JSON-to-JSON. --------
    const DEFAULT_PROMPT = `
Bạn là chuyên gia trader kiêm risk-manager, tư vấn những lệnh tôi đang chạy. Hãy ouput lạicác lệnh bên dưới, sắp xếp mức độ ưu tiên cao đến thấp, lấy giá coin này để phân tích kiểm tra rủi ro và PNL, trình bày có icon, ngắn gọn, dễ đọc. Dữ liệu rõ ràng, và dự đoán những số liệu quan trọng, và thêm những column:
-  Dựa vào những gì bạn đang biết về tình hình thị trường này, tư vấn cho tôi có gì sai hay có gì cần lưu ý không.
-  Phân loại lệnh: 🔥 Ưu tiên | 🛡️ An toàn | ⚠️ Rủi ro | 📈 Đang trend.
-  Tư vấn tối ưu hoá lợi nhuận & quản trị rủi ro cho từng lệnh

Các lệnh Futures của tôi(nếu không có thì chỉ cần trả lời "chưa có lệnh nào"):
${positionsCsv || "<EMPTY>"}
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
        // vẫn trả RAW để bạn debug/hiển thị UI
        positionsRaw,
        openOrdersRaw,
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
      // Trả đủ mọi field từ positions/openOrders
      positionsRaw,
      openOrdersRaw,
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
    "access-control-allow-headers": "Content-Type, Authorization, X-API-Key, x-api-key",
  };
}

function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: corsHeaders() });
}

// Preflight
export const onRequestOptions = async () => new Response(null, { status: 204, headers: corsHeaders() });

/** Trích mảng từ response MEXC mà không mất field (ưu tiên data/result) */
function extractArray(resp) {
  const root = (resp && (resp.data ?? resp.result ?? resp)) ?? [];
  if (Array.isArray(root)) return root;
  if (Array.isArray(root.positions)) return root.positions; // một số API bọc trong { positions: [...] }
  if (Array.isArray(root.orders)) return root.orders;
  // Nếu không rõ, cố tìm mảng đầu tiên trong object:
  if (root && typeof root === "object") {
    for (const v of Object.values(root)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

/** Build CSV động: gom union tất cả keys (level 1) và fill theo từng item */
function buildDynamicCsv(items) {
  if (!Array.isArray(items) || items.length === 0) return "";

  // union tất cả keys level-1
  const keySet = new Set();
  for (const it of items) {
    if (it && typeof it === "object" && !Array.isArray(it)) {
      Object.keys(it).forEach(k => keySet.add(k));
    }
  }
  const headers = Array.from(keySet);
  // CSV
  const lines = [];
  lines.push(headers.join(","));
  for (const it of items) {
    const row = headers.map(h => {
      let v = it?.[h];
      if (v === null || v === undefined) v = "";
      if (typeof v === "object") {
        try { v = JSON.stringify(v); } catch { v = String(v); }
      }
      // tránh phá CSV (đơn giản): bỏ dấu phẩy, xuống dòng
      return String(v).replace(/[\n\r]+/g, " ").replace(/,/g, " ");
    }).join(",");
    lines.push(row);
  }
  return lines.join("\n");
}
