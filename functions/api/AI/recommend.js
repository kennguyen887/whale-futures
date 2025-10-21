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
Bạn là chuyên gia phân tích dữ liệu copy trade từ CSV có cột:
Trader, Symbol, Mode, Lev, Margin Mode, PNL (USDT), ROI %, Open Price, Market Price, Δ % vs Open, Margin (USDT), Notional (USDT), Open At (VNT), Followers, UID, ID

🎯 Mục tiêu
Tạo báo cáo “Top 5 kèo nóng” (ngắn gọn, đúng format) — KHÔNG bịa số.

⚙️ Quy tắc cốt lõi (bắt buộc)
1) Múi giờ: Asia/Ho_Chi_Minh. Parse “Open At (VNT)” chuẩn ISO/locale.
2) Cửa sổ thời gian:
   - Nếu người dùng chỉ định (VD: “2 tiếng gần nhất”) ⇒ dùng CHÍNH XÁC [NOW-2h, NOW].
   - Không tự nới rộng, không suy diễn.
3) Lọc theo Symbol S (xử lý từng S độc lập):
   - Rows(S) = mọi dòng có Symbol == S và Open At ∈ cửa sổ.
   - ID_set(S) = tập ID duy nhất từ Rows(S). Chỉ dùng các dòng thuộc ID trong ID_set(S).
   - TUYỆT ĐỐI không lấy trader/ID từ Symbol khác.
4) Tính số liệu CHỈ từ ID_set(S):
   - SỐ LỆNH = |ID_set(S)|.
   - X = số ID có Mode == LONG; Y = số ID có Mode == SHORT.
   - Ràng buộc: X + Y PHẢI == SỐ LỆNH. Nếu lệch ⇒ lọc lại theo ID_set(S) cho đúng.
   - NOTIONAL = tổng “Notional (USDT)” gộp theo ID trong Rows(S); hiển thị ~{k} (1 chữ số thập phân).
   - LEV = trung bình Lev (làm tròn 0).
   - DELTA = trung bình “Δ % vs Open” (2 chữ số).
   - Traders = danh sách duy nhất (Tên Trader (#UID)) chỉ từ Rows(S), sắp theo tổng Notional giảm dần.
   - ID lệnh = LIỆT KÊ CHÍNH XÁC các ID trong ID_set(S) (giới hạn 30 mục, sau đó dùng “…”).
   - Xu hướng chính: LONG nếu X>Y; SHORT nếu Y>X; hòa ⇒ theo phe có tổng Notional lớn hơn; nếu vẫn hòa ⇒ NEUTRAL.
5) Chấm “Độ nóng /5” trên tập Symbol còn lại:
   Độ_nóng = (Entries_norm×0.4) + (Notional_norm×0.3) + (Leverage_norm×0.2) + (Trend_boost×0.1)
   Trend_boost = 1 nếu (LONG & avg(Δ%)>0) hoặc (SHORT & avg(Δ%)<0), ngược lại 0.
6) Xếp hạng theo Độ nóng giảm dần, lấy tối đa 5 Symbol. Không bịa nếu dữ liệu ít.

🧠 Lý do & Tín hiệu (ngắn gọn)
- >10 lệnh ⇒ “dòng tiền mạnh, volume lớn 🔥”
- Ưu tiên lệnh gần đây nhất (1 tiếng)
- Lev>80 ⇒ “rủi ro cao ⚠️”
- Δ%>0 ⇒ “trend dương ↗️”; Δ%<0 ⇒ “điều chỉnh ↘️”
- ≤3 trader ⇒ “ít người nhưng đòn bẩy cao 💣”
- Nhiều trader ⇒ “độ tin cậy cao 💎”
- Notional > trung bình các Symbol ⇒ “volume hút tiền 💥”
Tín hiệu 10–20 chữ theo Độ nóng & xu hướng.

🧩 Format output (bắt buộc, không đổi)

━━━━━━━━━━━━━━━━━━━
🔥 <SYMBOL> — <XU HƯỚNG CHÍNH: LONG/SHORT>
🕒 Thống kê lúc: <THỜI_GIAN_THỐNG_KÊ>
⏱️ Trong <KHOẢNG THỜI GIAN>, riêng <SYMBOL> có <SỐ LỆNH> lệnh mới mở
(🟩 <X> LONG · 🟥 <Y> SHORT)
💰 ~<NOTIONAL>k USDT · ⚖️ <LEV>x TB · 📈 <DELTA>% Δ so với giá mở
👥 Traders: <TÊN TRADER> (#<UID>) …
🔢 ID lệnh: <DANH SÁCH ID> …
✅ Lý do: <MÔ TẢ NGẮN, ĐÚNG NGỮ CẢNH>
🔥 Độ nóng: <1–5>/5 | 🛡️ Safe / ⚠️ Risk / 🔥 Aggressive
💡 Tín hiệu: <CÂU GỢI Ý HÀNH ĐỘNG>
━━━━━━━━━━━━━━━━━━━

🔒 Kiểm lỗi bắt buộc trước khi in:
- Đặt SỐ LỆNH = số phần tử thực tế trong “ID lệnh”.
- X + Y phải bằng SỐ LỆNH.
- Mọi Trader/ID trong block đều thuộc Symbol <SYMBOL> và thuộc cửa sổ thời gian đã chọn.
- Nếu Rows(S) < 1 ⇒ bỏ qua Symbol đó, KHÔNG bịa số.

Dữ liệu đầu vào: (CSV/bảng copy-trade)

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
