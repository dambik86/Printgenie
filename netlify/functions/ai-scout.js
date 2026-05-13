// PrintGenie AI Scout — Anthropic API proxy with web search
// Uses claude-sonnet-4-20250514 + web_search_20250305 tool

const https = require('https');

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_SCOUT || 8);

const buckets = globalThis.__PG_SCOUT_BUCKETS__ || new Map();
globalThis.__PG_SCOUT_BUCKETS__ = buckets;

function getIp(event) {
  const h = event.headers || {};
  return (h["cf-connecting-ip"] || h["x-nf-client-connection-ip"] || h["x-forwarded-for"] || "unknown").split(",")[0].trim();
}

function rateLimit(ip) {
  const now = Date.now();
  const cur = buckets.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > cur.resetAt) { cur.count = 0; cur.resetAt = now + WINDOW_MS; }
  cur.count++;
  buckets.set(ip, cur);
  return { allowed: cur.count <= MAX_REQUESTS };
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

exports.handler = async function(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const ip = getIp(event);
  if (!rateLimit(ip).allowed) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "Příliš mnoho dotazů. Počkej chvíli. / Too many requests." }) };
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "API key not configured" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const mode = body.mode || "forum";
  const lang = body.lang || "cs";
  const query = (body.query || "").trim().slice(0, 500);
  const printer = (body.printer || "").trim().slice(0, 80);
  const filament = (body.filament || "").trim().slice(0, 40);

  if (!query) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing query" }) };

  let systemPrompt, userMessage;

  if (mode === "forum") {
    systemPrompt = lang === "cs"
      ? `Jsi PrintGenie AI Scout — expert na FDM 3D tisk. Použi web search pro vyhledávání SKUTEČNÝCH řešení na těchto zdrojích: forum.prusa3d.com, reddit.com/r/FixMyPrint, reddit.com/r/3Dprinting, reddit.com/r/prusa3d, reddit.com/r/BambuLab, community.bambulab.com, ellis3d.github.io, teachingtechyt.github.io, docs.prusa3d.com.

Vrať POUZE JSON (bez markdown backticks):
{"diagnosis":"krátká diagnóza","sources_searched":["zdroj1","zdroj2"],"solutions":[{"title":"název","probability":"Nejpravděpodobnější","steps":["krok1","krok2"],"values":"přesné hodnoty","source":"název zdroje","source_url":"https://..."}],"quick_tip":"tip"}`
      : `You are PrintGenie AI Scout — FDM 3D printing expert. Use web search to find REAL solutions from: forum.prusa3d.com, reddit.com/r/FixMyPrint, reddit.com/r/3Dprinting, community.bambulab.com, ellis3d.github.io, teachingtechyt.github.io.

Return ONLY JSON (no markdown backticks):
{"diagnosis":"short diagnosis","sources_searched":["source1"],"solutions":[{"title":"title","probability":"Most likely","steps":["step1"],"values":"exact values","source":"source name","source_url":"https://..."}],"quick_tip":"tip"}`;

    const ctx = [printer && `Tiskárna: ${printer}`, filament && `Filament: ${filament}`].filter(Boolean).join(", ");
    userMessage = ctx ? `${ctx}\nProblém: ${query}` : query;

  } else if (mode === "models") {
    systemPrompt = lang === "cs"
      ? `Jsi PrintGenie Model Scout. Pokud je dotaz laický, přelož ho na anglická klíčová slova. Prohledej: makerworld.bambulab.com, printables.com, thingiverse.com, myminifactory.com, cults3d.com.

Vrať POUZE JSON (bez markdown backticks):
{"search_summary":"co jsi hledal","models":[{"name":"název","author":"autor","site":"MakerWorld","url":"https://...","license":"CC BY","free":true,"description":"popis","recommended_for":"pro koho"}],"tip":"tip pro tisk"}`
      : `You are PrintGenie Model Scout. If query is informal, translate to search keywords. Search: makerworld.bambulab.com, printables.com, thingiverse.com, myminifactory.com, cults3d.com.

Return ONLY JSON (no markdown backticks):
{"search_summary":"what searched","models":[{"name":"name","author":"author","site":"MakerWorld","url":"https://...","license":"CC BY","free":true,"description":"desc","recommended_for":"who for"}],"tip":"print tip"}`;
    userMessage = query;
  } else {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid mode" }) };
  }

  try {
    const reqBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }]
    });

    const result = await httpsPost({
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

    const data = JSON.parse(result.body);

    if (result.status !== 200) {
      return { statusCode: result.status, headers, body: JSON.stringify({ error: data.error?.message || "API error" }) };
    }

    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) return { statusCode: 500, headers, body: JSON.stringify({ error: "No response from AI" }) };

    let jsonStr = textBlock.text.trim().replace(/^```json\s*/,"").replace(/\s*```$/,"").trim();
    try { JSON.parse(jsonStr); } catch(e) {
      return { statusCode: 200, headers, body: JSON.stringify({ raw: textBlock.text }) };
    }

    return { statusCode: 200, headers, body: jsonStr };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || "Server error" }) };
  }
};
