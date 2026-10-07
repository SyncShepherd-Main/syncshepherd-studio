# SyncShepherd Studio — PageCast

**URL to Broadcast Engine** by SyncShepherd Digital Solutions

## Live URLs

| Service | URL |
|---------|-----|
| App (Cloudflare Pages) | https://pagecast-a6g.pages.dev |
| Worker (Cloudflare Workers) | https://pagecast-fetcher.syncshepherd.workers.dev |
| GitHub Repo | https://github.com/SyncShepherd-Main/syncshepherd-studio |

Access is restricted via Cloudflare Zero Trust (Access policy on the Pages domain).

## What It Does

PageCast has three inputs: **Enter URL**, **Content Library**, and **Upload PDF**.

**Scripts (Claude AI).** From a URL, Content Library pages, or a PDF, PageCast generates broadcast-ready scripts:

- **Video Script** — scene-by-scene with visual cues, B-roll notes, on-screen text
- **Dual-Host Podcast** — ALEX + MORGAN dialogue with stage directions
- **TTS Narration** — spoken-word prose optimized for audio
- **Tell the Story** — narrative prose

Scripts can be copied, downloaded as .txt, played, or exported as MP3 (OpenAI, ElevenLabs, or free browser voice).

**PDF → audiobook (no Claude).** Drop a PDF and **Read it word-for-word**:

- Text is extracted in the browser (pdf.js). Running headers, footers, and page numbers are removed.
- **What to narrate:** an include/skip checkbox for each chapter. Contents, Sources, References, and Index start unchecked. An editable **spoken intro** (title + author) replaces the front page.
- **Voice + Vibe:**
  - **Standard** uses `tts-1`, the most literal reading.
  - Vibes (Storyteller, Educational, …) use `gpt-4o-mini-tts` with tone instructions.
  - **▶ Preview** plays about 15 s of the real opening, for under $0.01.
- One MP3 of any length downloads automatically. The text is split into chunks of 4,000 characters or fewer and rendered in parallel.
- **Create share page:** a public listen + read-along link with an optional password. See [Share pages](#share-pages).

## Architecture

```
Browser (React/Vite, pagecast-a6g.pages.dev — behind Zero Trust)
    |
    |--- /api/*  --> Pages Function app/functions/api/[[path]].js
    |                 adds X-PageCast-Key (WORKER_KEY) server-side
    |
Cloudflare Worker (pagecast-fetcher.syncshepherd.workers.dev)
    |--- every route except /s/... requires X-PageCast-Key (== PAGECAST_KEY)
    |--- /fetch, /generate, /tts, /tts-openai, /subscription, /openai-billing, /share...
    |--- /s/<id>  public share pages (optional password)
    |--- R2 bucket pagecast-shares (binding SHARES)
    |--- Secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY, PAGECAST_KEY
```

**Key design:**
- All API keys live on the Worker as secrets. The browser never sees them, or the Worker key.
- The workers.dev URL is public, so the Worker refuses anything without the key and **fails closed** if `PAGECAST_KEY` is unset.
- Only share pages are open to the public.

## Branding

Uses SyncShepherd brand identity:
- **Primary Blue:** #0f70b7
- **Accent Gold:** #eeaf00
- **Dark Navy:** #192534
- **Fonts:** Heebo (headings), Roboto (body), Roboto Mono (code/labels)

## Local Development

### Prerequisites

- Node.js 18+
- npm
- Cloudflare account (for Worker)

### 1. Install dependencies

```bash
npm run install:all
```

### 2. Configure Worker secrets (local dev)

Create `worker/.dev.vars`:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
ELEVENLABS_API_KEY=your-elevenlabs-key
OPENAI_API_KEY=your-openai-key
PAGECAST_KEY=dev-key
```

`PAGECAST_KEY` must match the key the Vite dev proxy sends (`dev-key` unless you set `PAGECAST_KEY` in your shell).

### 3. Configure app environment

```bash
cp app/.env.example app/.env
```

The app calls the Worker at `/api` in both dev and production, so `app/.env` can stay empty:
```
VITE_WORKER_URL=/api
```
- **Production:** `/api/*` is a Pages Function (`app/functions/api/[[path]].js`) behind Zero Trust that adds the Worker key.
- **Local dev:** Vite proxies `/api/*` to the Worker on :8787 with the dev key.

### 4. Run locally

```bash
npm run dev
```

Starts both servers concurrently:
- Vite dev server: http://localhost:5173
- Worker (Miniflare): http://localhost:8787

Or run separately:
```bash
npm run dev:worker   # Worker on :8787
npm run dev:app      # React app on :5173
```

## Deployment

### Deploy the Worker

```bash
cd worker
npx wrangler login          # one-time browser OAuth
npx wrangler deploy
```

Set secrets (one-time, or when keys change):
```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put OPENAI_API_KEY
```

The Worker rejects every route except public `/s/…` share pages unless the request has `X-PageCast-Key`. Set the same random value on the Worker and on Pages (one-time):
```bash
K=$(openssl rand -hex 32)
echo "$K" | npx wrangler secret put PAGECAST_KEY
echo "$K" | npx wrangler pages secret put WORKER_KEY --project-name pagecast
```

### Deploy the App (Cloudflare Pages)

```bash
cd app

# Calls go through the /api Pages Function
echo "VITE_WORKER_URL=/api" > .env

# Build and deploy
npx vite build
npx wrangler pages deploy dist --project-name pagecast
```

### Access Control (Cloudflare Zero Trust)

The app is locked down via Cloudflare Access:

1. Go to https://one.dash.cloudflare.com -> Access -> Applications
2. Application: `pagecast-a6g.pages.dev` (this also covers `/api/*`)
3. Policy: Allow — emails ending in `@syncshepherd.com` (add individual outside emails as needed)

### Deploy order when the Worker key changes

Set the secrets, then deploy Pages, then the Worker. If the Worker goes first, the live app breaks until Pages catches up. Day to day, deploy only what changed.

> **Merges and deploys:** Claude Code's auto mode blocks `gh pr merge`, `wrangler deploy`, and `wrangler pages deploy`. Run them yourself with a `!` line.

## Worker API Reference

All routes except `/s/...` need the `X-PageCast-Key` header. The app calls them as `/api/<route>`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/fetch?url=<url>[&links=true]` | Fetch & clean a public URL (any unmatched GET also lands here) |
| POST | `/generate` | Anthropic Messages API proxy |
| POST | `/tts` | ElevenLabs TTS proxy |
| POST | `/tts-openai` | OpenAI speech: `{ text, voice, model: tts-1 \| tts-1-hd \| gpt-4o-mini-tts, instructions? }` |
| GET | `/subscription`, `/openai-billing` | Credit / billing info |
| POST | `/share` | Start a share page: `{ title, voice, pdfName, segments, chapters, password? }` → `{ id }` |
| POST/PUT | `/share/<id>/<audio.mp3\|source.pdf>/start\|part\|complete` | R2 multipart upload (10 MB parts, ≤ 3 h window) |
| POST | `/share/<id>/finish` | Verify both files (PDF magic bytes), publish → `{ url }` |
| GET/HEAD | `/s/<id>[/audio.mp3\|/source.pdf]` | **Public** share page + files (Range supported) |
| POST | `/s/<id>/unlock` | **Public** password form → per-link cookie |

### GET /fetch?url=\<encoded-url\>

Fetches a public URL, strips HTML to clean text.

```json
{
  "url": "https://example.com/page",
  "text": "Cleaned page content...",
  "wordCount": 1234,
  "fetchedAt": "2026-03-08T..."
}
```

### GET /fetch?url=\<encoded-url\>&links=true

Same as above, plus discovers up to 10 internal links:

```json
{
  "url": "...",
  "text": "...",
  "wordCount": 1234,
  "links": ["https://example.com/page-2", "..."]
}
```

### POST /generate

Proxies to Anthropic Messages API. Body:

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 4000,
  "system": "System prompt...",
  "messages": [{ "role": "user", "content": "..." }]
}
```

### POST /tts

Proxies to ElevenLabs TTS API. Returns `audio/mpeg` stream. Body:

```json
{
  "text": "Text to speak",
  "voice_id": "pNInz6obpgDQGcFmaJgB",
  "model_id": "eleven_turbo_v2",
  "voice_settings": { "stability": 0.5, "similarity_boost": 0.75 }
}
```

## ElevenLabs Voice Setup

Voices are hardcoded in the app:
- **ALEX** (Adam): `pNInz6obpgDQGcFmaJgB`
- **MORGAN** (Matilda): `XrExE9yKIg1WjnnlVkGX`

Podcast format uses both voices (dual-voice). Video and TTS use ALEX only.

**Credit budget:** A typical 1,200-word podcast script is ~7,500 characters. The app shows character count before each MP3 export.

**What costs ElevenLabs credits:**
- "Play (AI Voice)" button
- "Export MP3" button

**What does NOT cost credits:**
- Fetching pages (Worker only)
- Generating scripts (Anthropic API, separate billing)
- Copy/Download text
- Browser SpeechSynthesis playback (free, uses computer voices)

## Share pages

**Create share page** uploads three things to the R2 bucket `pagecast-shares` under `shares/<id>/`: the PDF, the MP3, and `meta.json` (sentence timings, chapters, optional password hash). The Worker serves `/s/<id>`:

- **Read-along:** the current sentence is highlighted, and tapping a sentence seeks there. Speed control, Follow along, and MP3 / PDF downloads.
- **☰ Contents:** chapters from the PDF's bookmarks (outline), or from larger-font headings when there are none. Tapping one jumps the audio, the text, and the PDF. A "Now:" line shows the current chapter.
- **Text | PDF view:** real pages rendered with pdf.js 4.10.38 from jsDelivr, following the audio. This works on phones, where iframe PDF viewers don't.
- **Resume:** the position is saved per device in `localStorage` (`pagecast.pos.<id>`). On return the page shows "Picked up where you left off — 1:02:13 · Chapter 4", with a **Start over** button.
- **Password (optional):** the creator's last password is pre-filled. Storage keeps only a salted PBKDF2 hash. A correct password sets a 1-year HttpOnly cookie scoped to `/s/<id>`. The audio and PDF files are locked too, and wrong guesses wait 1 s.
- **Privacy:** pages are `noindex`, and IDs are 128-bit random.

**Limits and costs:**
- Audio is about 60 MB per hour (OpenAI MP3: 128 kbps, 24 kHz).
- R2 free tier: 10 GB stored (about 40 four-hour books), unlimited egress, 10 M reads a month. Past that, storage is about $0.015 per GB-month.
- Share pages never expire, and there's no delete UI yet. Delete under `shares/<id>/` in R2.

**OpenAI narration cost:**
- **Standard (`tts-1`):** $0.015 per 1,000 characters.
- **Vibes (`gpt-4o-mini-tts`):** about $0.015 per audio minute. Slow vibes such as Storyteller run about 1.4× longer than Standard.
- All of it is billed to the OpenAI account behind `OPENAI_API_KEY`, from prepaid API credit.

## Features

| Feature | Status |
|---------|--------|
| Cloudflare Worker fetch proxy | Deployed |
| Anthropic API proxy (keys on Worker) | Deployed |
| ElevenLabs TTS proxy (keys on Worker) | Deployed |
| Three output formats (Video, Podcast, TTS) | Done |
| Content Library browser | Done |
| Multi-page crawl (up to 10 links) | Done |
| Dual-voice podcast MP3 (ALEX + MORGAN) | Done |
| Single-voice MP3 export | Done |
| Browser SpeechSynthesis fallback | Done |
| Copy + Download script export | Done |
| SyncShepherd branding | Done |
| Cloudflare Pages deployment | Done |
| Cloudflare Access (Zero Trust) | Done |
| OpenAI TTS (11 voices) + chunked long exports | Done |
| Voice ▶ Preview | Done |
| PDF upload → word-for-word MP3 (any length) | Done |
| Narration vibes, skip sections, spoken intro | Done |
| Share pages: read-along, chapters, PDF view, resume, password | Done |
| Worker lockdown via /api Pages Function | Done |

## Project Structure

```
syncshepherd-studio/
├── worker/                    # Cloudflare Worker
│   ├── src/index.js           #   All routes (see Worker API Reference)
│   ├── src/sharePage.js       #   Share, password and not-found page HTML
│   ├── .dev.vars              #   Local dev secrets (gitignored)
│   ├── wrangler.toml          #   Worker config
│   └── package.json
├── app/                       # React app (Vite)
│   ├── src/
│   │   ├── main.jsx           #   React entry point
│   │   └── App.jsx            #   PageCast — all UI + logic (single file)
│   ├── functions/api/[[path]].js  # Pages Function: /api/* → Worker + key
│   ├── dist/                  #   Production build output (gitignored)
│   ├── index.html             #   HTML shell + Google Fonts
│   ├── vite.config.js
│   ├── .env                   #   VITE_WORKER_URL=/api (gitignored)
│   ├── .env.example           #   Template
│   └── package.json
├── ContentStudio.jsx          # Original Phase 1 artifact (reference only)
├── package.json               # Root scripts (concurrently)
├── .gitignore
└── README.md
```

## Content Library

The Content Library tab browses a connected GitHub repo and fetches files via raw.githubusercontent.com through the Worker proxy. The repo URL is configured in `App.jsx` (`RepoFilePicker` component).
