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
Tạo “Top 5 Kèo Nóng trong vòng 3 hours” — ngắn gọn, CHÍNH XÁC, KHÔNG bịa số.

🧭 Chuẩn hoá
- Timezone: Asia/Ho_Chi_Minh. Parse “Open At (VNT)” chuẩn ISO.
- Cửa sổ: nếu user chỉ định thì dùng đúng; nếu không ⇒ NOW-3h..NOW.
- Mapping cứng: Trader = tên; UID = Trader ID; ID = Order ID (không nhầm UID).

🚫 HARD FILTERS (loại ngay nếu vi phạm)
- Rows(S) = Symbol==S & Open At ∈ cửa sổ.
- Dedup theo ID trước khi tính (ID_set(S) = các Order ID duy nhất).
- SỐ_LỆNH = |ID_set(S)|; yêu cầu SỐ_LỆNH ≥ 3.
- Distinct trader (distinct UID) ≥ 2.
- PNL_TỔNG(S) = Σ PNL (USDT) > 0 (không nhận ≤ 0).
- Không in dấu “~” ở con số. Có thể dùng hậu tố k (12.3k), KHÔNG có dấu ~.

📐 TÍNH TOÁN (chỉ với bản ghi có ID ∈ ID_set(S))
- X = số ID có Mode==LONG; Y = số ID có Mode==SHORT; YÊU CẦU: X+Y == SỐ_LỆNH.
- MARGIN_TỔNG = Σ Margin (USDT).
- PNL_TỔNG = Σ PNL (USDT).
- LEV_TB = avg(Lev) (làm tròn 0); ΔTB = avg(Δ % vs Open, 2 số).
- Traders = danh sách duy nhất “Tên (#UID)” sort theo ΣMargin ↓ (tối đa 5). Gắn ⭐ nếu VIP (UID ∈ VIP_UIDS hoặc Followers ∈ top 10% của Symbol).
- ID lệnh = danh sách Order ID **duy nhất**, sắp theo Open At ↓, **ghi kèm hướng**: `ID(MODE)` ví dụ `7361507…(LONG)`. Tối đa 30; dư ⇒ “…”.
- Nếu cùng một ID có nhiều dòng với Mode khác nhau ⇒ chọn Mode thực tế mới nhất theo Open At; loại dòng còn lại.
- Xu hướng: LONG nếu X>Y; SHORT nếu Y>X; hoà ⇒ phe có ΣMargin lớn hơn.

🔥 HOT SCORE & CHỌN TOP
- Chuẩn hoá: entries_norm, margin_norm, lev_norm, pnl_stability_norm; trend_boost∈{0,1}.
- trend_boost = 1 nếu (LONG & ΔTB>0) hoặc (SHORT & ΔTB<0).
- pnl_stability_norm cao nếu PNL trung bình dương và std(PNL) thấp (gộp theo ID).
- hot = 0.30*entries_norm + 0.30*margin_norm + 0.15*lev_norm + 0.15*pnl_stability_norm + 0.10*trend_boost.
- Sắp xếp hot ↓; in tối đa 5 Symbol. Nếu không còn Symbol hợp lệ ⇒ in: “Không có ‘kèo ngon’ trong cửa sổ thời gian.”

🧠 Diễn giải & Nhãn rủi ro
- Ưu tiên lệnh mới (≤1h), nhiều trader cùng hướng ⇒ “đồng thuận”.
- Lev>80 ⇒ ⚠️ Risk; ΔTB>0 ⇒ trend ↗️; ΔTB<0 ⇒ ↘️.
- Lý do phải CỤ THỂ: số trader, VIP⭐, xu hướng, PNL, Margin, độ ổn định.
- “Tín hiệu” 10–20 chữ, hành động rõ ràng.

📈 PHÂN TÍCH TỔNG QUAN (bắt buộc, có TỔNG PNL & LÝ DO)
- Trên toàn bộ dữ liệu (sau dedup ID):
  • PNL_LONG = Σ PNL của ID Mode==LONG.
  • PNL_SHORT = Σ PNL của ID Mode==SHORT.
  • Bên đang lời hơn = bên có PNL cao hơn (nêu LÝ DO: ΔTB, số lệnh, ΣMargin, độ ổn định).
  • “Traders vào hớ” = trader có PNL tổng âm HOẶC vào sai hướng chi phối của Symbol (LONG khi ΔTB<0 chi phối / SHORT khi ΔTB>0 chi phối). Nêu **danh sách**, **PNL_TỔNG nhóm**, và **lý do**.
  • “Những trader thông minh nhất” = **danh sách** trader PNL dương, đúng xu hướng Symbol, vào sớm nhịp, Lev ≤ 60, Margin hợp lý. Nêu **PNL_TỔNG nhóm** và **lý do**.

🔢 FORMAT OUTPUT

━━━━━━━━━━━━━━━━━━━
🔥 <SYMBOL> — <LONG/SHORT>
🕒 Thống kê: <THỜI_GIAN_THỐNG_KÊ>
⏱️ Trong <KHOẢNG>, có <SỐ_LỆNH> lệnh (🟩 <X> LONG · 🟥 <Y> SHORT)
💰 <MARGIN_TỔNG> USDT · 💵 <PNL_TỔNG> PNL · ⚖️ <LEV_TB>x TB · 📈 <ΔTB>% Δ
👥 Traders: <TênTrader[⭐] (#UID)>, …
🔢 ID: <ID1(LONG|SHORT)>, <ID2(LONG|SHORT)>, … (tối đa 30; dư “…")
✅ Lý do: <nhiều trader, VIP⭐ nếu có, xu hướng, PNL dương & ổn định, chi tiết cụ thể>
🔥 Độ nóng: <1–5>/5 | 🛡️ Safe / ⚠️ Risk / 🔥 Aggressive
💡 Tín hiệu: <Gợi ý hành động 10–20 chữ>
━━━━━━━━━━━━━━━━━━━

📊 Tổng kết cuối cùng:
📈 Phe lời nhiều nhất: <LONG/SHORT> — PNL_TỔNG = <PNL_LONG hoặc PNL_SHORT> USDT — vì <ΔTB thuận chiều, số lệnh/ΣMargin áp đảo, PNL dương ổn định>.
🤕 Traders vào “hớ”: <Danh sách Tên (#UID)> — PNL_TỔNG nhóm = <PNL> USDT — vì <vào ngược trend chi phối/ΔTB bất lợi/PNL âm>.
💎 Những trader “thông minh nhất”: <Danh sách Tên (#UID)> — PNL_TỔNG nhóm = <PNL> USDT — vì <đúng xu hướng, vào sớm, Lev ≤60, Margin hợp lý, PNL dương ổn định>.
━━━━━━━━━━━━━━━━━━━

🧪 ASSERT (kiểm lỗi cuối)
- Danh sách ID là **duy nhất** và **mỗi ID hiển thị kèm (LONG|SHORT)** đúng theo bản ghi mới nhất.
- X+Y == SỐ_LỆNH == số ID đã in.
- Mọi Trader/UID/ID thuộc đúng Symbol & đúng cửa sổ.
- Loại Symbol có: SỐ_LỆNH<3, chỉ 1 trader, hoặc PNL_TỔNG ≤ 0.
- Không dùng dấu “~” ở con số.
- In tối đa 5 Symbol theo hot ↓.


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
