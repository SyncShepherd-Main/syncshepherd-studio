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

PageCast takes any public URL, fetches the full page content server-side via a Cloudflare Worker, and generates broadcast-ready media scripts using Claude AI. Six output formats are available:

- **Video Script** — scene-by-scene with visual cues, B-roll notes, on-screen text (gold accent)
- **Dual-Host Podcast** — ALEX + MORGAN dialogue with stage directions (blue accent)
- **TTS Narration** — audio-optimised spoken-word prose (teal accent)
- **Tell the Story** — compelling narrative prose from any content (purple accent)
- **Word for Word** — verbatim source text, no AI rewriting (grey accent)
- **Summary** — detailed 300–1,500 word summary scaled to source length (orange accent)

### Voice Engines

Three voice/speech engines are available, selectable per session:

| Engine | Cost | Quality | Notes |
|--------|------|---------|-------|
| **OpenAI TTS** | ~$0.015/1K chars | High — 11 voices | Default. Parallel batch rendering. |
| **ElevenLabs** | Per subscription plan | Very high — 6 voices | Dual-voice podcast support. |
| **Browser Voice** | Free | Varies by OS/browser | Uses Web SpeechSynthesis API. |

### Vibe System

A "vibe" selector injects tone instructions into the Claude system prompt before generation:

- Professional, Casual, Energetic, Storyteller, Educational, Humorous

### Post-Generation Tools

- **Regenerate** — re-runs script generation from the same fetched source text (no re-fetch)
- **Edit Transcript** — opens an editable textarea; save changes and Play/Export uses the edited text
- **Copy / Download** — clipboard or .txt file
- **Play** — in-browser audio playback via selected voice engine
- **Export MP3** — renders and downloads full MP3 via selected voice engine

## Architecture

```
Browser (React/Vite)
    |
    |--- GET /?url=<url>          --> Worker fetches & cleans page
    |--- GET /?url=<url>&links    --> Worker fetches page + discovers internal links
    |--- POST /generate           --> Worker proxies to Anthropic Messages API
    |--- POST /tts                --> Worker proxies to ElevenLabs TTS API
    |--- POST /tts-openai         --> Worker proxies to OpenAI TTS API
    |--- GET  /subscription       --> Worker returns ElevenLabs usage info
    |--- GET  /openai-billing     --> Worker returns OpenAI billing/balance info
    |
Cloudflare Worker (pagecast-fetcher)
    |--- API keys stored as Worker Secrets (never exposed to browser)
    |--- ANTHROPIC_API_KEY
    |--- ELEVENLABS_API_KEY
    |--- OPENAI_API_KEY
```

**Key design:** All API keys live on the Worker as secrets. The React app only knows the Worker URL — it never touches Anthropic, ElevenLabs, or OpenAI directly.

## Branding

Uses SyncShepherd brand identity:
- **Primary Blue:** #0f70b7
- **Accent Gold:** #eeaf00
- **Dark Navy:** #192534
- **Fonts:** Heebo (headings), Roboto (body), Roboto Mono (code/labels)

## Security

- All API keys stored as Cloudflare Worker Secrets (production) or `.dev.vars` (local dev)
- Frontend contains zero credentials — only the Worker URL
- `.gitignore` covers `.env`, `.dev.vars`, `dist/`, `node_modules/`
- CORS currently set to `*` (open) — consider restricting to `https://pagecast-a6g.pages.dev` in production
- Input validation on all Worker routes (URL format, JSON body, required fields)
- ElevenLabs voice IDs are public identifiers, not secrets

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
OPENAI_API_KEY=sk-your-openai-key-here
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
npx wrangler secret put OPENAI_API_KEY
```

### Deploy the App (Cloudflare Pages)

**IMPORTANT:** Always use `--branch main` to deploy to production. Without it, deploys go to a Preview URL instead.

```bash
cd app

# Set production Worker URL in .env
echo "VITE_WORKER_URL=https://pagecast-fetcher.syncshepherd.workers.dev" > .env

# Build and deploy to production
npx vite build
npx wrangler pages deploy dist --project-name pagecast --branch main
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

### POST /tts-openai

Proxies to OpenAI TTS API. Returns `audio/mpeg` stream. Body:

```json
{
  "text": "Text to speak (max ~4096 chars per request)",
  "voice": "onyx",
  "model": "tts-1"
}
```

### GET /subscription

Returns ElevenLabs character usage:

```json
{
  "character_count": 1234,
  "character_limit": 10000
}
```

### GET /openai-billing

Returns OpenAI monthly cost and/or credit balance (if available). Falls back to `{ rate: 0.015 }` if billing endpoints aren't accessible.

## Voice Configuration

### OpenAI TTS Voices (11 options)

| Key | Voice | Description |
|-----|-------|-------------|
| onyx | Onyx | Deep, authoritative |
| alloy | Alloy | Neutral, balanced |
| echo | Echo | Warm, engaging |
| fable | Fable | Expressive, British |
| nova | Nova | Friendly, upbeat |
| shimmer | Shimmer | Soft, clear |
| ash | Ash | Conversational |
| coral | Coral | Warm, natural |
| sage | Sage | Calm, wise |
| ballad | Ballad | Smooth, melodic |
| verse | Verse | Versatile, dynamic |

### ElevenLabs Voices (6 options)

| Key | Voice | ID | Description |
|-----|-------|----|-------------|
| adam | Adam | pNInz6obpgDQGcFmaJgB | Deep, warm |
| matilda | Matilda | XrExE9yKIg1WjnnlVkGX | Bright, articulate |
| charlie | Charlie | IKne3meq5aSn9XLyUdCD | Natural, Australian |
| rachel | Rachel | 21m00Tcm4TlvDq8ikWAM | Calm, collected |
| clyde | Clyde | 2EiwWnXFnvU5JabPnv8n | Gruff, middle-aged |
| dorothy | Dorothy | ThT5KcBeYPX3keUQqHPh | Friendly, pleasant |

Podcast format uses two voices (host 1 = ALEX, host 2 = MORGAN). All other formats use host 1 only.

## Cost Reference

**What costs money:**
- Play (AI Voice) and Export MP3 with OpenAI TTS (~$0.015 per 1,000 characters)
- Play (AI Voice) and Export MP3 with ElevenLabs (per your subscription plan)
- Script generation via Anthropic API (per your API plan)

**What is free:**
- Fetching pages (Worker compute only)
- Copy/Download text
- Browser Voice playback (Web SpeechSynthesis — no API calls)

## Features

| Feature | Status |
|---------|--------|
| Cloudflare Worker fetch proxy | Deployed |
| Anthropic API proxy (keys on Worker) | Deployed |
| ElevenLabs TTS proxy (keys on Worker) | Deployed |
| OpenAI TTS proxy (keys on Worker) | Deployed |
| Six output formats (Video, Podcast, TTS, Story, Verbatim, Summary) | Done |
| Voice Engine selector (OpenAI / ElevenLabs / Browser) | Done |
| Voice picker per engine (11 OpenAI, 6 ElevenLabs) | Done |
| Vibe selector (6 tones injected into system prompt) | Done |
| Multi-page crawl (up to 10 links) | Done |
| Dual-voice podcast MP3 (host 1 + host 2) | Done |
| Single-voice MP3 export | Done |
| Parallel TTS rendering (batches of 4 OpenAI / 3 ElevenLabs) | Done |
| Text chunking for long scripts (~3,800 char splits) | Done |
| Regenerate from cached source text | Done |
| Editable transcript with audio re-render | Done |
| OpenAI billing/balance display | Done |
| ElevenLabs usage display | Done |
| Browser SpeechSynthesis fallback | Done |
| Copy + Download script export | Done |
| Feature highlights + format detail cards | Done |
| SyncShepherd branding | Done |
| Cloudflare Pages deployment | Done |
| Cloudflare Access (Zero Trust) | Needs setup |

## Project Structure

```
syncshepherd-studio/
├── worker/                    # Cloudflare Worker (439 lines)
│   ├── src/index.js           #   Routes: GET /?url, POST /generate, POST /tts,
│   │                          #           POST /tts-openai, GET /subscription,
│   │                          #           GET /openai-billing
│   ├── .dev.vars              #   Local dev secrets (gitignored)
│   ├── wrangler.toml          #   Worker config
│   └── package.json
├── app/                       # React app (Vite)
│   ├── src/
│   │   ├── main.jsx           #   React entry point
│   │   └── App.jsx            #   PageCast — all UI + logic (1,446 lines)
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
