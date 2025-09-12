import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

// ---------- Config ----------
const app = express();
const PORT = Number(process.env.PORT || 8787);

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'x-api-key']
}));
app.use(express.json({ limit: '1mb' }));

// ---------- Helpers ----------
const corsHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, X-API-Key, x-api-key'
};
function jsonRes(res, status, obj) { return res.status(status).set(corsHeaders).json(obj); }

function num(x, def = 0) {
  const n = typeof x === 'number' ? x : Number(String(x ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : def;
}
async function safeJson(res) { try { return await res.json(); } catch { return await res.text(); } }

// Build requestParamString: sort keys, URL-encode values, join by '&' (khớp demo đã chạy OK)
function buildRequestParamString(params = {}) {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null) // null không ký
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/\+/g, '%20')}`);
  return entries.join('&');
}

// HMAC SHA256 signature: payload = accessKey + reqTime + requestParamString
function signContract({ accessKey, secretKey, reqTime, requestParamString }) {
  const payload = `${accessKey}${reqTime}${requestParamString || ''}`;
  return crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
}

// Gọi private GET cho MEXC Contract theo chuẩn đã xác thực
async function mexcPrivateGet(base, path, params, { accessKey, secretKey, debugMode }) {
  const reqTime = Date.now().toString();
  const requestParamString = buildRequestParamString(params || {});
  const signature = signContract({ accessKey, secretKey, reqTime, requestParamString });

  const url = `${base}${path}${requestParamString ? '?' + requestParamString : ''}`;
  const headers = {
    'ApiKey': accessKey,
    'Request-Time': reqTime,
    'Signature': signature,
    'Content-Type': 'application/json'
  };

  const res = await fetch(url, { method: 'GET', headers }).catch(() => null);
  const data = res ? await safeJson(res) : { success: false, message: 'network_error' };

  const dbg = debugMode ? {
    url,
    status: res?.status || 0,
    headersSent: { ...headers, ApiKey: '***', Signature: String(signature).slice(0, 16) + '…' },
    requestParamString,
    reqTime
  } : undefined;

  return { ok: !!res?.ok, data, debug: dbg };
}

function mergeMexcData(store, path, data) {
  const d = data?.data ?? data?.result ?? data ?? [];
  if (path.includes('/position/')) {
    const arr = Array.isArray(d) ? d : (Array.isArray(d?.positions) ? d.positions : []);
    for (const it of arr) store.positions.push(it);
  } else if (path.includes('/order/')) {
    const arr = Array.isArray(d) ? d : (Array.isArray(d?.orders) ? d.orders : []);
    for (const it of arr) store.openOrders.push(it);
  }
}

// ---------- Route ----------
app.options('/api/AI/recommend-live', (req, res) => res.status(204).set(corsHeaders).send());

app.post('/api/AI/recommend-live', async (req, res) => {
  try {
    // --- Security ---
    const REQUIRED_KEY = process.env.INTERNAL_API_KEY || '';
    if (REQUIRED_KEY) {
      const clientKey = req.header('x-api-key') || '';
      if (clientKey !== REQUIRED_KEY) {
        return jsonRes(res, 401, { success: false, error: 'Unauthorized: invalid x-api-key.' });
      }
    }

    // --- OpenAI config ---
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return jsonRes(res, 500, { success: false, error: 'Server misconfig: OPENAI_API_KEY not set.' });
    }
    const OPENAI_BASE = (process.env.OPENAI_BASE || 'https://api.openai.com').replace(/\/+$/, '');
    const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    // --- MEXC keys ---
    const ACCESS_KEY = process.env.MEXC_ACCESS_KEY;
    const SECRET_KEY = process.env.MEXC_SECRET_KEY;
    if (!ACCESS_KEY || !SECRET_KEY) {
      return jsonRes(res, 500, { success: false, error: 'Server misconfig: MEXC keys not set.' });
    }

    // --- Params & flags ---
    const lang = String(req.query.lang ?? 'vi').toLowerCase();
    const debugMode = String(req.query.debug ?? '').toLowerCase() === '1' || process.env.DEBUG_MEXC === '1';
    const FORCE_SYMBOL = process.env.MEXC_SYMBOL || '';               // optional: ép symbol qua env
    const symbol = String(req.query.symbol ?? FORCE_SYMBOL ?? '');    // cũng cho phép ?symbol=BTC_USDT
    const customPrompt = String(req.body?.prompt ?? '').trim();

    // --- Fetch live (positions + open orders) via proven signer ---
    const BASE = 'https://contract.mexc.com';
    const endpoints = [
      { path: '/api/v1/private/position/open_positions', params: symbol ? { symbol } : {} },
      { path: '/api/v1/private/order/open_orders',       params: symbol ? { symbol } : {} }
    ];

    const live = { positions: [], openOrders: [], raw: [], debug: [] };
    for (const ep of endpoints) {
      const r = await mexcPrivateGet(BASE, ep.path, ep.params, {
        accessKey: ACCESS_KEY, secretKey: SECRET_KEY, debugMode
      });
      live.raw.push({ path: ep.path, status: r.debug?.status ?? 0, data: r.data });
      if (debugMode && r.debug) live.debug.push({ ...r.debug, path: ep.path });
      if (r.data?.success) mergeMexcData(live, ep.path, r.data);
    }

    console.log(
      `Fetched ${live.positions.length} positions and ${live.openOrders.length} open orders from MEXC`,
      live.raw
    );

    // --- Normalize → CSV for AI ---
    const rows = [];
    const tz = 'Asia/Ho_Chi_Minh';

    // Positions
    for (const p of live.positions) {
      const symbol = p.symbol || p.currency || p.contract || p.instrumentId || '';
      const sideRaw = p.side || p.positionSide || p.direction || (p.positionType === 1 ? 'LONG' : p.positionType === 2 ? 'SHORT' : '');
      const side = `${sideRaw}`.toUpperCase().includes('SHORT') ? 'SHORT' : 'LONG';
      const lev = p.leverage || p.lever || p.leverRate || p.marginLeverage || 0;
      const marginMode = (p.marginMode || p.margin_type || p.isIsolated ? 'Isolated' : 'Cross');
      const entry = num(p.avgEntryPrice ?? p.openPrice ?? p.openAvgPrice ?? p.holdAvgPrice ?? p.entryPrice);
      const mark  = num(p.markPrice ?? p.lastPrice ?? p.currentPrice ?? p.fairPrice);
      const qty   = num(p.positionVolume ?? p.size ?? p.holdVol ?? p.quantity ?? p.positionAmt);
      const notional = Math.abs(mark * qty);
      const pnl   = num(p.unrealizedPnl ?? p.pnl ?? p.unrealizedProfit);
      const roiPct = notional > 0 ? (pnl / (notional / (lev || 1))) * 100 : 0;
      const deltaPct = entry ? ((mark - entry) / entry) * 100 : 0;
      const openedAt = p.openTime || p.createTime || p.updateTime || Date.now();

      rows.push({
        'Trader': p.uid || p.traderUid || p.accountId || '',
        'Symbol': symbol,
        'Mode': side,
        'Lev': lev,
        'Margin Mode': marginMode,
        'PNL (USDT)': pnl,
        'ROI %': roiPct,
        'Open Price': entry,
        'Market Price': mark,
        'Δ % vs Open': deltaPct,
        'Amount': qty,
        'Margin (USDT)': notional / (lev || 1),
        'Notional (USDT)': notional,
        'Open At (VNT)': new Date(openedAt).toLocaleString('en-GB', { timeZone: tz, hour12: false }).replace(',', ''),
        'Margin %': '',
        'Followers': '',
        'UID': p.uid || ''
      });
    }

    // Open Orders
    for (const o of live.openOrders) {
        console.log('=--------Open order:', o);
      const symbol = o.symbol || o.currency || o.contract || '';
      const sideRaw = o.side || o.positionSide || o.direction || o.orderSide || '';
      const isLong = `${sideRaw}`.toUpperCase().includes('BUY');
      const side = isLong ? 'LONG' : 'SHORT';
      const lev = o.leverage || o.lever || o.leverRate || 0;
      const marginMode = (o.marginMode || o.margin_type || o.isIsolated ? 'Isolated' : 'Cross');
      const price = num(o.price ?? o.triggerPrice ?? o.orderPrice);
      const qty   = num(o.vol ?? o.quantity ?? o.size);
      const openedAt = o.createTime || o.updateTime || Date.now();

      rows.push({
        'Trader': o.uid || o.traderUid || '',
        'Symbol': symbol,
        'Mode': side,
        'Lev': lev,
        'Margin Mode': marginMode,
        'PNL (USDT)': 0,
        'ROI %': 0,
        'Open Price': price,
        'Market Price': price,
        'Δ % vs Open': 0,
        'Amount': qty,
        'Margin (USDT)': '',
        'Notional (USDT)': '',
        'Open At (VNT)': new Date(openedAt).toLocaleString('en-GB', { timeZone: tz, hour12: false }).replace(',', ''),
        'Margin %': '',
        'Followers': '',
        'UID': o.uid || ''
      });
    }

    const headers = [
      'Trader','Symbol','Mode','Lev','Margin Mode','PNL (USDT)','ROI %','Open Price',
      'Market Price','Δ % vs Open','Amount','Margin (USDT)','Notional (USDT)','Open At (VNT)','Margin %','Followers','UID'
    ];
    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => String(r[h] ?? '').replace(/,/g, '')).join(','))
    ].join('\n');
console.log(`---------------Prepared CSV with ${rows.length} rows for AI.`, csv);
    // --- Prompt ---
    const DEFAULT_PROMPT = `
Bạn là chuyên gia trader kiêm risk-manager, tư vấn những lệnh tôi đang có. Hãy:
1) Đọc lệnh Futures (vị thế đang mở + lệnh đang chờ khớp) bên dưới.
2) Chuẩn hoá số, parse thời gian Asia/Ho_Chi_Minh. Ưu tiên lệnh mở 6–12h gần nhất.
4) Phân loại kèo: 🔥 Ưu tiên | 🛡️ An toàn | ⚠️ Rủi ro | 📈 Đang trend.
5) Tư vấn tối ưu hoá lợi nhuận & quản trị rủi ro
6) Quản trị rủi ro (cứng): Lev tối đa như trên; ≤3 kèo cùng lớp tài sản; risk per trade ≤1% tài khoản; tổng risk ≤5%.
7) Thêm cảnh báo ⚠️ nếu có
8) Ngôn ngữ: ${lang === 'vi' ? 'Tiếng Việt' : 'User language'}; xuất bảng: [Nhóm] | Symbol | Bias | Market | Entry | Lev | Term | Risk | TP | SL | R:R | Reason.
9) Format các lệnh bên dưới dạng table Markdown có icon, ngắn gọn, dễ đọc. Dữ liệu rõ ràng.
lệnh Futures:
${csv || '<EMPTY>'}
`.trim();

    const finalPrompt = customPrompt || DEFAULT_PROMPT;

    // --- OpenAI call ---
    const aiReq = { model: OPENAI_MODEL, temperature: 0.2, messages: [{ role: 'user', content: finalPrompt }] };
    const aiResp = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(aiReq)
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      return jsonRes(res, aiResp.status, {
        success: false,
        error: `OpenAI error: ${errText}`,
        debug: live.raw.slice(-4)
      });
    }

    const data = await aiResp.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || '';

    return jsonRes(res, 200, {
      success: true,
      model: OPENAI_MODEL,
      resultMarkdown: content,
      positionsCount: live.positions.length,
      openOrdersCount: live.openOrders.length,
      debug: (debugMode ? { requests: live.debug, raw: live.raw.slice(-4) } : undefined)
    });
  } catch (e) {
    return jsonRes(res, 500, { success: false, error: String(e?.message || e) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`recommend-live node server listening on http://localhost:${PORT}`);
});
