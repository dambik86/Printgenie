# PrintGenie — Nasazení na Netlify (ZDARMA)

## Co potřebuješ:
- GitHub účet → github.com
- Netlify účet → netlify.com  
- OpenAI API klíč → platform.openai.com (máš $9.88 kredit)

---

## KROK 1: OpenAI API klíč
1. Jdi na https://platform.openai.com
2. Vlevo menu → API keys
3. Klikni "Create new secret key"
4. Zkopíruj klíč (sk-...)

---

## KROK 2: Nahraj na GitHub
1. github.com → přihlas se → zelené tlačítko "New"
2. Pojmenuj "printgenie" → Create repository
3. Klikni "uploading an existing file"  
4. Přetáhni VŠECHNY soubory z tohoto balíčku:
   - index.html
   - netlify.toml
   - netlify/functions/analyze.js  (celou složku netlify!)
5. Commit changes

---

## KROK 3: Nasaď na Netlify
1. app.netlify.com → přihlas se přes GitHub
2. "Add new site" → "Import an existing project"
3. Vyber GitHub → najdi "printgenie"
4. Klikni "Deploy site"
5. Po nasazení: Site configuration → Environment variables
6. Klikni "Add a variable":
   - Key: OPENAI_API_KEY
   - Values: tvůj klíč sk-...
   - Klikni Save
7. Jdi do Deploys → Trigger deploy → Deploy site

---

## HOTOVO!
Web běží na: https://printgenie-XXXXX.netlify.app

## Náklady:
- Netlify: ZDARMA (125k function calls/měsíc)
- OpenAI GPT-4o: ~$0.01 za analýzu textu, ~$0.02 za analýzu fotky
- S tvým kreditem $9.88 = stovky analýz

## Vlastní doména:
Domain management → Add custom domain → zadej svoji doménu
