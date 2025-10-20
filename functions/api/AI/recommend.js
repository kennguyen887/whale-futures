// /functions/AI/recommend.js
// POST /api/AI/recommend
// Env: OPENAI_API_KEY (required), OPENAI_BASE, OPENAI_MODEL, OPENAI_PROXY_URL (optional)
// Shared security: INTERNAL_API_KEY (optional, header x-api-key)

export const onRequestPost = async (context) => {
  const { request, env } = context;
  try {
    // --- check auth ---
    const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
    if (REQUIRED_KEY) {
      const clientKey = request.headers.get("x-api-key") || "";
      if (clientKey !== REQUIRED_KEY) {
        return jsonRes(401, { success: false, error: "Unauthorized: invalid x-api-key." });
      }
    }

    // --- parse body ---
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    let csv = "";
    let customPrompt = "";
    if (ct.includes("application/json")) {
      const j = await request.json();
      csv = typeof j.csv === "string" ? j.csv.trim() : JSON.stringify(j.csv || "");
      customPrompt = (j.prompt || "").toString().trim();
    } else {
      csv = (await request.text()).trim();
    }

    // --- config ---
    const OPENAI_API_KEY = env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return jsonRes(500, { success: false, error: "OPENAI_API_KEY not set." });
    }
    const OPENAI_BASE = (env.OPENAI_BASE || "https://api.openai.com").replace(/\/+$/, "");
    const OPENAI_MODEL = env.OPENAI_MODEL || "gpt-4o-mini";
    const OPENAI_PROXY_URL = env.OPENAI_PROXY_URL || "";
    const country = request?.cf?.country || "XX";
    const blockedRegions = ["VN"];

    // --- prompt ---
    const BASE_PROMPT = `
Phân tích file CSV gồm các lệnh copy trade (trường như: Trader, Symbol, Lev, Margin Mode, PNL, ROI %, Open Price, Market Price, Δ % vs Open, Margin (USDT), Notional (USDT), Open At (VNT), Followers, UID).

Mục tiêu: Tạo report “Top kèo nóng (tinh gọn, có icon & lý do)” theo đúng format sau:

Top kèo nóng (tinh gọn, có icon & lý do):

SOLUSDT — 🔥 35 lệnh/10m · 💰 ~8,322.3k notional · ⚖️ 92x TB · ↔️ -0.22% · ⏱️ từ 5 giây đến 4 tiếng 30 phút trước 
👥 Traders: Masters at Coin (#61698494), Mexctrader-9NLMP3 (#30339263), 27*****2 (#27337672)… 
↗️ ID lệnh: 18313020, 67429135, 82874560… 
✅ Lý do: dòng tiền đổ vào rất mạnh (pile-in), notional lớn, đòn bẩy cao ⇒ kèo “nóng tay”.

BTCUSDT — 🔥 12 lệnh/10m · 💰 ~2,486.5k notional · ⚖️ 61x TB · ↔️ +0.13% · ⏱️ từ 2phút đến 3 tiếng 30 phút trước 
👥 Traders: 82*****0 (#82874560), Mexctrader-LeA89w (#18313020), WAVE SURFER (#67429135)…  
↗️ ID lệnh: 18313020, 67429135, 82874560… 
✅ Lý do: nhiều lệnh đồng thời + notional cao ⇒ độ tin cậy tốt để copy theo dòng.

---

**Yêu cầu cụ thể:**
- Chỉ tính lệnh mở trong **10 phút gần nhất** (theo “Open At (VNT)”).
- Gom nhóm theo **Symbol**.
- Tính:
  - 🔥 số lượng lệnh (entries)
  - 💰 tổng notional (Σ Notional)
  - ⚖️ trung bình leverage (Avg Lev)
  - ↔️ trung bình Δ % vs Open
  - ⏱️ thời gian lệnh mới nhất
  - tính xem có bao nhiêu VIP traders (followers > 1000 và có ⭐).
- Ghi rõ **Top traders** (3–5 người đầu, có UID).
- Thêm **Lý do ngắn gọn, tự động** dựa trên dữ liệu:
  - Nếu entries > 5 ⇒ “dòng tiền đổ vào mạnh”
  - Nếu leverage > 80 ⇒ “đòn bẩy cao, rủi ro ↗️”
  - Nếu Δ % < 0 ⇒ “đang điều chỉnh nhẹ”
  - Nếu Δ % > 0 ⇒ “đang bật trend dương”
  - Nếu notional > trung bình toàn bảng ⇒ “volume lớn, đáng chú ý”
- Giữ format Markdown, có emoji và icon rõ ràng.
- Sắp xếp theo độ nóng giảm dần (entries và notional).

Dữ liệu đầu vào:
${csv || "<NO_CSV_PROVIDED>"}
`.trim();

    const prompt = customPrompt ? `${BASE_PROMPT}\n\nYêu cầu bổ sung:\n${customPrompt}` : BASE_PROMPT;

    // --- request to OpenAI (proxy if needed) ---
    const endpoint =
      blockedRegions.includes(country) && OPENAI_PROXY_URL
        ? `${OPENAI_PROXY_URL.replace(/\/+$/, "")}/v1/chat/completions`
        : `${OPENAI_BASE}/v1/chat/completions`;

    const body = {
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    };

    const aiResp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const raw = await aiResp.text();

    // --- handle region errors ---
    if (aiResp.status === 403 && raw.includes("unsupported_country_region_territory")) {
      return jsonRes(403, {
        success: false,
        country,
        error:
          "OpenAI chặn vùng (unsupported_country_region_territory). Hãy cấu hình OPENAI_PROXY_URL trỏ đến proxy (US/EU).",
      });
    }

    if (!aiResp.ok) {
      return jsonRes(aiResp.status, {
        success: false,
        country,
        error: `OpenAI error: ${raw}`,
      });
    }

    const data = JSON.parse(raw);
    const content = data?.choices?.[0]?.message?.content?.trim() || "";

    return jsonRes(200, {
      success: true,
      country,
      model: OPENAI_MODEL,
      resultMarkdown: content,
      csvProvided: Boolean(csv),
    });
  } catch (err) {
    return jsonRes(500, { success: false, error: String(err?.message || err) });
  }
};

// --- helpers ---
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
