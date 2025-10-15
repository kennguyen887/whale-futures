// Cloudflare Pages Functions - /api/call
// Usage examples:
//   GET  /api/call?callUrl=https://api.mexc.com/api/v3/ticker/price&limit=50
//   POST /api/call?callUrl=https://example.com/endpoint&method=POST
//
// Env (optional):
//   INTERNAL_API_KEY  -> nếu set, yêu cầu header x-api-key khớp

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade"
]);

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    "access-control-allow-headers": "Content-Type, X-API-Key",
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function addCors(h) {
  const headers = new Headers(h || {});
  const ch = corsHeaders();
  Object.entries(ch).forEach(([k, v]) => headers.set(k, v));
  return headers;
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: addCors({ "content-type": "application/json; charset=utf-8" }),
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchWithRetry(url, init, timeoutMs, retries = 1) {
  try {
    return await fetchWithTimeout(url, init, timeoutMs);
  } catch (e) {
    if (retries <= 0) throw e;
    await sleep(200 + Math.floor(Math.random() * 200));
    return fetchWithRetry(url, init, timeoutMs, retries - 1);
  }
}

// SSRF guard: only http/https, block local/lb ranges
function isSafeTarget(u) {
  try {
    const url = new URL(u);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost")
    ) return false;
    // Basic link-local guard (won't resolve DNS here):
    if (host.startsWith("169.254.")) return false;
    return true;
  } catch {
    return false;
  }
}

function mergeLimitParam(targetUrl, limitStr) {
  if (!limitStr) return targetUrl;
  const u = new URL(targetUrl);
  u.searchParams.set("limit", limitStr);
  return u.toString();
}

export async function onRequest(context) {
  const { request, env } = context;

  // API key check (giữ nguyên như mẫu)
  const REQUIRED_KEY = env.INTERNAL_API_KEY || "";
  if (REQUIRED_KEY) {
    const clientKey = request.headers.get("x-api-key") || "";
    if (clientKey !== REQUIRED_KEY) {
      return json(401, { success: false, error: "Unauthorized: invalid x-api-key." });
    }
  }

  try {
    const url = new URL(request.url);
    const callUrl = url.searchParams.get("callUrl") || url.searchParams.get("callURL");
    const limit = url.searchParams.get("limit"); // sẽ push vào upstream query ?limit=
    const methodParam = (url.searchParams.get("method") || "").toUpperCase();
    const method = ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(methodParam)
      ? methodParam
      : (request.method || "GET").toUpperCase();

    if (!callUrl) {
      return json(400, { success: false, error: "Missing required param: callUrl" });
    }
    if (!isSafeTarget(callUrl)) {
      return json(400, { success: false, error: "Blocked target URL (protocol/host not allowed)." });
    }

    // Gắn/ghi đè ?limit= vào URL đích nếu có
    const target = mergeLimitParam(callUrl, limit);

    // Chuẩn bị headers cho upstream: copy từ request nhưng bỏ các hop-by-hop & không forward x-api-key
    const incoming = new Headers(request.headers);
    const upstreamHeaders = new Headers();
    for (const [k, v] of incoming.entries()) {
      const key = k.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(key)) continue;
      if (key === "host") continue;
      if (key === "x-api-key") continue; // giữ cho gateway, không chuyển tiếp lên upstream
      // Cho phép content-type, authorization,... nếu FE gửi
      upstreamHeaders.set(k, v);
    }

    // Body forward nếu là phương thức có body
    let body = null;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      // Tránh đọc body nhiều lần: clone trực tiếp
      body = request.body;
    }

    const timeoutMs = 10000;
    const res = await fetchWithRetry(
      target,
      {
        method,
        headers: upstreamHeaders,
        body,
        redirect: "follow",
      },
      timeoutMs,
      1
    );

    // Sao chép status, headers, body y nguyên; thêm CORS
    const outHeaders = new Headers(res.headers);
    // Dọn hop-by-hop headers
    for (const h of HOP_BY_HOP_HEADERS) outHeaders.delete(h);
    // Thêm/ghi đè CORS
    const headers = addCors(outHeaders);

    // Stream trực tiếp body gốc
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } catch (e) {
    return json(500, { success: false, error: String(e?.message || e) });
  }
}
