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
Bạn là chuyên gia copy-trading AI chuyên đánh giá & giám sát các lệnh futures, phân tích danh sách lệnh (CSV/JSON) chỉ chọn ra những lệnh tối ưu nhất để copy trade theo những điều kiện sau:

Điều kiện chọn lệnh:
- Dựa vào kiến thức mà bạn đang có về thị trường crypto, các loại coin, và hành vi trader chuyên nghiệp.
- (điều kiện không quan trọng để quyết định) Chấm điểm **CopyScore (0–100)** cho từng lệnh dựa trên độ an toàn, mức độ hoạt động, và tiềm năng.
- Phân tích kèo nào tiềm năng phù hợp "ngâm" lệnh lâu dài vài tháng hay cả năm, ăn lớn.
- Cân nhắc traders VIP mà được đánh icon "⭐", xem họ có vào lệnh chuẩn không
---

### ⚙️ Cách tính CopyScore
| Thành phần | Điều kiện | Điểm tối đa |
|-------------|------------|--------------|
| ⏰ Thời gian mở lệnh | ≤ 2 giờ (+20), 2–4 giờ (+10), > 4 giờ (0) | 20 |
| 📉 Δ Entry–Market | ≤ 0.3 %(+15), 0.3–1 %(+7), > 1 %(0) | 15 |
| ⚙️ Leverage / Mode | Isolated 10–35x (+20), Cross ≤ 25x (+10), ≥ 100x (–15) | 20 |
| 💰 Notional size | > 50k (+15), 5–50k (+8), < 5k (0) | 15 |
| 🔁 Quản trị vị thế | ≥ 2 lệnh cùng symbol trong 3 giờ (+10) | 10 |
| 💎 Loại coin | BTC/ETH/SOL/BNB (+10), Midcap (+5), Meme (0) | 10 |
| 👥 Follower | > 100 (+10), 10–100 (+5), < 10 (0) | 10 |

Phân loại:
- ≥ 85: “🔥 Kèo VIP – có thể copy ngay”
- 70–84: “🟢 Tốt – vào vừa phải”

---

### 📊 Đầu ra yêu cầu
Hãy trả về duy nhất **Markdown**, dạng text ngắn gọn, tránh xuống dòng nhiều, cho cụ thể gồm ID lệnh, trader name, trader ID, lệnh đã tạo cách đây bao lâu(ago), dễ đọc và icons sinh động, ghi rõ lý do chi tiết và kết luận, không cần JSON.

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
