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
- Mapping bắt buộc:
  • Trader = cột Trader
  • Trader ID (UID) = cột UID
  • Order ID = cột ID
- Mọi dữ liệu Symbol chỉ lấy đúng Symbol đó trong cửa sổ.

🗂 Lọc theo Symbol S
- Rows(S) = dòng có Symbol==S & Open At ∈ cửa sổ.
- Nếu Rows(S) < 3 ⇒ BỎ (tránh coin “1–2 lệnh”).
- ID_set(S) = tập Order ID duy nhất trong Rows(S).

📐 Tính toán
- SỐ_LỆNH = |ID_set(S)|
- X = Mode==LONG; Y = Mode==SHORT; yêu cầu X+Y==SỐ_LỆNH.
- 💰 MARGIN_TỔNG = Σ Margin (USDT) (theo ID); hiển thị ~{k}.
- 💵 PNL_TỔNG = Σ PNL (USDT) (theo ID); hiển thị ~{k}.
- ⚖️ LEV_TB = avg(Lev); 📈 DELTA_TB = avg(Δ % vs Open) (2 số).
- 👥 Traders = “Tên (#UID)” sắp theo tổng Margin giảm dần, max 5.
  • Gắn ⭐ sau tên trader nếu VIP.
- 🔢 ID = danh sách Order ID thật (max 30; dư ⇒ “…").
- Xu hướng: LONG nếu X>Y; SHORT nếu Y>X; hoà ⇒ phe có Margin cao hơn.

⭐ Trader VIP
- VIP nếu UID nằm trong VIP_UIDS hoặc Followers thuộc top 10% trong Symbol.
- Gắn ký hiệu ⭐ ngay sau tên.

📊 Độ nóng /5
hot = 0.35*entries_norm + 0.30*margin_norm + 0.15*lev_norm + 0.15*pnl_stability_norm + 0.05*trend_boost  
trend_boost=1 nếu (LONG & Δ>0) hoặc (SHORT & Δ<0).  
PNL Stability = độ lệch chuẩn ROI% hoặc PNL (nhóm theo ID), std thấp ⇒ điểm cao.  
Chọn top 5 Symbol có hot cao nhất và Rows(S) hợp lệ.

🧠 Lý do & Tín hiệu
- Ưu tiên nhiều lệnh cùng hướng, gần hiện tại (≤1h).  
- Lev>80 ⇒ ⚠️ rủi ro cao; Δ>0 ⇒ trend ↗️; Δ<0 ⇒ ↘️.  
- ≤3 trader nhưng Margin lớn ⇒ 💣; nhiều trader + Margin lớn ⇒ 💎.  
- PNL ổn 3h qua ⇒ “ổn định”, biến động mạnh ⇒ “dao động”.  
- Viết lý do chi tiết hơn, giải thích yếu tố VIP⭐, Margin, PNL, xu hướng.  
- “Tín hiệu” 10–20 chữ, ngắn, dễ hiểu.

🧾 FORMAT OUTPUT
━━━━━━━━━━━━━━━━━━━
🔥 <SYMBOL> — <LONG/SHORT>
🕒 Thống kê: <THỜI_GIAN_THỐNG_KÊ>
⏱️ Trong <KHOẢNG>, có <SỐ_LỆNH> lệnh (🟩 <X> LONG · 🟥 <Y> SHORT)
💰 ~<MARGIN_TỔNG>k USDT · 💵 ~<PNL_TỔNG>k PNL · ⚖️ <LEV_TB>x TB · 📈 <DELTA_TB>% Δ
👥 Traders: <TênTrader[⭐] (#UID)>, …
🔢 ID: <DANH_SÁCH_ORDER_ID> …
✅ Lý do: <CỤ THỂ, nêu VIP⭐, PNL ổn định, Margin cao, xu hướng, số trader>
🔥 Độ nóng: <1–5>/5 | 🛡️ Safe / ⚠️ Risk / 🔥 Aggressive
💡 Tín hiệu: <Gợi ý hành động 10–20 chữ>
━━━━━━━━━━━━━━━━━━━

🔒 Kiểm lỗi
- SỐ_LỆNH == số ID; X+Y==SỐ_LỆNH.
- Trader/UID/Order ID đúng Symbol & cửa sổ.
- Không nhầm UID ↔ ID.
- Không bịa số; thiếu dữ liệu ⇒ bỏ Symbol.

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
