# SyncShepherd Studio — PageCast

**URL → Broadcast Engine** by SyncShepherd Digital Solutions

🔗 [GitHub Repository](https://github.com/SyncShepherd-Main/syncshepherd-studio)

PageCast transforms any public URL into production-ready media scripts: video scripts with visual cues, dual-host podcast episodes, or TTS-optimised narration. Powered by Claude AI with ElevenLabs MP3 export.

## Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────┐
│  React App   │────▶│  Cloudflare Worker   │────▶│  Target URL  │
│  (Vite)      │     │  (pagecast-fetcher)  │     │  (any site)  │
│  port 5173   │     │  port 8787           │     └──────────────┘
└──────┬───────┘     └─────────────────────┘
       │
       ├──▶ Anthropic API (script generation)
       └──▶ ElevenLabs API (MP3 export)
```

## Quick Start

### 1. Install dependencies

```bash
npm run install:all
```

### 2. Configure environment

```bash
cp app/.env.example app/.env
```

Edit `app/.env`:

```env
VITE_WORKER_URL=http://localhost:8787
VITE_ANTHROPIC_API_KEY=sk-ant-your-key-here
VITE_ELEVENLABS_API_KEY=your-elevenlabs-key      # optional
VITE_ELEVENLABS_VOICE_ID=your-voice-id           # optional
```

### 3. Run locally

```bash
npm run dev
```

This starts both the Cloudflare Worker (localhost:8787) and the Vite dev server (localhost:5173) concurrently.

Or run them separately:

```bash
npm run dev:worker   # Worker on :8787
npm run dev:app      # React app on :5173
```

## Features

| Feature | Status |
|---------|--------|
| Three output formats (Video, Podcast, TTS) | Done |
| Cloudflare Worker fetch proxy | Done |
| Gary's Garden repo browser | Done |
| Multi-page crawl (up to 10 links) | Done |
| ElevenLabs MP3 export | Done |
| Browser SpeechSynthesis audio player | Done |
| Copy + Download script export | Done |

## Worker API

**Endpoint:** `GET /?url=<encoded-url>`

Returns:
```json
{
  "url": "https://example.com/page",
  "text": "Cleaned page content...",
  "wordCount": 1234,
  "fetchedAt": "2026-03-08T..."
}
```

**With link discovery:** `GET /?url=<encoded-url>&links=true`

Adds `links[]` array of up to 10 internal URLs found on the page.

## Deploying the Worker

```bash
cd worker
npx wrangler deploy
```

Then update `VITE_WORKER_URL` in `app/.env` to your deployed Worker URL:
```
VITE_WORKER_URL=https://pagecast-fetcher.<account>.workers.dev
```

## ElevenLabs MP3 Export

To enable MP3 export:

1. Go to [ElevenLabs Voice Library](https://elevenlabs.io/app/voice-library)
2. Choose a voice (recommended: Adam, Callum, or Charlotte)
3. Copy the Voice ID from the voice settings
4. Add to `app/.env`:
   ```
   VITE_ELEVENLABS_API_KEY=your-api-key
   VITE_ELEVENLABS_VOICE_ID=the-voice-id
   ```

**Credit budget:** AI Suite 40K plan = 40,000 chars/month. A typical 1,200-word podcast script is ~7,500 characters (~5 exports/month). The app shows character count before each export.

## Project Structure

```
syncshepherd-studio/
├── worker/                 # Cloudflare Worker (fetch proxy)
│   ├── src/index.js
│   ├── wrangler.toml
│   └── package.json
├── app/                    # React app (Vite)
│   ├── src/
│   │   ├── main.jsx
│   │   └── App.jsx         # PageCast main component
│   ├── index.html
│   ├── vite.config.js
│   ├── .env.example
│   └── package.json
├── package.json            # Root scripts (concurrently)
├── ContentStudio.jsx       # Original Phase 1 artifact (reference)
└── README.md
```
