// /api/admin.js — Admin endpoint for Peter to view collected data
// Protected by ADMIN_PASSWORD environment variable.
// Routes:
//   GET  /api/admin?action=login&password=XXX  — validate password, return token
//   POST /api/admin (body: {action, token, ...}) — list, get photo signed URL, delete, stats

const crypto = require("crypto");
const sb = require("./_supabase.js");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
// Token signing key — derived from admin password + service role key
const TOKEN_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "fallback-key";

function signToken(payload) {
  const data = JSON.stringify({ ...payload, exp: Date.now() + 60 * 60 * 1000 }); // 1h expiry
  const sig = crypto.createHmac("sha256", TOKEN_KEY).update(data).digest("hex");
  return Buffer.from(data).toString("base64url") + "." + sig;
}

function verifyToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [b64, sig] = token.split(".");
  try {
    const data = Buffer.from(b64, "base64url").toString("utf8");
    const expectedSig = crypto.createHmac("sha256", TOKEN_KEY).update(data).digest("hex");
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(data);
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "Admin not configured (ADMIN_PASSWORD missing)" });
  }

  if (!sb.supabaseConfigured()) {
    return res.status(500).json({ error: "Supabase not configured" });
  }

  // ── LOGIN (GET with password) ─────────────────────────────────
  if (req.method === "GET") {
    const action = req.query?.action || "";
    const password = req.query?.password || "";
    if (action !== "login") {
      return res.status(400).json({ error: "Use POST for API actions" });
    }
    // Use constant-time comparison to prevent timing attacks
    if (!password || password.length !== ADMIN_PASSWORD.length ||
        !crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD))) {
      // Add small delay to slow brute-force
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ error: "Wrong password" });
    }
    const token = signToken({ admin: true });
    return res.status(200).json({ ok: true, token });
  }

  // ── ALL OTHER ACTIONS REQUIRE POST + TOKEN ─────────────────────
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body;
  try {
    body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const payload = verifyToken(body.token);
  if (!payload || !payload.admin) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const action = String(body.action || "");

  try {
    if (action === "list_analyses") {
      const limit = Math.min(Number(body.limit) || 50, 200);
      const offset = Math.max(0, Number(body.offset) || 0);
      const data = await sb.dbSelect("analyses",
        `select=*&order=created_at.desc&limit=${limit}&offset=${offset}`);
      return res.status(200).json({ ok: true, data });
    }

    if (action === "list_chats") {
      const limit = Math.min(Number(body.limit) || 50, 200);
      const offset = Math.max(0, Number(body.offset) || 0);
      const data = await sb.dbSelect("chats",
        `select=*&order=created_at.desc&limit=${limit}&offset=${offset}`);
      return res.status(200).json({ ok: true, data });
    }

    if (action === "list_searches") {
      const limit = Math.min(Number(body.limit) || 50, 200);
      const offset = Math.max(0, Number(body.offset) || 0);
      const data = await sb.dbSelect("model_searches",
        `select=*&order=created_at.desc&limit=${limit}&offset=${offset}`);
      return res.status(200).json({ ok: true, data });
    }

    if (action === "photo_url") {
      const path = String(body.path || "");
      if (!path || path.includes("..") || path.includes("/")) {
        return res.status(400).json({ error: "Invalid path" });
      }
      const result = await sb.storageSignedUrl({
        bucket: "analysis-photos",
        path,
        expiresIn: 3600
      });
      // Result.signedURL or result.signedUrl depending on Supabase version
      const signedUrl = result?.signedURL || result?.signedUrl;
      if (!signedUrl) return res.status(500).json({ error: "Could not generate signed URL" });
      // Make absolute URL
      const fullUrl = signedUrl.startsWith("http")
        ? signedUrl
        : (process.env.SUPABASE_URL + "/storage/v1" + signedUrl);
      return res.status(200).json({ ok: true, url: fullUrl });
    }

    if (action === "stats") {
      // Get counts and aggregates for dashboard
      const [analyses, chats, searches] = await Promise.all([
        sb.dbSelect("analyses", "select=created_at,problem_category,printer_brand,material&order=created_at.desc&limit=10000"),
        sb.dbSelect("chats", "select=created_at&order=created_at.desc&limit=10000"),
        sb.dbSelect("model_searches", "select=created_at,query&order=created_at.desc&limit=10000")
      ]);

      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      function countSince(rows, ms) {
        const cutoff = now - ms;
        return rows.filter(r => new Date(r.created_at).getTime() > cutoff).length;
      }

      // Top categories / printers / materials
      function topCounts(rows, field, n = 5) {
        const counts = {};
        for (const r of rows) {
          const v = r[field];
          if (!v) continue;
          counts[v] = (counts[v] || 0) + 1;
        }
        return Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([k, v]) => ({ name: k, count: v }));
      }

      return res.status(200).json({
        ok: true,
        stats: {
          analyses: {
            total: analyses.length,
            last_24h: countSince(analyses, day),
            last_7d: countSince(analyses, 7 * day),
            top_categories: topCounts(analyses, "problem_category"),
            top_printers: topCounts(analyses, "printer_brand"),
            top_materials: topCounts(analyses, "material")
          },
          chats: {
            total: chats.length,
            last_24h: countSince(chats, day),
            last_7d: countSince(chats, 7 * day)
          },
          searches: {
            total: searches.length,
            last_24h: countSince(searches, day),
            last_7d: countSince(searches, 7 * day),
            top_queries: topCounts(searches, "query", 10)
          }
        }
      });
    }

    if (action === "delete") {
      const table = String(body.table || "");
      const id = String(body.id || "");
      const allowedTables = ["analyses", "chats", "model_searches"];
      if (!allowedTables.includes(table)) return res.status(400).json({ error: "Invalid table" });
      if (!id.match(/^[0-9a-f-]{36}$/i)) return res.status(400).json({ error: "Invalid id" });

      // If deleting analysis with photo, delete photo too
      if (table === "analyses") {
        const rows = await sb.dbSelect("analyses", `select=photo_url&id=eq.${id}`);
        if (rows && rows[0] && rows[0].photo_url) {
          try {
            await sb.supabaseRequest({
              method: "DELETE",
              path: `/storage/v1/object/analysis-photos/${encodeURIComponent(rows[0].photo_url)}`
            });
          } catch (e) { /* ignore — best effort */ }
        }
      }

      await sb.supabaseRequest({
        method: "DELETE",
        path: `/rest/v1/${table}?id=eq.${id}`
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("[admin] error:", err.message);
    return res.status(500).json({ error: "Internal error: " + err.message });
  }
};
