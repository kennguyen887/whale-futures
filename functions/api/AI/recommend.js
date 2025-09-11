// /functions/AI/recommend.js
// Route: POST /api/AI/recommend
// Requires env: OPENAI_API_KEY
// Optional env: OPENAI_BASE (default https://api.openai.com), OPENAI_MODEL (default gpt-4o-mini)

export const onRequestPost = async (context) => {
  try {
    const { request, env } = context;

    // -------- Read CSV from body (JSON {csv} or raw text/csv) --------
    const ct = request.headers.get("content-type") || "";
    let csv = "";
    if (ct.includes("application/json")) {
      const j = await request.json();
      csv = (j?.csv || "").trim();
    } else {
      csv = (await request.text()).trim(); // accept text/csv or raw
    }

    if (!csv) {
      return jsonRes(
        400,
        { success: false, error: "Missing CSV content in body. Send {\"csv\": \"...\"} or text/csv." }
      );
    }

    // -------- OpenAI config --------
    const OPENAI_API_KEY = env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return jsonRes(500, { success: false, error: "Server misconfig: OPENAI_API_KEY not set." });
    }
    const OPENAI_BASE = (env.OPENAI_BASE || "https://api.openai.com").replace(/\/+$/, "");
    const OPENAI_MODEL = env.OPENAI_MODEL || "gpt-4o-mini";

    // Optional client tuning from query/body
    const url = new URL(request.url);
    const topN = parseInt(url.searchParams.get("topN") || "10", 10);
    const lang = (url.searchParams.get("lang") || "vi").toLowerCase(); // "vi" default

    // -------- System + User prompt (Vietnamese) --------
    const GUIDANCE = `
Bạn là chuyên gia trader kiêm risk manager. Nhiệm vụ:
1) Nhận CSV lệnh copy-trade (cột: Trader, Symbol, Mode, Lev, Margin Mode, PNL (USDT), ROI %, Open Price, Market Price, Δ % vs Open, Amount, Margin (USDT), Notional (USDT), Open At (VNT), Margin %, Followers, UID).
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
5) PHẢI kiểm tra xung đột leader (cùng Symbol có người đang LONG và có người SHORT). 
   - Nếu có → thêm cảnh báo: ⚠️ **Xung đột hướng**: <SYMBOL> (nêu trader/UID tiêu biểu), gợi ý chơi theo vùng giá xác suất cao (retest/pullback) hoặc tránh nếu R:R kém.
6) Đề xuất 5–10 kèo tốt nhất, có icon & nhóm:
   - 🔥 **Ưu tiên cần chú ý**: điểm cao nhất, động lượng đẹp, thanh khoản tốt.
   - 🛡️ **An toàn**: majors, biến động vừa, R:R ≥ 1.5.
   - ⚠️ **Rủi ro**: meme/vi mô, lev cao, Δ% lớn hoặc xung đột hướng.
   - 📈 **Đang trend**: break/continuation rõ, nhưng SL bắt buộc chặt.
7) Cho mỗi kèo: 
   - Icon + Symbol + Bias (LONG/SHORT) 
   - Entry Zone (LONG: pullback 0.3–0.7% dưới giá hiện tại; SHORT: retest 0.3–0.7% trên giá hiện tại)
   - Lev khuyến nghị:
       * Majors (BTC, ETH, BNB, SOL, XRP, LINK, DOT, ADA): 5–10x
       * Meme/vi mô (WIF, PEPE, DOGE, PENGU, MEW, FART, USELESS…): 2–5x
       * Alts trend (SUI, MYX, LINEA, WLD, ANKR…): 3–6x
   - Term (|Δ%|<0.6% = Ngắn hạn/Scalp; 0.6–2% = Trung hạn/Swing; >2% = Rất ngắn/Breakout)
   - Risk (Cao nếu Lev≥100 hoặc |Δ%|≥5; Trung bình nếu Lev≥50 hoặc |Δ%|≥2; Thấp nếu dưới ngưỡng)
   - TP/SL theo lớp tài sản:
       * Majors: TP +1%, SL −1%
       * Meme/vi mô: TP +3%, SL −1.5%
       * Alts trend: TP +2%, SL −1.2%
   - Tính R:R, ghi Reason (ROI/PNL dương, giá >/< open, khối lượng lớn, v.v.)
8) Xuất bảng gọn có icon: [Nhóm] | Symbol | Bias | Market | Entry | Lev | Term | Risk | TP | SL | R:R | Reason.
9) Quản trị rủi ro: 
   - Không >10x (majors), >6x (alts trend), >5x (meme/vi mô).
   - Không mở >3 kèo cùng lớp tài sản.
   - Risk mỗi kèo ≤1% tài khoản, tổng vị thế mở ≤5%.
10) Ngôn ngữ: tiếng Việt, ngắn gọn, số liệu rõ.
    `.trim();

    const USER_TASK = `
Dưới đây là CSV lệnh copy-trade. Hãy thực hiện đúng 10 yêu cầu trên.
- Trả lời bằng tiếng Việt, ngắn gọn, có bảng gọn mục (8).
- Ưu tiên 5–10 kèo tốt nhất (tham số topN hiện tại: ${Number.isFinite(topN) ? topN : 10}).
- Nếu có xung đột hướng theo (5), thêm cảnh báo phía trên bảng.
- Khi chưa đủ dữ liệu một số cột, nêu rõ giả định.

CSV:
${csv}
    `.trim();

    // -------- Call OpenAI Chat Completions --------
    const body = {
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: GUIDANCE },
        { role: "user", content: USER_TASK },
      ],
    };

    const aiResp = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
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
    });
  } catch (e) {
    return jsonRes(500, { success: false, error: String(e?.message || e) });
  }
};

// --- helpers ---
function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
