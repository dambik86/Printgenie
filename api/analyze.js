// PrintGenie analyze.js — Vercel API Route
// Anthropic Claude vision proxy for 3D print defect diagnosis.
// Accepts OpenAI-format requests (messages with image_url) for backward compat
// and returns OpenAI-format responses ({choices:[{message:{content}}]})
// so the frontend doesn't need to change.

const https = require('https');

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX || 8);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 8 * 1024 * 1024);
const MAX_TOKENS_CAP = Number(process.env.MAX_TOKENS_CAP || 4000);

const DEFAULT_MODEL = process.env.ANALYZE_DEFAULT_MODEL || "claude-opus-4-7";
const ALLOWED_MODELS = new Set(
  (process.env.ALLOWED_MODELS || "claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5")
    .split(",").map(s => s.trim()).filter(Boolean)
);

const buckets = globalThis.__PRINTGENIE_RATE_BUCKETS__ || new Map();
globalThis.__PRINTGENIE_RATE_BUCKETS__ = buckets;

function getClientIp(req) {
  const h = req.headers || {};
  const xff = h["x-forwarded-for"] || h["x-real-ip"] || h["cf-connecting-ip"] || "unknown";
  return String(xff).split(",")[0].trim();
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

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function convertImageBlock(openaiBlock) {
  const url = openaiBlock.image_url?.url || "";
  const m = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: m[1],
      data: m[2]
    }
  };
}

function convertContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  const blocks = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text") {
      blocks.push({ type: "text", text: item.text || "" });
    } else if (item.type === "image_url") {
      const img = convertImageBlock(item);
      if (img) blocks.push(img);
    } else if (item.type === "image") {
      blocks.push(item);
    }
  }
  return blocks.length ? blocks : "";
}

function buildAnthropicRequest(openaiBody) {
  const incomingMessages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
  const systemParts = [];
  const anthropicMessages = [];

  for (const msg of incomingMessages) {
    if (!msg || !msg.role) continue;
    if (msg.role === "system") {
      const c = msg.content;
      if (typeof c === "string") {
        systemParts.push(c);
      } else if (Array.isArray(c)) {
        for (const item of c) {
          if (item?.type === "text") systemParts.push(item.text || "");
        }
      }
    } else if (msg.role === "user" || msg.role === "assistant") {
      anthropicMessages.push({
        role: msg.role,
        content: convertContent(msg.content)
      });
    }
  }

  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: anthropicMessages
  };
}

// Vercel handler signature: (req, res)
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Vercel auto-parses JSON for application/json
  const body = req.body || {};
  const bodySize = JSON.stringify(body).length;
  if (bodySize > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Request is too large. Please upload a smaller image." });
  }

  const ip = getClientIp(req);
  const rl = rateLimit(ip);
  res.setHeader("X-RateLimit-Limit", String(MAX_REQUESTS));
  res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(rl.resetAt / 1000)));

  if (!rl.allowed) {
    return res.status(429).json({ error: "Too many AI requests. Please wait a few minutes and try again." });
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: "Anthropic API key is not configured" });
  }

  // Optional Turnstile
  try {
    const captcha = await verifyTurnstile(body.turnstileToken, ip);
    if (!captcha.ok) {
      return res.status(403).json({ error: "Captcha verification failed", details: captcha.error });
    }
  } catch (err) {
    return res.status(500).json({ error: "Captcha verification error: " + err.message });
  }

  let model = body.model;
  if (!model || !ALLOWED_MODELS.has(model)) {
    model = DEFAULT_MODEL;
  }

  const max_tokens = Math.min(Number(body.max_tokens || 1500), MAX_TOKENS_CAP);

  const { system, messages } = buildAnthropicRequest(body);
  if (!messages.length) {
    return res.status(400).json({ error: "Missing messages" });
  }

  const anthropicPayload = { model, max_tokens, messages };
  if (system) anthropicPayload.system = system;

  const reqBody = JSON.stringify(anthropicPayload);

  let result;
  try {
    result = await httpsPost({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(reqBody)
      }
    }, reqBody);
  } catch (err) {
    return res.status(502).json({ error: "Upstream error: " + err.message });
  }

  let data;
  try {
    data = JSON.parse(result.body);
  } catch {
    return res.status(502).json({ error: "Invalid response from AI provider" });
  }

  if (result.status !== 200) {
    return res.status(result.status).json({ error: data.error?.message || data.error || "API error" });
  }

  const textBlocks = (data.content || []).filter(b => b.type === "text");
  const contentText = textBlocks.map(b => b.text).join("\n").trim();

  const stopReasonMap = {
    "end_turn": "stop",
    "max_tokens": "length",
    "stop_sequence": "stop",
    "tool_use": "tool_calls"
  };
  const finish_reason = stopReasonMap[data.stop_reason] || "stop";

  const openaiResponse = {
    id: data.id,
    object: "chat.completion",
    model: data.model || model,
    choices: [{
      index: 0,
      message: { role: data.role || "assistant", content: contentText },
      finish_reason
    }],
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
    } : undefined
  };

  return res.status(200).json(openaiResponse);
};

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '8mb' }
  }
};
