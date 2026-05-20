# Derma 2026 — Conference AI Teaser

Open-ended chat over the Israeli Society of Dermatology & Venereology Annual Conference 2026 program. Attendees ask questions in Hebrew or English; Claude answers from the program file only.

Built for the **Practical AI Workshop for Dermatologists** at the conference (Friday June 5, 2026, 11:05–13:00).

---

## Architecture

```
GitHub Pages (static HTML/JS) ──fetch──> program.txt (same repo)
        │
        └──POST──> Vercel Serverless Function ──> Anthropic API
                   (holds ANTHROPIC_API_KEY in env var)
```

- **Frontend:** `index.html` — single-file vanilla JS chat UI, bilingual (EN/HE) with RTL support. Hosted on GitHub Pages.
- **Program data:** `program.txt` — raw conference program. The client fetches it at runtime, so editing the file and pushing to GitHub updates the live site instantly (no rebuild).
- **Backend:** `api/chat.js` — Vercel serverless proxy. Holds the Anthropic API key, applies CORS + rate limiting, uses prompt caching to keep costs down.

### Why this split?

- GitHub Pages can't keep an API key secret → Vercel function does.
- Vercel function is stateless → cheap, scales to zero, free tier covers a small conference.
- Program text is shipped client-side → instant updates by editing one file.
- Prompt caching on the system prompt (which contains the program text) → after the first hit, each subsequent call costs ~10% of an uncached one.

---

## File layout

```
.
├── index.html         # bilingual chat UI
├── program.txt        # conference program (the only source of truth for Claude)
├── api/
│   └── chat.js        # Vercel serverless proxy
├── vercel.json        # Vercel function config (30s max duration)
├── package.json       # pulls in @anthropic-ai/sdk for the function
├── .gitignore
└── README.md
```

---

## Local testing with `vercel dev`

You need both the static site and the serverless function running together. `vercel dev` does both.

```bash
# Once:
npm install -g vercel
npm install                                # installs @anthropic-ai/sdk

# Set your API key for local dev:
vercel env add ANTHROPIC_API_KEY           # paste key when prompted (choose: Development)
# OR put it in a local .env file:
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# Start the dev server:
vercel dev
```

Open <http://localhost:3000>. The frontend will fetch `program.txt` and POST to `/api/chat`, which runs `api/chat.js` locally with your key.

---

## Deployment

### Step 1 — Deploy the serverless function to Vercel

1. Push the repo to GitHub.
2. Go to <https://vercel.com/new> and import the repo.
3. Vercel auto-detects the `api/` folder and `package.json`. Click **Deploy**.
4. After the first deploy, go to **Settings → Environment Variables** and add:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** your key from <https://console.anthropic.com>
   - **Environments:** Production, Preview, Development
5. Redeploy (Deployments → ⋯ → Redeploy) so the function picks up the env var.

Your function URL will be something like `https://your-project.vercel.app/api/chat`.

### Step 2 — Deploy the static site to GitHub Pages

1. In the same repo, go to **Settings → Pages**.
2. **Source:** Deploy from a branch → `main` → `/ (root)` → Save.
3. Wait ~1 minute. Your site goes live at `https://your-username.github.io/your-repo/`.

### Step 3 — Wire the frontend to the Vercel function

The frontend currently POSTs to `/api/chat` (relative path). On GitHub Pages there's no `/api/chat`, so you need to point it at your Vercel URL.

In `index.html`, find the fetch call (~line 290):

```js
const resp = await fetch("/api/chat", {
```

Change it to your Vercel URL:

```js
const resp = await fetch("https://your-project.vercel.app/api/chat", {
```

Commit and push. GitHub Pages will rebuild within a minute.

> **Tip:** If you want to keep `vercel dev` working locally without a code switch, host the frontend on Vercel too (it'll serve `index.html` as a static file from the project root). Then GitHub Pages is optional.

### Restricting CORS (optional, recommended)

`api/chat.js` currently sets `Access-Control-Allow-Origin: *` so any site can call your function. To restrict to your GitHub Pages domain, edit `setCORS()` in `api/chat.js`:

```js
res.setHeader("Access-Control-Allow-Origin", "https://your-username.github.io");
```

---

## Updating the program

Edit `program.txt`, commit, push. GitHub Pages serves the new version within a minute. No rebuild, no redeploy.

---

## Cost & rate limiting

- **Model:** `claude-sonnet-4-6` (good balance of quality + cost for a public chat).
- **Prompt caching:** The system prompt (which includes the ~20KB program text) is cached. The first request of each 5-minute window pays full price; subsequent requests pay ~10% of input tokens.
- **Per-IP rate limit:** 20 requests / minute, enforced in-memory in the serverless function. Cold starts reset the counter, so it's best-effort — fine for a conference teaser, not bulletproof.
- **Function timeout:** 30 seconds (set in `vercel.json`).

Want to swap models? Change `MODEL` at the top of `api/chat.js`. Options: `claude-haiku-4-5` (cheapest), `claude-sonnet-4-6` (default), `claude-opus-4-7` (most capable).

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Frontend shows "Couldn't load the conference program" | `program.txt` missing or wrong path |
| Chat returns "Server not configured. Missing API key." | `ANTHROPIC_API_KEY` env var not set in Vercel (or not redeployed after setting it) |
| Browser console: CORS error | Wrong fetch URL, or CORS restricted to a domain that doesn't match |
| Chat returns "Too many requests" | Hit the 20/min limit — wait a minute |
| Vercel logs show 502 / "AI service error" | Upstream Anthropic API issue — usually transient |

To view function logs: Vercel dashboard → your project → Deployments → click a deployment → Functions → `api/chat.js`.
