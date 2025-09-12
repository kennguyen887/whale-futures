// file: get-open-positions.js
// Usage:
//   MEXC_ACCESS_KEY=222 MEXC_SECRET_KEY=22 node get-open-positions.js
//   MEXC_ACCESS_KEY=222 MEXC_SECRET_KEY=22 node get-open-positions.js BTC_USDT

import crypto from "crypto";
import axios from "axios";
import 'dotenv/config'; // <-- thêm dòng này

const ACCESS_KEY = process.env.MEXC_ACCESS_KEY;
const SECRET_KEY = process.env.MEXC_SECRET_KEY;

if (!ACCESS_KEY || !SECRET_KEY) {
  console.error("Missing MEXC_ACCESS_KEY or MEXC_SECRET_KEY envs.");
  process.exit(1);
}

const BASE = "https://contract.mexc.com";
const PATH = "/api/v1/private/position/open_positions";

// Build requestParamString for GET: sort keys asc, url-encode values, join by '&'
function buildRequestParamString(params = {}) {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null) // null không tham gia ký
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/\+/g, "%20")}`);
  return entries.join("&");
}

// Create HMAC SHA256 signature: accessKey + reqTime + requestParamString
function sign({ accessKey, secretKey, reqTime, requestParamString }) {
  const payload = `${accessKey}${reqTime}${requestParamString || ""}`;
  return crypto.createHmac("sha256", secretKey).update(payload).digest("hex");
}

async function main() {
  // optional symbol from CLI: e.g. BTC_USDT
  const symbol = process.argv[2]; 
  const query = {};
  if (symbol) query.symbol = symbol;

  const requestParamString = buildRequestParamString(query);
  const reqTime = Date.now().toString();
  const signature = sign({
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    reqTime,
    requestParamString,
  });

  const url = `${BASE}${PATH}${requestParamString ? "?" + requestParamString : ""}`;

  const headers = {
    "ApiKey": ACCESS_KEY,
    "Request-Time": reqTime,
    "Signature": signature,
    "Content-Type": "application/json",
  };

  try {
    const { data } = await axios.get(url, { headers, timeout: 15000 });
    if (data?.success) {
      console.log("Open positions:", JSON.stringify(data.data, null, 2));
    } else {
      console.error("API error:", data);
      process.exit(2);
    }
  } catch (err) {
    if (err.response) {
      console.error("HTTP", err.response.status, err.response.data);
    } else {
      console.error("ERR", err.message);
    }
    process.exit(3);
  }
}

main();
