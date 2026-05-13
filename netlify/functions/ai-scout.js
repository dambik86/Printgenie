// PrintGenie AI Scout — Anthropic API proxy with web search
// Uses claude-sonnet-4-20250514 + web_search_20250305 tool
// Two modes: "forum" (troubleshooting) and "models" (3D model search)

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000); // 10 min
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_SCOUT || 8);
const MAX_BODY_BYTES = 512 * 1024; // 512 KB — no image uploads on this endpoint

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
  return { allowed: cur.count <= MAX_REQUESTS, remaining: Math.max(0, MAX_REQUESTS - cur.count) };
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
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  if (Buffer.byteLength(event.body || "", "utf8") > MAX_BODY_BYTES) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: "Request too large" }) };
  }

  const ip = getIp(event);
  const rl = rateLimit(ip);
  if (!rl.allowed) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "Příliš mnoho dotazů. Počkej chvíli a zkus znovu. / Too many requests, please wait." }) };
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "API key not configured" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const mode = body.mode || "forum"; // "forum" | "models"
  const lang = body.lang || "cs";
  const query = (body.query || "").trim().slice(0, 500);
  const printer = (body.printer || "").trim().slice(0, 80);
  const filament = (body.filament || "").trim().slice(0, 40);

  if (!query) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing query" }) };

  let systemPrompt, userMessage;

  // ── FORUM MODE ────────────────────────────────────────────────────────────
  if (mode === "forum") {
    systemPrompt = lang === "cs"
      ? `Jsi PrintGenie AI Scout — expert na FDM 3D tisk. Používáš web search pro vyhledávání SKUTEČNÝCH vláken a diskuzí na těchto zdrojích (v tomto pořadí priority):
1. forum.prusa3d.com — Prusa Research oficiální fórum
2. reddit.com/r/FixMyPrint — nejlepší komunitní diagnostika
3. reddit.com/r/3Dprinting — obecné 3D tisk
4. reddit.com/r/prusa3d — Prusa specifické
5. reddit.com/r/BambuLab — Bambu Lab specifické
6. reddit.com/r/ender3 — Creality/Ender
7. community.bambulab.com — Bambu Lab komunita
8. ellis3d.github.io — Ellis calibration guide (vysoce autoritativní)
9. teachingtechyt.github.io — Teaching Tech průvodce
10. docs.prusa3d.com — Prusa dokumentace

INSTRUKCE:
- Vždy prohledej aspoň 2-3 zdroje před odpovědí
- Uváděj KONKRÉTNÍ HODNOTY: teploty °C, retrakce mm, rychlost mm/s, flow %, fan %
- Uváděj odkud rada pochází (název fóra nebo webu)
- Seřaď opravy od nejpravděpodobnější příčiny
- Odpovídej česky, buď přátelský k začátečníkům ale technicky přesný
- Formátuj pomocí HTML: h3, ul/li, strong

Vrať POUZE JSON (bez markdown):
{
  "diagnosis": "krátká diagnóza 1-2 věty",
  "sources_searched": ["prusa forum", "reddit r/FixMyPrint", ...],
  "solutions": [
    {
      "title": "název řešení",
      "probability": "Nejpravděpodobnější / Možné / Méně časté",
      "steps": ["krok 1", "krok 2"],
      "values": "přesné hodnoty: např. teplota 210-220°C, retrakce 0.8mm",
      "source": "název zdroje",
      "source_url": "https://..."
    }
  ],
  "quick_tip": "jeden rychlý tip pro začátečníky"
}`
      : `You are PrintGenie AI Scout — an FDM 3D printing expert. You use web search to find REAL threads and discussions from these sources (priority order):
1. forum.prusa3d.com — Prusa Research official forum
2. reddit.com/r/FixMyPrint — best community diagnostics
3. reddit.com/r/3Dprinting — general 3D printing
4. reddit.com/r/prusa3d — Prusa specific
5. reddit.com/r/BambuLab — Bambu Lab specific
6. reddit.com/r/ender3 — Creality/Ender
7. community.bambulab.com — Bambu Lab community
8. ellis3d.github.io — Ellis calibration guide (highly authoritative)
9. teachingtechyt.github.io — Teaching Tech guide
10. docs.prusa3d.com — Prusa documentation

INSTRUCTIONS:
- Always search at least 2-3 sources before answering
- Give EXACT VALUES: temperatures °C, retraction mm, speed mm/s, flow %, fan %
- State where each recommendation comes from
- Rank fixes from most probable cause
- Be beginner-friendly but technically precise
- Format using HTML: h3, ul/li, strong

Return ONLY JSON (no markdown):
{
  "diagnosis": "short diagnosis 1-2 sentences",
  "sources_searched": ["prusa forum", "reddit r/FixMyPrint", ...],
  "solutions": [
    {
      "title": "solution title",
      "probability": "Most likely / Possible / Less common",
      "steps": ["step 1", "step 2"],
      "values": "exact values: e.g. temp 210-220°C, retraction 0.8mm",
      "source": "source name",
      "source_url": "https://..."
    }
  ],
  "quick_tip": "one quick beginner tip"
}`;

    const printerInfo = printer ? `Tiskárna: ${printer}` : "";
    const filamentInfo = filament ? `Filament: ${filament}` : "";
    const ctx = [printerInfo, filamentInfo].filter(Boolean).join(", ");
    userMessage = ctx ? `${ctx}\nProblém: ${query}` : query;

  // ── MODELS MODE ───────────────────────────────────────────────────────────
  } else if (mode === "models") {
    systemPrompt = lang === "cs"
      ? `Jsi PrintGenie Model Scout — asistent pro hledání 3D modelů. Vyhledáváš modely na těchto VEŘEJNÝCH repozitářích (vše legální, modely jsou volně dostupné):
1. makerworld.bambulab.com — Bambu Lab MakerWorld (největší, nejkvalitnější)
2. printables.com — Prusa Printables (komunitní, vysoká kvalita)
3. thingiverse.com — Thingiverse (největší databáze)
4. myminifactory.com — MyMiniFactory (prémiové modely)
5. cults3d.com — Cults3D (designérské modely)

INSTRUKCE:
- Vyhledej skutečné modely na těchto stránkách
- Pro každý model uveď: název, web, přímý odkaz, autor, licence, počet stažení pokud dostupný
- Seřaď podle relevance a kvality
- Uveď zda je model zdarma nebo placený
- Odpovídej česky

Vrať POUZE JSON (bez markdown):
{
  "search_summary": "co jsi prohledal",
  "models": [
    {
      "name": "název modelu",
      "author": "autor",
      "site": "MakerWorld / Printables / Thingiverse / ...",
      "url": "https://...",
      "license": "CC BY / CC BY-SA / Free / ...",
      "free": true,
      "downloads": "počet nebo null",
      "description": "krátký popis 1 věta",
      "recommended_for": "pro koho/co se hodí"
    }
  ],
  "tip": "tip pro tisk tohoto modelu"
}`
      : `You are PrintGenie Model Scout — a 3D model finder assistant. You search models on these PUBLIC repositories (all legal, models are freely available):
1. makerworld.bambulab.com — Bambu Lab MakerWorld (largest, highest quality)
2. printables.com — Prusa Printables (community, high quality)
3. thingiverse.com — Thingiverse (largest database)
4. myminifactory.com — MyMiniFactory (premium models)
5. cults3d.com — Cults3D (designer models)

INSTRUCTIONS:
- Search for real models on these sites
- For each model include: name, site, direct link, author, license, downloads if available
- Sort by relevance and quality
- Indicate if free or paid

Return ONLY JSON (no markdown):
{
  "search_summary": "what you searched",
  "models": [
    {
      "name": "model name",
      "author": "author",
      "site": "MakerWorld / Printables / Thingiverse / ...",
      "url": "https://...",
      "license": "CC BY / CC BY-SA / Free / ...",
      "free": true,
      "downloads": "count or null",
      "description": "short description 1 sentence",
      "recommended_for": "who/what it's best for"
    }
  ],
  "tip": "tip for printing this model"
}`;

    userMessage = query;
  } else {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid mode" }) };
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return { statusCode: response.status, headers, body: JSON.stringify({ error: data.error?.message || "API error" }) };
    }

    // Extract text from content blocks (may contain tool_use + tool_result + text)
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "No response from AI" }) };
    }

    let jsonStr = textBlock.text.trim().replace(/^```json\s*/,"").replace(/\s*```$/,"").trim();

    // Validate it's parseable JSON before returning
    try { JSON.parse(jsonStr); } catch(e) {
      // Return raw text wrapped if not valid JSON
      return { statusCode: 200, headers, body: JSON.stringify({ raw: jsonStr }) };
    }

    return { statusCode: 200, headers, body: jsonStr };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || "Server error" }) };
  }
};
