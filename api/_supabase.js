// Shared Supabase helper for PrintGenie backend
// Used by /api/save-data.js, /api/admin/*.js
//
// Uses service_role key — has full DB access. NEVER expose to frontend.

const https = require("https");
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function supabaseConfigured() {
  return !!(SUPABASE_URL && SERVICE_KEY);
}

// Generic REST API caller
function supabaseRequest({ method, path, body, headers = {}, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    if (!supabaseConfigured()) {
      return reject(new Error("Supabase not configured (missing env vars)"));
    }

    let u;
    try {
      u = new URL(SUPABASE_URL + path);
    } catch (e) {
      return reject(new Error("Invalid SUPABASE_URL"));
    }

    const reqBody = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "apikey": SERVICE_KEY,
        "Authorization": "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
        ...headers
      },
      timeout: timeoutMs
    };
    if (reqBody) opts.headers["Content-Length"] = Buffer.byteLength(reqBody);

    const r = https.request(opts, (resp) => {
      let chunks = [];
      resp.on("data", c => chunks.push(c));
      resp.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf8");
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : null); }
          catch { resolve(data); }
        } else {
          reject(new Error("Supabase " + resp.statusCode + ": " + data.slice(0, 200)));
        }
      });
      resp.on("error", reject);
    });
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(); reject(new Error("Supabase timeout")); });
    if (reqBody) r.write(reqBody);
    r.end();
  });
}

// Insert a row into a table
function dbInsert(table, row) {
  return supabaseRequest({
    method: "POST",
    path: "/rest/v1/" + encodeURIComponent(table),
    body: row
  });
}

// Select rows (basic)
function dbSelect(table, queryParams = "") {
  return supabaseRequest({
    method: "GET",
    path: "/rest/v1/" + encodeURIComponent(table) + (queryParams ? "?" + queryParams : "")
  });
}

// Upload binary to Storage bucket
function storageUpload({ bucket, path, body, contentType, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    if (!supabaseConfigured()) {
      return reject(new Error("Supabase not configured"));
    }
    let u;
    try {
      u = new URL(SUPABASE_URL + "/storage/v1/object/" + bucket + "/" + path);
    } catch (e) {
      return reject(new Error("Invalid storage URL"));
    }
    const opts = {
      method: "POST",
      hostname: u.hostname,
      path: u.pathname,
      headers: {
        "apikey": SERVICE_KEY,
        "Authorization": "Bearer " + SERVICE_KEY,
        "Content-Type": contentType || "application/octet-stream",
        "Content-Length": body.length,
        "x-upsert": "false"
      },
      timeout: timeoutMs
    };
    const r = https.request(opts, (resp) => {
      let chunks = [];
      resp.on("data", c => chunks.push(c));
      resp.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf8");
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          resolve({ ok: true, path: path });
        } else {
          reject(new Error("Storage " + resp.statusCode + ": " + data.slice(0, 200)));
        }
      });
      resp.on("error", reject);
    });
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(); reject(new Error("Storage timeout")); });
    r.write(body);
    r.end();
  });
}

// Generate a signed URL for private file access (for admin only)
function storageSignedUrl({ bucket, path, expiresIn = 3600 }) {
  return supabaseRequest({
    method: "POST",
    path: "/storage/v1/object/sign/" + bucket + "/" + encodeURIComponent(path),
    body: { expiresIn }
  });
}

// ── ANONYMIZATION HELPERS ────────────────────────────────────────

// SHA-256 hash of input — used to hash IP without storing raw IP
function sha256(input) {
  if (!input) return null;
  return crypto.createHash("sha256")
    .update(String(input) + (process.env.HASH_SALT || "printgenie"))
    .digest("hex")
    .slice(0, 32); // first 32 chars is plenty
}

// Get hashed client IP from request
function hashedIp(req) {
  const ip = (req.headers["x-forwarded-for"] || "")
    .split(",")[0].trim() || req.headers["x-real-ip"] || "";
  return ip ? sha256(ip) : null;
}

// Get hashed user agent
function hashedUserAgent(req) {
  const ua = req.headers["user-agent"] || "";
  return ua ? sha256(ua) : null;
}

// Get country from Vercel header
function getCountry(req) {
  return req.headers["x-vercel-ip-country"] || null;
}

// Strip EXIF metadata from JPEG (basic — removes APP1 segments)
// This is a privacy measure — EXIF can contain GPS coordinates, camera, timestamp, etc.
function stripExifFromJpeg(buffer) {
  if (!Buffer.isBuffer(buffer)) return buffer;
  // JPEG starts with 0xFFD8
  if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
    return buffer; // not a JPEG, return as-is
  }
  const out = [];
  out.push(buffer.slice(0, 2)); // SOI marker
  let i = 2;
  while (i < buffer.length - 1) {
    if (buffer[i] !== 0xFF) break;
    const marker = buffer[i + 1];
    // Skip APP0-APP15 markers (0xE0-0xEF) — these contain EXIF, XMP, IPTC
    if (marker >= 0xE0 && marker <= 0xEF) {
      const segLen = (buffer[i + 2] << 8) | buffer[i + 3];
      i += 2 + segLen;
      continue;
    }
    // Start of compressed data — copy rest as-is
    if (marker === 0xDA) {
      out.push(buffer.slice(i));
      break;
    }
    // Other markers — copy with their data
    if (marker >= 0xD0 && marker <= 0xD9) {
      // Restart markers, no length
      out.push(buffer.slice(i, i + 2));
      i += 2;
    } else {
      const segLen = (buffer[i + 2] << 8) | buffer[i + 3];
      out.push(buffer.slice(i, i + 2 + segLen));
      i += 2 + segLen;
    }
  }
  return Buffer.concat(out);
}

module.exports = {
  supabaseConfigured,
  supabaseRequest,
  dbInsert,
  dbSelect,
  storageUpload,
  storageSignedUrl,
  sha256,
  hashedIp,
  hashedUserAgent,
  getCountry,
  stripExifFromJpeg
};
