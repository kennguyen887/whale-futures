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
Bạn là chuyên gia trader kiêm risk manager. Hãy:
1) Nhận dữ liệu CSV lệnh copy-trade nếu có (cột: Trader, Symbol, Mode, Lev, Margin Mode, PNL (USDT), ROI %, Open Price, Market Price, Δ % vs Open, Amount, Margin (USDT), Notional (USDT), Open At (VNT), Margin %, Followers, UID). Nếu KHÔNG có CSV: vẫn tạo **khung phân tích mẫu** và checklist cách cung cấp CSV hợp lệ.
2) Chuẩn hóa số (bỏ dấu phẩy, chuyển %), parse thời gian Asia/Ho_Chi_Minh. Ưu tiên lệnh mở 6–12h gần nhất.
3) Tính điểm cho mỗi lệnh:
   - Momentum: Market vs Open (đẹp nhất ~ +1%).
   - PNL & ROI dương.
   - Notional lớn (ưu tiên >10k USDT).
   - Followers cao.
   - Phạt điểm nếu Lev>80x.
4) Gom theo Symbol, lấy lệnh điểm cao nhất làm đại diện. Suy Bias:
   - Market ≥ Open + PNL/ROI dương → nghiêng LONG.
   - Market < Open + PNL âm → cân nhắc SHORT (scalp).
5) Kiểm tra xung đột leader (cùng Symbol có người LONG và có người SHORT). Nếu có → thêm cảnh báo: ⚠️ **Xung đột hướng**: <SYMBOL> (nêu trader/UID tiêu biểu), gợi ý vùng giá (retest/pullback) hoặc tránh nếu R:R kém.
6) Đề xuất ${Number.isFinite(topN) ? topN : 10} kèo tốt nhất, có icon & nhóm:
   - 🔥 **Ưu tiên cần chú ý**: điểm cao nhất, động lượng đẹp, thanh khoản tốt.
   - 🛡️ **An toàn**: majors, biến động vừa, R:R ≥ 1.5.
   - ⚠️ **Rủi ro**: meme/vi mô, lev cao, Δ% lớn hoặc xung đột hướng.
   - 📈 **Đang trend**: break/continuation rõ, SL chặt.
7) Cho mỗi kèo: Icon + Symbol + Bias (LONG/SHORT) + Entry Zone (LONG: -0.3–0.7% dưới hiện tại; SHORT: +0.3–0.7% trên hiện tại) + Lev khuyến nghị:
   * Majors (BTC, ETH, BNB, SOL, XRP, LINK, DOT, ADA): 5–10x
   * Meme/vi mô (WIF, PEPE, DOGE, PENGU, MEW, FART, USELESS…): 2–5x
   * Alts trend (SUI, MYX, LINEA, WLD, ANKR…): 3–6x
   Term (|Δ%|<0.6%=Scalp; 0.6–2%=Swing; >2%=Breakout) + Risk (Cao nếu Lev≥100 hoặc |Δ%|≥5; Trung bình nếu Lev≥50 hoặc |Δ%|≥2; Thấp nếu dưới ngưỡng) + TP/SL theo lớp tài sản:
   * Majors: TP +1%, SL −1%
   * Meme/vi mô: TP +3%, SL −1.5%
   * Alts trend: TP +2%, SL −1.2%
   Tính R:R, ghi Reason (ROI/PNL dương, giá >/< open, khối lượng, v.v.)
8) Xuất **bảng gọn có icon**: [Nhóm] | Symbol | Bias | Market | Entry | Lev | Term | Risk | TP | SL | R:R | Reason.
9) Quản trị rủi ro: Không >10x (majors), >6x (alts trend), >5x (meme/vi mô). Không mở >3 kèo cùng lớp tài sản. Risk mỗi kèo ≤1% tài khoản, tổng vị thế mở ≤5%.
10) Ngôn ngữ: ${lang === "vi" ? "tiếng Việt" : "ngôn ngữ người dùng yêu cầu"}, ngắn gọn, số liệu rõ.

CSV (có thể để trống nếu không cung cấp):
${csv || "<NO_CSV_PROVIDED>"}

Nếu CSV trống:
- Hiển thị 1 bảng **mẫu** với 2–3 hàng minh hoạ (giá trị giả định hợp lý) để người dùng thấy đúng định dạng đầu ra.
- Thêm checklist ngắn: “Cần cung cấp CSV với các cột bắt buộc…”
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
