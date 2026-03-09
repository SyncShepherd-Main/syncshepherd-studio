import { useState, useRef, useEffect, useCallback } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   PageCast — URL → Broadcast Engine
   Phase 2: Cloudflare Worker fetch + Anthropic API pipeline
   No browser fetch. No CORS. No proxies. Server-side only.
───────────────────────────────────────────────────────────────────────────── */

const WORKER_URL = import.meta.env.VITE_WORKER_URL || "http://localhost:8787";

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
    desc: "Scene-by-scene with visual cues & B-roll",
    detail: "Produces a documentary-style video script with labelled scenes, [VISUAL CUE] and [B-ROLL] markers, [ON-SCREEN TEXT] callouts, and narration written in a dynamic broadcast voice. Includes a hook, scene-by-scene breakdown, and a call to action. 900–1,600 words."
  },
  podcast: {
    label: "🎙 Dual-Host Podcast",
    tag: "PODCAST",
    color: "#0f70b7",
    glow: "rgba(15,112,183,0.35)",
    desc: "Two hosts, full dialogue, natural flow",
    detail: "Creates a full dual-host podcast episode with ALEX (analytical, evidence-driven) and MORGAN (storyteller, relatable). Natural dialogue with interruptions, stage directions, rhetorical questions, and segment headers. Dual-voice MP3 export available. 1,100–1,800 words."
  },
  tts: {
    label: "📢 TTS Narration",
    tag: "NARRATION",
    color: "#34b899",
    glow: "rgba(52,184,153,0.35)",
    desc: "Audio-optimised spoken-word prose",
    detail: "Generates pure spoken-word narration optimised for text-to-speech playback. No bullet points, no headers — just flowing prose with natural cadence, like a trusted public radio presenter. Ideal for audio-first content. 1,000–1,500 words."
  },
  story: {
    label: "📖 Tell the Story",
    tag: "STORY",
    color: "#9b59b6",
    glow: "rgba(155,89,182,0.35)",
    desc: "Compelling narrative prose from any content",
    detail: "Transforms any web content into a compelling linear narrative. No dialogue, no visual cues — just cohesive story-style prose with a strong opening hook, developed middle, and resonant conclusion. Professional yet engaging. 800–1,400 words."
  },
  verbatim: {
    label: "📄 Word for Word",
    tag: "VERBATIM",
    color: "#7f8c8d",
    glow: "rgba(127,140,141,0.35)",
    desc: "Read the source content exactly as written",
    detail: "Outputs the fetched page content as-is — no rewriting, no creative interpretation. Cleans up formatting for readability but preserves the original words. Ideal for feeding directly into TTS or for a straight read-through of the source material."
  },
  summary: {
    label: "📋 Summary",
    tag: "SUMMARY",
    color: "#e67e22",
    glow: "rgba(230,126,34,0.35)",
    desc: "Detailed overview you can embed anywhere",
    detail: "Generates a detailed, well-structured summary of the page or site. Covers all key points, themes, and takeaways in polished prose. Scales with the source — a single page gets 300–500 words, a full multi-page site gets up to 1,500 words. Designed to be embedded as a playable audio introduction."
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
- 800–1400 words`,

    summary: `You are an expert content analyst and writer. Read the provided web content thoroughly and produce a detailed, well-structured summary that captures everything important.${multiPageNote}

${vibeNote}

FORMAT: DETAILED SUMMARY
- Open with a clear, engaging introduction that establishes what this content is about and why it matters
- Cover every major point, theme, argument, and key detail from the source
- Preserve important facts, statistics, quotes, and specific claims
- Organise logically — group related points together with smooth transitions
- Write in flowing prose paragraphs — no bullet points, no markdown headers, no lists
- Close with the key takeaways and overall significance
- This should work as a standalone audio introduction — someone listening should understand the full scope of the content without reading it
- If multiple pages are provided, synthesise across all of them into one cohesive summary
- Scale the length to match the source: a single blog post might need 300–500 words, a full website with multiple pages needs 1,000–1,500 words
- Never rush or skip important content just to be brief — thoroughness matters more than brevity`
  };

  return formats[format];
}

/* ─── Client-side HTML→Text (for file uploads) ───────────────────────────── */

function htmlToTextClient(html) {
  let text = html;
  text = text.replace(/<(script|style|nav|footer|header|aside|noscript|iframe|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, "\n");
  text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "\n• ");
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, _level, content) => {
    const clean = content.replace(/<[^>]+>/g, "").trim();
    return `\n\n${clean.toUpperCase()}\n`;
  });
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
  text = text.replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  text = text.replace(/&rsquo;/gi, "\u2019").replace(/&lsquo;/gi, "\u2018");
  text = text.replace(/&rdquo;/gi, "\u201D").replace(/&ldquo;/gi, "\u201C");
  text = text.replace(/&mdash;/gi, "\u2014").replace(/&ndash;/gi, "\u2013");
  text = text.replace(/&#\d+;/g, "");
  text = text.replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function extractTextFromFile(content, fileName) {
  const ext = fileName.split(".").pop().toLowerCase();
  if (ext === "html" || ext === "htm" || content.trim().startsWith("<!") || content.trim().startsWith("<html")) {
    return htmlToTextClient(content);
  }
  // For all text formats: strip any embedded HTML/script tags as a safety measure
  return content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").trim();
}

/* ─── Fetch + Generate Pipeline (Task 2) ─────────────────────────────────── */

async function fetchViaWorker(url) {
  if (!WORKER_URL) {
    throw new Error("Worker not configured — deploy the Cloudflare Worker first and set VITE_WORKER_URL in .env");
  }
  const res = await fetch(`${WORKER_URL}?url=${encodeURIComponent(url)}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function fetchViaWorkerWithLinks(url) {
  if (!WORKER_URL) {
    throw new Error("Worker not configured — deploy the Cloudflare Worker first and set VITE_WORKER_URL in .env");
  }
  const res = await fetch(`${WORKER_URL}?url=${encodeURIComponent(url)}&links=true`);
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
 * Generate podcast MP3 with distinct ElevenLabs voices (parallel batches of 3).
 * ElevenLabs has stricter rate limits so we use smaller batches.
 */
async function generatePodcastMp3(scriptText, onProgress, voiceKey1 = "adam", voiceKey2 = "matilda") {
  const segments = parsePodcastSegments(scriptText);
  if (segments.length === 0) throw new Error("No dialogue found in script");

  const BATCH = 3;
  const audioBuffers = new Array(segments.length);
  for (let i = 0; i < segments.length; i += BATCH) {
    const batch = segments.slice(i, i + BATCH);
    if (onProgress) onProgress(`Rendering segments ${i + 1}–${Math.min(i + BATCH, segments.length)} of ${segments.length}...`);
    const results = await Promise.all(
      batch.map((seg) => {
        const voiceId = seg.speaker === "MORGAN"
          ? ELEVENLABS_VOICES[voiceKey2].id
          : ELEVENLABS_VOICES[voiceKey1].id;
        return fetchTTSClip(seg.text, voiceId);
      })
    );
    results.forEach((buf, j) => { audioBuffers[i + j] = buf; });
  }

  return concatAudioBuffers(audioBuffers);
}

/** Generate single-voice MP3 via ElevenLabs */
async function generateSingleVoiceMp3(scriptText, format, voiceKey1 = "adam") {
  const cleaned = cleanScriptForTTS(scriptText, format);
  const buffer = await fetchTTSClip(cleaned, ELEVENLABS_VOICES[voiceKey1].id);
  return new Blob([buffer], { type: "audio/mpeg" });
}

async function exportToMp3(scriptText, format, onProgress, voiceKey1 = "adam", voiceKey2 = "matilda") {
  let blob;
  if (format === "podcast") {
    blob = await generatePodcastMp3(scriptText, onProgress, voiceKey1, voiceKey2);
  } else {
    blob = await generateSingleVoiceMp3(scriptText, format, voiceKey1);
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
    return await generateSingleVoiceMp3(scriptText, format, voiceKey1);
  }
}

/* ─── OpenAI TTS Export ──────────────────────────────────────────────────── */

/** Fetch a single TTS clip via Worker (OpenAI proxy) */
async function fetchOpenAITTSClip(text, voice) {
  const res = await fetch(`${WORKER_URL}/tts-openai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: voice || "onyx", model: "tts-1" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err?.error || `OpenAI TTS error ${res.status}`);
  }
  return await res.arrayBuffer();
}

/** Generate podcast MP3 with OpenAI voices (parallel batches of 4) */
async function generatePodcastMp3OpenAI(scriptText, onProgress, voice1 = "onyx", voice2 = "alloy") {
  const segments = parsePodcastSegments(scriptText);
  if (segments.length === 0) throw new Error("No dialogue found in script");

  const BATCH = 4;
  const audioBuffers = new Array(segments.length);
  for (let i = 0; i < segments.length; i += BATCH) {
    const batch = segments.slice(i, i + BATCH);
    if (onProgress) onProgress(`Rendering segments ${i + 1}–${Math.min(i + BATCH, segments.length)} of ${segments.length}...`);
    const results = await Promise.all(
      batch.map((seg, j) => {
        const voice = seg.speaker === "MORGAN" ? voice2 : voice1;
        return fetchOpenAITTSClip(seg.text, voice);
      })
    );
    results.forEach((buf, j) => { audioBuffers[i + j] = buf; });
  }
  return concatAudioBuffers(audioBuffers);
}

/** Split text into chunks of roughly maxChars, breaking at sentence boundaries */
function splitTextIntoChunks(text, maxChars = 3800) {
  if (text.length <= maxChars) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if ((current + " " + s).length > maxChars && current) {
      chunks.push(current.trim());
      current = s;
    } else {
      current = current ? current + " " + s : s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Generate single-voice MP3 via OpenAI (with chunking for long scripts) */
async function generateSingleVoiceMp3OpenAI(scriptText, format, voice1 = "onyx") {
  const cleaned = cleanScriptForTTS(scriptText, format);
  const chunks = splitTextIntoChunks(cleaned);
  if (chunks.length === 1) {
    const buffer = await fetchOpenAITTSClip(chunks[0], voice1);
    return new Blob([buffer], { type: "audio/mpeg" });
  }
  // Parallel fetch all chunks
  const buffers = await Promise.all(chunks.map(c => fetchOpenAITTSClip(c, voice1)));
  return concatAudioBuffers(buffers);
}

async function exportToMp3OpenAI(scriptText, format, onProgress, voice1 = "onyx", voice2 = "alloy") {
  let blob;
  if (format === "podcast") {
    blob = await generatePodcastMp3OpenAI(scriptText, onProgress, voice1, voice2);
  } else {
    blob = await generateSingleVoiceMp3OpenAI(scriptText, format, voice1);
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${format}-narration.mp3`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ─── UI Components ───────────────────────────────────────────────────────── */

function Ticker() {
  const items = ["SERVER-SIDE FETCH","NO CORS LIMITS","URL → BROADCAST READY","VIDEO · PODCAST · TTS · STORY","POWERED BY SYNCSHEPHERD DIGITAL SOLUTIONS","READS ANY PUBLIC PAGE","MP3 EXPORT VIA OPENAI & ELEVENLABS"];
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
          : await generateSingleVoiceMp3OpenAI(script, format, openaiVoice1);
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

function VoiceEngineSelector({ engine, onChange, meta, elBalance, elError, oaiBilling, output, format,
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
  const [inputMode, setInputMode]       = useState("url"); // "url" | "file"
  const [uploadedFile, setUploadedFile] = useState(null);  // { name, text }
  const [dragOver, setDragOver]         = useState(false);
  const [format, setFormat]             = useState("podcast");
  const [phase, setPhase]               = useState("idle");
  const [statusMsg, setStatus]          = useState("");
  const [output, setOutput]             = useState("");
  const [error, setError]               = useState("");
  const [copied, setCopied]             = useState(false);
  const [crawlLinks, setCrawlLinks]     = useState(false);
  const [sourceWordCount, setSourceWordCount] = useState(0);
  const [voiceEngine, setVoiceEngine]   = useState("openai"); // openai | elevenlabs | browser
  const [vibe, setVibe]                 = useState("professional");
  const [lastSourceText, setLastSourceText]   = useState("");
  const [lastIsMultiPage, setLastIsMultiPage] = useState(false);
  const [isEditing, setIsEditing]             = useState(false);
  const [editText, setEditText]               = useState("");
  // Voice selections: host1 = main/ALEX voice, host2 = MORGAN voice (podcast only)
  const [openaiVoice1, setOpenaiVoice1]   = useState("onyx");
  const [openaiVoice2, setOpenaiVoice2]   = useState("alloy");
  const [elevenVoice1, setElevenVoice1]   = useState("adam");
  const [elevenVoice2, setElevenVoice2]   = useState("matilda");
  const { balance: elBalance, error: elError, refresh: refreshBalance } = useElevenLabsBalance();
  const { billing: oaiBilling } = useOpenAIBilling();
  const outputRef = useRef(null);
  const fileInputRef = useRef(null);
  const meta = FORMAT_META[format];
  const busy = phase === "running";

  // Allowed file types — extension + MIME whitelist
  const ALLOWED_EXTENSIONS = ["txt", "html", "htm", "md", "csv", "xml", "json"];
  const ALLOWED_MIMES = [
    "text/plain", "text/html", "text/markdown", "text/csv", "text/xml",
    "application/json", "application/xml", "application/xhtml+xml", "",
  ];

  const validateFile = useCallback((file) => {
    if (!file) return "No file provided.";
    const ext = file.name.split(".").pop().toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) return `Unsupported file type: .${ext}. Use: ${ALLOWED_EXTENSIONS.map(e => `.${e}`).join(", ")}`;
    if (file.type && !ALLOWED_MIMES.includes(file.type)) return `Unexpected MIME type: ${file.type}`;
    if (file.size > 5 * 1024 * 1024) return "File too large (max 5MB).";
    if (file.size === 0) return "File is empty.";
    return null;
  }, []);

  const handleFileRead = useCallback((file) => {
    const err = validateFile(file);
    if (err) { setError(err); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const raw = e.target.result;
      // Security: truncate excessively long files
      const truncated = raw.length > 500000 ? raw.slice(0, 500000) : raw;
      const text = extractTextFromFile(truncated, file.name);
      if (!text.trim()) { setError("Could not extract text from file."); return; }
      setUploadedFile({ name: file.name, text });
      setError("");
    };
    reader.onerror = () => setError("Failed to read file.");
    reader.readAsText(file);
  }, [validateFile]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      setInputMode("file"); // auto-switch to file mode
      handleFileRead(file);
    }
  }, [handleFileRead]);

  const handleDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }, []);
  const handleDragEnter = useCallback((e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); setInputMode("file"); }, []);
  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    // Only leave if we actually left the container (not a child element)
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  }, []);

  // Prevent browser from opening dropped files anywhere on the page
  useEffect(() => {
    const preventDefaults = (e) => { e.preventDefault(); e.stopPropagation(); };
    window.addEventListener("dragover", preventDefaults);
    window.addEventListener("drop", preventDefaults);
    return () => {
      window.removeEventListener("dragover", preventDefaults);
      window.removeEventListener("drop", preventDefaults);
    };
  }, []);

  const run = async () => {
    if (inputMode === "url") {
      const u = url.trim();
      if (!u) { setError("Please enter a URL."); return; }
      if (!u.startsWith("http")) { setError("URL must start with http:// or https://"); return; }
    } else {
      if (!uploadedFile) { setError("Please upload a file first."); return; }
    }

    setError(""); setOutput(""); setPhase("running"); setSourceWordCount(0); setIsEditing(false);

    try {
      let combinedText = "";
      let isMultiPage = false;

      if (inputMode === "file") {
        // File upload mode — text already extracted client-side
        setStatus("Processing uploaded file...");
        combinedText = uploadedFile.text;
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
      setLastSourceText(combinedText);
      setLastIsMultiPage(isMultiPage);

      let result;
      if (format === "verbatim") {
        setStatus("Preparing content...");
        result = combinedText.replace(/--- PAGE BREAK:.*---/g, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
      } else {
        setStatus(`Generating your ${FORMAT_META[format].tag}...`);
        result = await generateScript(combinedText, format, isMultiPage, vibe);
      }
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

  const regenerate = async () => {
    if (!lastSourceText) return;
    setError(""); setOutput(""); setPhase("running"); setIsEditing(false);
    try {
      let result;
      if (format === "verbatim") {
        setStatus("Preparing content...");
        result = lastSourceText.replace(/--- PAGE BREAK:.*---/g, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
      } else {
        setStatus(`Regenerating your ${FORMAT_META[format].tag}...`);
        result = await generateScript(lastSourceText, format, lastIsMultiPage, vibe);
      }
      setOutput(result);
      setPhase("done");
      setTimeout(() => outputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    } catch(e) {
      setPhase("error");
      setError(e.message);
    }
  };

  const saveEdit = () => {
    setOutput(editText);
    setIsEditing(false);
  };

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      style={{ minHeight:"100vh", background:BRAND.darkBg, color:"#d0d0d0", fontFamily:BRAND.bodyFont }}>

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
      <div style={{ textAlign:"center", padding:"54px 24px 20px", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", top:"60%", left:"50%", transform:"translate(-50%,-50%)", width:700, height:400,
          background:`radial-gradient(ellipse, ${BRAND.blue}10 0%, transparent 65%)`, pointerEvents:"none" }} />
        <div style={{ fontSize:13, letterSpacing:"0.3em", color:"#8899aa", fontFamily:BRAND.monoFont, marginBottom:18, textTransform:"uppercase" }}>
          ◆ Content-to-Broadcast Engine
        </div>
        <h1 style={{ margin:"0 0 10px", fontSize:"clamp(38px,6vw,70px)", fontWeight:900, lineHeight:1.0, letterSpacing:"-0.02em", color:"#fff", fontFamily:BRAND.headingFont }}>
          Page<br />
          <span style={{ color:BRAND.blue, transition:"color 0.3s" }}>Cast</span>
        </h1>
        <p style={{ fontSize:17, color:"#bcc8d4", maxWidth:540, margin:"16px auto 0", lineHeight:1.7, fontFamily:BRAND.bodyFont }}>
          Paste a URL or upload a document and generate broadcast-ready scripts in seconds. Server-side fetch for URLs — drag-and-drop for local files.
        </p>
      </div>

      {/* Feature bar */}
      <div style={{ display:"flex", justifyContent:"center", gap:24, flexWrap:"wrap", padding:"16px 24px 20px", borderBottom:`1px solid ${BRAND.borderColor}` }}>
        {["Server-side fetch", "File upload", "Reads any public page", "MP3 export", "Multiple AI voices"].map((t, i) => (
          <span key={i} style={{ fontSize:12, color:"#8899aa", fontFamily:BRAND.monoFont, letterSpacing:"0.08em", display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ color:BRAND.gold, fontSize:8 }}>●</span>{t}
          </span>
        ))}
      </div>

      {/* Format details section */}
      <div style={{ maxWidth:820, margin:"0 auto", padding:"36px 24px 0" }}>
        <div style={{ fontSize:12, letterSpacing:"0.2em", color:"#8899aa", fontFamily:BRAND.monoFont, textTransform:"uppercase", marginBottom:16, textAlign:"center" }}>
          Output Formats
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(340px, 1fr))", gap:14 }}>
          {Object.entries(FORMAT_META).map(([id, m]) => (
            <div key={id} style={{
              background:BRAND.cardBg, border:`1px solid ${BRAND.borderColor}`, borderRadius:10,
              padding:"18px 20px", borderLeft:`3px solid ${m.color}`,
            }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                <span style={{ fontSize:9, background:m.color, color:"#000", padding:"2px 8px", borderRadius:3, fontFamily:BRAND.monoFont, fontWeight:700, letterSpacing:"0.1em" }}>{m.tag}</span>
                <span style={{ fontSize:15, color:"#e0e0e0", fontFamily:BRAND.headingFont, fontWeight:700 }}>{m.label}</span>
              </div>
              <p style={{ margin:0, fontSize:14, color:"#9aa8b8", lineHeight:1.7, fontFamily:BRAND.bodyFont }}>{m.detail}</p>
            </div>
          ))}
        </div>
        <div style={{ textAlign:"center", marginTop:20 }}>
          <span style={{ fontSize:13, color:BRAND.gold, fontFamily:BRAND.headingFont, fontWeight:700, letterSpacing:"0.1em" }}>
            Powered by SyncShepherd Digital Solutions
          </span>
        </div>
      </div>

      <div style={{ maxWidth:760, margin:"0 auto", padding:"44px 22px 0" }}>

        {/* Input mode toggle */}
        <div style={{ display:"flex", gap:0, marginBottom:16 }}>
          {[
            { id: "url", label: "URL", icon: "🔗" },
            { id: "file", label: "Upload File", icon: "📄" },
          ].map(m => (
            <button key={m.id} onClick={() => { setInputMode(m.id); setError(""); }}
              style={{
                flex:1, padding:"12px 16px", border:`1px solid ${inputMode === m.id ? meta.color : BRAND.borderColor}`,
                background: inputMode === m.id ? `${meta.color}15` : BRAND.cardBg,
                color: inputMode === m.id ? meta.color : "#8899aa",
                fontSize:14, fontFamily:BRAND.monoFont, cursor:"pointer", transition:"all 0.15s",
                borderRadius: m.id === "url" ? "10px 0 0 10px" : "0 10px 10px 0",
                fontWeight: inputMode === m.id ? 700 : 400,
              }}>
              {m.icon} {m.label}
            </button>
          ))}
        </div>

        {/* URL input */}
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

        {/* File upload / drag-and-drop */}
        {inputMode === "file" && (
          <div style={{ marginBottom:20 }}>
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onClick={() => !busy && fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? meta.color : uploadedFile ? "#3a5a3a" : BRAND.borderColor}`,
                borderRadius: 12,
                padding: uploadedFile ? "20px 24px" : "40px 24px",
                textAlign: "center",
                cursor: busy ? "not-allowed" : "pointer",
                background: dragOver ? `${meta.color}08` : uploadedFile ? `${BRAND.cardBg}` : BRAND.cardBg,
                transition: "all 0.2s",
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.html,.htm,.md,.csv,.xml,.json"
                style={{ display: "none" }}
                onChange={e => { if (e.target.files?.[0]) handleFileRead(e.target.files[0]); }}
              />
              {uploadedFile ? (
                <div>
                  <div style={{ fontSize:15, color:"#e0e0e0", fontFamily:BRAND.monoFont, marginBottom:6 }}>
                    {uploadedFile.name}
                  </div>
                  <div style={{ fontSize:13, color:"#8899aa", fontFamily:BRAND.monoFont }}>
                    {uploadedFile.text.split(/\s+/).filter(Boolean).length.toLocaleString()} words extracted
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setUploadedFile(null); }}
                    style={{
                      marginTop:10, padding:"4px 14px", fontSize:12, fontFamily:BRAND.monoFont,
                      background:"transparent", border:`1px solid #555`, borderRadius:6,
                      color:"#999", cursor:"pointer",
                    }}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize:32, marginBottom:10 }}>
                    {dragOver ? "+" : ""}
                  </div>
                  <div style={{ fontSize:16, color:"#bcc8d4", fontFamily:BRAND.monoFont, marginBottom:8 }}>
                    {dragOver ? "Drop it here!" : "Drag & drop a file here"}
                  </div>
                  <div style={{ fontSize:13, color:"#8899aa", fontFamily:BRAND.monoFont, marginBottom:12 }}>
                    or click to browse
                  </div>
                  <div style={{ fontSize:12, color:"#667788", fontFamily:BRAND.monoFont }}>
                    Supports: .html, .htm, .txt, .md, .csv, .xml, .json — max 5MB
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Format cards */}
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

        {/* Voice engine + voice selection */}
        <VoiceEngineSelector engine={voiceEngine} onChange={setVoiceEngine} meta={meta} elBalance={elBalance} elError={elError} oaiBilling={oaiBilling} output={null} format={format}
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
          {busy ? `● ${statusMsg}` : `▶  GENERATE ${meta.tag}${inputMode === "file" && uploadedFile ? ` FROM FILE` : ""}`}
        </button>

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
            <div style={{ fontSize:15, color:"#bbb" }}>
              This usually means the page requires a login, is behind a paywall, or is a JavaScript single-page app. Try a direct article URL rather than a homepage.
            </div>
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
              {lastSourceText && !isEditing && (
                <button onClick={regenerate} disabled={busy} style={btnS("#9b59b6")}>⟳ Regenerate</button>
              )}
              {isEditing ? (
                <button onClick={saveEdit} style={btnS("#27ae60")}>✓ Save Edit</button>
              ) : (
                <button onClick={() => { setEditText(output); setIsEditing(true); }} style={btnS("#e67e22")}>✎ Edit</button>
              )}
              {isEditing && (
                <button onClick={() => setIsEditing(false)} style={btnS("#282828")}>✕ Cancel</button>
              )}
              <button onClick={()=>{setPhase("idle");setOutput("");setError("");setSourceWordCount(0);setIsEditing(false);}} style={btnS("#282828")}>↺ New</button>
            </div>
            {/* Voice engine selector */}
            <VoiceEngineSelector engine={voiceEngine} onChange={setVoiceEngine} meta={meta} elBalance={elBalance} elError={elError} oaiBilling={oaiBilling} output={output} format={format}
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

          {/* script viewer / editor */}
          <div style={{ background:BRAND.cardBg, border:`1px solid ${isEditing ? "#e67e22" : BRAND.borderColor}`, borderRadius:14, overflow:"hidden", boxShadow:"0 4px 50px rgba(0,0,0,0.6)", transition:"border-color 0.2s" }}>
            <div style={{ background:BRAND.navy, borderBottom:`1px solid ${BRAND.borderColor}`, padding:"10px 24px", display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:9, background: isEditing ? "#e67e22" : meta.color, color:"#000", padding:"2px 8px", borderRadius:3, fontFamily:BRAND.monoFont, fontWeight:700, letterSpacing:"0.1em" }}>{isEditing ? "EDITING" : meta.tag}</span>
              {!isEditing && format==="podcast" && <span style={{ fontSize:14, color:"#bbb", fontFamily:BRAND.monoFont }}>ALEX <span style={{color:BRAND.blue}}>●</span>  MORGAN <span style={{color:BRAND.gold}}>●</span></span>}
              {!isEditing && format==="video"   && <span style={{ fontSize:14, color:"#bbb", fontFamily:BRAND.monoFont }}>[VISUAL CUES] highlighted</span>}
              {isEditing && <span style={{ fontSize:13, color:"#e67e22", fontFamily:BRAND.monoFont }}>Edit your transcript below — audio will re-render from the saved text</span>}
            </div>
            {isEditing ? (
              <textarea
                value={editText}
                onChange={e => setEditText(e.target.value)}
                style={{
                  width:"100%", minHeight:400, padding:"20px 24px", background:BRAND.cardBg, color:"#d0d0d0",
                  border:"none", outline:"none", resize:"vertical", fontSize:15, lineHeight:1.8,
                  fontFamily:BRAND.monoFont, boxSizing:"border-box"
                }}
              />
            ) : (
              <ScriptBlock content={output} format={format} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
