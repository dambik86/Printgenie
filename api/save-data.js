// /api/save-data.js — Vercel serverless function
// Stores anonymized user data (Print Doctor / AI Advisor / Model Search) in Supabase.
// Called by the frontend in "fire and forget" mode AFTER the AI response is shown.
//
// Privacy guarantees:
// - Only saves if consent === true in the request body
// - Hashes IP and user agent (no raw identification)
// - Strips EXIF metadata from photos before storing
// - Photos stored in private bucket (only accessible via signed URLs from admin)
// - No name, email, account, or tracking cookie required

const sb = require("./_supabase.js");

// ── RATE LIMIT (in-memory, per Vercel instance) ──────────────────
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // max 10 saves per minute per IP

function checkRateLimit(ipHash) {
  const now = Date.now();
  const entry = rateLimit.get(ipHash) || { count: 0, reset: now + RATE_LIMIT_WINDOW };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + RATE_LIMIT_WINDOW;
  }
  entry.count++;
  rateLimit.set(ipHash, entry);
  // Cleanup old entries every 100 requests
  if (rateLimit.size > 1000) {
    for (const [k, v] of rateLimit.entries()) {
      if (now > v.reset + RATE_LIMIT_WINDOW) rateLimit.delete(k);
    }
  }
  return entry.count <= RATE_LIMIT_MAX;
}

// ── VALIDATION HELPERS ───────────────────────────────────────────
function cleanText(input, maxLen = 5000) {
  if (typeof input !== "string") return null;
  const s = input.trim().slice(0, maxLen);
  return s.length ? s : null;
}

function cleanEnum(input, allowed) {
  if (typeof input !== "string") return null;
  return allowed.includes(input) ? input : null;
}

// Parse data URL: "data:image/jpeg;base64,XXXX"
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  const match = dataUrl.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const allowedMime = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedMime.includes(mime)) return null;
  let buf;
  try {
    buf = Buffer.from(match[2], "base64");
  } catch { return null; }
  if (!buf.length || buf.length > 5 * 1024 * 1024) return null;
  return { mime, buffer: buf };
}

// ── HANDLER ──────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!sb.supabaseConfigured()) {
    // Silent fail — don't tell the client we have a Supabase setup
    return res.status(200).json({ ok: false, reason: "storage_unavailable" });
  }

  let body;
  try {
    body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  // ── EXPLICIT CONSENT CHECK (REQUIRED) ──────────────────────────
  if (body.consent !== true) {
    return res.status(200).json({ ok: false, reason: "no_consent" });
  }

  // ── RATE LIMIT ─────────────────────────────────────────────────
  const ipHash = sb.hashedIp(req);
  if (ipHash && !checkRateLimit(ipHash)) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  const userAgentHash = sb.hashedUserAgent(req);
  const country = sb.getCountry(req);
  const language = cleanEnum(body.language, ["cs", "en"]) || "cs";

  const type = cleanEnum(body.type, ["analysis", "chat", "search"]);
  if (!type) return res.status(400).json({ error: "Invalid type" });

  try {
    if (type === "analysis") {
      return await saveAnalysis(req, res, body, { ipHash, userAgentHash, country, language });
    }
    if (type === "chat") {
      return await saveChat(req, res, body, { ipHash, userAgentHash, country, language });
    }
    if (type === "search") {
      return await saveSearch(req, res, body, { ipHash, userAgentHash, country, language });
    }
  } catch (err) {
    console.error("[save-data] error:", err.message);
    // Don't expose error details to the client
    return res.status(500).json({ ok: false, reason: "internal_error" });
  }
};

// ── SAVE: ANALYSIS ───────────────────────────────────────────────
async function saveAnalysis(req, res, body, meta) {
  const description = cleanText(body.description, 5000);
  const ai_diagnosis = cleanText(body.ai_diagnosis, 20000);
  const ai_model = cleanText(body.ai_model, 100);
  const ai_response_time_ms = Number.isFinite(body.ai_response_time_ms) ? body.ai_response_time_ms : null;
  const problem_category = cleanText(body.problem_category, 100);
  const printer_brand = cleanText(body.printer_brand, 100);
  const material = cleanText(body.material, 100);

  // ── HANDLE PHOTO (optional) ──
  let photo_url = null;
  let photo_size_kb = null;
  let photo_mime = null;

  if (body.photo_data_url) {
    const parsed = parseDataUrl(body.photo_data_url);
    if (parsed) {
      // Strip EXIF metadata for privacy (only JPEG — PNG/WebP don't typically have EXIF)
      let buf = parsed.buffer;
      if (parsed.mime === "image/jpeg") {
        buf = sb.stripExifFromJpeg(buf);
      }

      // Generate random filename
      const ext = parsed.mime === "image/jpeg" ? "jpg" : parsed.mime === "image/png" ? "png" : "webp";
      const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;

      try {
        await sb.storageUpload({
          bucket: "analysis-photos",
          path: filename,
          body: buf,
          contentType: parsed.mime,
          timeoutMs: 15000
        });
        photo_url = filename; // store just the filename (resolve to signed URL in admin)
        photo_size_kb = Math.round(buf.length / 1024);
        photo_mime = parsed.mime;
      } catch (e) {
        console.error("[save-data] photo upload failed:", e.message);
        // Continue without photo — better to save text than fail completely
      }
    }
  }

  // ── INSERT METADATA ROW ──
  await sb.dbInsert("analyses", {
    description,
    language: meta.language,
    photo_url,
    photo_size_kb,
    photo_mime,
    ai_diagnosis,
    ai_model,
    ai_response_time_ms,
    problem_category,
    printer_brand,
    material,
    ip_hash: meta.ipHash,
    user_agent_hash: meta.userAgentHash,
    country: meta.country
  });

  return res.status(200).json({ ok: true });
}

// ── SAVE: CHAT ───────────────────────────────────────────────────
async function saveChat(req, res, body, meta) {
  const user_message = cleanText(body.user_message, 5000);
  if (!user_message) return res.status(400).json({ error: "Missing user_message" });

  const ai_response = cleanText(body.ai_response, 20000);
  const ai_model = cleanText(body.ai_model, 100);
  const ai_response_time_ms = Number.isFinite(body.ai_response_time_ms) ? body.ai_response_time_ms : null;

  await sb.dbInsert("chats", {
    user_message,
    ai_response,
    language: meta.language,
    ai_model,
    ai_response_time_ms,
    ip_hash: meta.ipHash,
    user_agent_hash: meta.userAgentHash,
    country: meta.country
  });

  return res.status(200).json({ ok: true });
}

// ── SAVE: SEARCH ─────────────────────────────────────────────────
async function saveSearch(req, res, body, meta) {
  const query = cleanText(body.query, 500);
  if (!query) return res.status(400).json({ error: "Missing query" });

  const speed = cleanEnum(body.speed, ["fast", "deep"]);
  const results_count = Number.isFinite(body.results_count) ? body.results_count : null;

  await sb.dbInsert("model_searches", {
    query,
    speed,
    results_count,
    language: meta.language,
    ip_hash: meta.ipHash,
    user_agent_hash: meta.userAgentHash,
    country: meta.country
  });

  return res.status(200).json({ ok: true });
}
