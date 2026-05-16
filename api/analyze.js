// PrintGenie analyze.js — Vercel API Route
// Robust Anthropic Claude vision proxy for 3D print defect diagnosis.
// Accepts OpenAI-format requests and returns OpenAI-format responses.

const https = require("https");

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX || 8);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 8 * 1024 * 1024);
const MAX_TOKENS_CAP = Number(process.env.MAX_TOKENS_CAP || 4000);

// Use Sonnet as default: good vision quality, faster/cheaper/more reliable than Opus for this endpoint.
const DEFAULT_MODEL = process.env.ANALYZE_DEFAULT_MODEL || "claude-sonnet-4-6";
const FALLBACK_MODELS = (process.env.ANALYZE_FALLBACK_MODELS || "claude-sonnet-4-6,claude-haiku-4-5,claude-opus-4-7")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const ALLOWED_MODELS = new Set(
  (process.env.ALLOWED_MODELS || "claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

const buckets = globalThis.__PRINTGENIE_RATE_BUCKETS__ || new Map();
globalThis.__PRINTGENIE_RATE_BUCKETS__ = buckets;

function getHeader(req, name) {
  const headers = req.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
}

function getClientIp(req) {
  const xff = getHeader(req, "x-forwarded-for") || getHeader(req, "x-real-ip") || getHeader(req, "cf-connecting-ip") || "unknown";
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

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form
  });

  const data = await response.json().catch(() => ({}));
  return { ok: !!data.success, error: data["error-codes"] || "Captcha failed" };
}

function httpsPost(options, body, timeoutMs = 55_000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Anthropic request timed out"));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function safeJsonParse(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function parseBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") return safeJsonParse(body);
  return body;
}

function convertImageBlock(openaiBlock) {
  const url = openaiBlock?.image_url?.url || "";
  const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: match[1],
      data: match[2]
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
      blocks.push({ type: "text", text: String(item.text || "") });
      continue;
    }

    if (item.type === "image_url") {
      const image = convertImageBlock(item);
      if (image) blocks.push(image);
      continue;
    }

    // Already Anthropic-compatible image block.
    if (item.type === "image" && item.source) {
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
      const content = msg.content;
      if (typeof content === "string") {
        systemParts.push(content);
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (item?.type === "text") systemParts.push(String(item.text || ""));
        }
      }
      continue;
    }

    if (msg.role === "user" || msg.role === "assistant") {
      const content = convertContent(msg.content);
      if (content && (!Array.isArray(content) || content.length > 0)) {
        anthropicMessages.push({ role: msg.role, content });
      }
    }
  }

  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: anthropicMessages
  };
}

function normalizeAnthropicError(status, data) {
  const error = data?.error || {};
  const type = error.type || data?.type || "anthropic_error";
  const message = error.message || data?.message || "Anthropic API error";
  return { type, message, status };
}

function isRetryableAnthropicStatus(status, type) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529 || type === "overloaded_error" || type === "rate_limit_error";
}

async function callAnthropic({ apiKey, payload, model }) {
  const requestBody = JSON.stringify({ ...payload, model });

  const result = await httpsPost({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(requestBody)
    }
  }, requestBody);

  const data = safeJsonParse(result.body);

  if (result.status < 200 || result.status >= 300) {
    const normalized = normalizeAnthropicError(result.status, data);
    const err = new Error(normalized.message);
    err.status = result.status;
    err.type = normalized.type;
    err.data = data;
    err.model = model;
    throw err;
  }

  return data;
}

async function callAnthropicWithFallbacks({ apiKey, payload, preferredModel }) {
  const models = [];

  if (preferredModel) models.push(preferredModel);
  for (const fallback of FALLBACK_MODELS) {
    if (!models.includes(fallback)) models.push(fallback);
  }

  let lastError = null;

  for (const model of models) {
    if (!ALLOWED_MODELS.has(model)) continue;

    try {
      return await callAnthropic({ apiKey, payload, model });
    } catch (error) {
      lastError = error;
      console.error("Anthropic analyze error", {
        model,
        status: error.status,
        type: error.type,
        message: error.message
      });

      if (!isRetryableAnthropicStatus(error.status, error.type)) {
        throw error;
      }
    }
  }

  throw lastError || new Error("No allowed Claude model is configured");
}

function anthropicToOpenAI(data, fallbackModel) {
  const textBlocks = Array.isArray(data.content)
    ? data.content.filter(block => block && block.type === "text" && typeof block.text === "string")
    : [];

  const contentText = textBlocks.map(block => block.text).join("\n").trim();

  const stopReasonMap = {
    end_turn: "stop",
    max_tokens: "length",
    stop_sequence: "stop",
    tool_use: "tool_calls",
    refusal: "content_filter"
  };

  return {
    id: data.id || `pg_${Date.now()}`,
    object: "chat.completion",
    model: data.model || fallbackModel,
    choices: [{
      index: 0,
      message: {
        role: data.role || "assistant",
        content: contentText || "Nepodařilo se získat textovou odpověď z AI. Zkus prosím kratší dotaz nebo menší obrázek."
      },
      finish_reason: stopReasonMap[data.stop_reason] || "stop"
    }],
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens || 0,
      completion_tokens: data.usage.output_tokens || 0,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
    } : undefined
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = parseBody(req);
  const bodySize = Buffer.byteLength(JSON.stringify(body || {}));

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Anthropic API key is not configured" });
  }

  try {
    const captcha = await verifyTurnstile(body.turnstileToken, ip);
    if (!captcha.ok) {
      return res.status(403).json({ error: "Captcha verification failed", details: captcha.error });
    }
  } catch (error) {
    console.error("Turnstile verification error", error);
    return res.status(500).json({ error: "Captcha verification error" });
  }

  let preferredModel = typeof body.model === "string" ? body.model.trim() : "";
  if (!preferredModel || !ALLOWED_MODELS.has(preferredModel)) preferredModel = DEFAULT_MODEL;

  const max_tokens = Math.min(Math.max(Number(body.max_tokens || 1500), 256), MAX_TOKENS_CAP);
  const { system, messages } = buildAnthropicRequest(body);

  if (!messages.length) {
    return res.status(400).json({ error: "Missing messages" });
  }

  const anthropicPayload = { max_tokens, messages };
  if (system) anthropicPayload.system = system;

  try {
    const data = await callAnthropicWithFallbacks({
      apiKey,
      payload: anthropicPayload,
      preferredModel
    });

    return res.status(200).json(anthropicToOpenAI(data, preferredModel));
  } catch (error) {
    console.error("Analyze failed", {
      status: error.status,
      type: error.type,
      model: error.model,
      message: error.message
    });

    const status = error.status === 429 ? 429 : 502;
    return res.status(status).json({
      error: "AI provider error",
      provider_status: error.status || null,
      provider_type: error.type || null,
      message: error.message || "Unknown error"
    });
  }
};

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "8mb" }
  }
};
