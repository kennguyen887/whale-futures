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
Bạn là chuyên gia phân tích dữ liệu copy trade từ CSV gồm:
Trader,Symbol,Mode,Lev,Margin Mode,PNL (USDT),ROI %,Open Price,Market Price,Δ % vs Open,Margin (USDT),Notional (USDT),Open At (VNT),Followers,UID,ID

🎯 Mục tiêu: Tạo “Top 5 kèo nóng” (ngắn, đúng format, không bịa).

⚙️ Quy tắc:
1️⃣ Múi giờ: Asia/Ho_Chi_Minh. Parse “Open At (VNT)” chuẩn ISO.
2️⃣ Cửa sổ thời gian: dùng đúng khung user chỉ định (VD: 2h gần nhất).
3️⃣ Lọc theo Symbol S:
   - Rows(S): Symbol == S & Open At trong khung.
   - ID_set(S): ID duy nhất trong Rows(S).
   - Không lấy dữ liệu Symbol khác.
4️⃣ Tính toán:
   - SỐ_LỆNH = |ID_set(S)|; X=LONG; Y=SHORT; X+Y=SỐ_LỆNH.
   - NOTIONAL = Σ Notional; hiển thị ~{k}.
   - LEV = TB Lev (làm tròn 0); DELTA = TB Δ% (2 số).
   - Traders = tên + UID, sort theo Notional giảm dần.
   - ID = liệt kê chính xác, max 30.
   - Xu hướng: LONG nếu X>Y; SHORT nếu Y>X; hòa ⇒ phe có Notional cao hơn.
5️⃣ Độ nóng /5:
   hot = 0.4*entries_norm + 0.3*notional_norm + 0.2*lev_norm + 0.1*trend_boost  
   trend_boost=1 nếu (LONG & Δ>0) hoặc (SHORT & Δ<0).
6️⃣ Chọn top 5 Symbol có hot cao nhất.

🧠 Lý do & tín hiệu:
- Nhiều lệnh cùng hướng ⇒ đồng thuận mạnh.  
- Ưu tiên lệnh mới (≤1h).  
- Lev>80 ⇒ ⚠️ rủi ro cao.  
- Δ>0 ⇒ trend ↗️; Δ<0 ⇒ ↘️.  
- ≤3 trader ⇒ 💣 đòn bẩy cao; nhiều trader ⇒ 💎 đáng tin.  
- Notional cao ⇒ 💥 hút tiền.  
→ Gợi ý hành động 10–20 chữ.

📊 Format output:

━━━━━━━━━━━━━━━━━━━
🔥 <SYMBOL> — <LONG/SHORT>
🕒 Thống kê: <THỜI_GIAN>
⏱️ Trong <KHOẢNG>, có <SỐ_LỆNH> lệnh (🟩 <X> LONG · 🟥 <Y> SHORT)
💰 ~<NOTIONAL>k USDT · ⚖️ <LEV>x TB · 📈 <DELTA>% Δ
👥 Traders: <TÊN (#UID)> …
🔢 ID: <DANH SÁCH> …
✅ Lý do: <MÔ TẢ NGẮN>
🔥 Độ nóng: <1–5>/5 | 🛡️ Safe / ⚠️ Risk / 🔥 Aggressive
💡 Tín hiệu: <GỢI Ý>
━━━━━━━━━━━━━━━━━━━

🔒 Kiểm lỗi:
- X+Y==SỐ_LỆNH
- Trader/ID đều thuộc Symbol & khung thời gian
- Rows(S)<1 ⇒ bỏ qua Symbol

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
