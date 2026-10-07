import { useState, useRef, useEffect, useCallback, useMemo } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   PageCast — URL → Broadcast Engine
   Phase 2: Cloudflare Worker fetch + Anthropic API pipeline
   No browser fetch. No CORS. No proxies. Server-side only.
───────────────────────────────────────────────────────────────────────────── */

/* Calls go through the Pages Function at /api (behind Zero Trust), which adds the Worker key.
   Local dev: Vite proxies /api to the local Worker (see vite.config.js). */
const WORKER_URL = import.meta.env.VITE_WORKER_URL || "/api";

/* ElevenLabs Voice IDs — NOT secrets (just identifiers), keys stay on the Worker */
const ELEVENLABS_VOICES = {
  adam:     { id: "pNInz6obpgDQGcFmaJgB", label: "Adam",     desc: "Deep, warm" },
  matilda:  { id: "XrExE9yKIg1WjnnlVkGX", label: "Matilda",  desc: "Bright, articulate" },
  charlie:  { id: "IKne3meq5aSn9XLyUdCD", label: "Charlie",  desc: "Natural, Australian" },
  rachel:   { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel",   desc: "Calm, collected" },
  clyde:    { id: "2EiwWnXFnvU5JabPnv8n", label: "Clyde",    desc: "Gruff, middle-aged" },
  dorothy:  { id: "ThT5KcBeYPX3keUQqHPh", label: "Dorothy",  desc: "Friendly, pleasant" },
};

/* OpenAI TTS Voices */
const OPENAI_VOICES = {
  onyx:    { label: "Onyx",    desc: "Deep, authoritative" },
  alloy:   { label: "Alloy",   desc: "Neutral, balanced" },
  echo:    { label: "Echo",    desc: "Warm, engaging" },
  fable:   { label: "Fable",   desc: "Expressive, British" },
  nova:    { label: "Nova",    desc: "Friendly, upbeat" },
  shimmer: { label: "Shimmer", desc: "Soft, clear" },
  ash:     { label: "Ash",     desc: "Conversational" },
  coral:   { label: "Coral",   desc: "Warm, natural" },
  sage:    { label: "Sage",    desc: "Calm, wise" },
  ballad:  { label: "Ballad",  desc: "Smooth, melodic" },
  verse:   { label: "Verse",   desc: "Versatile, dynamic" },
};

/* Vibe presets — injected into system prompt */
const VIBES = {
  professional: { label: "Professional", icon: "💼", desc: "Polished, authoritative, business-ready" },
  casual:       { label: "Casual",       icon: "😎", desc: "Relaxed, conversational, approachable" },
  energetic:    { label: "Energetic",    icon: "⚡", desc: "High-energy, punchy, fast-paced" },
  storyteller:  { label: "Storyteller",  icon: "📖", desc: "Narrative, immersive, cinematic" },
  educational:  { label: "Educational",  icon: "🎓", desc: "Clear, patient, informative" },
  humorous:     { label: "Humorous",     icon: "😂", desc: "Witty, playful, entertaining" },
};

/* Narration vibes for word-for-word reading (OpenAI gpt-4o-mini-tts tone instructions).
   "standard" = tts-1: no tone control, but the most literal reading. */
const READ_FAITHFULLY = "Read the text exactly as written — do not add, skip, or change any words.";
const NARRATION_VIBES = {
  standard:     { label: "Standard",     icon: "🎙", desc: "Most faithful word-for-word reading (tts-1)", instructions: null },
  professional: { label: "Professional", icon: "💼", desc: "Polished, confident, authoritative",
    instructions: `Polished, confident, authoritative broadcast narrator. Clear diction, steady pace. ${READ_FAITHFULLY}` },
  casual:       { label: "Casual",       icon: "😎", desc: "Relaxed, like talking to a friend",
    instructions: `Relaxed and conversational, like talking to a friend. Natural and unhurried. ${READ_FAITHFULLY}` },
  energetic:    { label: "Energetic",    icon: "⚡", desc: "Upbeat and lively",
    instructions: `Upbeat and energetic with a lively pace, while keeping every word clear. ${READ_FAITHFULLY}` },
  storyteller:  { label: "Storyteller",  icon: "📖", desc: "Warm, immersive, dramatic pauses",
    instructions: `Warm, immersive storyteller. Vary pace and emphasis and pause naturally at dramatic moments. ${READ_FAITHFULLY}` },
  educational:  { label: "Educational",  icon: "🎓", desc: "Clear, patient teacher",
    instructions: `Clear, patient teacher. Measured pace, gently emphasizing key ideas. ${READ_FAITHFULLY}` },
  humorous:     { label: "Humorous",     icon: "😂", desc: "Light and warm, smile in the voice",
    instructions: `Light, warm and playful, with a smile in the voice — never mocking. ${READ_FAITHFULLY}` },
};

/* ─── SyncShepherd Brand ─────────────────────────────────────────────────── */
const BRAND = {
  blue: "#0f70b7",
  gold: "#eeaf00",
  navy: "#192534",
  darkBg: "#0e1117",
  cardBg: "#141a23",
  borderColor: "#253040",
  headingFont: "'Heebo', sans-serif",
  bodyFont: "'Roboto', sans-serif",
  monoFont: "'Roboto Mono', 'Courier New', monospace",
};

const FORMAT_META = {
  video: {
    label: "🎬 Video Script",
    tag: "VIDEO",
    color: "#eeaf00",
    glow: "rgba(238,175,0,0.35)",
    desc: "Scene-by-scene with visual cues & B-roll"
  },
  podcast: {
    label: "🎙 Dual-Host Podcast",
    tag: "PODCAST",
    color: "#0f70b7",
    glow: "rgba(15,112,183,0.35)",
    desc: "Two hosts, full dialogue, natural flow"
  },
  tts: {
    label: "📢 TTS Narration",
    tag: "NARRATION",
    color: "#34b899",
    glow: "rgba(52,184,153,0.35)",
    desc: "Audio-optimised spoken-word prose"
  },
  story: {
    label: "📖 Tell the Story",
    tag: "STORY",
    color: "#9b59b6",
    glow: "rgba(155,89,182,0.35)",
    desc: "Compelling narrative prose from any content"
  }
};

/* ─── System Prompts (DO NOT MODIFY — calibrated output) ─────────────────── */

function buildSystemPrompt(format, isMultiPage = false, vibe = "professional") {
  const multiPageNote = isMultiPage
    ? `\n\nNOTE: The content below comes from multiple pages, separated by PAGE BREAK markers. Treat all pages as a single cohesive source — synthesise across all of them, covering every page's content in full.`
    : "";

  const vibeInstructions = {
    professional: "Tone: polished, authoritative, confident. Speak like a seasoned broadcast professional.",
    casual: "Tone: relaxed, conversational, approachable. Speak like you're talking to a friend over coffee.",
    energetic: "Tone: high-energy, punchy, fast-paced. Use short sentences. Build excitement. Keep momentum.",
    storyteller: "Tone: narrative, immersive, cinematic. Paint pictures with words. Build tension and resolution.",
    educational: "Tone: clear, patient, informative. Explain concepts simply. Use analogies. Build understanding step by step.",
    humorous: "Tone: witty, playful, entertaining. Use clever observations, mild self-deprecation, and unexpected connections. Keep it tasteful.",
  };

  const vibeNote = vibeInstructions[vibe] || vibeInstructions.professional;

  const shared = `You are a world-class broadcast media producer. Your job is to take the provided page content and produce a broadcast-ready script in the format specified below. Read every section thoroughly. Do not summarise or skip any part.\n\n${vibeNote}${multiPageNote}`;

  const formats = {
    video: `${shared}

FORMAT: DOCUMENTARY VIDEO SCRIPT
- Open with a punchy 10-second hook
- Clearly labelled SCENES with [VISUAL CUE: description] on its own line
- [ON-SCREEN TEXT: ...] for key stats and pull quotes
- Narration in dynamic broadcast voice — authoritative, engaging, human
- Structure: HOOK → CONTEXT → SCENE PER MAJOR POINT → DATA/EVIDENCE → CONCLUSION → CALL TO ACTION
- End with [END CARD]
- Every scene has an estimated read time in parentheses
- 900–1600 words of narration`,

    podcast: `${shared}

FORMAT: DUAL-HOST PODCAST EPISODE
Hosts:
- ALEX: analytical, sharp, plays devil's advocate, cites evidence
- MORGAN: storyteller, connects ideas to real life, drives narrative warmth

Rules:
- Natural dialogue — hosts riff, interrupt, agree, disagree
- Stage directions in [brackets]: [laughs], [pause], [skeptical tone], [leaning in]
- Casual unscripted-feeling cold open teasing the topic
- Clear SEGMENT headers (e.g. SEGMENT 1: THE BACKSTORY)
- Every point from the source gets covered — nothing skipped
- At least 3 rhetorical questions aimed at the listener
- Closes with personal takeaways and a listener challenge
- Format every line: ALEX: ... or MORGAN: ...
- 1100–1800 words of dialogue`,

    tts: `${shared}

FORMAT: TTS BROADCAST NARRATION
- Pure spoken prose — zero bullet points, zero markdown, zero headers in the output
- Natural spoken transitions between sections
- Rhythm: mix short punchy sentences with longer explanatory ones for audio cadence
- Every point from the source covered in full — this is not a summary
- Structure: vivid INTRO → full BODY with transitions → emphasis on key data → resonant CONCLUSION
- Tone: trusted public radio presenter — warm, authoritative, unhurried
- 1000–1500 words`,

    story: `You are an expert Content Strategist and Narrative Designer. Transform the provided web content into a compelling, linear narrative that captures the essence of the source material.${multiPageNote}

FORMAT: STORY NARRATIVE
- Analyse the content, identify the core message and narrative arc
- Write a cohesive story-style narrative — professional yet engaging
- Proportional in length to the source material
- No multi-voice dialogue, no podcast back-and-forth
- No visual cues, stage directions, or scene markers
- No bullet points, no markdown headers in the output
- Pure singular narrative prose only
- Natural paragraph breaks for readability
- Strong opening hook, developed middle, resonant conclusion
- 800–1400 words`
  };

  return formats[format];
}

/* ─── Fetch + Generate Pipeline (Task 2) ─────────────────────────────────── */

async function fetchViaWorker(url) {
  if (!WORKER_URL) {
    throw new Error("Worker not configured — deploy the Cloudflare Worker first and set VITE_WORKER_URL in .env");
  }
  const res = await fetch(`${WORKER_URL}/fetch?url=${encodeURIComponent(url)}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function fetchViaWorkerWithLinks(url) {
  if (!WORKER_URL) {
    throw new Error("Worker not configured — deploy the Cloudflare Worker first and set VITE_WORKER_URL in .env");
  }
  const res = await fetch(`${WORKER_URL}/fetch?url=${encodeURIComponent(url)}&links=true`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function generateScript(text, format, isMultiPage = false, vibe = "professional") {
  const res = await fetch(`${WORKER_URL}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: buildSystemPrompt(format, isMultiPage, vibe),
      messages: [{
        role: "user",
        content: `Produce the complete ${FORMAT_META[format].tag} script from the following page content:\n\n${text}`
      }]
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `API error ${res.status}`);
  }

  const output = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n");
  if (!output || output.length < 100) throw new Error("No script was generated. The page may be empty or inaccessible.");
  return output;
}

/* ─── ElevenLabs MP3 Export (Task 7) ─────────────────────────────────────── */

function cleanLine(text) {
  return text.replace(/\[.*?\]/g, "").replace(/\*\*/g, "").trim();
}

function cleanScriptForTTS(text, format) {
  let cleaned = text;
  if (format === "video") {
    cleaned = cleaned.replace(/^\[(VISUAL CUE|B-ROLL|GRAPHIC|ON-SCREEN TEXT|END CARD)[^\]]*\].*$/gm, "");
  }
  if (format === "podcast") {
    cleaned = cleaned.replace(/^(ALEX|MORGAN):\s*/gm, "");
  }
  cleaned = cleaned.replace(/\[.*?\]/g, "");
  cleaned = cleaned.replace(/^(SCENE|SEGMENT|SECTION|INTRO|OUTRO|HOOK|CONCLUSION)\s*\d*[:\-—]?.*/gm, "");
  cleaned = cleaned.replace(/\*\*/g, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

/**
 * Parse podcast script into sequential segments with speaker labels.
 * Returns [{ speaker: "ALEX"|"MORGAN", text: "..." }, ...]
 */
function parsePodcastSegments(scriptText) {
  const lines = scriptText.split("\n");
  const segments = [];
  let currentSpeaker = null;
  let currentText = "";

  for (const line of lines) {
    const alexMatch = line.match(/^ALEX:\s*(.*)/);
    const morganMatch = line.match(/^MORGAN:\s*(.*)/);

    if (alexMatch) {
      if (currentSpeaker && currentText.trim()) {
        segments.push({ speaker: currentSpeaker, text: cleanLine(currentText) });
      }
      currentSpeaker = "ALEX";
      currentText = alexMatch[1];
    } else if (morganMatch) {
      if (currentSpeaker && currentText.trim()) {
        segments.push({ speaker: currentSpeaker, text: cleanLine(currentText) });
      }
      currentSpeaker = "MORGAN";
      currentText = morganMatch[1];
    } else if (currentSpeaker && line.trim() && !/^\[.*\]$/.test(line.trim()) && !/^(SEGMENT|SECTION|SCENE)\b/i.test(line)) {
      // Continuation line for current speaker
      currentText += " " + line;
    }
  }
  if (currentSpeaker && currentText.trim()) {
    segments.push({ speaker: currentSpeaker, text: cleanLine(currentText) });
  }
  return segments;
}

/** Fetch a single TTS clip via Worker (ElevenLabs proxy) */
async function fetchTTSClip(text, voiceId) {
  const res = await fetch(`${WORKER_URL}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice_id: voiceId,
      model_id: "eleven_turbo_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err?.error || `ElevenLabs error ${res.status}`);
  }
  return await res.arrayBuffer();
}

/** Concatenate multiple audio ArrayBuffers into a single Blob */
function concatAudioBuffers(buffers) {
  const totalLen = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const buf of buffers) {
    combined.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return new Blob([combined], { type: "audio/mpeg" });
}

/**
 * Generate podcast MP3 with distinct ElevenLabs voices for ALEX and MORGAN.
 */
async function generatePodcastMp3(scriptText, onProgress, voiceKey1 = "adam", voiceKey2 = "matilda") {
  const segments = parsePodcastSegments(scriptText);
  if (segments.length === 0) throw new Error("No dialogue found in script");

  const audioBuffers = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (onProgress) onProgress(`Rendering ${seg.speaker} (${i + 1}/${segments.length})...`);
    const voiceId = seg.speaker === "MORGAN"
      ? ELEVENLABS_VOICES[voiceKey2].id
      : ELEVENLABS_VOICES[voiceKey1].id;
    const buffer = await fetchTTSClip(seg.text, voiceId);
    audioBuffers.push(buffer);
  }

  return concatAudioBuffers(audioBuffers);
}

/** Generate single-voice MP3 via ElevenLabs (chunked, any length) */
async function generateSingleVoiceMp3(scriptText, format, voiceKey1 = "adam", onProgress) {
  const cleaned = cleanScriptForTTS(scriptText, format);
  const { blob } = await renderLongTextMp3(splitIntoSentences([{ page: 1, text: cleaned }]), "elevenlabs", voiceKey1, onProgress);
  return blob;
}

async function exportToMp3(scriptText, format, onProgress, voiceKey1 = "adam", voiceKey2 = "matilda") {
  let blob;
  if (format === "podcast") {
    blob = await generatePodcastMp3(scriptText, onProgress, voiceKey1, voiceKey2);
  } else {
    blob = await generateSingleVoiceMp3(scriptText, format, voiceKey1, onProgress);
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${format}-narration.mp3`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Generate MP3 blob for in-browser ElevenLabs playback */
async function generateMp3Blob(scriptText, format, onProgress, voiceKey1 = "adam", voiceKey2 = "matilda") {
  if (format === "podcast") {
    return await generatePodcastMp3(scriptText, onProgress, voiceKey1, voiceKey2);
  } else {
    return await generateSingleVoiceMp3(scriptText, format, voiceKey1, onProgress);
  }
}

/* ─── OpenAI TTS Export ──────────────────────────────────────────────────── */

/** Fetch a single TTS clip via Worker (OpenAI proxy). With instructions (a narration vibe)
    it uses gpt-4o-mini-tts, which can follow tone directions; otherwise tts-1. */
async function fetchOpenAITTSClip(text, voice, instructions) {
  const res = await fetch(`${WORKER_URL}/tts-openai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(instructions
      ? { text, voice: voice || "onyx", model: "gpt-4o-mini-tts", instructions }
      : { text, voice: voice || "onyx", model: "tts-1" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err?.error || `OpenAI TTS error ${res.status}`);
  }
  return await res.arrayBuffer();
}

/** Generate podcast MP3 with OpenAI voices */
async function generatePodcastMp3OpenAI(scriptText, onProgress, voice1 = "onyx", voice2 = "alloy") {
  const segments = parsePodcastSegments(scriptText);
  if (segments.length === 0) throw new Error("No dialogue found in script");

  const audioBuffers = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (onProgress) onProgress(`Rendering ${seg.speaker} (${i + 1}/${segments.length})...`);
    const voice = seg.speaker === "MORGAN" ? voice2 : voice1;
    const buffer = await fetchOpenAITTSClip(seg.text, voice);
    audioBuffers.push(buffer);
  }
  return concatAudioBuffers(audioBuffers);
}

/** Generate single-voice MP3 via OpenAI (chunked — OpenAI caps each request at 4,096 chars) */
async function generateSingleVoiceMp3OpenAI(scriptText, format, voice1 = "onyx", onProgress) {
  const cleaned = cleanScriptForTTS(scriptText, format);
  const { blob } = await renderLongTextMp3(splitIntoSentences([{ page: 1, text: cleaned }]), "openai", voice1, onProgress);
  return blob;
}

async function exportToMp3OpenAI(scriptText, format, onProgress, voice1 = "onyx", voice2 = "alloy") {
  let blob;
  if (format === "podcast") {
    blob = await generatePodcastMp3OpenAI(scriptText, onProgress, voice1, voice2);
  } else {
    blob = await generateSingleVoiceMp3OpenAI(scriptText, format, voice1, onProgress);
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${format}-narration.mp3`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ─── PDF → Audio ────────────────────────────────────────────────────────── */

const TTS_CHUNK_CHARS = 4000;          // OpenAI TTS hard limit is 4,096 chars per request
const PDF_MAX_BYTES = 50 * 1024 * 1024;
const PDF_SCRIPT_MAX_CHARS = 150000;   // cap when feeding a PDF to Claude for a script

/** Extract plain text from a PDF in the browser (pdf.js, loaded on demand) */
async function extractPdfText(file, onProgress) {
  const pdfjs = await import("pdfjs-dist");
  const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pageLines = []; // [{ page, lines: [], heights: [] }] — heights = font size per line
  for (let i = 1; i <= pdf.numPages; i++) {
    if (onProgress) onProgress(`Reading page ${i} of ${pdf.numPages}...`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const lines = [], heights = [];
    let cur = "", h = 0;
    const push = () => {
      const l = cur.replace(/\s+/g, " ").trim();
      if (l) { lines.push(l); heights.push(Math.round(h * 2) / 2); }
      cur = ""; h = 0;
    };
    for (const it of content.items) {
      cur += it.str || "";
      if (it.str && it.str.trim()) h = Math.max(h, Math.abs(it.transform?.[3] || 0) || it.height || 0);
      if (it.hasEOL) push();
    }
    push();
    pageLines.push({ page: i, lines, heights });
  }

  // Running headers/footers: short lines at the top/bottom of a page that repeat (digits
  // ignored) on 30%+ of pages, AND either have no numbers or carry a number that climbs in
  // step with the page ("Page 7 of 100", "Report | 37"). Section headings like "Section 12"
  // repeat too, but their numbers don't track the page, so they are kept.
  // Also drop bare page numbers ("12", "Page 12", "12 of 100").
  const norm = l => l.toLowerCase().replace(/\d+/g, "#");
  const seen = new Map(); // norm → [{ page, nums }]
  for (const { page, lines } of pageLines) {
    const edges = new Set([...lines.slice(0, 3), ...lines.slice(-3)].filter(l => l.length < 100));
    const byKey = new Map();
    edges.forEach(l => byKey.set(norm(l), l));
    byKey.forEach((l, k) => {
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push({ page, nums: (l.match(/\d+/g) || []).map(Number) });
    });
  }
  const minRepeats = Math.max(3, Math.ceil(pageLines.length * 0.3));
  const repeated = new Set();
  seen.forEach((occ, k) => {
    if (pageLines.length < 4 || occ.length < minRepeats) return;
    if (!/#/.test(k)) { repeated.add(k); return; }
    // Every number in the line must be fixed ("9125 Main St") or track the page
    const mostCommon = vals => { const m = new Map(); vals.forEach(v => m.set(v, (m.get(v) || 0) + 1)); return Math.max(...m.values()); };
    const positions = occ[0].nums.length;
    let running = true;
    for (let j = 0; j < positions && running; j++) {
      const fixed = mostCommon(occ.map(o => o.nums[j]));
      const tracks = mostCommon(occ.map(o => o.nums[j] - o.page));
      running = Math.max(fixed, tracks) >= occ.length * 0.8;
    }
    if (running) repeated.add(k);
  });
  const isPageNumber = l => /^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(l);

  // Pass 1: drop headers/footers/page numbers; keep each line's font size
  const keptByPage = pageLines.map(({ page, lines, heights }) => ({
    page,
    lines: lines.map((text, idx) => ({ text, h: heights[idx], idx, count: lines.length }))
      .filter(({ text, idx, count }) => {
        const atEdge = idx < 3 || idx >= count - 3;
        return !isPageNumber(text) && !(atEdge && repeated.has(norm(text)));
      }),
  }));
  const keptLines = keptByPage.flatMap(({ page, lines }) => lines.map(l => ({ page, text: l.text, h: l.h })));
  const bodySize = mostUsedFontSize(keptLines);

  // Pass 2: page text. Headings (larger font, no end punctuation) get a period so the
  // narrator pauses and they become their own sentence for read-along / chapter jumps.
  const pages = []; // [{ page, text }]
  const isHeadingLine = l => bodySize && l.h >= bodySize * 1.2 && l.text.length <= 120;
  for (const { page, lines } of keptByPage) {
    // A heading wrapped over several lines gets one period, after its last line
    const text = lines.map((l, i) => (isHeadingLine(l) && !/[.!?:;,]$/.test(l.text)
      && !(lines[i + 1] && isHeadingLine(lines[i + 1]) && lines[i + 1].h === l.h)) ? `${l.text}.` : l.text)
      .join("\n")
      .replace(/(\w)-\n(\w)/g, "$1$2")   // re-join words hyphenated across lines
      .replace(/\s+/g, " ")
      .trim();
    if (text) pages.push({ page, text });
  }

  const text = pages.map(p => p.text).join("\n\n");
  if (text.replace(/\s/g, "").length < 20) {
    throw new Error("No readable text found. This PDF is probably a scanned image — it needs OCR first.");
  }
  // Chapters: the PDF's own bookmarks if it has them, else large-font headings
  const outline = await readPdfOutline(pdf);
  const sentences = splitIntoSentences(pages);
  const chapters = locateChapters(outline.length ? outline : detectHeadings(keptLines), sentences);
  const sections = buildSections(chapters, sentences.length);

  // Spoken intro: PDF title/author metadata, else page 1's two largest heading sizes
  const info = (await pdf.getMetadata().catch(() => null))?.info || {};
  // Ignore metadata titles that are really file names ("book.html", "Microsoft Word - draft.docx")
  if (/\.(html?|pdf|docx?|pages|txt|rtf)$|^microsoft (word|powerpoint)|^untitled/i.test((info.Title || "").trim())) info.Title = "";
  // Page 1's original lines — the author's name may repeat as a running header elsewhere
  const page1 = pageLines[0] ? pageLines[0].lines.map((text, i) => ({ text, h: pageLines[0].heights[i] })) : [];
  // Only when there's front matter before the first chapter for the intro to stand in for
  const intro = sections[0].key === "front"
    ? (info.Title ? [info.Title, info.Author].filter(Boolean).join(". ") : titleFromLines(page1, bodySize))
    : "";

  return {
    name: file.name,
    file,
    text,
    chapters,
    sections,
    intro,
    chapterSource: outline.length ? "bookmarks" : "headings",
    sentences,
    pages: pdf.numPages,
    words: text.split(/\s+/).filter(Boolean).length,
    chars: text.length,
  };
}

/** PDF bookmarks (outline) → [{ title, page, level }], up to 3 levels deep */
async function readPdfOutline(pdf) {
  const outline = await pdf.getOutline().catch(() => null);
  if (!outline || !outline.length) return [];
  const out = [];
  const walk = async (items, level) => {
    for (const it of items) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === "string") dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0] != null) {
          page = typeof dest[0] === "number" ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
        }
      } catch { /* unresolvable bookmark */ }
      const title = (it.title || "").replace(/\s+/g, " ").trim();
      if (page && title) out.push({ title, page, level });
      if (level < 3 && it.items && it.items.length) await walk(it.items, level + 1);
    }
  };
  await walk(outline, 1);
  return out;
}

/**
 * No bookmarks: treat short lines in a clearly larger font than the body text as
 * headings. The two largest heading sizes become levels 1 and 2.
 */
/** The font size most text is set in (by character count) */
function mostUsedFontSize(lines) {
  const weight = new Map(); // font size → characters set in it
  lines.forEach(l => weight.set(l.h, (weight.get(l.h) || 0) + l.text.length));
  return weight.size ? [...weight].sort((a, b) => b[1] - a[1])[0][0] : 0;
}

function detectHeadings(lines) {
  const body = mostUsedFontSize(lines);
  if (!body) return [];

  const isHeading = l => l.h >= body * 1.2 && l.text.length >= 2 && l.text.length <= 120
    && /[a-z]/i.test(l.text) && !/\.{4,}/.test(l.text);   // skip TOC dot-leader lines
  const candidates = [];
  let prevWasHeading = false;
  for (const l of lines) {
    if (!isHeading(l)) { prevWasHeading = false; continue; }
    const prev = candidates[candidates.length - 1];
    // A heading wrapped onto two lines: same page, same size, back to back
    if (prevWasHeading && prev.page === l.page && prev.h === l.h) prev.title += " " + l.text;
    else candidates.push({ title: l.text, page: l.page, h: l.h });
    prevWasHeading = true;
  }

  const sizes = [...new Set(candidates.map(c => c.h))].sort((a, b) => b - a);
  const levelOf = h => sizes.indexOf(h) + 1;
  let picked = candidates.filter(c => levelOf(c.h) <= 2);
  if (picked.length > 300) picked = picked.filter(c => levelOf(c.h) === 1);
  return picked.map(c => ({ title: c.title, page: c.page, level: levelOf(c.h) }));
}

/** Index of each chapter's first sentence (its title on its page, else the page's first sentence) */
const normTitle = t => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function locateChapters(chapters, sentences) {
  const normed = sentences.map(s => normTitle(s.text));
  return chapters.map(c => {
    const key = normTitle(c.title).slice(0, 40);
    let i = key ? sentences.findIndex((s, j) => s.page === c.page && normed[j].includes(key)) : -1;
    if (i < 0) i = sentences.findIndex(s => s.page >= c.page);
    return { ...c, sentence: i };
  }).filter(c => c.sentence >= 0);
}

/* Sections a listener might not want read aloud */
const SKIP_BY_DEFAULT = /^(table of )?contents$|^(sources|references|bibliography|works cited|index|endnotes|notes|acknowledg(e)?ments)$/i;

/**
 * Top-level chapters as sentence ranges, plus the front matter before the first one.
 * Each: { key, title, page, start, end, skip } — skip = default for the checkbox.
 */
function buildSections(chapters, total) {
  if (!chapters.length) return [{ key: "all", title: "Whole document", page: 1, start: 0, end: total, skip: false }];
  const top = Math.min(...chapters.map(c => c.level || 1));
  const heads = chapters.filter(c => (c.level || 1) === top).sort((a, b) => a.sentence - b.sentence);
  const out = [];
  if (heads[0].sentence > 0) out.push({ key: "front", title: "Front page", page: 1, start: 0, end: heads[0].sentence, skip: false });
  heads.forEach((c, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].sentence : total;
    if (end > c.sentence) out.push({ key: `c${i}`, title: c.title, page: c.page, start: c.sentence, end, skip: SKIP_BY_DEFAULT.test(c.title.replace(/[^a-z ]/gi, "").trim()) });
  });
  return out;
}

/** "Title. Author." from the first page's two largest font sizes (same-size lines joined) */
function titleFromLines(lines, bodySize) {
  const sizes = [...new Set(lines.filter(l => l.h >= bodySize * 1.2).map(l => l.h))].sort((a, b) => b - a).slice(0, 2);
  if (!sizes.length) return "";
  const parts = [];
  let prevH = null;
  for (const l of lines) {
    if (!sizes.includes(l.h)) { prevH = null; continue; }
    if (prevH === l.h) parts[parts.length - 1] += " " + l.text.replace(/\.$/, "");
    else parts.push(l.text.replace(/\.$/, ""));
    prevH = l.h;
  }
  return parts.join(". ").slice(0, 300) + ".";
}

/** The sentences to narrate: spoken intro + every section not skipped */
function narrationSentences(pdfDoc, skip, intro) {
  const out = intro.trim() ? splitIntoSentences([{ page: 1, text: intro.trim() }]) : [];
  for (const sec of pdfDoc.sections) {
    if (!skip.has(sec.key)) out.push(...pdfDoc.sentences.slice(sec.start, sec.end));
  }
  return out;
}

/** Give each chapter the audio time of its first sentence (title match on its page, else page start) */
function placeChapters(chapters, segments) {
  const norm = t => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normed = segments.map(s => norm(s.text));
  return chapters.map(c => {
    const key = norm(c.title).slice(0, 40);
    let i = key ? segments.findIndex((s, j) => s.page === c.page && normed[j].includes(key)) : -1;
    if (i < 0) i = segments.findIndex(s => s.page >= c.page);
    return i < 0 ? null : { title: c.title, page: c.page, level: c.level, t: segments[i].t };
  }).filter(Boolean);
}

/** Split page texts into sentences tagged with their page (each ≤ max chars) */
function splitIntoSentences(pages, max = TTS_CHUNK_CHARS) {
  const out = [];
  for (const { page, text } of pages) {
    for (let s of text.split(/(?<=[.!?])\s+/)) {
      // A single "sentence" longer than the limit (tables, lists) gets split on spaces
      while (s.length > max) {
        const cut = s.lastIndexOf(" ", max) > 0 ? s.lastIndexOf(" ", max) : max;
        out.push({ page, text: s.slice(0, cut).trim() });
        s = s.slice(cut).trim();
      }
      if (s) out.push({ page, text: s });
    }
  }
  return out;
}

/** Group sentences into TTS-sized chunks: returns arrays of sentence indexes */
function chunkSentences(sentences, max = TTS_CHUNK_CHARS) {
  const chunks = [];
  let current = [], len = 0;
  sentences.forEach((s, i) => {
    if (current.length && len + 1 + s.text.length > max) { chunks.push(current); current = []; len = 0; }
    current.push(i);
    len += (len ? 1 : 0) + s.text.length;
  });
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Duration of an MP3 clip in seconds, by walking its frame headers.
 * Cheap on memory (no decode), which matters for multi-hour PDFs.
 */
function mp3Duration(buffer) {
  const b = new Uint8Array(buffer);
  const BITRATES = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],  // MPEG-1 Layer III
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],      // MPEG-2/2.5 Layer III
  };
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  let i = 0, seconds = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {           // skip ID3v2 tag
    i = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
  }
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (b[i + 1] >> 3) & 3;            // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (b[i + 1] >> 1) & 3;          // 1 = Layer III
    const brIdx = b[i + 2] >> 4, srIdx = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) { i++; continue; }
    const bitrate = BITRATES[ver === 3 ? 1 : 2][brIdx] * 1000;
    const rate = RATES[ver][srIdx];
    const samples = ver === 3 ? 1152 : 576;
    const len = Math.floor((samples / 8) * bitrate / rate) + pad;
    seconds += samples / rate;
    i += len;
  }
  return seconds;
}

/** Run fn over items with limited concurrency, keeping result order */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Render sentences of any total length to one MP3 in a single voice (OpenAI or ElevenLabs).
 * Returns { blob, segments } — segments are [{ t, page, text }] start times for read-along.
 */
async function renderLongTextMp3(sentences, engine, voice, onProgress, instructions) {
  const groups = chunkSentences(sentences);
  const chunks = groups.map(g => g.map(i => sentences[i].text).join(" "));
  let done = 0;
  const fetchClip = (chunk) => engine === "openai"
    ? fetchOpenAITTSClip(chunk, voice, instructions)
    : fetchTTSClip(chunk, ELEVENLABS_VOICES[voice].id);

  const buffers = await mapLimit(chunks, engine === "openai" ? 3 : 2, async (chunk) => {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const buf = await fetchClip(chunk);
        done++;
        if (onProgress) onProgress(`Rendering audio ${done} of ${chunks.length}...`);
        return buf;
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, [2000, 5000, 10000, 20000, 0][attempt]));
      }
    }
    throw lastErr;
  });

  // Timestamps: each chunk's real duration, split across its sentences by length
  if (onProgress) onProgress("Timing read-along...");
  const segments = [];
  let t = 0;
  for (let c = 0; c < groups.length; c++) {
    const dur = mp3Duration(buffers[c]);
    const total = groups[c].reduce((n, i) => n + sentences[i].text.length, 0) || 1;
    for (const i of groups[c]) {
      segments.push({ t: Math.round(t * 100) / 100, page: sentences[i].page, text: sentences[i].text });
      t += dur * sentences[i].text.length / total;
    }
  }

  // Blob from the parts directly — avoids one more full-size copy for multi-hour audio
  return { blob: new Blob(buffers, { type: "audio/mpeg" }), segments };
}

const SHARE_PART_BYTES = 10 * 1024 * 1024; // R2 multipart: every part but the last must be ≥ 5 MB

async function shareCall(path, opts = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, opts);
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || data.error) throw new Error(data.error || `Share error ${res.status}`);
  return data;
}

/** Upload one file to R2 in 10 MB parts through the Worker */
async function uploadShareFile(id, name, blob, onBytes) {
  const { uploadId } = await shareCall(`/share/${id}/${name}/start`, { method: "POST" });
  const count = Math.max(1, Math.ceil(blob.size / SHARE_PART_BYTES));
  const parts = await mapLimit([...Array(count).keys()], 3, async (i) => {
    const body = blob.slice(i * SHARE_PART_BYTES, (i + 1) * SHARE_PART_BYTES);
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const part = await shareCall(`/share/${id}/${name}/part?uploadId=${encodeURIComponent(uploadId)}&n=${i + 1}`, { method: "PUT", body });
        onBytes(body.size);
        return part;
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    throw lastErr;
  });
  await shareCall(`/share/${id}/${name}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId, parts }),
  });
}

/** Upload PDF + MP3 + read-along timings; returns the public share URL */
async function createSharePage({ pdfFile, audioBlob, title, voice, segments, chapters, password }, onProgress) {
  const { id } = await shareCall("/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, voice, pdfName: pdfFile.name, segments, chapters, password }),
  });
  const total = pdfFile.size + audioBlob.size;
  let sent = 0;
  const onBytes = (n) => { sent += n; if (onProgress) onProgress(Math.round(sent / total * 100)); };
  await uploadShareFile(id, "source.pdf", pdfFile, onBytes);
  await uploadShareFile(id, "audio.mp3", audioBlob, onBytes);
  const { url } = await shareCall(`/share/${id}/finish`, { method: "POST" });
  return url;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ─── UI Components ───────────────────────────────────────────────────────── */

function Ticker() {
  const items = ["SERVER-SIDE FETCH","NO CORS LIMITS","URL → BROADCAST READY","VIDEO · PODCAST · TTS","POWERED BY CLAUDE AI","READS ANY PUBLIC PAGE","MP3 EXPORT VIA ELEVENLABS"];
  return (
    <div style={{ overflow:"hidden", borderTop:`1px solid ${BRAND.borderColor}`, borderBottom:`1px solid ${BRAND.borderColor}`, background:BRAND.navy, height:30, display:"flex", alignItems:"center" }}>
      <div style={{ display:"inline-flex", gap:48, animation:"ticker 22s linear infinite", whiteSpace:"nowrap", paddingLeft:"100%" }}>
        {[...items,...items].map((t,i) => (
          <span key={i} style={{ fontSize:13, letterSpacing:"0.2em", color:"#8899aa", fontFamily:BRAND.monoFont, textTransform:"uppercase" }}>
            <span style={{ color:BRAND.gold, marginRight:10 }}>◆</span>{t}
          </span>
        ))}
      </div>
      <style>{`@keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}

function FormatCard({ id, meta, selected, onClick }) {
  return (
    <button onClick={onClick} style={{
      flex:"1 1 200px", minWidth:200, border:`1.5px solid ${selected ? meta.color : BRAND.borderColor}`,
      borderRadius:10, background: selected ? `${meta.color}12` : BRAND.cardBg,
      padding:"16px 14px", cursor:"pointer", textAlign:"left", transition:"all 0.2s",
      boxShadow: selected ? `0 0 28px ${meta.glow}` : "none", position:"relative", overflow:"hidden"
    }}>
      {selected && <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:`linear-gradient(to right,${meta.color},transparent)` }} />}
      <div style={{ fontSize:22, marginBottom:6 }}>{meta.label.split(" ")[0]}</div>
      <div style={{ fontSize:14, fontWeight:700, color: selected ? meta.color : "#bbb", letterSpacing:"0.1em", fontFamily:BRAND.monoFont, marginBottom:6 }}>{meta.tag}</div>
      <div style={{ fontSize:14, color:"#bbb", lineHeight:1.5, fontFamily:BRAND.bodyFont }}>{meta.desc}</div>
    </button>
  );
}

function ScriptBlock({ content, format }) {
  const meta = FORMAT_META[format];
  return (
    <div style={{ padding:"28px 28px 36px", fontFamily:BRAND.bodyFont }}>
      {content.split("\n").map((line, i) => {
        if (!line.trim()) return <div key={i} style={{ height:8 }} />;

        if (format === "video" && /^\[(VISUAL|B-ROLL|GRAPHIC|ON-SCREEN|END CARD)[^\]]*\]/i.test(line)) {
          return (
            <div key={i} style={{ display:"flex", gap:10, margin:"14px 0", alignItems:"flex-start" }}>
              <span style={{ fontSize:11, color:meta.color, fontFamily:BRAND.monoFont, letterSpacing:"0.1em", paddingTop:4, flexShrink:0 }}>▶ CUE</span>
              <div style={{ background:`${meta.color}12`, border:`1px solid ${meta.color}28`, borderRadius:6, padding:"8px 14px", fontSize:14, color:"#aaa", fontStyle:"italic", flex:1, fontFamily:BRAND.monoFont, lineHeight:1.6 }}>
                {line}
              </div>
            </div>
          );
        }

        if (format === "podcast") {
          const alex = line.match(/^ALEX:\s*(.*)/);
          const morgan = line.match(/^MORGAN:\s*(.*)/);
          if (alex) return (
            <div key={i} style={{ display:"flex", gap:14, margin:"12px 0" }}>
              <span style={{ width:60, flexShrink:0, fontSize:12, fontWeight:700, color:BRAND.blue, fontFamily:BRAND.monoFont, letterSpacing:"0.08em", paddingTop:4 }}>ALEX</span>
              <p style={{ margin:0, flex:1, fontSize:16, color:"#ccc", lineHeight:1.8, fontFamily:BRAND.bodyFont }}>{alex[1]}</p>
            </div>
          );
          if (morgan) return (
            <div key={i} style={{ display:"flex", gap:14, margin:"12px 0" }}>
              <span style={{ width:60, flexShrink:0, fontSize:12, fontWeight:700, color:BRAND.gold, fontFamily:BRAND.monoFont, letterSpacing:"0.08em", paddingTop:4 }}>MORGAN</span>
              <p style={{ margin:0, flex:1, fontSize:16, color:"#ccc", lineHeight:1.8, fontFamily:BRAND.bodyFont }}>{morgan[1]}</p>
            </div>
          );
          if (/^\[.+\]$/.test(line.trim())) return (
            <div key={i} style={{ fontSize:14, color:"#999", fontStyle:"italic", fontFamily:BRAND.monoFont, margin:"4px 0 4px 74px" }}>{line}</div>
          );
        }

        if (/^(SCENE|SEGMENT|SECTION|INTRO|OUTRO|HOOK|CONCLUSION|BODY)\b/i.test(line) || /^#{1,3} /.test(line)) {
          return (
            <div key={i} style={{ borderLeft:`3px solid ${meta.color}`, paddingLeft:14, margin:"28px 0 10px", fontSize:14, fontWeight:700, color:meta.color, letterSpacing:"0.14em", fontFamily:BRAND.headingFont, textTransform:"uppercase" }}>
              {line.replace(/^#+\s*/,"")}
            </div>
          );
        }

        return <p key={i} style={{ margin:"0 0 2px", fontSize:16, color:"#c0c0c0", lineHeight:1.85, fontFamily:BRAND.bodyFont }}>{line}</p>;
      })}
    </div>
  );
}

function AudioPlayer({ script, format, voiceEngine, openaiVoice1, openaiVoice2, elevenVoice1, elevenVoice2 }) {
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused]   = useState(false);
  const [speed, setSpeed]     = useState(1);
  const [pct, setPct]         = useState(0);
  const [mp3Url, setMp3Url]   = useState(null);
  const [mp3Loading, setMp3Loading] = useState(false);
  const [mp3Error, setMp3Error] = useState("");
  const [loadingMsg, setLoadingMsg] = useState("");
  const audioRef = useRef(null);
  const chunksRef = useRef([]);
  const chunkIndexRef = useRef(0);
  const lastEngineRef = useRef(null);
  const meta = FORMAT_META[format];

  const clean = format === "podcast"
    ? script.replace(/^(ALEX|MORGAN):\s*/gm,"").replace(/\[.*?\]/g,"").replace(/\*\*/g,"")
    : script.replace(/\[.*?\]/g,"").replace(/\*\*/g,"");

  const wc = useRef(clean.split(/\s+/).length);

  // Reset cached audio when engine changes
  useEffect(() => {
    if (lastEngineRef.current && lastEngineRef.current !== voiceEngine) {
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      speechSynthesis.cancel();
      setMp3Url(null);
      setPlaying(false); setPaused(false); setPct(0); setMp3Error("");
    }
    lastEngineRef.current = voiceEngine;
  }, [voiceEngine]);

  useEffect(() => {
    return () => {
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      speechSynthesis.cancel();
    };
  },[]);

  // Track MP3 playback progress (for openai / elevenlabs)
  useEffect(() => {
    if (!mp3Url || !audioRef.current) return;
    const audio = audioRef.current;
    const onTime = () => setPct(audio.duration ? (audio.currentTime / audio.duration) * 100 : 0);
    const onEnd = () => { setPlaying(false); setPaused(false); setPct(100); };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnd);
    return () => { audio.removeEventListener("timeupdate", onTime); audio.removeEventListener("ended", onEnd); };
  }, [mp3Url]);

  // ── Browser SpeechSynthesis helpers ──
  const [browserVoice, setBrowserVoice] = useState(null);

  useEffect(() => {
    const load = () => {
      const v = speechSynthesis.getVoices().filter(v => v.lang.startsWith("en"));
      const best = v.find(x => /google|samantha|daniel|karen|moira/i.test(x.name)) || v[0];
      if (best) setBrowserVoice(best);
    };
    load();
    speechSynthesis.onvoiceschanged = load;
  },[]);

  const getChunks = useCallback(() => {
    const sentences = clean.split(/(?<=[.!?])\s+/);
    const chunks = [];
    let current = "";
    for (const s of sentences) {
      if ((current + " " + s).split(/\s+/).length > 150 && current) {
        chunks.push(current.trim());
        current = s;
      } else {
        current = current ? current + " " + s : s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }, [clean]);

  const speakChunk = useCallback((index) => {
    const chunks = chunksRef.current;
    if (index >= chunks.length) {
      setPlaying(false); setPaused(false); setPct(100);
      return;
    }
    const u = new SpeechSynthesisUtterance(chunks[index]);
    if (browserVoice) u.voice = browserVoice;
    u.rate = speed;
    u.onboundary = () => {
      const wordsBeforeChunk = chunks.slice(0, index).join(" ").split(/\s+/).filter(Boolean).length;
      const progress = (wordsBeforeChunk + chunks[index].slice(0, 50).split(/\s+/).length) / wc.current * 100;
      setPct(Math.min(progress, 99));
    };
    u.onend = () => {
      chunkIndexRef.current = index + 1;
      speakChunk(index + 1);
    };
    u.onerror = () => { setPlaying(false); setPaused(false); };
    speechSynthesis.speak(u);
  }, [browserVoice, speed]);

  const playBrowserVoice = useCallback(() => {
    speechSynthesis.cancel();
    chunksRef.current = getChunks();
    chunkIndexRef.current = 0;
    speakChunk(0);
    setPlaying(true); setPaused(false); setPct(0);
  }, [getChunks, speakChunk]);

  // ── AI voice (OpenAI / ElevenLabs) ──
  const playAIVoice = async () => {
    if (mp3Url) {
      audioRef.current.currentTime = 0;
      audioRef.current.playbackRate = speed;
      audioRef.current.play();
      setPlaying(true); setPaused(false);
      return;
    }
    setMp3Loading(true); setMp3Error(""); setLoadingMsg("Preparing audio...");
    try {
      let blob;
      if (voiceEngine === "openai") {
        blob = format === "podcast"
          ? await generatePodcastMp3OpenAI(script, (msg) => setLoadingMsg(msg), openaiVoice1, openaiVoice2)
          : await generateSingleVoiceMp3OpenAI(script, format, openaiVoice1, (msg) => setLoadingMsg(msg));
      } else {
        blob = await generateMp3Blob(script, format, (msg) => setLoadingMsg(msg), elevenVoice1, elevenVoice2);
      }
      const blobUrl = URL.createObjectURL(blob);
      setMp3Url(blobUrl);
      const audio = new Audio(blobUrl);
      audio.playbackRate = speed;
      audioRef.current = audio;
      audio.play();
      setPlaying(true); setPaused(false);
    } catch (err) {
      setMp3Error(err.message);
    } finally {
      setMp3Loading(false); setLoadingMsg("");
    }
  };

  // ── Unified play/pause/stop ──
  const play_ = () => {
    if (voiceEngine === "browser") { playBrowserVoice(); }
    else { playAIVoice(); }
  };

  const pause_ = () => {
    if (voiceEngine === "browser") { speechSynthesis.pause(); }
    else if (audioRef.current) { audioRef.current.pause(); }
    setPlaying(false); setPaused(true);
  };
  const resume_ = () => {
    if (voiceEngine === "browser") { speechSynthesis.resume(); }
    else if (audioRef.current) { audioRef.current.play(); }
    setPlaying(true); setPaused(false);
  };
  const stop_ = () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; }
    speechSynthesis.cancel();
    setPlaying(false); setPaused(false); setPct(0);
  };

  const bars = [26,16,30,12,24,18,28,14,22,20];
  const mins = Math.max(1, Math.round(wc.current / (speed * 145)));
  return (
    <div style={{ background:BRAND.navy, border:`1px solid ${meta.color}35`, borderRadius:12, padding:"18px 22px", marginBottom:20 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"flex-end", gap:3, height:30 }}>
          {bars.map((h,i) => (
            <div key={i} style={{ width:4, borderRadius:2, background:`linear-gradient(to top,${meta.color},${meta.color}60)`,
              height: playing ? undefined : 4,
              animation: playing ? `wb${(i%4)+1} ${0.5+i*0.07}s ease-in-out infinite alternate` : "none",
              transition:"height 0.3s" }} />
          ))}
          <style>{`@keyframes wb1{from{height:4px}to{height:26px}}@keyframes wb2{from{height:5px}to{height:18px}}@keyframes wb3{from{height:7px}to{height:30px}}@keyframes wb4{from{height:4px}to{height:14px}}`}</style>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:13, color:"#aaa", fontFamily:BRAND.monoFont }}>SPEED</span>
          <input type="range" min="0.6" max="2.5" step="0.1" value={speed}
            onChange={e => {
              const newSpeed = +e.target.value;
              setSpeed(newSpeed);
              if (audioRef.current) { audioRef.current.playbackRate = newSpeed; }
            }}
            style={{ width:72, accentColor:meta.color }} />
          <span style={{ fontSize:14, color:meta.color, fontFamily:BRAND.monoFont, width:32 }}>{speed.toFixed(1)}×</span>
        </div>
      </div>
      <div style={{ height:3, background:"#181818", borderRadius:2, marginBottom:14, overflow:"hidden" }}>
        <div style={{ height:"100%", width:`${pct}%`, background:`linear-gradient(to right,${meta.color},${meta.color}70)`, transition:"width 0.4s linear", borderRadius:2 }} />
      </div>
      <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
        {playing
          ? <button onClick={pause_}  style={btnS(meta.color)}>⏸ Pause</button>
          : paused
            ? <button onClick={resume_} style={btnS(meta.color)}>▶ Resume</button>
            : mp3Loading
              ? <button disabled style={{...btnS(meta.color), opacity:0.5, cursor:"wait"}}>{loadingMsg || "Loading voice..."}</button>
              : <button onClick={play_} style={btnS(meta.color, true)}>▶ Play</button>}
        <button onClick={stop_} style={btnS("#2a2a2a")}>⏹</button>
        {mp3Url && <span style={{ fontSize:13, color:"#2a6", fontFamily:BRAND.monoFont }}>{format === "podcast" ? "● Dual-voice loaded" : "● AI voice loaded"}</span>}
        <span style={{ flex:1 }} />
        <span style={{ fontSize:14, color:"#aaa", fontFamily:BRAND.monoFont }}>~{mins} min</span>
      </div>
      {mp3Error && <div style={{ fontSize:14, color:"#e06050", fontFamily:BRAND.monoFont, marginTop:8 }}>Voice error: {mp3Error}</div>}
    </div>
  );
}

const btnS = (color, primary=false) => ({
  background: primary ? color : "transparent",
  border:`1px solid ${color}`, borderRadius:7,
  color: primary ? "#000" : color, padding:"10px 20px",
  cursor:"pointer", fontSize:15, fontFamily:BRAND.monoFont,
  letterSpacing:"0.05em", fontWeight: primary ? 700 : 400, transition:"all 0.15s"
});

/* ─── Repo Browser (Task 3) ───────────────────────────────────────────────── */

function RepoFilePicker({ selectedPages, setSelectedPages }) {
  const [repoFiles, setRepoFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("https://api.github.com/repos/syncshepherd-main/garys-garden/git/trees/main?recursive=1")
      .then(r => r.json())
      .then(data => {
        const files = (data.tree || [])
          .filter(f => f.type === "file" && /\.(html|md)$/i.test(f.path))
          .map(f => f.path);
        setRepoFiles(files);
        setLoading(false);
      })
      .catch(err => {
        setError("Could not load repo files: " + err.message);
        setLoading(false);
      });
  }, []);

  const toggle = (path) => {
    setSelectedPages(prev =>
      prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
    );
  };

  const estimatedWords = selectedPages.length * 800; // rough estimate per page

  if (loading) return <div style={{ color: "#bbb", fontSize: 14, fontFamily: BRAND.monoFont, padding: "12px 0" }}>Loading repo files...</div>;
  if (error) return <div style={{ color: "#e06050", fontSize: 12, fontFamily: BRAND.monoFont, padding: "12px 0" }}>{error}</div>;

  return (
    <div>
      <div style={{
        maxHeight: 220, overflowY: "auto", background: BRAND.cardBg, border: `1px solid ${BRAND.borderColor}`,
        borderRadius: 10, padding: "8px 0",
        scrollbarWidth: "thin", scrollbarColor: "#222 #0a0a0a"
      }}>
        {repoFiles.map(path => (
          <label key={path} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "7px 14px",
            cursor: "pointer", fontSize: 15, color: selectedPages.includes(path) ? "#e0e0e0" : "#bbb",
            fontFamily: BRAND.monoFont, transition: "background 0.15s",
            background: selectedPages.includes(path) ? "#1c1c1c" : "transparent",
          }}>
            <input
              type="checkbox"
              checked={selectedPages.includes(path)}
              onChange={() => toggle(path)}
              style={{ accentColor: "#60c860" }}
            />
            <span style={{ fontSize: 13, color: "#aaa", width: 32 }}>{/\.md$/i.test(path) ? "MD" : "HTML"}</span>
            {path}
          </label>
        ))}
      </div>
      {selectedPages.length > 0 && (
        <div style={{ fontSize: 14, color: "#bbb", fontFamily: BRAND.monoFont, marginTop: 8, paddingLeft: 2 }}>
          {selectedPages.length} page{selectedPages.length > 1 ? "s" : ""} selected · ~{estimatedWords.toLocaleString()} words estimated
        </div>
      )}
    </div>
  );
}

/* ─── Input Mode Tab Switcher ────────────────────────────────────────────── */

function InputModeTabs({ inputMode, setInputMode, color }) {
  const tabs = [
    { id: "url", label: "Enter URL" },
    { id: "repo", label: "Content Library" },
    { id: "pdf", label: "Upload PDF" },
  ];
  return (
    <div style={{ display: "flex", gap: 0, marginBottom: 14 }}>
      {tabs.map((tab, i) => (
        <button key={tab.id} onClick={() => setInputMode(tab.id)} style={{
          flex: 1, padding: "10px 16px", cursor: "pointer",
          background: inputMode === tab.id ? BRAND.cardBg : BRAND.darkBg,
          border: `1px solid ${inputMode === tab.id ? color : BRAND.borderColor}`,
          borderBottom: inputMode === tab.id ? `2px solid ${color}` : `1px solid ${BRAND.borderColor}`,
          color: inputMode === tab.id ? color : "#bbb",
          fontSize: 15, fontFamily: BRAND.monoFont, letterSpacing: "0.08em",
          fontWeight: inputMode === tab.id ? 700 : 400, transition: "all 0.2s",
          borderRadius: i === 0 ? "8px 0 0 0" : i === tabs.length - 1 ? "0 8px 0 0" : 0,
        }}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/* ─── PDF Drop Zone ──────────────────────────────────────────────────────── */

function PdfDropZone({ pdfDoc, pdfStatus, pdfMsg, onFile, disabled, color }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);

  // Catch drops anywhere on the page, so a near-miss doesn't open the PDF in the tab
  useEffect(() => {
    const isFileDrag = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
    const onDragOver = e => { if (isFileDrag(e)) e.preventDefault(); };
    const onDrop = e => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file && !disabled) onFile(file);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFile, disabled]);

  const reading = pdfStatus === "reading";

  return (
    <div
      onClick={() => !disabled && !reading && inputRef.current?.click()}
      onDragEnter={() => setOver(true)}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      style={{
        border: `2px dashed ${over ? color : BRAND.borderColor}`, borderRadius: 10,
        background: over ? `${color}12` : BRAND.cardBg,
        padding: "28px 20px", textAlign: "center", cursor: disabled || reading ? "wait" : "pointer",
        transition: "all 0.2s",
      }}
    >
      <input
        ref={inputRef} type="file" accept="application/pdf,.pdf" style={{ display: "none" }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}
      />
      {reading ? (
        <div style={{ fontSize: 15, color, fontFamily: BRAND.monoFont }}>{pdfMsg || "Reading PDF..."}</div>
      ) : pdfDoc ? (
        <>
          <div style={{ fontSize: 16, color: "#e0e0e0", fontFamily: BRAND.monoFont, marginBottom: 6, wordBreak: "break-all" }}>📄 {pdfDoc.name}</div>
          <div style={{ fontSize: 14, color: "#bcc8d4", fontFamily: BRAND.monoFont }}>
            {pdfDoc.pages} page{pdfDoc.pages > 1 ? "s" : ""} · {pdfDoc.words.toLocaleString()} words · {pdfDoc.chars.toLocaleString()} characters
          </div>
          <div style={{ fontSize: 13, color: "#8899aa", fontFamily: BRAND.monoFont, marginTop: 4 }}>
            {pdfDoc.chapters.length
              ? <>📑 {pdfDoc.chapters.length} chapter{pdfDoc.chapters.length > 1 ? "s" : ""}/sections found ({pdfDoc.chapterSource === "bookmarks" ? "from the PDF's bookmarks" : "from its headings"})</>
              : "📑 No chapters found — the share page will have no Contents menu"}
          </div>
          <div style={{ fontSize: 13, color: "#8899aa", fontFamily: BRAND.monoFont, marginTop: 8 }}>Drop another PDF or click to replace</div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📄</div>
          <div style={{ fontSize: 16, color: "#e0e0e0", fontFamily: BRAND.monoFont }}>Drop a PDF here or click to browse</div>
          <div style={{ fontSize: 13, color: "#8899aa", fontFamily: BRAND.monoFont, marginTop: 6 }}>Text is read in your browser · PDFs with selectable text (not scans) · up to 50 MB</div>
        </>
      )}
    </div>
  );
}

function SharePageButton({ pdfDoc, pdfAudio, color }) {
  const [status, setStatus] = useState("idle"); // idle | uploading | done | error
  const [shareUrl, setShareUrl] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [pct, setPct] = useState(0);
  // Remembered so the same share password is pre-filled next time (this browser only)
  const [password, setPassword] = useState(() => { try { return localStorage.getItem("pagecast.sharePassword") || ""; } catch { return ""; } });
  const [usedPassword, setUsedPassword] = useState("");

  // A new render means a new share page
  useEffect(() => { setStatus("idle"); setShareUrl(""); setErr(""); }, [pdfAudio]);

  const create = async () => {
    setStatus("uploading"); setErr(""); setPct(0);
    try {
      const url = await createSharePage({
        pdfFile: pdfDoc.file,
        audioBlob: pdfAudio.blob,
        title: pdfDoc.name.replace(/\.pdf$/i, ""),
        voice: pdfAudio.voice,
        segments: pdfAudio.segments,
        chapters: pdfAudio.chapters,
        password: password.trim(),
      }, setPct);
      try { localStorage.setItem("pagecast.sharePassword", password.trim()); } catch { /* storage blocked */ }
      setUsedPassword(password.trim());
      setShareUrl(url); setStatus("done");
    } catch (e) {
      setErr(e.message); setStatus("error");
    }
  };

  const copy = () => { navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 2200); };

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${BRAND.borderColor}` }}>
      {status === "done" ? (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <a href={shareUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, color, fontFamily: BRAND.monoFont, wordBreak: "break-all", flex: "1 1 260px" }}>{shareUrl}</a>
            <button onClick={copy} style={btnS(color)}>{copied ? "✓ Copied" : "⎘ Copy link"}</button>
          </div>
          <div style={{ fontSize: 14, color: "#bcc8d4", fontFamily: BRAND.monoFont, marginTop: 8 }}>
            {usedPassword ? <>🔒 Password: <span style={{ color: "#fff" }}>{usedPassword}</span></> : "🔓 Open link — no password"}
          </div>
        </>
      ) : (
        <>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <label htmlFor="share-pw" style={{ fontSize: 12, color: "#8899aa", fontFamily: BRAND.monoFont, letterSpacing: "0.1em" }}>PASSWORD:</label>
          <input id="share-pw" type="text" value={password} onChange={e => setPassword(e.target.value)} placeholder="optional"
            disabled={status === "uploading"} autoComplete="off" spellCheck={false}
            style={{ background: BRAND.cardBg, border: `1px solid ${BRAND.borderColor}`, borderRadius: 6, color: "#e0e0e0",
              fontSize: 14, fontFamily: BRAND.monoFont, padding: "6px 10px", flex: "1 1 160px", maxWidth: 260 }} />
        </div>
        <button onClick={create} disabled={status === "uploading"} style={{ ...btnS(color, status !== "uploading"), opacity: status === "uploading" ? 0.5 : 1, cursor: status === "uploading" ? "wait" : "pointer" }}>
          {status === "uploading" ? `Uploading... ${pct}%` : status === "error" ? "⚠ Retry share page" : "🔗 Create share page"}
        </button>
        </>
      )}
      <div style={{ fontSize: 13, color: "#8899aa", fontFamily: BRAND.monoFont, marginTop: 8 }}>
        {status === "error" ? <span style={{ color: "#e06050" }}>Share error: {err}</span>
          : status === "done" ? "Listen + read-along page with the original PDF. Send the password along with the link."
          : "Listen + read-along page with the original PDF. Leave the password blank for an open link. Listeners enter it once per device."}
      </div>
    </div>
  );
}

/** What to narrate: spoken intro + include/skip per top-level chapter */
function NarrationPicker({ pdfDoc, skip, setSkip, intro, setIntro, color, disabled }) {
  const toggle = key => setSkip(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  return (
    <div style={{ marginTop: 16, background: BRAND.cardBg, border: `1px solid ${BRAND.borderColor}`, borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 12, color: "#8899aa", fontFamily: BRAND.monoFont, letterSpacing: "0.1em", marginBottom: 8 }}>WHAT TO NARRATE:</div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13, color: "#bcc8d4", fontFamily: BRAND.monoFont, marginBottom: 10 }}>
        Spoken intro
        <input value={intro} onChange={e => setIntro(e.target.value)} disabled={disabled} placeholder="optional — e.g. title and author" spellCheck={false}
          style={{ flex: "1 1 260px", background: BRAND.darkBg, border: `1px solid ${BRAND.borderColor}`, borderRadius: 6, color: "#e0e0e0", fontSize: 14, fontFamily: BRAND.bodyFont, padding: "6px 10px" }} />
      </label>
      <div style={{ maxHeight: 240, overflowY: "auto", scrollbarWidth: "thin" }}>
        {pdfDoc.sections.map(sec => {
          const on = !skip.has(sec.key);
          return (
            <label key={sec.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 2px", cursor: disabled ? "default" : "pointer",
              fontSize: 14, fontFamily: BRAND.bodyFont, color: on ? "#e0e0e0" : "#667" }}>
              <input type="checkbox" checked={on} onChange={() => toggle(sec.key)} disabled={disabled} style={{ accentColor: color }} />
              <span style={{ flex: 1, textDecoration: on ? "none" : "line-through" }}>{sec.title}</span>
              <span style={{ fontSize: 12, fontFamily: BRAND.monoFont, color: "#8899aa" }}>p{sec.page}</span>
            </label>
          );
        })}
      </div>
      <div style={{ fontSize: 12, color: "#8899aa", fontFamily: BRAND.monoFont, marginTop: 8 }}>
        Unchecked parts aren't read aloud. They still show in the PDF view of the share page.
      </div>
    </div>
  );
}

function PdfAudioEstimate({ narration, voiceEngine, elBalance, vibed }) {
  if (!narration || !narration.length) return null;
  const chars = narration.reduce((n, s) => n + s.text.length + 1, 0);
  const words = narration.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  const mins = Math.max(1, Math.round(words / 150));
  const style = { fontSize: 14, fontFamily: BRAND.monoFont, marginTop: 10, paddingLeft: 2 };

  if (voiceEngine === "browser") {
    return <div style={{ ...style, color: "#e0a030" }}>Browser Voice can't make an audio file. Pick OpenAI or ElevenLabs to download an MP3.</div>;
  }
  const fmt = m => m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
  const renderNote = chars > 40000 && <> · takes several minutes — keep this tab open</>;
  if (voiceEngine === "openai") {
    // tts-1: $0.015 / 1K chars · gpt-4o-mini-tts (vibes): ~$0.015 per minute of audio
    const cost = vibed ? mins * 0.015 : chars / 1000 * 0.015;
    return <div style={{ ...style, color: "#10a37f" }}>~{fmt(mins)} of audio · est. OpenAI cost ${cost.toFixed(2)}{renderNote}</div>;
  }
  const remaining = elBalance ? elBalance.character_limit - elBalance.character_count : null;
  const short = remaining != null && chars > remaining;
  return (
    <div style={{ ...style, color: short ? "#e05050" : "#f0a030" }}>
      ~{fmt(mins)} of audio · uses ~{chars.toLocaleString()} ElevenLabs characters
      {remaining != null && <> of {remaining.toLocaleString()} remaining</>}
      {short && " — not enough credit for the whole PDF"}
    </div>
  );
}

/* ─── ElevenLabs Credit Balance ───────────────────────────────────────────── */

async function fetchElevenLabsBalance() {
  try {
    const res = await fetch(`${WORKER_URL}/subscription`);
    const data = await res.json();
    if (data.error) return null;
    return data;
  } catch {
    return null;
  }
}

function useElevenLabsBalance() {
  const [balance, setBalance] = useState(null);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${WORKER_URL}/subscription`);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setBalance(null);
      } else {
        setBalance(data);
        setError(null);
      }
    } catch (err) {
      setError(err.message);
    }
    setLoaded(true);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { balance, error, loaded, refresh };
}

function CreditBalance({ balance, error }) {
  if (error) {
    const isPermission = error.includes("401") || error.includes("permission");
    if (isPermission) return null; // API key lacks user_read scope — hide quietly
    return (
      <div style={{ fontSize: 13, color: "#e0a030", fontFamily: BRAND.monoFont }}>
        ElevenLabs: {error}
      </div>
    );
  }
  if (!balance) return null;
  const { character_count, character_limit } = balance;
  const remaining = character_limit - character_count;
  const pct = remaining / character_limit;
  const color = pct < 0.1 ? "#e05050" : pct < 0.3 ? "#e0a030" : "#40b060";
  return (
    <div style={{ fontSize: 13, color, fontFamily: BRAND.monoFont }}>
      ElevenLabs: {remaining.toLocaleString()} / {character_limit.toLocaleString()} chars remaining
    </div>
  );
}

/* ─── OpenAI Billing Info ─────────────────────────────────────────────────── */

function useOpenAIBilling() {
  const [billing, setBilling] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${WORKER_URL}/openai-billing`);
      const data = await res.json();
      setBilling(data);
    } catch {
      setBilling({ error: "Failed to fetch", rate: 0.015 });
    }
    setLoaded(true);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { billing, loaded, refresh };
}

function OpenAIBillingDisplay({ billing }) {
  if (!billing) return null;

  const parts = [];

  // Show balance if available
  if (billing.balance && billing.balance.total_available != null) {
    const avail = billing.balance.total_available;
    const color = avail < 1 ? "#e05050" : avail < 5 ? "#e0a030" : "#10a37f";
    parts.push(
      <span key="bal" style={{ color }}>
        Balance: ${avail.toFixed(2)}
      </span>
    );
  }

  // Show monthly cost if available
  if (billing.monthly_cost != null) {
    parts.push(
      <span key="cost" style={{ color: "#aaa" }}>
        This month: ${billing.monthly_cost.toFixed(2)}
      </span>
    );
  }

  // Always show the rate
  if (parts.length === 0) {
    parts.push(
      <span key="rate" style={{ color: "#10a37f" }}>
        TTS rate: $0.015 / 1K chars
      </span>
    );
  }

  return (
    <div style={{ fontSize: 13, fontFamily: BRAND.monoFont, display: "flex", gap: 12 }}>
      <span style={{ color: "#10a37f" }}>OpenAI:</span>
      {parts}
    </div>
  );
}

/* ─── Voice Engine Selector ───────────────────────────────────────────────── */

const ENGINES = [
  { id: "openai",     label: "OpenAI TTS",        color: "#10a37f", icon: "🤖" },
  { id: "elevenlabs", label: "ElevenLabs",         color: "#f0a030", icon: "🔊" },
  { id: "browser",    label: "Browser Voice (Free)", color: "#888",  icon: "🖥" },
];

/* ─── Voice Preview ──────────────────────────────────────────────────────── */

const PREVIEW_CHARS = 280; // ~15 seconds of speech, under $0.01

/** Opening sentences of the source (up to ~280 chars), or a stock line */
function previewText(sampleText, label) {
  const text = (sampleText || "").replace(/\s+/g, " ").trim();
  if (text.length < 40) return `Hi, I'm ${label}. This is how I'll sound reading your document out loud, from start to finish.`;
  if (text.length <= PREVIEW_CHARS) return text;
  const cut = text.slice(0, PREVIEW_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > 80 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(" ")) + "...";
}

function VoicePreviewButton({ engine, voice, sampleText, instructions }) {
  const [state, setState] = useState("idle"); // idle | loading | playing | error
  const [err, setErr] = useState("");
  const audioRef = useRef(null);
  const cacheRef = useRef({}); // "engine|voice|text" → blob URL, so replays are free

  const stop = () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setState("idle");
  };

  // Stop when the voice changes or the picker unmounts
  useEffect(() => stop, [engine, voice, instructions]);
  useEffect(() => () => Object.values(cacheRef.current).forEach(u => URL.revokeObjectURL(u)), []);

  const play = async () => {
    if (state === "playing" || state === "loading") { stop(); return; }
    const label = engine === "openai" ? OPENAI_VOICES[voice].label : ELEVENLABS_VOICES[voice].label;
    const text = previewText(sampleText, label);
    const key = `${engine}|${voice}|${instructions || ""}|${text}`;
    setErr("");
    try {
      if (!cacheRef.current[key]) {
        setState("loading");
        const buf = engine === "openai"
          ? await fetchOpenAITTSClip(text, voice, instructions)
          : await fetchTTSClip(text, ELEVENLABS_VOICES[voice].id);
        cacheRef.current[key] = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
      }
      const audio = new Audio(cacheRef.current[key]);
      audio.onended = () => setState("idle");
      audioRef.current = audio;
      await audio.play();
      setState("playing");
    } catch (e) {
      setErr(e.message); setState("error");
    }
  };

  const color = engine === "openai" ? "#10a37f" : "#f0a030";
  return (
    <>
      <button onClick={play} title="Hear a ~15 second sample (under $0.01)" style={{
        background: state === "playing" ? `${color}20` : "transparent",
        border: `1px solid ${color}`, borderRadius: 6, padding: "4px 10px",
        color, fontSize: 13, fontFamily: BRAND.monoFont, cursor: state === "loading" ? "wait" : "pointer",
      }}>
        {state === "loading" ? "Loading..." : state === "playing" ? "⏹ Stop" : "▶ Preview"}
      </button>
      {state === "error" && <span style={{ fontSize: 12, color: "#e06050", fontFamily: BRAND.monoFont }}>{err}</span>}
    </>
  );
}

function VoiceEngineSelector({ engine, onChange, meta, elBalance, elError, oaiBilling, output, format, sampleText, previewInstructions,
  openaiVoice1, setOpenaiVoice1, openaiVoice2, setOpenaiVoice2,
  elevenVoice1, setElevenVoice1, elevenVoice2, setElevenVoice2 }) {

  const cleaned = output ? cleanScriptForTTS(output, format) : "";
  const charCount = cleaned.length;
  const estCost = charCount > 0 ? (charCount / 1000 * 0.015).toFixed(3) : null;
  const isPodcast = format === "podcast";

  const selectStyle = {
    background: BRAND.cardBg, border: `1px solid ${BRAND.borderColor}`, borderRadius: 6,
    color: "#ccc", fontSize: 13, fontFamily: BRAND.monoFont, padding: "4px 8px", cursor: "pointer",
  };

  return (
    <div style={{ marginTop:8 }}>
      {/* Engine toggle row */}
      <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
        <span style={{ fontSize:12, color:"#8899aa", fontFamily:BRAND.monoFont, letterSpacing:"0.1em" }}>ENGINE:</span>
        {ENGINES.map(e => (
          <button
            key={e.id}
            onClick={() => onChange(e.id)}
            style={{
              background: engine === e.id ? `${e.color}20` : "transparent",
              border: `1px solid ${engine === e.id ? e.color : "#333"}`,
              borderRadius: 6, padding: "4px 10px",
              color: engine === e.id ? e.color : "#777",
              fontSize: 13, fontFamily: BRAND.monoFont,
              cursor: "pointer", transition: "all 0.15s",
            }}
          >
            {e.icon} {e.label}
          </button>
        ))}
        {engine === "browser" && <span style={{ fontSize:12, color:"#888", fontFamily:BRAND.monoFont, marginLeft:4 }}>Free</span>}
      </div>

      {/* Billing info row */}
      <div style={{ marginTop:6 }}>
        {engine === "openai" && <OpenAIBillingDisplay billing={oaiBilling} />}
        {engine === "elevenlabs" && <CreditBalance balance={elBalance} error={elError} />}
      </div>

      {/* Voice picker row */}
      {engine !== "browser" && (
        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginTop:8 }}>
          <span style={{ fontSize:12, color:"#8899aa", fontFamily:BRAND.monoFont, letterSpacing:"0.1em" }}>
            {isPodcast ? "ALEX:" : "VOICE:"}
          </span>
          {engine === "openai" && (
            <select value={openaiVoice1} onChange={e => setOpenaiVoice1(e.target.value)} style={selectStyle}>
              {Object.entries(OPENAI_VOICES).map(([k,v]) => (
                <option key={k} value={k}>{v.label} — {v.desc}</option>
              ))}
            </select>
          )}
          {engine === "elevenlabs" && (
            <select value={elevenVoice1} onChange={e => setElevenVoice1(e.target.value)} style={selectStyle}>
              {Object.entries(ELEVENLABS_VOICES).map(([k,v]) => (
                <option key={k} value={k}>{v.label} — {v.desc}</option>
              ))}
            </select>
          )}
          <VoicePreviewButton engine={engine} voice={engine === "openai" ? openaiVoice1 : elevenVoice1} sampleText={sampleText} instructions={engine === "openai" ? previewInstructions : null} />

          {isPodcast && (
            <>
              <span style={{ fontSize:12, color:"#8899aa", fontFamily:BRAND.monoFont, letterSpacing:"0.1em", marginLeft:8 }}>MORGAN:</span>
              {engine === "openai" && (
                <select value={openaiVoice2} onChange={e => setOpenaiVoice2(e.target.value)} style={selectStyle}>
                  {Object.entries(OPENAI_VOICES).map(([k,v]) => (
                    <option key={k} value={k}>{v.label} — {v.desc}</option>
                  ))}
                </select>
              )}
              {engine === "elevenlabs" && (
                <select value={elevenVoice2} onChange={e => setElevenVoice2(e.target.value)} style={selectStyle}>
                  {Object.entries(ELEVENLABS_VOICES).map(([k,v]) => (
                    <option key={k} value={k}>{v.label} — {v.desc}</option>
                  ))}
                </select>
              )}
              <VoicePreviewButton engine={engine} voice={engine === "openai" ? openaiVoice2 : elevenVoice2} sampleText={sampleText} instructions={engine === "openai" ? previewInstructions : null} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Unified Export MP3 Button ──────────────────────────────────────────── */

function ExportMp3Unified({ output, format, meta, voiceEngine, onExportDone,
  openaiVoice1, openaiVoice2, elevenVoice1, elevenVoice2 }) {
  const [exportStatus, setExportStatus] = useState("idle");
  const [exportError, setExportError] = useState("");
  const [exportMsg, setExportMsg] = useState("");

  if (voiceEngine === "browser") return null; // browser voice can't export MP3

  const handleExport = async () => {
    setExportStatus("exporting");
    setExportError(""); setExportMsg("");
    try {
      if (voiceEngine === "openai") {
        await exportToMp3OpenAI(output, format, (msg) => setExportMsg(msg), openaiVoice1, openaiVoice2);
      } else {
        await exportToMp3(output, format, (msg) => setExportMsg(msg), elevenVoice1, elevenVoice2);
      }
      setExportStatus("done");
      if (onExportDone) onExportDone();
      setTimeout(() => setExportStatus("idle"), 3000);
    } catch (err) {
      setExportStatus("error");
      setExportError(err.message);
    }
  };

  const engineColor = voiceEngine === "openai" ? "#10a37f" : meta.color;
  const engineLabel = voiceEngine === "openai" ? "OpenAI" : "ElevenLabs";

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={handleExport}
          disabled={exportStatus === "exporting"}
          title={`Export as MP3 via ${engineLabel}`}
          style={{
            ...btnS(engineColor, exportStatus === "idle"),
            opacity: exportStatus === "exporting" ? 0.5 : 1,
            cursor: exportStatus === "exporting" ? "not-allowed" : "pointer",
          }}
        >
          {exportStatus === "exporting" && (
            <span style={{ display: "inline-block", animation: "blink 1s ease-in-out infinite" }}>🔊 {exportMsg || "Rendering audio..."}</span>
          )}
          {exportStatus === "done" && "✓ Downloaded"}
          {exportStatus === "error" && `⚠ Retry`}
          {exportStatus === "idle" && `↓ Export MP3 (${engineLabel})`}
        </button>
      </div>
      {exportStatus === "error" && exportError && (
        <div style={{ fontSize: 14, color: engineColor, fontFamily: BRAND.monoFont, marginTop: 6 }}>
          {engineLabel} error: {exportError}
        </div>
      )}
    </div>
  );
}

/* ─── Main App ────────────────────────────────────────────────────────────── */

export default function PageCast() {
  const [url, setUrl]                   = useState("");
  const [format, setFormat]             = useState("podcast");
  const [phase, setPhase]               = useState("idle");
  const [statusMsg, setStatus]          = useState("");
  const [output, setOutput]             = useState("");
  const [error, setError]               = useState("");
  const [copied, setCopied]             = useState(false);
  const [inputMode, setInputMode]       = useState("url"); // url | repo
  const [selectedPages, setSelectedPages] = useState([]);
  const [crawlLinks, setCrawlLinks]     = useState(false);
  const [sourceWordCount, setSourceWordCount] = useState(0);
  const [voiceEngine, setVoiceEngine]   = useState("openai"); // openai | elevenlabs | browser
  const [vibe, setVibe]                 = useState("professional");
  // Voice selections: host1 = main/ALEX voice, host2 = MORGAN voice (podcast only)
  const [openaiVoice1, setOpenaiVoice1]   = useState("onyx");
  const [openaiVoice2, setOpenaiVoice2]   = useState("alloy");
  const [elevenVoice1, setElevenVoice1]   = useState("adam");
  const [elevenVoice2, setElevenVoice2]   = useState("matilda");
  const { balance: elBalance, error: elError, refresh: refreshBalance } = useElevenLabsBalance();
  const { billing: oaiBilling } = useOpenAIBilling();
  // PDF input: pdfMode "verbatim" reads the PDF as-is, "script" feeds it to the selected format
  const [pdfDoc, setPdfDoc]             = useState(null);
  const [pdfStatus, setPdfStatus]       = useState("idle"); // idle | reading | ready | error
  const [pdfMsg, setPdfMsg]             = useState("");
  const [pdfMode, setPdfMode]           = useState("verbatim");
  const [pdfAudio, setPdfAudio]         = useState(null);   // { url, name }
  const [pdfSkip, setPdfSkip]           = useState(new Set()); // section keys left out of the audio
  const [pdfIntro, setPdfIntro]         = useState("");        // spoken intro line
  const [readVibe, setReadVibe]         = useState("standard"); // narration vibe (word-for-word)
  const outputRef = useRef(null);
  const meta = FORMAT_META[format];
  const busy = phase === "running";
  const pdfVerbatim = inputMode === "pdf" && pdfMode === "verbatim";
  const narration = useMemo(() => pdfDoc ? narrationSentences(pdfDoc, pdfSkip, pdfIntro) : [], [pdfDoc, pdfSkip, pdfIntro]);
  const readInstructions = voiceEngine === "openai" ? NARRATION_VIBES[readVibe].instructions : null;

  const handlePdfFile = useCallback(async (file) => {
    if (!(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) {
      setError("That file isn't a PDF."); return;
    }
    if (file.size > PDF_MAX_BYTES) {
      setError("That PDF is over 50 MB."); return;
    }
    setError(""); setPdfStatus("reading"); setPdfMsg("Reading PDF...");
    setPdfAudio(prev => { if (prev) URL.revokeObjectURL(prev.url); return null; });
    try {
      const doc = await extractPdfText(file, setPdfMsg);
      // Defaults: skip Contents/Sources-type sections; with an intro, skip the front page
      setPdfSkip(new Set(doc.sections.filter(s => s.skip || (s.key === "front" && doc.intro)).map(s => s.key)));
      setPdfIntro(doc.intro);
      setPdfDoc(doc); setPdfStatus("ready");
    } catch (e) {
      setPdfDoc(null); setPdfStatus("error"); setError(e.message);
    }
  }, []);

  const renderPdfAudio = async () => {
    if (voiceEngine === "browser") { setError("Browser Voice can't make an audio file. Pick OpenAI or ElevenLabs."); return; }
    setError(""); setPhase("running"); setStatus("Rendering audio...");
    setPdfAudio(prev => { if (prev) URL.revokeObjectURL(prev.url); return null; });
    try {
      const voice = voiceEngine === "openai" ? openaiVoice1 : elevenVoice1;
      if (!narration.length) { setPhase("idle"); setError("Nothing selected to narrate."); return; }
      const { blob, segments } = await renderLongTextMp3(narration, voiceEngine, voice, setStatus, readInstructions);
      const name = `${pdfDoc.name.replace(/\.pdf$/i, "")}-${voice}.mp3`;
      downloadBlob(blob, name);
      // Contents only lists chapters whose section is narrated
      const included = pdfDoc.sections.filter(sec => !pdfSkip.has(sec.key));
      const chapters = pdfDoc.chapters.filter(c => included.some(sec => c.sentence >= sec.start && c.sentence < sec.end));
      setPdfAudio({ url: URL.createObjectURL(blob), name, blob, segments, voice, chapters: placeChapters(chapters, segments) });
      setPhase("idle");
      if (voiceEngine === "elevenlabs") refreshBalance();
    } catch (e) {
      setPhase("error");
      setError(e.message);
    }
  };

  const run = async () => {
    if (inputMode === "pdf") {
      if (!pdfDoc) { setError("Drop a PDF first."); return; }
      if (pdfMode === "verbatim") return renderPdfAudio();
    } else if (inputMode === "url") {
      const u = url.trim();
      if (!u) { setError("Please enter a URL."); return; }
      if (!u.startsWith("http")) { setError("URL must start with http:// or https://"); return; }
    } else {
      if (selectedPages.length === 0) { setError("Select at least one page from the repo."); return; }
    }

    setError(""); setOutput(""); setPhase("running"); setSourceWordCount(0);

    try {
      let combinedText = "";
      let isMultiPage = false;

      if (inputMode === "pdf") {
        // PDF mode — text already extracted in the browser
        combinedText = pdfDoc.text.length > PDF_SCRIPT_MAX_CHARS
          ? pdfDoc.text.slice(0, PDF_SCRIPT_MAX_CHARS) + "\n\n[Content truncated at 150,000 characters]"
          : pdfDoc.text;
      } else if (inputMode === "repo") {
        // Content Library mode — fetch each selected page via raw.githubusercontent.com
        const total = selectedPages.length;
        isMultiPage = total > 1;
        for (let i = 0; i < total; i++) {
          setStatus(`Fetching page ${i + 1} of ${total}...`);
          const rawUrl = `https://raw.githubusercontent.com/syncshepherd-main/garys-garden/main/${selectedPages[i]}`;
          const data = await fetchViaWorker(rawUrl);
          combinedText += `\n\n--- PAGE BREAK: ${selectedPages[i]} ---\n\n${data.text}`;
        }
      } else if (crawlLinks) {
        // URL mode with crawl enabled
        setStatus("Fetching page and discovering links...");
        const rootData = await fetchViaWorkerWithLinks(url.trim());
        combinedText = rootData.text;

        if (rootData.links && rootData.links.length > 0) {
          const links = rootData.links.slice(0, 10);
          isMultiPage = true;
          const fetches = links.map((link, i) => {
            setStatus(`Fetching page ${i + 2} of ${links.length + 1}...`);
            return fetchViaWorker(link).catch(() => ({ text: "" }));
          });
          const results = await Promise.all(fetches);
          results.forEach((data, i) => {
            if (data.text) {
              combinedText += `\n\n--- PAGE BREAK: ${links[i]} ---\n\n${data.text}`;
            }
          });
        }
      } else {
        // Simple single-URL mode
        setStatus("Fetching page...");
        const data = await fetchViaWorker(url.trim());
        combinedText = data.text;
      }

      const srcWords = combinedText.split(/\s+/).filter(Boolean).length;
      setSourceWordCount(srcWords);

      setStatus(`Generating your ${FORMAT_META[format].tag}...`);
      const result = await generateScript(combinedText, format, isMultiPage, vibe);
      setOutput(result);
      setPhase("done");
      setTimeout(() => outputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    } catch(e) {
      setPhase("error");
      setError(e.message);
    }
  };

  const copy = () => { navigator.clipboard.writeText(output); setCopied(true); setTimeout(()=>setCopied(false),2200); };
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([output],{type:"text/plain"}));
    a.download = `${format}-script.txt`;
    a.click();
  };

  return (
    <div style={{ minHeight:"100vh", background:BRAND.darkBg, color:"#d0d0d0", fontFamily:BRAND.bodyFont }}>

      {/* top bar */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 28px", height:52, borderBottom:`1px solid ${BRAND.borderColor}`, background:BRAND.navy }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ width:7, height:7, borderRadius:"50%", display:"inline-block",
            background: busy ? BRAND.gold : "#555",
            boxShadow: busy ? `0 0 8px ${BRAND.gold}` : "none",
            animation: busy ? "blink 1s ease-in-out infinite" : "none" }} />
          <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}`}</style>
          <span style={{ fontSize:13, fontFamily:BRAND.monoFont, letterSpacing:"0.18em", color:"#bcc8d4", textTransform:"uppercase" }}>
            {busy ? statusMsg : phase === "done" ? "● OUTPUT READY" : "PAGECAST"}
          </span>
        </div>
        <span style={{ fontSize:13, color:BRAND.gold, fontFamily:BRAND.headingFont, fontWeight:700, letterSpacing:"0.12em" }}>SYNCSHEPHERD STUDIO</span>
      </div>

      <Ticker />

      {/* hero */}
      <div style={{ textAlign:"center", padding:"54px 24px 44px", borderBottom:`1px solid ${BRAND.borderColor}`, position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", top:"60%", left:"50%", transform:"translate(-50%,-50%)", width:700, height:400,
          background:`radial-gradient(ellipse, ${BRAND.blue}10 0%, transparent 65%)`, pointerEvents:"none" }} />
        <div style={{ fontSize:13, letterSpacing:"0.3em", color:"#8899aa", fontFamily:BRAND.monoFont, marginBottom:18, textTransform:"uppercase" }}>
          ◆ URL-to-Broadcast Engine · Server-Side Fetch
        </div>
        <h1 style={{ margin:"0 0 10px", fontSize:"clamp(38px,6vw,70px)", fontWeight:900, lineHeight:1.0, letterSpacing:"-0.02em", color:"#fff", fontFamily:BRAND.headingFont }}>
          Page<br />
          <span style={{ color:BRAND.blue, transition:"color 0.3s" }}>Cast</span>
        </h1>
        <p style={{ fontSize:17, color:"#bcc8d4", maxWidth:500, margin:"16px auto 0", lineHeight:1.7, fontFamily:BRAND.bodyFont }}>
          Paste any public URL or browse your Content Library. The Worker fetches the full page server-side — no browser limits, no CORS, no proxies.
        </p>
      </div>

      <div style={{ maxWidth:760, margin:"0 auto", padding:"44px 22px 0" }}>

        {/* Input mode tabs */}
        <InputModeTabs inputMode={inputMode} setInputMode={setInputMode} color={meta.color} />

        {/* URL input (url mode) */}
        {inputMode === "url" && (
          <div style={{ marginBottom:20 }}>
            <div style={{ position:"relative" }}>
              <span style={{ position:"absolute", left:16, top:"50%", transform:"translateY(-50%)", fontSize:15, color:"#8899aa", fontFamily:BRAND.monoFont, pointerEvents:"none" }}>URL →</span>
              <input
                type="url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !busy && run()}
                placeholder="https://any-public-website.com/page"
                disabled={busy}
                style={{ width:"100%", background:BRAND.cardBg, border:`1px solid ${BRAND.borderColor}`, borderRadius:10,
                  padding:"16px 16px 16px 76px", color:"#e0e0e0", fontSize:17,
                  fontFamily:BRAND.monoFont, outline:"none", boxSizing:"border-box", transition:"border-color 0.2s" }}
                onFocus={e => e.target.style.borderColor = BRAND.blue}
                onBlur={e => e.target.style.borderColor = BRAND.borderColor}
              />
            </div>
            {/* Crawl links checkbox (Task 4) */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 15, color: "#bcc8d4", fontFamily: BRAND.monoFont }}>
                <input
                  type="checkbox"
                  checked={crawlLinks}
                  onChange={e => setCrawlLinks(e.target.checked)}
                  style={{ accentColor: meta.color }}
                />
                Include linked pages (crawl up to 10)
              </label>
            </div>
            <div style={{ fontSize:14, color:"#8899aa", fontFamily:BRAND.monoFont, marginTop:7, paddingLeft:2 }}>
              Works on articles, blogs, business sites, docs, news — any publicly accessible page.
            </div>
          </div>
        )}

        {/* Repo file picker (repo mode — Task 3) */}
        {inputMode === "repo" && (
          <div style={{ marginBottom: 20 }}>
            <RepoFilePicker selectedPages={selectedPages} setSelectedPages={setSelectedPages} />
          </div>
        )}

        {/* PDF drop zone (pdf mode) */}
        {inputMode === "pdf" && (
          <div style={{ marginBottom: 20 }}>
            <PdfDropZone pdfDoc={pdfDoc} pdfStatus={pdfStatus} pdfMsg={pdfMsg} onFile={handlePdfFile} disabled={busy} color={meta.color} />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
              {[
                { id: "verbatim", label: "🔊 Read it word-for-word" },
                { id: "script",   label: "✍ Turn it into a script first" },
              ].map(m => (
                <button key={m.id} onClick={() => setPdfMode(m.id)} style={{
                  background: pdfMode === m.id ? `${meta.color}20` : "transparent",
                  border: `1px solid ${pdfMode === m.id ? meta.color : "#333"}`,
                  borderRadius: 7, padding: "6px 12px",
                  color: pdfMode === m.id ? meta.color : "#777",
                  fontSize: 13, fontFamily: BRAND.monoFont,
                  cursor: "pointer", transition: "all 0.15s",
                }}>
                  {m.label}
                </button>
              ))}
            </div>
            {pdfVerbatim && pdfDoc && pdfDoc.sections.length > 1 && (
              <NarrationPicker pdfDoc={pdfDoc} skip={pdfSkip} setSkip={setPdfSkip} intro={pdfIntro} setIntro={setPdfIntro} color={meta.color} disabled={busy} />
            )}
            {pdfVerbatim && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize:12, color:"#8899aa", fontFamily:BRAND.monoFont, letterSpacing:"0.1em", marginBottom:8 }}>VIBE:</div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  {Object.entries(NARRATION_VIBES).map(([id, v]) => (
                    <button key={id} onClick={() => setReadVibe(id)} title={v.desc} disabled={voiceEngine !== "openai"} style={{
                      background: readVibe === id && voiceEngine === "openai" ? `${meta.color}20` : "transparent",
                      border: `1px solid ${readVibe === id && voiceEngine === "openai" ? meta.color : "#333"}`,
                      borderRadius: 7, padding: "6px 12px",
                      color: readVibe === id && voiceEngine === "openai" ? meta.color : "#777",
                      fontSize: 13, fontFamily: BRAND.monoFont,
                      cursor: voiceEngine === "openai" ? "pointer" : "not-allowed", transition: "all 0.15s",
                      opacity: voiceEngine === "openai" ? 1 : 0.5,
                    }}>
                      {v.icon} {v.label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 13, color: "#8899aa", fontFamily: BRAND.monoFont, marginTop: 6 }}>
                  {voiceEngine !== "openai" ? "Vibes work with OpenAI voices."
                    : readVibe === "standard" ? "Standard is the most faithful word-for-word reading. Pick a vibe for tone, then ▶ Preview to hear it."
                    : `${NARRATION_VIBES[readVibe].desc} — uses OpenAI's expressive voice model. ▶ Preview to hear it.`}
                </div>
              </div>
            )}
            {pdfVerbatim && <PdfAudioEstimate narration={narration} voiceEngine={voiceEngine} elBalance={elBalance} vibed={!!readInstructions} />}
          </div>
        )}

        {/* Format cards */}
        {!pdfVerbatim && <>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 10, marginBottom: 26
        }}>
          {Object.entries(FORMAT_META).map(([id,m]) => (
            <FormatCard key={id} id={id} meta={m} selected={format===id} onClick={()=>setFormat(id)} />
          ))}
        </div>

        {/* Vibe selector */}
        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:12, color:"#8899aa", fontFamily:BRAND.monoFont, letterSpacing:"0.1em", marginBottom:8 }}>VIBE:</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {Object.entries(VIBES).map(([id, v]) => (
              <button
                key={id}
                onClick={() => setVibe(id)}
                title={v.desc}
                style={{
                  background: vibe === id ? `${meta.color}20` : "transparent",
                  border: `1px solid ${vibe === id ? meta.color : "#333"}`,
                  borderRadius: 7, padding: "6px 12px",
                  color: vibe === id ? meta.color : "#777",
                  fontSize: 13, fontFamily: BRAND.monoFont,
                  cursor: "pointer", transition: "all 0.15s",
                }}
              >
                {v.icon} {v.label}
              </button>
            ))}
          </div>
        </div>
        </>}

        {/* Voice engine + voice selection */}
        <VoiceEngineSelector engine={voiceEngine} onChange={setVoiceEngine} meta={meta} elBalance={elBalance} elError={elError} oaiBilling={oaiBilling} output={null} format={pdfVerbatim ? "tts" : format}
          sampleText={inputMode === "pdf" && pdfDoc ? (pdfVerbatim ? narration.slice(0, 12).map(x => x.text).join(" ") : pdfDoc.text.slice(0, 2000)) : ""}
          previewInstructions={pdfVerbatim ? readInstructions : null}
          openaiVoice1={openaiVoice1} setOpenaiVoice1={setOpenaiVoice1} openaiVoice2={openaiVoice2} setOpenaiVoice2={setOpenaiVoice2}
          elevenVoice1={elevenVoice1} setElevenVoice1={setElevenVoice1} elevenVoice2={elevenVoice2} setElevenVoice2={setElevenVoice2} />

        {/* Generate button */}
        <button onClick={run} disabled={busy} style={{
          width:"100%", padding:"18px", borderRadius:11, border:"none",
          background: busy ? "#111" : `linear-gradient(135deg,${meta.color}dd,${meta.color})`,
          color: busy ? "#2a2a2a" : "#000", fontSize:17, fontWeight:900,
          cursor: busy ? "not-allowed" : "pointer", letterSpacing:"0.1em",
          fontFamily:BRAND.headingFont, textTransform:"uppercase",
          transition:"all 0.2s", boxShadow: busy ? "none" : `0 0 30px ${meta.glow}`,
          marginBottom:10, marginTop:16
        }}>
          {busy ? `● ${statusMsg}` : pdfVerbatim ? "▶  CREATE MP3" : `▶  GENERATE ${meta.tag}`}
        </button>

        {/* finished PDF audio */}
        {pdfVerbatim && pdfAudio && !busy && (
          <div style={{ background:BRAND.navy, border:`1px solid ${meta.color}35`, borderRadius:12, padding:"16px 20px", marginBottom:20 }}>
            <div style={{ fontSize:14, color:"#2a6", fontFamily:BRAND.monoFont, marginBottom:10 }}>✓ Downloaded {pdfAudio.name}</div>
            <audio controls src={pdfAudio.url} style={{ width:"100%" }} />
            <a href={pdfAudio.url} download={pdfAudio.name} style={{ display:"inline-block", marginTop:10, fontSize:14, color:meta.color, fontFamily:BRAND.monoFont }}>↓ Download again</a>
            <SharePageButton pdfDoc={pdfDoc} pdfAudio={pdfAudio} color={meta.color} />
          </div>
        )}

        {/* progress bar */}
        {busy && (
          <div style={{ height:2, background:"#111", borderRadius:1, overflow:"hidden", marginBottom:22 }}>
            <div style={{ height:"100%", width:"40%", background:`linear-gradient(to right,${meta.color},${meta.color}50)`,
              borderRadius:1, animation:"lb 1.8s ease-in-out infinite" }} />
            <style>{`@keyframes lb{0%{margin-left:-40%}100%{margin-left:100%}}`}</style>
          </div>
        )}

        {/* error */}
        {error && (
          <div style={{ background:"#0f0808", border:"1px solid #4a1010", borderRadius:10, padding:"16px 20px", marginBottom:20, lineHeight:1.7 }}>
            <div style={{ fontSize:16, color:"#e06050", marginBottom:6 }}><strong>⚠ Error</strong> — {error}</div>
            {inputMode !== "pdf" && <div style={{ fontSize:15, color:"#bbb" }}>
              This usually means the page requires a login, is behind a paywall, or is a JavaScript single-page app. Try a direct article URL rather than a homepage.
            </div>}
          </div>
        )}
      </div>

      {/* ── Output ── */}
      {phase === "done" && output && (
        <div ref={outputRef} style={{ maxWidth:900, margin:"44px auto 60px", padding:"0 22px" }}>

          {/* header row */}
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16, flexWrap:"wrap", gap:10 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ width:3, height:30, background:meta.color, borderRadius:2, boxShadow:`0 0 14px ${meta.glow}` }} />
              <div>
                <div style={{ fontSize:13, color:meta.color, letterSpacing:"0.2em", fontFamily:BRAND.monoFont }}>{meta.tag} · OUTPUT READY</div>
                <div style={{ fontSize:15, color:"#bbb", marginTop:2 }}>
                  {sourceWordCount > 0 && <>{sourceWordCount.toLocaleString()} words in → </>}
                  {output.split(/\s+/).length.toLocaleString()} words out
                </div>
              </div>
            </div>
            <div style={{ display:"flex", gap:8, flexWrap: "wrap", alignItems:"center" }}>
              <button onClick={copy}     style={btnS(meta.color)}>{copied ? "✓ Copied" : "⎘ Copy"}</button>
              <button onClick={download} style={btnS(meta.color)}>↓ Download</button>
              <button onClick={()=>{setPhase("idle");setOutput("");setError("");setSourceWordCount(0);}} style={btnS("#282828")}>↺ New</button>
            </div>
            {/* Voice engine selector */}
            <VoiceEngineSelector engine={voiceEngine} onChange={setVoiceEngine} meta={meta} elBalance={elBalance} elError={elError} oaiBilling={oaiBilling} output={output} format={format}
              sampleText={cleanScriptForTTS(output, format).slice(0, 2000)}
              openaiVoice1={openaiVoice1} setOpenaiVoice1={setOpenaiVoice1} openaiVoice2={openaiVoice2} setOpenaiVoice2={setOpenaiVoice2}
              elevenVoice1={elevenVoice1} setElevenVoice1={setElevenVoice1} elevenVoice2={elevenVoice2} setElevenVoice2={setElevenVoice2} />
          </div>

          {/* audio player */}
          {format !== "video" && <AudioPlayer script={output} format={format} voiceEngine={voiceEngine}
            openaiVoice1={openaiVoice1} openaiVoice2={openaiVoice2}
            elevenVoice1={elevenVoice1} elevenVoice2={elevenVoice2} />}

          {/* export row */}
          <ExportMp3Unified output={output} format={format} meta={meta} voiceEngine={voiceEngine} onExportDone={refreshBalance}
            openaiVoice1={openaiVoice1} openaiVoice2={openaiVoice2}
            elevenVoice1={elevenVoice1} elevenVoice2={elevenVoice2} />

          {/* script viewer */}
          <div style={{ background:BRAND.cardBg, border:`1px solid ${BRAND.borderColor}`, borderRadius:14, overflow:"hidden", boxShadow:"0 4px 50px rgba(0,0,0,0.6)" }}>
            <div style={{ background:BRAND.navy, borderBottom:`1px solid ${BRAND.borderColor}`, padding:"10px 24px", display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:9, background:meta.color, color:"#000", padding:"2px 8px", borderRadius:3, fontFamily:BRAND.monoFont, fontWeight:700, letterSpacing:"0.1em" }}>{meta.tag}</span>
              {format==="podcast" && <span style={{ fontSize:14, color:"#bbb", fontFamily:BRAND.monoFont }}>ALEX <span style={{color:BRAND.blue}}>●</span>  MORGAN <span style={{color:BRAND.gold}}>●</span></span>}
              {format==="video"   && <span style={{ fontSize:14, color:"#bbb", fontFamily:BRAND.monoFont }}>[VISUAL CUES] highlighted</span>}
            </div>
            <ScriptBlock content={output} format={format} />
          </div>
        </div>
      )}
    </div>
  );
}
