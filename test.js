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
function stableQs(paramsObj = {}) {
  const entries = Object.entries(paramsObj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  const usp = new URLSearchParams();
  for (const [k, v] of entries) usp.append(k, String(v));
  const s = usp.toString();
  return s ? `?${s}` : '';
}
function stableQsPure(paramsObj = {}) {
  const q = stableQs(paramsObj);
  return q.startsWith('?') ? q.slice(1) : q;
}
async function getMexcServerTime() {
  const candidates = [
    'https://contract.mexc.com/api/v1/public/time',
    'https://contract.mexc.com/api/v1/contract/ping',
    'https://futures.mexc.com/api/v1/public/time'
  ];
  for (const u of candidates) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const j = await r.json().catch(() => ({}));
      const t = j?.serverTime ?? j?.data?.serverTime ?? j?.timestamp ?? Date.now();
      return Number(t);
    } catch {}
  }
  return Date.now();
}

const corsHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, X-API-Key, x-api-key'
};
function jsonRes(res, status, obj) { return res.status(status).set(corsHeaders).json(obj); }
function num(x, def = 0) { const n = typeof x === 'number' ? x : Number(String(x ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : def; }
async function safeJson(res) { try { return await res.json(); } catch { return await res.text(); } }

// HMAC helpers with encodings
function hmacRaw(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }
const encoders = {
  hex: (buf) => buf.toString('hex'),
  HEX: (buf) => buf.toString('hex').toUpperCase(),
  b64: (buf) => buf.toString('base64')
};
function signWith(key, msg, mode) { return encoders[mode](hmacRaw(key, msg)); }

function maskHeaders(h) {
  const out = { ...h };
  if (out['ApiKey']) out['ApiKey'] = '***';
  if (out['api-key']) out['api-key'] = '***';
  if (out['X-MEXC-APIKEY']) out['X-MEXC-APIKEY'] = '***';
  if (out['Signature']) out['Signature'] = String(out['Signature']).slice(0, 16) + '…';
  return out;
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
    // Security
    const REQUIRED_KEY = process.env.INTERNAL_API_KEY || '';
    if (REQUIRED_KEY) {
      const clientKey = req.header('x-api-key') || '';
      if (clientKey !== REQUIRED_KEY) return jsonRes(res, 401, { success: false, error: 'Unauthorized: invalid x-api-key.' });
    }

    // OpenAI
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return jsonRes(res, 500, { success: false, error: 'Server misconfig: OPENAI_API_KEY not set.' });
    const OPENAI_BASE = (process.env.OPENAI_BASE || 'https://api.openai.com').replace(/\/+$/, '');
    const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    // MEXC
    const MEXC_ACCESS_KEY = process.env.MEXC_ACCESS_KEY;
    const MEXC_SECRET_KEY = process.env.MEXC_SECRET_KEY;
    if (!MEXC_ACCESS_KEY || !MEXC_SECRET_KEY) return jsonRes(res, 500, { success: false, error: 'Server misconfig: MEXC keys not set.' });

    // Flags
    const lang = String(req.query.lang ?? 'vi').toLowerCase();
    const debugMode = String(req.query.debug ?? '').toLowerCase() === '1' || process.env.DEBUG_MEXC === '1';
    const FORCE_SYMBOL = process.env.MEXC_SYMBOL || ''; // e.g. BTC_USDT if region requires
    const TS_UNIT = (process.env.MEXC_TS_UNIT || 'ms').toLowerCase(); // 'ms' | 'sec'
    const INCLUDE_HOST = process.env.MEXC_INCLUDE_HOST === '1'; // include host in prehash

    // ------------ Robust signer + fetcher ------------
    async function mexcFetchTryAllAsync({ debugMode = false } = {}) {
      const collected = { positions: [], openOrders: [], rawResponses: [] };
      const DEBUG = [];

      const HOSTS = ['https://contract.mexc.com', 'https://futures.mexc.com'];
      const ENDPOINTS = [
        { method: 'GET', path: '/api/v1/private/position/open_positions' },
        { method: 'GET', path: '/api/v1/private/order/open_orders' },
        { method: 'GET', path: '/api/v1/private/position/openPositions' }, // likely 404
        { method: 'GET', path: '/api/v1/private/order/openOrders' }        // likely 404
      ];

      // time sync
      const localNow = Date.now();
      const serverNow = await getMexcServerTime();
      const driftMs = serverNow - localNow;
      const tsNow = () => {
        const t = Date.now() + driftMs;
        return TS_UNIT === 'sec' ? Math.floor(t / 1000).toString() : t.toString(); // seconds or ms
      };

      // Build prehash strings
      function buildPayloads({ ts, method, host, path, qsStr, pureQs, body }) {
        const h = host.replace(/^https?:\/\//, ''); // host only
        const base = INCLUDE_HOST ? `${h}${path}` : path;

        // variants: with ?qs vs pure qs, with/without body, with newline styles, with host included
        return [
          { name: 'A',  str: `${ts}${method}${base}${pureQs}${body}` },              // ts+method+path(+host)+pureQs+body
          { name: 'Aq', str: `${ts}${method}${base}${qsStr}${body}` },               // ts+method+path(+host)+?qs+body
          { name: 'B',  str: `${method}\n${base}\n${qsStr}\n${body}\n${ts}` },       // method\npath(+host)\n?qs\nbody\nts
          { name: 'Bq', str: `${method}\n${base}\n${pureQs}\n${body}\n${ts}` },      // method\npath(+host)\npureQs\nbody\nts
          { name: 'C',  str: `${ts}${method}${base}${pureQs}` },                     // no body
          { name: 'Cq', str: `${ts}${method}${base}${qsStr}` },                      // no body, ?qs
          { name: 'D',  str: `${method}${base}${pureQs}${ts}` },                     // concat no sep
          { name: 'E',  str: `${method}\n${base}\n${ts}\n${pureQs}\n${body}` }       // alt order
        ];
      }

      for (const host of HOSTS) {
        for (const { method, path } of ENDPOINTS) {
          const qsBase = {};
          if (FORCE_SYMBOL && (path.includes('open_orders') || path.includes('open_positions'))) {
            qsBase.symbol = FORCE_SYMBOL;
          }
          const qsStr = stableQs(qsBase);
          const pureQs = stableQsPure(qsBase);
          const url = `${host}${path}${qsStr}`;
          const ts = tsNow();
          const body = ''; // GET

          // --------------- MODE 1: HEADER-SIGN (multi payload x encodings) ---------------
          {
            const payloads = buildPayloads({ ts, method, host, path, qsStr, pureQs, body });
            const encs = ['hex', 'HEX', 'b64'];

            let ok = false;
            for (const p of payloads) {
              for (const enc of encs) {
                const sig = signWith(MEXC_SECRET_KEY, p.str, enc);
                const headerCandidates = [
                  { 'Content-Type': 'application/json', 'ApiKey': MEXC_ACCESS_KEY, 'Request-Time': ts, 'Signature': sig, __pv: `${p.name}-${enc}` },
                  { 'Content-Type': 'application/json', 'api-key': MEXC_ACCESS_KEY, 'Request-Time': ts, 'Signature': sig, __pv: `${p.name}-${enc}` },
                  { 'Content-Type': 'application/json', 'X-MEXC-APIKEY': MEXC_ACCESS_KEY, 'Request-Time': ts, 'Signature': sig, __pv: `${p.name}-${enc}` },
                  { 'Content-Type': 'application/json', 'ApiKey': MEXC_ACCESS_KEY, 'request-time': ts, 'Signature': sig, __pv: `${p.name}-${enc}` }
                ];
                for (let i = 0; i < headerCandidates.length; i++) {
                  const h = headerCandidates[i];
                  const resX = await fetch(url, { method, headers: h }).catch(() => null);
                  const j = resX ? await safeJson(resX) : 'network_error';
                  collected.rawResponses.push({ variant: `H-${p.name}-${enc}-${i+1}`, host, path, status: resX?.status || 0, data: j });
                  if (debugMode) {
                    DEBUG.push({
                      mode: 'header', host, path, variant: `H-${p.name}-${enc}-${i+1}`,
                      status: resX?.status || 0, ts, driftMs, url, qs: qsStr,
                      headersSent: maskHeaders(h),
                      payloadVariant: `${p.name}-${enc}`,
                      respMsg: typeof j === 'object' && j ? (j.message || j.msg || '') : String(j).slice(0, 120)
                    });
                  }
                  if (resX?.ok && j && j.success !== false) {
                    mergeMexcData(collected, path, j); ok = true; break;
                  }
                }
                if (ok) break;
              }
              if (ok) break;
            }
            if (ok) continue;
          }

          // --------------- MODE 2: QUERY-SIGN (api_key/req_time/sign) ---------------
          {
            const encs = ['hex', 'HEX', 'b64'];
            const baseQ = { ...qsBase, api_key: MEXC_ACCESS_KEY, req_time: ts };
            const pqs = stableQsPure(baseQ);

            const prehashes = [
              { name: 'Q1', str: `${ts}${method}${path}${pqs}` },
              { name: 'Q2', str: `${ts}${method}${host.replace(/^https?:\/\//,'')}${path}${pqs}` }, // include host
              { name: 'Q3', str: `${ts}${method}${path}${pqs}` + '' } // explicit +body empty
            ];
            let ok = false;
            for (const ph of prehashes) {
              for (const enc of encs) {
                const sign = signWith(MEXC_SECRET_KEY, ph.str, enc);
                const u = `${host}${path}${stableQs({ ...baseQ, sign })}`;
                const resQ = await fetch(u, { method }).catch(() => null);
                const j = resQ ? await safeJson(resQ) : 'network_error';
                collected.rawResponses.push({ variant: `${ph.name}-${enc}`, host, path, status: resQ?.status || 0, data: j });
                if (debugMode) {
                  DEBUG.push({
                    mode: 'query', host, path, variant: `${ph.name}-${enc}`,
                    status: resQ?.status || 0, ts, driftMs, url: u,
                    respMsg: typeof j === 'object' && j ? (j.message || j.msg || '') : String(j).slice(0, 120)
                  });
                }
                if (resQ?.ok && j && j.success !== false) { mergeMexcData(collected, path, j); ok = true; break; }
              }
              if (ok) break;
            }
            if (ok) continue;
          }

          collected.rawResponses.push({ variant: 'ALL_FAIL', host, path, status: 0, text: 'all signature modes failed' });
        }
      }
      if (debugMode) collected.DEBUG = DEBUG;
      return collected;
    }

    const live = await mexcFetchTryAllAsync({ debugMode });
    console.log(`Fetched ${live.positions.length} positions and ${live.openOrders.length} open orders from MEXC`, live.rawResponses);

    // -------- Normalize → CSV --------
    const rows = [];
    const tz = 'Asia/Ho_Chi_Minh';

    for (const p of live.positions) {
      const symbol = p.symbol || p.currency || p.contract || p.instrumentId || '';
      const sideRaw = p.side || p.positionSide || p.direction || '';
      const side = `${sideRaw}`.toUpperCase().includes('SHORT') ? 'SHORT' : 'LONG';
      const lev = p.leverage || p.lever || p.leverRate || p.marginLeverage || 0;
      const marginMode = (p.marginMode || p.margin_type || p.isIsolated ? 'Isolated' : 'Cross');
      const entry = num(p.avgEntryPrice ?? p.openPrice ?? p.averageOpenPrice ?? p.entryPrice);
      const mark  = num(p.markPrice ?? p.lastPrice ?? p.currentPrice ?? p.fairPrice);
      const qty   = num(p.positionVolume ?? p.size ?? p.holdVol ?? p.quantity ?? p.positionAmt);
      const notional = Math.abs(mark * qty);
      const pnl   = num(p.unrealizedPnl ?? p.pnl ?? p.unrealizedProfit);
      const roiPct = notional > 0 ? (pnl / (notional / (lev || 1))) * 100 : 0;
      const deltaPct = entry ? ((mark - entry) / entry) * 100 : 0;
      const openedAt = p.openTime || p.createTime || p.updateTime || Date.now();
      rows.push({
        'Trader': p.uid || p.traderUid || p.accountId || '',
        'Symbol': symbol, 'Mode': side, 'Lev': lev, 'Margin Mode': marginMode,
        'PNL (USDT)': pnl, 'ROI %': roiPct, 'Open Price': entry, 'Market Price': mark,
        'Δ % vs Open': deltaPct, 'Amount': qty,
        'Margin (USDT)': notional / (lev || 1), 'Notional (USDT)': notional,
        'Open At (VNT)': new Date(openedAt).toLocaleString('en-GB', { timeZone: tz, hour12: false }).replace(',', ''),
        'Margin %': '', 'Followers': '', 'UID': p.uid || ''
      });
    }

    for (const o of live.openOrders) {
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
        'Symbol': symbol, 'Mode': side, 'Lev': lev, 'Margin Mode': marginMode,
        'PNL (USDT)': 0, 'ROI %': 0, 'Open Price': price, 'Market Price': price,
        'Δ % vs Open': 0, 'Amount': qty, 'Margin (USDT)': '', 'Notional (USDT)': '',
        'Open At (VNT)': new Date(openedAt).toLocaleString('en-GB', { timeZone: tz, hour12: false }).replace(',', ''),
        'Margin %': '', 'Followers': '', 'UID': o.uid || ''
      });
    }

    const headers = ['Trader','Symbol','Mode','Lev','Margin Mode','PNL (USDT)','ROI %','Open Price','Market Price','Δ % vs Open','Amount','Margin (USDT)','Notional (USDT)','Open At (VNT)','Margin %','Followers','UID'];
    const csv = [ headers.join(','), ...rows.map(r => headers.map(h => String(r[h] ?? '').replace(/,/g, '')).join(',')) ].join('\n');

    // -------- Prompt --------
    const customPrompt = String(req.body?.prompt ?? '').trim();
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

    // -------- OpenAI --------
    const aiReq = { model: OPENAI_MODEL, temperature: 0.2, messages: [{ role: 'user', content: finalPrompt }] };
    const aiResp = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(aiReq)
    });
    if (!aiResp.ok) {
      const errText = await aiResp.text();
      return jsonRes(res, aiResp.status, { success: false, error: `OpenAI error: ${errText}`, debug: Array.isArray(live.rawResponses) ? live.rawResponses.slice(-12) : [] });
    }
    const data = await aiResp.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || '';

    return jsonRes(res, 200, {
      success: true,
      model: OPENAI_MODEL,
      resultMarkdown: content,
      positionsCount: live.positions.length,
      openOrdersCount: live.openOrders.length,
      debug: debugMode ? { requests: live.DEBUG || [], raw: Array.isArray(live.rawResponses) ? live.rawResponses.slice(-12) : [] } : undefined
    });
  } catch (e) {
    return jsonRes(res, 500, { success: false, error: String(e?.message || e) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`recommend-live node server listening on http://localhost:${PORT}`);
});
