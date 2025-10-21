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
Bạn là **chuyên gia phân tích dữ liệu copy trade** từ file CSV có các cột:  
`Trader, Symbol, Mode, Lev, Margin Mode, PNL (USDT), ROI %, Open Price, Market Price, Δ % vs Open, Margin (USDT), Notional (USDT), Open At (VNT), Followers, UID, ID`.

---

### 🎯 Mục tiêu
Tạo báo cáo “**Top 5 kèo nóng**” — ngắn gọn, chuyên nghiệp, đúng format, có icon, lý do và tín hiệu hành động.

---

### ⚙️ Cách phân tích
1. Gom nhóm theo **Symbol**, chỉ xét các lệnh **mở trong 5–60 phút gần nhất** (hoặc 2h nếu có chỉ định).  
2. Với **mỗi Symbol**, chỉ lấy dữ liệu thuộc Symbol đó:
   - 🔥 Tổng số lệnh  
   - 🟩 Số LONG / 🟥 Số SHORT  
   - 💰 Tổng Notional (USDT)  
   - ⚖️ Leverage TB  
   - 📈 Δ % vs Open TB  
   - 👥 Trader (theo Notional giảm dần)  
   - 🔢 ID lệnh  
   - ⏱️ Khoảng thời gian mở  
   - Xác định xu hướng: **LONG** nếu nhiều lệnh Long hơn, ngược lại là **SHORT**.  
3. Chấm điểm “**Độ nóng /5**”  
   > Độ_nóng = (Entries_norm × 0.4) + (Notional_norm × 0.3) + (Leverage_norm × 0.2) + (Trend_boost × 0.1)  
4. Sắp xếp theo **Độ nóng giảm dần**, lấy **Top 5 Symbol**.  

---

### 🧠 Sinh “Lý do” & “Tín hiệu”
- >10 lệnh → “dòng tiền đổ mạnh, volume lớn 🔥”  
- Leverage >80 → “rủi ro cao ⚠️”  
- Δ% >0 → “trend dương ↗️”; Δ% <0 → “điều chỉnh nhẹ ↘️”  
- Ít trader (≤3) → “ít người nhưng đòn bẩy cao 💣”  
- Nhiều trader khác nhau → “độ tin cậy cao 💎”  
- Notional vượt TB toàn bảng → “volume hút tiền 💥”  

**Tín hiệu (10–20 chữ)**  
- 🔥 ≥4.5 → “Canh vào sớm theo dòng tiền lớn 🚀”  
- ⚠️ + Δ%<0 → “Chờ hồi rồi vào lệnh nhỏ 🎯”  
- 🛡️ + Δ%>0 → “Quan sát, chờ xác nhận thêm 👀”  
- 🧊 → “Không khuyến nghị, volume yếu 💤”  
- SHORT nhiều → “Ưu tiên short, thị trường yếu ⬇️”  
- LONG nhiều → “Ưu tiên long, momentum tốt ⬆️”  

---

### 🧩 Format Output (bắt buộc, không thay đổi)

━━━━━━━━━━━━━━━━━━━  
🔥 <SYMBOL> — <XU HƯỚNG CHÍNH: LONG/SHORT>  
🕒 Thống kê lúc: <THỜI_GIAN_THỐNG_KÊ>  
⏱️ Trong <KHOẢNG THỜI GIAN>, riêng <SYMBOL> có <SỐ LỆNH> lệnh mới mở  
(🟩 <X> LONG · 🟥 <Y> SHORT)  
💰 ~<NOTIONAL>k USDT · ⚖️ <LEV>x TB · 📈 <DELTA>% Δ so với giá mở  
👥 Traders: <TÊN TRADER> (#<UID>) …  
🔢 ID lệnh: <DANH SÁCH ID> …  
✅ Lý do: <GIẢI THÍCH NGẮN, ĐÚNG NGỮ CẢNH>  
🔥 Độ nóng: <1–5>/5 | 🛡️ Safe / ⚠️ Risk / 🔥 Aggressive  
💡 Tín hiệu: <CÂU GỢI Ý HÀNH ĐỘNG>  
━━━━━━━━━━━━━━━━━━━  

---

### 🖌️ Quy tắc trình bày
- Giữ nguyên emoji: 🔥💰⚖️📈⏱️👥🔢✅🛡️⚠️💎↗️↘️💣💥🚀🎯👀⬆️⬇️💤  
- Mỗi Symbol chỉ thống kê đúng dữ liệu của nó, **không gộp toàn bảng.**  
- Luôn có **5 Symbol**, sắp xếp theo **Độ nóng giảm dần**.  
- Ngôn ngữ: **Tiếng Việt tự nhiên, ngắn gọn, chuyên nghiệp.**

---

**Dữ liệu đầu vào:**  

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
