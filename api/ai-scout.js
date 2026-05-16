// PrintGenie AI Scout — Vercel API Route
// Anthropic Claude proxy with web search
// Supports "fast" mode (Haiku 4.5, low max_uses) and "deep" mode (Sonnet 4.6, high max_uses)

const https = require('https');

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_SCOUT || 12);

const MODEL_FAST = process.env.SCOUT_MODEL_FAST || "claude-haiku-4-5";
const MODEL_DEEP = process.env.SCOUT_MODEL_DEEP || "claude-sonnet-4-6";
const WEB_SEARCH_VERSION = process.env.WEB_SEARCH_VERSION || "web_search_20260209";

const LIMITS = {
  fast: { models: 4, forum: 4, max_tokens: 2500 },
  deep: { models: 8, forum: 6, max_tokens: 3500 }
};

const MODEL_DOMAINS = [
  "makerworld.com",
  "printables.com",
  "thingiverse.com",
  "myminifactory.com",
  "cults3d.com"
];

// Note: reddit.com blocks Anthropic crawler via robots.txt — excluded
const FORUM_DOMAINS = [
  "forum.prusa3d.com",
  "community.bambulab.com",
  "ellis3d.github.io",
  "teachingtechyt.github.io",
  "docs.prusa3d.com",
  "wiki.bambulab.com",
  "all3dp.com",
  "help.prusa3d.com",
  "blog.prusa3d.com"
];

const buckets = globalThis.__PG_SCOUT_BUCKETS__ || new Map();
globalThis.__PG_SCOUT_BUCKETS__ = buckets;

function getIp(req) {
  const h = req.headers || {};
  const xff = h["x-forwarded-for"] || h["x-real-ip"] || h["cf-connecting-ip"] || "unknown";
  return String(xff).split(",")[0].trim();
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

// ── SYSTEM PROMPTS ────────────────────────────────────────────────

const FORUM_PROMPT_CS = `Jsi PrintGenie AI Scout — expert na FDM 3D tisk. Pomáháš lidem řešit problémy s tiskem na základě SKUTEČNÝCH řešení z komunitních fór.

POSTUP:
1. Pochop problém (tiskárna, filament, symptom).
2. Proveď 2–4 web_search dotazy s různými klíčovými slovy (anglicky pro lepší pokrytí).
3. Vyber nejlepší ověřená řešení, prioritizuj ta, která fungovala víc lidem.
4. Pro každé řešení uveď PŘESNÉ hodnoty (°C, mm, mm/s, %) — žádné vágní rady.

ZDROJE:
- forum.prusa3d.com — Prusa fórum (špičkové)
- community.bambulab.com — Bambu Lab komunita
- ellis3d.github.io — Ellis3D Print Tuning Guide
- teachingtechyt.github.io — Teaching Tech calibration
- docs.prusa3d.com — oficiální Prusa dokumentace
- wiki.bambulab.com — Bambu Lab wiki
- all3dp.com — průvodci a recenze

Vrať POUZE platný JSON (bez markdown backticks, bez textu mimo JSON):
{
  "diagnosis": "stručná diagnóza problému, 1–2 věty",
  "sources_searched": ["seznam zdrojů které jsi prohledal"],
  "solutions": [
    {
      "title": "název řešení",
      "probability": "Nejpravděpodobnější" | "Pravděpodobné" | "Méně pravděpodobné",
      "steps": ["krok 1", "krok 2", "krok 3"],
      "values": "PŘESNÉ hodnoty: např. tryska 215 °C, retrakce 5 mm, rychlost 60 mm/s",
      "source": "název zdroje",
      "source_url": "https://..."
    }
  ],
  "quick_tip": "praktický tip"
}`;

const FORUM_PROMPT_EN = `You are PrintGenie AI Scout — FDM 3D printing expert. You help people solve printing problems using REAL solutions from community forums.

WORKFLOW:
1. Understand the problem (printer, filament, symptom).
2. Run 2–4 web_search queries with different keywords.
3. Pick the best verified solutions, prioritize those that worked for multiple people.
4. For every solution give EXACT values (°C, mm, mm/s, %) — no vague advice.

SOURCES:
- forum.prusa3d.com — Prusa forum (top tier)
- community.bambulab.com — Bambu Lab community
- ellis3d.github.io — Ellis3D Print Tuning Guide
- teachingtechyt.github.io — Teaching Tech calibration
- docs.prusa3d.com — official Prusa docs
- wiki.bambulab.com — Bambu Lab wiki
- all3dp.com — guides and reviews

Return ONLY valid JSON (no markdown backticks, no text outside JSON):
{
  "diagnosis": "short problem diagnosis, 1–2 sentences",
  "sources_searched": ["list of sources searched"],
  "solutions": [
    {
      "title": "solution title",
      "probability": "Most likely" | "Likely" | "Less likely",
      "steps": ["step 1", "step 2", "step 3"],
      "values": "EXACT values: e.g. nozzle 215 °C, retraction 5 mm, speed 60 mm/s",
      "source": "source name",
      "source_url": "https://..."
    }
  ],
  "quick_tip": "practical tip"
}`;

const MODELS_PROMPT_FAST_CS = `Jsi Model Scout. Najdi 3D modely podle dotazu, RYCHLE.

POSTUP:
1. Pokud je dotaz česky/laicky, přelož na anglická klíčová slova.
2. Proveď 2–3 web_search dotazy přes makerworld.com, printables.com, thingiverse.com.
3. Vyber 6–8 nejlepších výsledků (preferuj víc stažení, lepší hodnocení).
4. NEVYMÝŠLEJ čísla — pokud neznáš stažení/hodnocení, pole vynech.

Vrať POUZE platný JSON (bez markdown):
{"search_summary":"co jsi hledal","models":[{"name":"...","author":"...","site":"MakerWorld|Printables|Thingiverse|MyMiniFactory|Cults3D","url":"https://...","license":"...","free":true,"downloads":"...","rating":"...","description":"...","material":"PLA|PETG|TPU..."}],"tip":"praktický tip"}`;

const MODELS_PROMPT_FAST_EN = `You are Model Scout. Find 3D models for the query, FAST.

WORKFLOW:
1. If query is informal, translate to English keywords.
2. Run 2–3 web_search queries across makerworld.com, printables.com, thingiverse.com.
3. Pick 6–8 best results (prefer more downloads, better ratings).
4. DO NOT make up numbers — if you don't know downloads/rating, omit the field.

Return ONLY valid JSON (no markdown):
{"search_summary":"what you searched","models":[{"name":"...","author":"...","site":"MakerWorld|Printables|Thingiverse|MyMiniFactory|Cults3D","url":"https://...","license":"...","free":true,"downloads":"...","rating":"...","description":"...","material":"PLA|PETG|TPU..."}],"tip":"practical tip"}`;

const MODELS_PROMPT_DEEP_CS = `Jsi PrintGenie Model Scout — expert na hledání 3D modelů. Tvým úkolem je najít SKUTEČNÉ, existující modely na hlavních repozitářích.

KLÍČOVÝ POSTUP:
1. Pokud je dotaz česky nebo laický, přelož na 2–3 anglické varianty klíčových slov.
2. PROVEĎ MINIMÁLNĚ 3 různé web_search dotazy s různými variantami a doménami.
3. Z výsledků vyber 6–8 NEJLEPŠÍCH modelů podle: stažení, hodnocení, relevance, kvality.
4. OVĚŘ že URL vede na konkrétní model.

Vrať POUZE platný JSON:
{"search_summary":"co jsi hledal","models":[{"name":"...","author":"...","site":"MakerWorld|Printables|Thingiverse|MyMiniFactory|Cults3D","url":"https://...","license":"...","free":true,"downloads":"...","rating":"...","description":"...","recommended_for":"...","material":"..."}],"tip":"..."}

DŮLEŽITÉ: NEVYMÝŠLEJ čísla. URL musí být skutečné. Modely seřaď podle kvality.`;

const MODELS_PROMPT_DEEP_EN = `You are PrintGenie Model Scout — expert at finding 3D models. Find REAL models on main repositories.

WORKFLOW:
1. If query is informal, translate to 2–3 English keyword variants.
2. RUN AT LEAST 3 different web_search queries with different variants and domains.
3. Pick 6–8 BEST models by: downloads, rating, relevance, quality.
4. VERIFY URL leads to a specific model.

Return ONLY valid JSON:
{"search_summary":"...","models":[{"name":"...","author":"...","site":"MakerWorld|Printables|Thingiverse|MyMiniFactory|Cults3D","url":"https://...","license":"...","free":true,"downloads":"...","rating":"...","description":"...","recommended_for":"...","material":"..."}],"tip":"..."}

IMPORTANT: DO NOT make up numbers. URLs must be real. Sort by quality.`;

// ── Vercel HANDLER ────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = getIp(req);
  if (!rateLimit(ip).allowed) {
    return res.status(429).json({ error: "Příliš mnoho dotazů. Počkej chvíli. / Too many requests." });
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: "API key not configured" });

  const body = req.body || {};
  const mode = body.mode || "forum";
  const lang = body.lang || "cs";
  const speed = (body.speed === "deep") ? "deep" : "fast";
  const query = (body.query || "").trim().slice(0, 500);
  const printer = (body.printer || "").trim().slice(0, 80);
  const filament = (body.filament || "").trim().slice(0, 40);

  if (!query) return res.status(400).json({ error: "Missing query" });

  const model = speed === "deep" ? MODEL_DEEP : MODEL_FAST;
  const limits = LIMITS[speed];

  let systemPrompt, userMessage, maxSearches, allowedDomains;

  if (mode === "forum") {
    systemPrompt = lang === "cs" ? FORUM_PROMPT_CS : FORUM_PROMPT_EN;
    const ctx = [printer && `Tiskárna: ${printer}`, filament && `Filament: ${filament}`].filter(Boolean).join(", ");
    userMessage = ctx ? `${ctx}\nProblém: ${query}` : query;
    maxSearches = limits.forum;
    allowedDomains = FORUM_DOMAINS;
  } else if (mode === "models") {
    systemPrompt = speed === "deep"
      ? (lang === "cs" ? MODELS_PROMPT_DEEP_CS : MODELS_PROMPT_DEEP_EN)
      : (lang === "cs" ? MODELS_PROMPT_FAST_CS : MODELS_PROMPT_FAST_EN);
    userMessage = lang === "cs"
      ? `Najdi mi nejlepší 3D modely pro: ${query}`
      : `Find me the best 3D models for: ${query}`;
    maxSearches = limits.models;
    allowedDomains = MODEL_DOMAINS;
  } else {
    return res.status(400).json({ error: "Invalid mode" });
  }

  try {
    const reqBody = JSON.stringify({
      model,
      max_tokens: limits.max_tokens,
      tools: [{
        type: WEB_SEARCH_VERSION,
        name: "web_search",
        max_uses: maxSearches,
        allowed_domains: allowedDomains,
        allowed_callers: ["direct"]
      }],
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

    let data;
    try { data = JSON.parse(result.body); } catch {
      return res.status(500).json({ error: "Invalid response from AI provider" });
    }

    if (result.status !== 200) {
      return res.status(result.status).json({ error: data.error?.message || "API error" });
    }

    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const textBlock = textBlocks[textBlocks.length - 1];

    if (!textBlock) return res.status(500).json({ error: "No text response from AI" });

    let jsonStr = textBlock.text.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    if (!jsonStr.startsWith("{")) {
      const match = jsonStr.match(/\{[\s\S]*\}/);
      if (match) jsonStr = match[0];
    }

    try {
      const parsed = JSON.parse(jsonStr);
      parsed._meta = { speed, model };
      return res.status(200).json(parsed);
    } catch (e) {
      return res.status(200).json({ raw: textBlock.text, _meta: { speed, model } });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
};
