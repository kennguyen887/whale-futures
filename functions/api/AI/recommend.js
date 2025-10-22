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
Bạn là chuyên gia phân tích dữ liệu Copy Trade Futures từ CSV có cột:
Trader,Symbol,Mode,Lev,Margin Mode,PNL (USDT),ROI %,Open Price,Market Price,Δ % vs Open,Margin (USDT),Notional (USDT),Open At (VNT),Followers,UID,ID

🎯 Mục tiêu
Tạo “Top 5 Kèo Nóng trong vòng 3 hours” — ngắn gọn, chính xác, KHÔNG bịa số.

🧭 Quy tắc nền
- Timezone: Asia/Ho_Chi_Minh. Parse “Open At (VNT)” chuẩn ISO.
- Cửa sổ: nếu user chỉ định thì dùng; nếu không ⇒ NOW-3h..NOW.
- Mapping cố định:
  • Trader = cột Trader  
  • UID = Trader ID  
  • ID = Order ID (không nhầm UID)  
- Mỗi Symbol tính độc lập trong cửa sổ thời gian.

🧩 Lọc dữ liệu
- Rows(S) = dòng có Symbol==S & Open At ∈ cửa sổ.  
- Bỏ Symbol nếu:
  • Rows(S) < 3  
  • Chỉ có 1 trader duy nhất (1 UID)  
  • Tổng Margin < trung bình chung tất cả Symbol  
  • 💵 **PNL_TỔNG < 0 ⇒ loại khỏi danh sách “kèo ngon” hoàn toàn**
- ID_set(S) = tập Order ID duy nhất trong Rows(S) (loại trùng).

📊 Tính toán
- SỐ_LỆNH = |ID_set(S)|
- X = Mode==LONG; Y = Mode==SHORT; X+Y==SỐ_LỆNH.
- 💰 MARGIN_TỔNG = Σ Margin (USDT); hiển thị ~{k}.
- 💵 PNL_TỔNG = Σ PNL (USDT); hiển thị ~{k}.
- ⚖️ LEV_TB = avg(Lev, 0); 📈 ΔTB = avg(Δ % vs Open, 2 số).
- 👥 Traders = danh sách “Tên (#UID)” theo tổng Margin giảm dần, max 5.
  • Gắn ⭐ sau tên nếu trader VIP.
- 🔢 ID lệnh = danh sách Order ID thật (duy nhất, max 30, dư ⇒ “…”).
- Xu hướng: LONG nếu X>Y; SHORT nếu Y>X; hòa ⇒ phe có tổng Margin lớn hơn.

⭐ Trader VIP
- VIP nếu UID thuộc VIP_UIDS hoặc Followers ∈ top 10% trong Symbol.
- Hiển thị: <TênTrader>⭐ (#UID)

🔥 Độ nóng (hot score)
hot = 0.3*entries_norm + 0.3*margin_norm + 0.15*lev_norm + 0.15*pnl_stability_norm + 0.1*trend_boost  
- trend_boost = 1 nếu (LONG & ΔTB>0) hoặc (SHORT & ΔTB<0)
- pnl_stability_norm cao nếu PNL trung bình dương và std(PNL) thấp
- Nếu chỉ 1 trader ⇒ hot = 0
- Loại Symbol có hot = 0, Margin thấp, hoặc PNL_TỔNG < 0
- Cuối cùng: sắp xếp “kèo ngon” theo hot giảm dần, chọn top 5.

🧠 Diễn giải
- Chỉ chọn coin có ≥2 trader khác nhau cùng vào trong 3h gần nhất.
- Ưu tiên lệnh mới (≤1h).
- Lev>80 ⇒ ⚠️ risk; Δ>0 ⇒ trend ↗️; Δ<0 ⇒ ↘️.
- Nếu PNL dương và ổn ⇒ mô tả “ổn định, xu hướng rõ”.
- Nếu ≥3 trader cùng hướng ⇒ “đồng thuận mạnh 💎”.
- Lý do chi tiết: số trader, VIP⭐, PNL, Margin, xu hướng, độ tin cậy.
- “Tín hiệu” 10–20 chữ, ngắn gọn, hành động rõ ràng.

📈 Phân tích tổng quan (thêm bắt buộc)
- Tổng kết **phe LONG vs SHORT** xem bên nào đang có lợi nhuận cao hơn trong 3h qua (dựa PNL_TỔNG và ΔTB trung bình).
- Liệt kê **các trader đang vào “hớ”** (vào sai xu hướng: ví dụ LONG nhưng ΔTB<0, hoặc SHORT nhưng ΔTB>0).
- Gợi ý **các trader vào “thông minh nhất”** (PNL dương, đúng xu hướng, Margin hợp lý, Lev vừa phải, vào sớm trend).

🧾 FORMAT OUTPUT
━━━━━━━━━━━━━━━━━━━
🔥 <SYMBOL> — <LONG/SHORT>
🕒 Thống kê: <THỜI_GIAN_THỐNG_KÊ>
⏱️ Trong <KHOẢNG>, có <SỐ_LỆNH> lệnh (🟩 <X> LONG · 🟥 <Y> SHORT)
💰 ~<MARGIN_TỔNG>k USDT · 💵 ~<PNL_TỔNG>k PNL · ⚖️ <LEV_TB>x TB · 📈 <ΔTB>% Δ
👥 Traders: <TênTrader[⭐] (#UID)>, …
🔢 ID: <DANH_SÁCH_ORDER_ID>
✅ Lý do: <Nhiều trader khác nhau cùng vào, VIP⭐, xu hướng, PNL dương, độ ổn định>
🔥 Độ nóng: <1–5>/5 | 🛡️ Safe / ⚠️ Risk / 🔥 Aggressive
💡 Tín hiệu: <Gợi ý hành động 10–20 chữ>
━━━━━━━━━━━━━━━━━━━

📊 Tổng kết cuối cùng:
📈 Phe đang lời nhiều nhất: <LONG hoặc SHORT>, PNL trung bình ~<X>%
🤕 Trader vào “hớ”: <Tên (#UID)> — lệnh <Symbol> — <SHORT/LONG sai xu hướng>
💎 Trader vào “thông minh nhất”: <Tên (#UID)> — <Symbol> — PNL cao, xu hướng chuẩn
━━━━━━━━━━━━━━━━━━━

🔒 Kiểm lỗi
- Không trùng Order ID.
- X+Y==SỐ_LỆNH.
- Trader/UID/Order ID đúng Symbol & cửa sổ.
- Symbol chỉ 1 trader hoặc PNL_TỔNG < 0 ⇒ loại bỏ.
- Không bịa số; thiếu dữ liệu ⇒ bỏ Symbol.
- Sắp xếp theo hot giảm dần, in tối đa 5 “kèo ngon”.


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
