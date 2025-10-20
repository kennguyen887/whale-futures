// /functions/AI/recommend.js
// Route: POST /api/AI/recommend
// Env required: OPENAI_API_KEY
// Optional: OPENAI_BASE (default https://api.openai.com), OPENAI_MODEL (default gpt-4o-mini), OPENAI_PROXY_URL
// Security: INTERNAL_API_KEY via header x-api-key

export const onRequestPost = async (context) => {
  const { request, env } = context;
  try {
    // -------- Security: shared key for internal APIs --------
    const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
    if (REQUIRED_KEY) {
      const clientKey = request.headers.get("x-api-key") || "";
      if (clientKey !== REQUIRED_KEY) {
        return jsonRes(401, { success: false, error: "Unauthorized: invalid x-api-key." });
      }
    }

    // -------- Parse body (CSV optional; custom prompt optional) --------
    const ct = (request.headers.get("content-type") || "").toLowerCase();

    let csv = "";
    let customPrompt = "";
    if (ct.includes("application/json")) {
      const j = await request.json();
      // robust: stringify object CSV safely if user accidentally sends object
      const rawCsv = j?.csv;
      if (typeof rawCsv === "string") csv = rawCsv.trim();
      else if (rawCsv && typeof rawCsv === "object") csv = JSON.stringify(rawCsv);
      customPrompt = (j?.prompt || "").toString().trim();
    } else {
      csv = (await request.text()).trim();
    }

    // hard limit input sizes to control token & cost
    if (csv.length > 300_000) {
      csv = csv.slice(0, 300_000) + "\n...<TRUNCATED>";
    }
    if (customPrompt.length > 20_000) {
      customPrompt = customPrompt.slice(0, 20_000) + "\n...<TRUNCATED>";
    }

    // -------- OpenAI config & region handling --------
    const OPENAI_API_KEY = env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return jsonRes(500, { success: false, error: "Server misconfig: OPENAI_API_KEY not set." });
    }
    const OPENAI_BASE = (env.OPENAI_BASE || "https://api.openai.com").replace(/\/+$/, "");
    const OPENAI_MODEL = env.OPENAI_MODEL || "gpt-4o-mini";
    const OPENAI_PROXY_URL = env.OPENAI_PROXY_URL || ""; // e.g., your US/EU proxy endpoint

    // detect CF edge country
    const country = request?.cf?.country || "XX";

    // if in unsupported region and no proxy configured, fail fast with guidance
    const possiblyBlocked = ["VN"]; // bạn có thể mở rộng list này nếu cần
    const mustProxy = possiblyBlocked.includes(country) && !OPENAI_PROXY_URL;

    // -------- Query params --------
    const url = new URL(request.url);
    const topN = parseInt(url.searchParams.get("topN") || "10", 10);
    const lang = (url.searchParams.get("lang") || "vi").toLowerCase();

    // -------- Prompts (system + user) --------
    const SYSTEM_PROMPT = `
Bạn là AI phân tích copy-trading. Trả về JSON với các khóa:
- "table": mảng các dòng, mỗi dòng: { rank, traderUid, symbol, side, levMode, entry, market, deltaPct, openedAgo, notional, copyScore, ratingText, safetyStars, slTpNote }
- "alerts": mảng chuỗi alert
- "marketView": chuỗi tóm tắt
- "recommendation": chuỗi kết luận
Yêu cầu: ngắn gọn, chính xác, không bịa số khi thiếu dữ liệu.
`.trim();

    const DEFAULT_COMBINED_PROMPT = `
Bạn là chuyên gia copy-trading AI chuyên đánh giá & giám sát các lệnh futures.

Mục tiêu:
- Phân tích danh sách lệnh (CSV/JSON).
- Chấm điểm **CopyScore (0–100)** cho từng lệnh dựa trên độ an toàn, mức độ hoạt động, và tiềm năng.
- Phát hiện **tín hiệu cảnh báo (Alert)** nếu trader có hành vi bất thường hoặc cơ hội mới xuất hiện.

---

### ⚙️ Cách tính CopyScore
Tổng = 100 − (Rủi ro × Hệ số) + (Tiềm năng + Uy tín + Quản trị)

| Thành phần | Điều kiện | Điểm tối đa |
|-------------|------------|--------------|
| ⏰ Thời gian mở lệnh | ≤ 2 giờ (+20), 2–4 giờ (+10), > 4 giờ (0) | 20 |
| 📉 Δ Entry–Market | ≤ 0.3 %(+15), 0.3–1 %(+7), > 1 %(0) | 15 |
| ⚙️ Leverage / Mode | Isolated 10–35x (+20), Cross ≤ 25x (+10), ≥ 100x (–15) | 20 |
| 💰 Notional size | > 50 k (+15), 5–50 k (+8), < 5 k (0) | 15 |
| 🔁 Quản trị vị thế | ≥ 2 lệnh cùng symbol trong 3 giờ (+10) | 10 |
| 💎 Loại coin | BTC/ETH/SOL/BNB (+10), Midcap (+5), Meme (0) | 10 |
| 👥 Follower | > 100 (+10), 10–100 (+5), < 10 (0) | 10 |

Phân loại:
- ≥ 85: “🔥 Kèo VIP – có thể copy ngay”
- 70–84: “🟢 Tốt – vào vừa phải”
- 55–69: “⚠️ Theo dõi thêm”
- < 55: “❌ Bỏ qua”

### 🧩 Auto-Alert Logic
(giữ nguyên như bạn mô tả)

### 📊 Đầu ra
Hãy tạo JSON đúng schema đã mô tả trong system prompt.
Dữ liệu nguồn (CSV/JSON, có thể trống):
${csv || "<NO_CSV_PROVIDED>"}
`.trim(); // <— sửa smart quote thành dấu " thường

    const USER_PROMPT = (customPrompt ? `${DEFAULT_COMBINED_PROMPT}\n\n===\nYêu cầu bổ sung:\n${customPrompt}` : DEFAULT_COMBINED_PROMPT);

    // -------- Build request to OpenAI (or proxy) --------
    const payload = {
      model: OPENAI_MODEL,
      temperature: 0.2,
      // buộc JSON output để dễ consume
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: USER_PROMPT },
      ],
    };

    // Timeout + simple retry for transient errors
    const maxAttempts = 2;
    let lastErrText = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 25_000);

      try {
        // chọn endpoint: nếu đang ở vùng có thể bị chặn và có proxy → gọi proxy
        const endpoint = (possiblyBlocked.includes(country) && OPENAI_PROXY_URL)
          ? OPENAI_PROXY_URL.replace(/\/+$/, "") + "/v1/chat/completions"
          : `${OPENAI_BASE}/v1/chat/completions`;

        const aiResp = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(t);

        // nếu bị chặn vùng và không dùng proxy, trả message rõ ràng
        // bên trong loop call OpenAI:
        if (aiResp.status === 403) {
          const text = await aiResp.text();
          if (text.includes("unsupported_country_region_territory")) {
            return jsonRes(403, {
              success: false,
              country,
              error: "OpenAI chặn vùng của server (unsupported_country_region_territory). Hãy cấu hình OPENAI_PROXY_URL trỏ đến server ở US/EU rồi thử lại.",
              detail: {
                message: "Region not supported by OpenAI",
                country,
                endpoint: OPENAI_BASE,
              },
            });
          }
        }

        if (!aiResp.ok) {
          // retry nhẹ cho 429/5xx
          if (aiResp.status === 429 || (aiResp.status >= 500 && aiResp.status <= 599)) {
            lastErrText = await aiResp.text();
            await sleep(300 * attempt);
            continue;
          }
          const errText = await aiResp.text();
          return jsonRes(aiResp.status, { success: false, error: `OpenAI error: ${errText}` });
        }

        const data = await aiResp.json();
        const content = data?.choices?.[0]?.message?.content?.trim() || "";

        // cố parse JSON; fallback về markdown nếu model “phá format”
        let parsed = null;
        try { parsed = JSON.parse(content); } catch { }

        return jsonRes(200, {
          success: true,
          model: OPENAI_MODEL,
          country,
          csvProvided: Boolean(csv),
          resultJSON: parsed || null,
          resultMarkdown: parsed ? null : content,
        });
      } catch (err) {
        clearTimeout(t);
        // AbortError → retry 1 lần
        if (attempt < maxAttempts) {
          await sleep(300 * attempt);
          continue;
        }
        return jsonRes(502, {
          success: false,
          country,
          error: `Upstream timeout/error: ${String(err?.message || err || lastErrText)}`
        });
      }
    }

    // theoretically unreachable
    return jsonRes(500, { success: false, error: "Unknown error" });
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
    // cho chắc ăn: cả hai biến thể header name
    "access-control-allow-headers": "Content-Type, Authorization, X-API-Key, x-api-key",
  };
}

function jsonRes(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: corsHeaders() });
}

export const onRequestOptions = async () => {
  return new Response(null, { status: 204, headers: corsHeaders() });
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
