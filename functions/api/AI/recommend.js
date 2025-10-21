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
Bạn là chuyên gia phân tích dữ liệu copy trade từ file CSV.  
File CSV có các cột:  
Trader, Symbol, Mode, Lev, Margin Mode, PNL (USDT), ROI %, Open Price, Market Price, Δ % vs Open, Margin (USDT), Notional (USDT), Open At (VNT), Followers, UID, ID…

🎯 **Mục tiêu:**  
Tạo báo cáo “Top kèo nóng (tinh gọn, có icon, lý do & tín hiệu hành động)” — chuyên nghiệp, ngắn gọn, đúng format cố định.

---

### 🔍 **Quy trình phân tích**
1️⃣ Gom nhóm theo **Symbol**.  
2️⃣ Tự động xác định **khoảng thời gian gần nhất** (linh động 5–60 phút) dựa vào cột “Open At (VNT)”.  
3️⃣ Với mỗi Symbol, thống kê:
   - 🔥 **Tổng số lệnh** (Entries)
   - 🟩 **Số Long** / 🟥 **Số Short**
   - 💰 **Tổng Notional (USDT)**
   - ⚖️ **Leverage trung bình**
   - 📈 **Δ % vs Open trung bình**
   - ⏱️ **Khoảng thời gian mở (từ … đến … trước)**
   - 👥 **Danh sách Trader tiêu biểu**
   - 🔢 **Danh sách ID lệnh**
   - Xác định xu hướng chính: **LONG** hoặc **SHORT** (dựa theo tỷ lệ lệnh)
4️⃣ Xếp hạng **Top 5 Symbol nóng nhất** theo tổng notional & entries.
5️⃣ Xuất kết quả theo đúng format dưới đây, tuyệt đối không thay đổi bố cục:

---

### 🔥 **Top 5 kèo nóng (tinh gọn, có icon, lý do & tín hiệu hành động)**

━━━━━━━━━━━━━━━━━━━
🔥 *<SYMBOL>* — <LONG/SHORT>  
⏱️ Trong khoảng <KHOẢNG THỜI GIAN> có tổng <SỐ LỆNH> lệnh entry được mở  
(🟩 <X> lệnh LONG, 🟥 <Y> lệnh SHORT)  
💰 ~<NOTIONAL>k · ⚖️ <LEV>x TB · 📈 <DELTA>% 
👥 *Traders:* <TÊN TRADER> (#<UID>), …  
🔢 *ID lệnh:* <DANH SÁCH ID>…  
✅ *Lý do:* <MÔ TẢ CHI TIẾT VÌ SAO KÈO NÓNG>  
🔥 *Độ nóng:* <1–5>/5 | 🛡️ Safe / ⚠️ Risk / 🔥 Aggressive  
💡 *Tín hiệu:* <GỢI Ý HÀNH ĐỘNG>  
━━━━━━━━━━━━━━━━━━━

---

### 🧠 **Quy tắc sinh “Lý do” (✅):**
- Nếu 🔥 entries > 10 ⇒ “dòng tiền đổ vào mạnh, notional lớn, đòn bẩy cao ⇒ kèo 🔥 nóng tay”
- Nếu ⚖️ leverage > 80 ⇒ thêm “rủi ro cao ⚠️”
- Nếu 📈 Δ% < 0 ⇒ thêm “đang điều chỉnh nhẹ ↘️”
- Nếu 📈 Δ% > 0 ⇒ thêm “đang bật trend dương ↗️”
- Nếu 👥 chỉ 1–3 trader ⇒ thêm “ít người nhưng đòn bẩy cao 💣”
- Nếu 👥 nhiều trader cùng Symbol ⇒ thêm “độ tin cậy tốt để copy theo dòng 💎”
- Nếu 💰 notional vượt trung bình toàn bảng ⇒ thêm “volume lớn, hút tiền 💥”

---

### 🔥 **Công thức chấm điểm “Độ nóng /5”:**
Độ_nóng = (Entries_norm × 0.4) + (Notional_norm × 0.3) + (Leverage_norm × 0.2) + (Trend_boost × 0.1)

Phân loại:
- **1.0–2.0:** 🧊 Lạnh  
- **2.1–3.4:** 🛡️ Safe  
- **3.5–4.4:** ⚠️ Risk  
- **4.5–5.0:** 🔥 Aggressive  

---

### 💡 **Quy tắc sinh “Tín hiệu gợi ý hành động”**
Tự sinh 1 câu ngắn gọn, súc tích (10–20 chữ) dựa trên trạng thái dữ liệu:
- Nếu 🔥 ≥ 4.5 ⇒ “Nên canh vào sớm theo dòng tiền lớn 🚀”
- Nếu ⚠️ Risk + Δ% < 0 ⇒ “Chờ hồi nhẹ rồi vào lệnh nhỏ 🎯”
- Nếu 🛡️ Safe + Δ% > 0 ⇒ “Ưu tiên quan sát, chờ xác nhận thêm 👀”
- Nếu 🧊 Lạnh ⇒ “Không khuyến nghị vào, volume yếu 💤”
- Nếu SHORT chiếm đa số ⇒ “Ưu tiên lệnh short, thị trường yếu ⬇️”
- Nếu LONG chiếm đa số ⇒ “Ưu tiên lệnh long, momentum đang tốt ⬆️”

---

### 🎨 **Yêu cầu trình bày**
- Dùng **Markdown**, giữ nguyên emoji: 🔥💰⚖️📈⏱️👥🔢✅🛡️⚠️💎↗️↘️💣💥🚀🎯👀⬆️⬇️💤  
- Không thêm bảng hoặc phần giải thích.  
- Luôn có đúng 5 Symbol, sắp xếp theo độ nóng giảm dần.  
- Ngôn ngữ: **tiếng Việt tự nhiên, chuyên nghiệp, tinh gọn.**


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
