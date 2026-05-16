// PrintGenie analyze.js — Anthropic Claude Opus 4.7 proxy
// Top-tier vision model for 3D print defect diagnosis.
// Accepts OpenAI-format requests (messages with image_url) for backward compat
// and returns OpenAI-format responses ({choices:[{message:{content}}]})
// so the frontend doesn't need to change.
//
// Protections preserved from previous version:
// - Anthropic key stays server-side
// - Per-IP in-memory rate limiting
// - Payload size limit (6 MB default)
// - Max output tokens cap
// - Allowed model whitelist (Claude family only)
// - Optional Cloudflare Turnstile verification

const https = require('https');

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX || 8);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 6 * 1024 * 1024);
const MAX_TOKENS_CAP = Number(process.env.MAX_TOKENS_CAP || 4000);

// Default and whitelist of Claude models — overridable via env vars
const DEFAULT_MODEL = process.env.ANALYZE_DEFAULT_MODEL || "claude-opus-4-7";
const ALLOWED_MODELS = new Set(
  (process.env.ALLOWED_MODELS || "claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5")
    .split(",").map(s => s.trim()).filter(Boolean)
);

// In-memory rate-limit buckets (per warm Lambda instance)
const buckets = globalThis.__PRINTGENIE_RATE_BUCKETS__ || new Map();
globalThis.__PRINTGENIE_RATE_BUCKETS__ = buckets;

function getClientIp(event) {
  const h = event.headers || {};
  return (h["cf-connecting-ip"] || h["x-nf-client-connection-ip"] || h["x-forwarded-for"] || "unknown")
    .split(",")[0].trim();
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

// ── Convert OpenAI message format → Anthropic format ────────────────

function convertImageBlock(openaiBlock) {
  // OpenAI: {type:"image_url", image_url:{url:"data:image/jpeg;base64,..."}}
  // Anthropic: {type:"image", source:{type:"base64", media_type, data}}
  const url = openaiBlock.image_url?.url || "";
  const m = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null; // Unsupported URL format (only data URLs supported here)
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
  if (typeof content === "string") {
    return content; // Anthropic accepts plain strings
  }
  if (!Array.isArray(content)) return String(content || "");

  // Convert each OpenAI content block to Anthropic format
  const blocks = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text") {
      blocks.push({ type: "text", text: item.text || "" });
    } else if (item.type === "image_url") {
      const img = convertImageBlock(item);
      if (img) blocks.push(img);
    } else if (item.type === "image") {
      // Already Anthropic format — pass through
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
      // Collect all system messages into a single system parameter
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

// ── Handler ────────────────────────────────────────────────────────

exports.handler = async function(event) {
  const headers = {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Size guard
  const bodyBytes = Buffer.byteLength(event.body || "", "utf8");
  if (bodyBytes > MAX_BODY_BYTES) {
    return {
      statusCode: 413, headers,
      body: JSON.stringify({ error: "Request is too large. Please upload a smaller image." })
    };
  }

  // Rate limit
  const ip = getClientIp(event);
  const rl = rateLimit(ip);
  headers["X-RateLimit-Limit"] = String(MAX_REQUESTS);
  headers["X-RateLimit-Remaining"] = String(rl.remaining);
  headers["X-RateLimit-Reset"] = String(Math.ceil(rl.resetAt / 1000));

  if (!rl.allowed) {
    return {
      statusCode: 429, headers,
      body: JSON.stringify({ error: "Too many AI requests. Please wait a few minutes and try again." })
    };
  }

  // API key
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "Anthropic API key is not configured" })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  // Optional Turnstile
  try {
    const captcha = await verifyTurnstile(body.turnstileToken, ip);
    if (!captcha.ok) {
      return {
        statusCode: 403, headers,
        body: JSON.stringify({ error: "Captcha verification failed", details: captcha.error })
      };
    }
  } catch (err) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "Captcha verification error: " + err.message })
    };
  }

  // Pick model (frontend sends OpenAI names like 'gpt-4o' — map those to default)
  let model = body.model;
  if (!model || !ALLOWED_MODELS.has(model)) {
    model = DEFAULT_MODEL;
  }

  const max_tokens = Math.min(Number(body.max_tokens || 1500), MAX_TOKENS_CAP);

  // Convert OpenAI → Anthropic
  const { system, messages } = buildAnthropicRequest(body);
  if (!messages.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing messages" }) };
  }

  const anthropicPayload = {
    model,
    max_tokens,
    messages
  };
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
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Upstream error: " + err.message }) };
  }

  let data;
  try {
    data = JSON.parse(result.body);
  } catch {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Invalid response from AI provider" }) };
  }

  if (result.status !== 200) {
    return {
      statusCode: result.status, headers,
      body: JSON.stringify({ error: data.error?.message || data.error || "API error" })
    };
  }

  // Concatenate all text blocks into one content string (OpenAI-compatible)
  const textBlocks = (data.content || []).filter(b => b.type === "text");
  const contentText = textBlocks.map(b => b.text).join("\n").trim();

  // Translate Anthropic stop_reason → OpenAI finish_reason
  const stopReasonMap = {
    "end_turn": "stop",
    "max_tokens": "length",
    "stop_sequence": "stop",
    "tool_use": "tool_calls"
  };
  const finish_reason = stopReasonMap[data.stop_reason] || "stop";

  // Return OpenAI-format response so frontend (which reads choices[0].message.content) works unchanged
  const openaiResponse = {
    id: data.id,
    object: "chat.completion",
    model: data.model || model,
    choices: [{
      index: 0,
      message: {
        role: data.role || "assistant",
        content: contentText
      },
      finish_reason
    }],
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
    } : undefined
  };

  return { statusCode: 200, headers, body: JSON.stringify(openaiResponse) };
};
