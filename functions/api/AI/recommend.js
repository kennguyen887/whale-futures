// /functions/AI/recommend.js
// Route: POST /api/AI/recommend
// Requires env: OPENAI_API_KEY
// Optional env: OPENAI_BASE (default https://api.openai.com), OPENAI_MODEL (default gpt-4o-mini)
// Security (shared across APIs): env.INTERNAL_API_KEY (header x-api-key)

export const onRequestPost = async (context) => {
  try {
    const { request, env } = context;

    // -------- Simple API key check (shared key for all internal APIs) --------
    const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
    if (REQUIRED_KEY) {
      const clientKey = request.headers.get("x-api-key") || "";
      if (clientKey !== REQUIRED_KEY) {
        return jsonRes(401, { success: false, error: "Unauthorized: invalid x-api-key." });
      }
    }

    // -------- Read body: CSV is now OPTIONAL; optional custom prompt --------
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    let csv = "";
    let customPrompt = ""; // optional user-provided prompt

    if (ct.includes("application/json")) {
      const j = await request.json();
      csv = (j?.csv || "").toString().trim();        // optional
      customPrompt = (j?.prompt || "").toString().trim(); // optional override
    } else {
      // accept text/csv or raw text as CSV content (also optional)
      csv = (await request.text()).trim();
    }

    // -------- OpenAI config --------
    const OPENAI_API_KEY = env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return jsonRes(500, { success: false, error: "Server misconfig: OPENAI_API_KEY not set." });
    }
    const OPENAI_BASE = (env.OPENAI_BASE || "https://api.openai.com").replace(/\/+$/, "");
    const OPENAI_MODEL = env.OPENAI_MODEL || "gpt-4o-mini";

    // -------- Client tuning (query) --------
    const url = new URL(request.url);
    const topN = parseInt(url.searchParams.get("topN") || "10", 10);
    const lang = (url.searchParams.get("lang") || "vi").toLowerCase(); // vi default

    // -------- One combined prompt (GUIDANCE + USER_TASK collapsed) --------
    const DEFAULT_COMBINED_PROMPT = `
Bạn là chuyên gia trader kiêm risk-manager, tư vấn những lệnh tôi đang có. Hãy:
1) Đọc lệnh Futures bên dưới, tìm ra top 10 lệnh tốt nhất dựa tao kiến thức bạn có.
2) Chuẩn hoá số, parse thời gian Asia/Ho_Chi_Minh. Ưu tiên lệnh mở 6–12h gần nhất.
4) Phân loại kèo: 🔥 Ưu tiên | 🛡️ An toàn | ⚠️ Rủi ro | 📈 Đang trend.
5) Tư vấn tối ưu hoá lợi nhuận & quản trị rủi ro cho từng lệnh
7) Thêm cảnh báo ⚠️ nếu có
8) Ngôn ngữ: ${lang === "vi" ? "Tiếng Việt" : "User language"}; xuất bảng: [Nhóm] | Symbol | Bias | Market | Entry | Lev | Term | Risk | TP | SL | R:R | Reason.
9) Cho kết quả format các lệnh dạng table Markdown có icon, ngắn gọn, dễ đọc. Dữ liệu rõ ràng.

Lệnh Futures cần phân tích:
${csv || "<NO_CSV_PROVIDED>"}”
`.trim();

    // Allow custom prompt override (if provided in body)
    const COMBINED_PROMPT = customPrompt || DEFAULT_COMBINED_PROMPT;

    // -------- Call OpenAI Chat Completions --------
    const body = {
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [{ role: "user", content: COMBINED_PROMPT }],
    };

    const aiResp = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      return jsonRes(aiResp.status, { success: false, error: `OpenAI error: ${errText}` });
    }

    const data = await aiResp.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || "";

    return jsonRes(200, {
      success: true,
      model: OPENAI_MODEL,
      resultMarkdown: content, // ready to render
      csvProvided: Boolean(csv),
    });
  } catch (e) {
    return jsonRes(500, { success: false, error: String(e?.message || e) });
  }
};

// --- helpers ---
function corsHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, X-API-Key",
  };
}

function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: corsHeaders() });
}

// Preflight for CORS
export const onRequestOptions = async () => {
  return new Response(null, { status: 204, headers: corsHeaders() });
};
