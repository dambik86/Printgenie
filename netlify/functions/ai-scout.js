// PrintGenie AI Scout — Anthropic API proxy with web search
// Supports two speed modes:
//   "fast" (default) — Haiku 4.5, low max_uses, ~5-7 s
//   "deep"           — Sonnet 4.6, high max_uses, ~12-15 s
// Web search tool: web_search_20260209 (GA April 2026, dynamic filtering)

const https = require('https');

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_SCOUT || 12);

// Model selection — overridable via env vars
const MODEL_FAST = process.env.SCOUT_MODEL_FAST || "claude-haiku-4-5";
const MODEL_DEEP = process.env.SCOUT_MODEL_DEEP || "claude-sonnet-4-6";
const WEB_SEARCH_VERSION = process.env.WEB_SEARCH_VERSION || "web_search_20260209";

// Search limits per mode
const LIMITS = {
  fast: { models: 4, forum: 3, max_tokens: 2500 },
  deep: { models: 8, forum: 6, max_tokens: 3500 }
};

// Allowed domains for model search — covers all 5 target repos
const MODEL_DOMAINS = [
  "makerworld.com",
  "printables.com",
  "thingiverse.com",
  "myminifactory.com",
  "cults3d.com"
];

// Allowed domains for forum/diagnostic search
const FORUM_DOMAINS = [
  "forum.prusa3d.com",
  "reddit.com",
  "community.bambulab.com",
  "ellis3d.github.io",
  "teachingtechyt.github.io",
  "docs.prusa3d.com",
  "wiki.bambulab.com",
  "all3dp.com"
];

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

// ── SYSTEM PROMPTS ────────────────────────────────────────────────

const FORUM_PROMPT_CS = `Jsi PrintGenie AI Scout — expert na FDM 3D tisk. Pomáháš lidem řešit problémy s tiskem na základě SKUTEČNÝCH řešení z komunitních fór.

POSTUP:
1. Pochop problém (tiskárna, filament, symptom).
2. Proveď 2–4 web_search dotazy s různými klíčovými slovy (anglicky pro lepší pokrytí).
3. Vyber nejlepší ověřená řešení, prioritizuj ta, která fungovala víc lidem.
4. Pro každé řešení uveď PŘESNÉ hodnoty (°C, mm, mm/s, %) — žádné vágní rady.

ZDROJE:
- forum.prusa3d.com — Prusa fórum (špičkové)
- reddit.com/r/FixMyPrint, r/3Dprinting, r/prusa3d, r/BambuLab
- community.bambulab.com — Bambu Lab komunita
- ellis3d.github.io — Ellis3D Print Tuning Guide
- teachingtechyt.github.io — Teaching Tech calibration
- docs.prusa3d.com — oficiální Prusa dokumentace

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
- reddit.com/r/FixMyPrint, r/3Dprinting, r/prusa3d, r/BambuLab
- community.bambulab.com — Bambu Lab community
- ellis3d.github.io — Ellis3D Print Tuning Guide
- teachingtechyt.github.io — Teaching Tech calibration
- docs.prusa3d.com — official Prusa docs

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

// FAST mode — concise, fewer instructions, faster output
const MODELS_PROMPT_FAST_CS = `Jsi Model Scout. Najdi 3D modely podle dotazu, RYCHLE.

POSTUP:
1. Pokud je dotaz česky/laicky, přelož na anglická klíčová slova.
2. Proveď 2–3 web_search dotazy přes makerworld.com, printables.com, thingiverse.com.
3. Vyber 6–8 nejlepších výsledků (preferuj víc stažení, lepší hodnocení).
4. NEVYMÝŠLEJ čísla — pokud neznáš stažení/hodnocení, pole vynech.

Vrať POUZE platný JSON (bez markdown):
{
  "search_summary": "co jsi hledal",
  "models": [
    {"name":"...","author":"...","site":"MakerWorld|Printables|Thingiverse|MyMiniFactory|Cults3D","url":"https://...","license":"...","free":true,"downloads":"...","rating":"...","description":"...","material":"PLA|PETG|TPU..."}
  ],
  "tip": "praktický tip"
}`;

const MODELS_PROMPT_FAST_EN = `You are Model Scout. Find 3D models for the query, FAST.

WORKFLOW:
1. If query is informal, translate to English keywords.
2. Run 2–3 web_search queries across makerworld.com, printables.com, thingiverse.com.
3. Pick 6–8 best results (prefer more downloads, better ratings).
4. DO NOT make up numbers — if you don't know downloads/rating, omit the field.

Return ONLY valid JSON (no markdown):
{
  "search_summary": "what you searched",
  "models": [
    {"name":"...","author":"...","site":"MakerWorld|Printables|Thingiverse|MyMiniFactory|Cults3D","url":"https://...","license":"...","free":true,"downloads":"...","rating":"...","description":"...","material":"PLA|PETG|TPU..."}
  ],
  "tip": "practical tip"
}`;

// DEEP mode — thorough, multi-step, higher quality
const MODELS_PROMPT_DEEP_CS = `Jsi PrintGenie Model Scout — expert na hledání 3D modelů. Tvým úkolem je najít SKUTEČNÉ, existující modely na hlavních repozitářích.

KLÍČOVÝ POSTUP — MUSÍŠ ho vždy dodržet:
1. Pokud je dotaz česky nebo laický ("věc co drží telefon u postele"), nejprve si přelož na 2–3 anglické varianty klíčových slov.
   Příklad: "věšák na klíče do předsíně" → ["wall key holder", "entryway key hook", "hallway key organizer"]
2. PROVEĎ MINIMÁLNĚ 3 různé web_search dotazy s různými variantami a doménami:
   - site:makerworld.com [keywords]
   - site:printables.com [keywords]
   - site:thingiverse.com [keywords]
   - rozšiř i na cults3d.com a myminifactory.com
3. Z výsledků vyber 6–8 NEJLEPŠÍCH modelů podle:
   - počtu stažení (čím víc, tím lépe)
   - hodnocení (4+ hvězd ideálně)
   - relevance k dotazu
   - kvality popisu a fotek
4. OVĚŘ že URL vede na konkrétní model (ne na kategorii ani search results).
5. Pokud najdeš méně než 6 kvalitních výsledků, řekni to v search_summary.

ZDROJE V POŘADÍ KVALITY:
1. makerworld.com (Bambu Lab — nejmodernější, vysoká kvalita)
2. printables.com (Prusa — silná komunita)
3. thingiverse.com (největší databáze)
4. myminifactory.com (prémiové modely)
5. cults3d.com (designérské)

Vrať POUZE platný JSON (bez markdown backticks, bez textu mimo JSON):
{
  "search_summary": "stručně co jsi hledal a kolik různých dotazů jsi provedl",
  "models": [
    {
      "name": "přesný název modelu",
      "author": "jméno autora",
      "site": "MakerWorld" | "Printables" | "Thingiverse" | "MyMiniFactory" | "Cults3D",
      "url": "https://... PŘÍMÝ odkaz na konkrétní model",
      "license": "CC BY 4.0" | "CC BY-NC" | "Standard Digital License" | atd.,
      "free": true | false,
      "downloads": "počet stažení pokud opravdu znáš (např. '12.5k')",
      "rating": "hodnocení pokud opravdu znáš (např. '4.8/5')",
      "description": "krátký popis modelu, 1–2 věty",
      "recommended_for": "pro koho je vhodný / k čemu se hodí",
      "material": "doporučený materiál (PLA, PETG, TPU...)"
    }
  ],
  "tip": "praktický tip pro tisk této kategorie modelů"
}

DŮLEŽITÁ PRAVIDLA:
- Vrať MINIMÁLNĚ 6 modelů (ideálně 8).
- Hodnocení (rating) a stažení (downloads) uváděj POUZE pokud je opravdu vidíš ve výsledcích — NEVYMÝŠLEJ čísla. Když neznáš, pole vynech.
- URL musí být skutečné a funkční — žádné fiktivní odkazy.
- Modely seřaď podle kvality (nejlepší první).`;

const MODELS_PROMPT_DEEP_EN = `You are PrintGenie Model Scout — expert at finding 3D models. Your job is to find REAL, existing models on the main repositories.

KEY WORKFLOW — always follow it:
1. If the query is informal ("thing that holds my phone by the bed"), first translate to 2–3 English keyword variants.
   Example: "phone holder bed" → ["bedside phone stand", "phone dock nightstand", "wall phone mount bed"]
2. RUN AT LEAST 3 different web_search queries with different variants and domains:
   - site:makerworld.com [keywords]
   - site:printables.com [keywords]
   - site:thingiverse.com [keywords]
   - extend to cults3d.com and myminifactory.com
3. From results pick the 6–8 BEST models based on:
   - download count (higher = better)
   - rating (4+ stars ideally)
   - relevance to query
   - quality of description and photos
4. VERIFY the URL leads to a specific model (not a category or search results).
5. If you find fewer than 6 quality results, say so in search_summary.

SOURCES BY QUALITY:
1. makerworld.com (Bambu Lab — most modern, high quality)
2. printables.com (Prusa — strong community)
3. thingiverse.com (largest database)
4. myminifactory.com (premium models)
5. cults3d.com (designer models)

Return ONLY valid JSON (no markdown backticks, no text outside JSON):
{
  "search_summary": "brief description of what you searched and how many different queries you ran",
  "models": [
    {
      "name": "exact model name",
      "author": "author name",
      "site": "MakerWorld" | "Printables" | "Thingiverse" | "MyMiniFactory" | "Cults3D",
      "url": "https://... DIRECT link to the specific model",
      "license": "CC BY 4.0" | "CC BY-NC" | "Standard Digital License" | etc.,
      "free": true | false,
      "downloads": "download count if you actually know it (e.g. '12.5k')",
      "rating": "rating if you actually know it (e.g. '4.8/5')",
      "description": "short model description, 1–2 sentences",
      "recommended_for": "who it's suitable for / use case",
      "material": "recommended material (PLA, PETG, TPU...)"
    }
  ],
  "tip": "practical tip for printing this category of models"
}

IMPORTANT RULES:
- Return AT LEAST 6 models (ideally 8).
- Only include rating and downloads if you actually see them in results — DO NOT make up numbers. Omit the field if unknown.
- URLs must be real and working — no fictional links.
- Sort models by quality (best first).`;

// ── HANDLER ────────────────────────────────────────────────

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
  const speed = (body.speed === "deep") ? "deep" : "fast"; // default: fast
  const query = (body.query || "").trim().slice(0, 500);
  const printer = (body.printer || "").trim().slice(0, 80);
  const filament = (body.filament || "").trim().slice(0, 40);

  if (!query) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing query" }) };

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
    if (speed === "deep") {
      systemPrompt = lang === "cs" ? MODELS_PROMPT_DEEP_CS : MODELS_PROMPT_DEEP_EN;
    } else {
      systemPrompt = lang === "cs" ? MODELS_PROMPT_FAST_CS : MODELS_PROMPT_FAST_EN;
    }
    userMessage = lang === "cs"
      ? `Najdi mi nejlepší 3D modely pro: ${query}`
      : `Find me the best 3D models for: ${query}`;
    maxSearches = limits.models;
    allowedDomains = MODEL_DOMAINS;
  } else {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid mode" }) };
  }

  try {
    const reqBody = JSON.stringify({
      model: model,
      max_tokens: limits.max_tokens,
      tools: [{
        type: WEB_SEARCH_VERSION,
        name: "web_search",
        max_uses: maxSearches,
        allowed_domains: allowedDomains
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
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Invalid response from AI provider" }) };
    }

    if (result.status !== 200) {
      return { statusCode: result.status, headers, body: JSON.stringify({ error: data.error?.message || "API error" }) };
    }

    // Find the LAST text block (after all web_search tool calls)
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const textBlock = textBlocks[textBlocks.length - 1];

    if (!textBlock) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "No text response from AI" }) };
    }

    // Clean up JSON — strip markdown fences if present
    let jsonStr = textBlock.text.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    // Try to extract JSON if there's surrounding text
    if (!jsonStr.startsWith("{")) {
      const match = jsonStr.match(/\{[\s\S]*\}/);
      if (match) jsonStr = match[0];
    }

    try {
      const parsed = JSON.parse(jsonStr);
      // Attach metadata about which mode was used
      parsed._meta = { speed, model };
      return { statusCode: 200, headers, body: JSON.stringify(parsed) };
    } catch (e) {
      // Return raw text so frontend can display something
      return { statusCode: 200, headers, body: JSON.stringify({ raw: textBlock.text, _meta: { speed, model } }) };
    }

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || "Server error" }) };
  }
};
