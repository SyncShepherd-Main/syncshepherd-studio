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

PageCast takes any public URL (or pages from your Content Library) and generates broadcast-ready media scripts using Claude AI:

- **Video Script** — scene-by-scene with visual cues, B-roll notes, on-screen text
- **Dual-Host Podcast** — ALEX + MORGAN dialogue with stage directions
- **TTS Narration** — spoken-word prose optimized for audio

Scripts can be copied, downloaded as .txt, played via browser speech synthesis, or exported as MP3 via ElevenLabs (uses API credits).

## Architecture

```
Browser (React/Vite)
    |
    |--- GET /?url=<url>       --> Worker fetches & cleans page
    |--- GET /?url=<url>&links --> Worker fetches page + discovers internal links
    |--- POST /generate        --> Worker proxies to Anthropic Messages API
    |--- POST /tts             --> Worker proxies to ElevenLabs TTS API
    |
Cloudflare Worker (pagecast-fetcher)
    |--- API keys stored as Worker Secrets (never exposed to browser)
    |--- ANTHROPIC_API_KEY
    |--- ELEVENLABS_API_KEY
```

**Key design:** All API keys live on the Worker as secrets. The React app only knows the Worker URL — it never touches Anthropic or ElevenLabs directly.

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
```

### 3. Configure app environment

```bash
cp app/.env.example app/.env
```

`app/.env` for local dev:
```
VITE_WORKER_URL=http://localhost:8787
```

For production builds:
```
VITE_WORKER_URL=https://pagecast-fetcher.syncshepherd.workers.dev
```

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
```

### Deploy the App (Cloudflare Pages)

```bash
cd app

# Set production Worker URL in .env
echo "VITE_WORKER_URL=https://pagecast-fetcher.syncshepherd.workers.dev" > .env

# Build and deploy
npx vite build
npx wrangler pages deploy dist --project-name pagecast
```

### Access Control (Cloudflare Zero Trust)

The app is locked down via Cloudflare Access:

1. Go to https://one.dash.cloudflare.com -> Access -> Applications
2. Application: `pagecast-a6g.pages.dev`
3. Policy: Allow — Emails — (your email only)

## Worker API Reference

### GET /?url=\<encoded-url\>

Fetches a public URL, strips HTML to clean text.

```json
{
  "url": "https://example.com/page",
  "text": "Cleaned page content...",
  "wordCount": 1234,
  "fetchedAt": "2026-03-08T..."
}
```

### GET /?url=\<encoded-url\>&links=true

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
| Cloudflare Access (Zero Trust) | Needs setup |

## Project Structure

```
syncshepherd-studio/
├── worker/                    # Cloudflare Worker
│   ├── src/index.js           #   Routes: GET /?url, POST /generate, POST /tts
│   ├── .dev.vars              #   Local dev secrets (gitignored)
│   ├── wrangler.toml          #   Worker config
│   └── package.json
├── app/                       # React app (Vite)
│   ├── src/
│   │   ├── main.jsx           #   React entry point
│   │   └── App.jsx            #   PageCast — all UI + logic (974 lines)
│   ├── dist/                  #   Production build output (gitignored)
│   ├── index.html             #   HTML shell + Google Fonts
│   ├── vite.config.js
│   ├── .env                   #   VITE_WORKER_URL (gitignored)
│   ├── .env.example           #   Template
│   └── package.json
├── ContentStudio.jsx          # Original Phase 1 artifact (reference only)
├── package.json               # Root scripts (concurrently)
├── .gitignore
└── README.md
```

## Content Library

The Content Library tab browses a connected GitHub repo and fetches files via raw.githubusercontent.com through the Worker proxy. The repo URL is configured in `App.jsx` (`RepoFilePicker` component).
