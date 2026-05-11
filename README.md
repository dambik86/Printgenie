# PrintGenie v40 BASIC PROTECTION

Tahle verze obsahuje základní ochranu pro veřejný web:

## Hotovo v kódu
- OpenAI API klíč zůstává pouze v Netlify Environment Variables.
- `/api/analyze` běží přes Netlify Function.
- Rate limit: výchozí 5 AI požadavků / 10 minut / IP.
- Limit velikosti requestu: výchozí 6 MB.
- Limit uploadované fotky ve frontendu: 5 MB.
- Povolené typy fotek: JPG, PNG, WEBP.
- Povolené modely přes allowlist.
- Max token cap, aby odpovědi nespalovaly kredit.
- Security headers v `netlify.toml`.
- Připravená Cloudflare Turnstile ochrana.

## Netlify Environment Variables
Povinné:

```txt
OPENAI_API_KEY=sk-...
```

Volitelné:

```txt
RATE_LIMIT_MAX=5
RATE_LIMIT_WINDOW_MS=600000
MAX_BODY_BYTES=6291456
MAX_TOKENS_CAP=2500
ALLOWED_MODELS=gpt-4o-mini,gpt-4o,gpt-4.1-mini
ALLOWED_ORIGIN=https://printgenieai.com
TURNSTILE_SECRET_KEY=...
```

## Doporučené nastavení na start
- Používej hlavně `gpt-4o-mini`, protože je levnější.
- V OpenAI nastav hard limit rozpočtu.
- V Cloudflare nech zapnutou základní bot/DDoS ochranu.
- Turnstile zapni až po vytvoření site key a secret key v Cloudflare.

## Poznámka k Turnstile
Když `TURNSTILE_SECRET_KEY` není nastavený, captcha se přeskočí. Aplikace funguje normálně.
Když ho nastavíš, backend bude vyžadovat Turnstile token.
