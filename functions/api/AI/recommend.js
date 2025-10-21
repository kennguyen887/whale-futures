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
Bạn là chuyên gia phân tích Copy Trade Futures từ CSV:
Trader,Symbol,Mode,Lev,Margin Mode,PNL (USDT),ROI %,Open Price,Market Price,Δ % vs Open,Margin (USDT),Notional (USDT),Open At (VNT),Followers,UID,ID

🎯 Mục tiêu
Tạo “Top 5 Kèo Nóng trong vòng 3 hours” — ngắn gọn, đúng format, KHÔNG bịa số.

🧭 Chuẩn hoá & Ràng buộc
- Timezone: Asia/Ho_Chi_Minh. Parse “Open At (VNT)” chuẩn ISO.
- Cửa sổ: nếu user chỉ định thì dùng chính xác; nếu không ⇒ NOW-3h..NOW.
- Mapping bắt buộc (KHÔNG nhầm lẫn):
  • Tên trader = cột Trader
  • Trader ID (UID) = cột UID
  • Order ID = cột ID
- Mọi số liệu của 1 Symbol chỉ lấy từ đúng Symbol đó trong cửa sổ.

🗂 Lọc theo từng Symbol S
- Rows(S) = dòng có Symbol==S & Open At ∈ cửa sổ.
- Nếu Rows(S) < 3 ⇒ BỎ (tránh coin “1–2 lệnh”).
- ID_set(S) = tập Order ID duy nhất trong Rows(S). Chỉ dùng các dòng có ID ∈ ID_set(S).

📐 Tính toán (chỉ từ ID_set(S))
- SỐ_LỆNH = |ID_set(S)|
- X = số ID Mode==LONG; Y = số ID Mode==SHORT; yêu cầu X+Y==SỐ_LỆNH.
- 💰 MARGIN_TỔNG = Σ “Margin (USDT)” (theo ID); hiển thị ~{k} (1 số thập phân).
- ⚖️ LEV_TB = avg(Lev) (làm tròn 0).
- 📈 DELTA_TB = avg(Δ % vs Open) (2 số).
- 👥 Traders = danh sách duy nhất “Tên (#UID)”, sort theo tổng Margin giảm dần, tối đa 5.
  • Gắn ⭐ ngay SAU tên trader nếu VIP (xem dưới).
- 🔢 ID lệnh = DANH SÁCH Order ID thực tế (max 30; dư ⇒ “…").
- Xu hướng chính: LONG nếu X>Y; SHORT nếu Y>X; hoà ⇒ phe có tổng Margin lớn hơn; vẫn hoà ⇒ NEUTRAL.

⭐ Xác định Trader VIP
- VIP nếu (UID ∈ VIP_UIDS do user truyền) HOẶC Followers thuộc top 10% trong Rows(S) của chính Symbol đó.
- Ký hiệu: “TênTrader⭐ (#UID)”.

📊 Độ nóng /5 (ưu tiên coin thực sự sôi động)
- Chuẩn hoá trên các Symbol còn lại trong cửa sổ:
  entries_norm, margin_norm, lev_norm, pnl_stability_norm (0..1), trend_boost∈{0,1}.
- PNL Stability (3h): dùng độ lệch chuẩn ROI % hoặc PNL (nhóm theo ID). std thấp ⇒ ổn (điểm cao).
- trend_boost=1 nếu (xu hướng LONG & DELTA_TB>0) hoặc (SHORT & DELTA_TB<0), ngược lại 0.
- hot = 0.35*entries_norm + 0.30*margin_norm + 0.15*lev_norm + 0.15*pnl_stability_norm + 0.05*trend_boost
- Chọn top 5 theo hot giảm dần; bỏ Symbol có dữ liệu quá ít/không đạt.

🧠 Lý do & Tín hiệu
- Ưu tiên nhiều lệnh cùng hướng, gần hiện tại (≤1h).
- Lev>80 ⇒ ⚠️ rủi ro cao; Δ>0 ⇒ trend ↗️; Δ<0 ⇒ ↘️.
- ≤3 trader nhưng Margin lớn ⇒ 💣; nhiều trader + Margin lớn ⇒ 💎.
- PNL ổn trong 3h (std thấp) ⇒ “ổn định”; std cao ⇒ “biến động”.
- “Tín hiệu” 10–20 chữ, rõ ràng theo xu hướng & hot.

🧾 FORMAT OUTPUT (giữ nguyên cấu trúc, cập nhật dùng MARGIN_TỔNG)
━━━━━━━━━━━━━━━━━━━
🔥 <SYMBOL> — <LONG/SHORT>
🕒 Thống kê: <THỜI_GIAN_THỐNG_KÊ>
⏱️ Trong <KHOẢNG>, có <SỐ_LỆNH> lệnh (🟩 <X> LONG · 🟥 <Y> SHORT)
💰 ~<MARGIN_TỔNG>k USDT · ⚖️ <LEV_TB>x TB · 📈 <DELTA_TB>% Δ
👥 Traders: <TênTrader[⭐] (#UID)>, …
🔢 ID: <DANH_SÁCH_ORDER_ID> …
✅ Lý do: <diễn giải ngắn nhưng CỤ THỂ, nhắc VIP⭐/PNL ổn/biến động, lượng trader, margin, thời tính>
🔥 Độ nóng: <1–5>/5 | 🛡️ Safe / ⚠️ Risk / 🔥 Aggressive
💡 Tín hiệu: <Gợi ý hành động 10–20 chữ>
━━━━━━━━━━━━━━━━━━━

🔒 Kiểm lỗi trước khi in
- SỐ_LỆNH == số phần tử thực trong “ID”.
- X+Y==SỐ_LỆNH.
- Mọi Trader/UID/Order ID đều thuộc đúng Symbol và đúng cửa sổ.
- Không gán nhầm Trader ID (UID) vào danh sách Order ID.
- Không bịa số; nếu thiếu dữ liệu ⇒ bỏ qua Symbol.


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
