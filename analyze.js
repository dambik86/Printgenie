// PrintGenie v40 protected OpenAI proxy
// Basic protections:
// - OpenAI key stays server-side only
// - per-IP in-memory rate limiting
// - payload size limit
// - allowed model whitelist
// - max_tokens cap
// - optional Cloudflare Turnstile verification

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000); // 10 min
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX || 5); // 5 requests per window
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 6 * 1024 * 1024); // 6 MB
const MAX_TOKENS_CAP = Number(process.env.MAX_TOKENS_CAP || 2500);
const ALLOWED_MODELS = new Set((process.env.ALLOWED_MODELS || "gpt-4o-mini,gpt-4o,gpt-4.1-mini").split(",").map(s => s.trim()).filter(Boolean));

const buckets = globalThis.__PRINTGENIE_RATE_BUCKETS__ || new Map();
globalThis.__PRINTGENIE_RATE_BUCKETS__ = buckets;

function getClientIp(event) {
  const h = event.headers || {};
  return (h["cf-connecting-ip"] || h["x-nf-client-connection-ip"] || h["x-forwarded-for"] || "unknown").split(",")[0].trim();
}

function rateLimit(ip) {
  const now = Date.now();
  const current = buckets.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > current.resetAt) {
    current.count = 0;
    current.resetAt = now + WINDOW_MS;
  }
  current.count += 1;
  buckets.set(ip, current);
  return {
    allowed: current.count <= MAX_REQUESTS,
    remaining: Math.max(0, MAX_REQUESTS - current.count),
    resetAt: current.resetAt
  };
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true };
  if (!token) return { ok: false, error: "Captcha verification required" };

  const form = new URLSearchParams();
  form.append("secret", secret);
  form.append("response", token);
  if (ip && ip !== "unknown") form.append("remoteip", ip);

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form
  });
  const data = await res.json();
  return { ok: !!data.success, error: data["error-codes"] || "Captcha failed" };
}

function safeBody(obj) {
  return JSON.stringify(obj);
}

exports.handler = async function(event) {
  const headers = {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: safeBody({ error: "Method not allowed" }) };

  const bodyBytes = Buffer.byteLength(event.body || "", "utf8");
  if (bodyBytes > MAX_BODY_BYTES) {
    return { statusCode: 413, headers, body: safeBody({ error: "Request is too large. Please upload a smaller image." }) };
  }

  const ip = getClientIp(event);
  const rl = rateLimit(ip);
  headers["X-RateLimit-Limit"] = String(MAX_REQUESTS);
  headers["X-RateLimit-Remaining"] = String(rl.remaining);
  headers["X-RateLimit-Reset"] = String(Math.ceil(rl.resetAt / 1000));

  if (!rl.allowed) {
    return {
      statusCode: 429,
      headers,
      body: safeBody({ error: "Too many AI requests. Please wait a few minutes and try again." })
    };
  }

  const API_KEY = process.env.OPENAI_API_KEY;
  if (!API_KEY) return { statusCode: 500, headers, body: safeBody({ error: "OpenAI API key is not configured" }) };

  try {
    const body = JSON.parse(event.body || "{}");

    const captcha = await verifyTurnstile(body.turnstileToken, ip);
    if (!captcha.ok) {
      return { statusCode: 403, headers, body: safeBody({ error: "Captcha verification failed", details: captcha.error }) };
    }

    const model = ALLOWED_MODELS.has(body.model) ? body.model : "gpt-4o-mini";
    const max_tokens = Math.min(Number(body.max_tokens || 1200), MAX_TOKENS_CAP);

    const payload = {
      model,
      max_tokens,
      messages: Array.isArray(body.messages) ? body.messages : []
    };

    if (!payload.messages.length) {
      return { statusCode: 400, headers, body: safeBody({ error: "Missing messages" }) };
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + API_KEY
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    return { statusCode: response.status, headers, body: JSON.stringify(data) };
  } catch (error) {
    return { statusCode: 500, headers, body: safeBody({ error: error.message || "Server error" }) };
  }
};
