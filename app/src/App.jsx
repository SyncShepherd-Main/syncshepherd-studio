import { useState, useRef, useEffect, useCallback } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   PageCast — URL → Broadcast Engine
   Phase 2: Cloudflare Worker fetch + Anthropic API pipeline
   No browser fetch. No CORS. No proxies. Server-side only.
───────────────────────────────────────────────────────────────────────────── */

const WORKER_URL = import.meta.env.VITE_WORKER_URL || "http://localhost:8787";

/* Voice IDs — these are NOT secrets (just identifiers), keys stay on the Worker */
const VOICE_ID_ALEX = "pNInz6obpgDQGcFmaJgB";    // Adam
const VOICE_ID_MORGAN = "XrExE9yKIg1WjnnlVkGX";  // Matilda
const VOICE_ID_DEFAULT = VOICE_ID_ALEX;

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

function buildSystemPrompt(format, isMultiPage = false) {
  const multiPageNote = isMultiPage
    ? `\n\nNOTE: The content below comes from multiple pages, separated by PAGE BREAK markers. Treat all pages as a single cohesive source — synthesise across all of them, covering every page's content in full.`
    : "";

  const shared = `You are a world-class broadcast media producer. Your job is to take the provided page content and produce a broadcast-ready script in the format specified below. Read every section thoroughly. Do not summarise or skip any part.${multiPageNote}`;

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

async function generateScript(text, format, isMultiPage = false) {
  const res = await fetch(`${WORKER_URL}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: buildSystemPrompt(format, isMultiPage),
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
 * Generate podcast MP3 with distinct voices for ALEX and MORGAN.
 * Renders each speaker segment sequentially, then concatenates.
 */
async function generatePodcastMp3(scriptText, onProgress) {
  const segments = parsePodcastSegments(scriptText);
  if (segments.length === 0) throw new Error("No dialogue found in script");

  const audioBuffers = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (onProgress) onProgress(`Rendering ${seg.speaker} (${i + 1}/${segments.length})...`);
    const voiceId = seg.speaker === "MORGAN" ? VOICE_ID_MORGAN : VOICE_ID_ALEX;
    const buffer = await fetchTTSClip(seg.text, voiceId);
    audioBuffers.push(buffer);
  }

  return concatAudioBuffers(audioBuffers);
}

/** Generate single-voice MP3 for video/tts formats */
async function generateSingleVoiceMp3(scriptText, format) {
  const cleaned = cleanScriptForTTS(scriptText, format);
  const buffer = await fetchTTSClip(cleaned, VOICE_ID_DEFAULT);
  return new Blob([buffer], { type: "audio/mpeg" });
}

async function exportToMp3(scriptText, format, onProgress) {
  let blob;
  if (format === "podcast") {
    blob = await generatePodcastMp3(scriptText, onProgress);
  } else {
    blob = await generateSingleVoiceMp3(scriptText, format);
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${format}-narration.mp3`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Generate MP3 blob for in-browser playback */
async function generateMp3Blob(scriptText, format, onProgress) {
  if (format === "podcast") {
    return await generatePodcastMp3(scriptText, onProgress);
  } else {
    return await generateSingleVoiceMp3(scriptText, format);
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

/** Generate podcast MP3 with OpenAI voices (onyx=ALEX, alloy=MORGAN) */
async function generatePodcastMp3OpenAI(scriptText, onProgress) {
  const segments = parsePodcastSegments(scriptText);
  if (segments.length === 0) throw new Error("No dialogue found in script");

  const audioBuffers = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (onProgress) onProgress(`Rendering ${seg.speaker} (${i + 1}/${segments.length})...`);
    const voice = seg.speaker === "MORGAN" ? "alloy" : "onyx";
    const buffer = await fetchOpenAITTSClip(seg.text, voice);
    audioBuffers.push(buffer);
  }
  return concatAudioBuffers(audioBuffers);
}

/** Generate single-voice MP3 via OpenAI */
async function generateSingleVoiceMp3OpenAI(scriptText, format) {
  const cleaned = cleanScriptForTTS(scriptText, format);
  const buffer = await fetchOpenAITTSClip(cleaned, "onyx");
  return new Blob([buffer], { type: "audio/mpeg" });
}

async function exportToMp3OpenAI(scriptText, format, onProgress) {
  let blob;
  if (format === "podcast") {
    blob = await generatePodcastMp3OpenAI(scriptText, onProgress);
  } else {
    blob = await generateSingleVoiceMp3OpenAI(scriptText, format);
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

function AudioPlayer({ script, format, voiceEngine }) {
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
          ? await generatePodcastMp3OpenAI(script, (msg) => setLoadingMsg(msg))
          : await generateSingleVoiceMp3OpenAI(script, format);
      } else {
        blob = await generateMp3Blob(script, format, (msg) => setLoadingMsg(msg));
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
  ];
  return (
    <div style={{ display: "flex", gap: 0, marginBottom: 14 }}>
      {tabs.map(tab => (
        <button key={tab.id} onClick={() => setInputMode(tab.id)} style={{
          flex: 1, padding: "10px 16px", cursor: "pointer",
          background: inputMode === tab.id ? BRAND.cardBg : BRAND.darkBg,
          border: `1px solid ${inputMode === tab.id ? color : BRAND.borderColor}`,
          borderBottom: inputMode === tab.id ? `2px solid ${color}` : `1px solid ${BRAND.borderColor}`,
          color: inputMode === tab.id ? color : "#bbb",
          fontSize: 15, fontFamily: BRAND.monoFont, letterSpacing: "0.08em",
          fontWeight: inputMode === tab.id ? 700 : 400, transition: "all 0.2s",
          borderRadius: tab.id === "url" ? "8px 0 0 0" : "0 8px 0 0",
        }}>
          {tab.label}
        </button>
      ))}
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

/* ─── Voice Engine Selector ───────────────────────────────────────────────── */

const ENGINES = [
  { id: "openai",     label: "OpenAI TTS",        color: "#10a37f", icon: "🤖" },
  { id: "elevenlabs", label: "ElevenLabs",         color: "#f0a030", icon: "🔊" },
  { id: "browser",    label: "Browser Voice (Free)", color: "#888",  icon: "🖥" },
];

function VoiceEngineSelector({ engine, onChange, meta, elBalance, elError, output, format }) {
  const cleaned = output ? cleanScriptForTTS(output, format) : "";
  const charCount = cleaned.length;
  const estCost = (charCount / 1000 * 0.015).toFixed(3);

  return (
    <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginTop:4 }}>
      <span style={{ fontSize:12, color:"#8899aa", fontFamily:BRAND.monoFont, letterSpacing:"0.1em" }}>VOICE:</span>
      {ENGINES.map(e => (
        <button
          key={e.id}
          onClick={() => onChange(e.id)}
          style={{
            background: engine === e.id ? `${e.color}20` : "transparent",
            border: `1px solid ${engine === e.id ? e.color : "#333"}`,
            borderRadius: 6,
            padding: "4px 10px",
            color: engine === e.id ? e.color : "#777",
            fontSize: 13,
            fontFamily: BRAND.monoFont,
            cursor: "pointer",
            transition: "all 0.15s",
          }}
        >
          {e.icon} {e.label}
        </button>
      ))}
      <span style={{ fontSize:12, color:"#666", fontFamily:BRAND.monoFont, marginLeft:4 }}>
        {engine === "openai" && charCount > 0 && `~$${estCost}`}
        {engine === "elevenlabs" && <CreditBalance balance={elBalance} error={elError} />}
        {engine === "browser" && "Free"}
      </span>
    </div>
  );
}

/* ─── Unified Export MP3 Button ──────────────────────────────────────────── */

function ExportMp3Unified({ output, format, meta, voiceEngine, onExportDone }) {
  const [exportStatus, setExportStatus] = useState("idle");
  const [exportError, setExportError] = useState("");
  const [exportMsg, setExportMsg] = useState("");

  if (voiceEngine === "browser") return null; // browser voice can't export MP3

  const handleExport = async () => {
    setExportStatus("exporting");
    setExportError(""); setExportMsg("");
    try {
      if (voiceEngine === "openai") {
        await exportToMp3OpenAI(output, format, (msg) => setExportMsg(msg));
      } else {
        await exportToMp3(output, format, (msg) => setExportMsg(msg));
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
  const { balance: elBalance, error: elError, refresh: refreshBalance } = useElevenLabsBalance();
  const outputRef = useRef(null);
  const meta = FORMAT_META[format];
  const busy = phase === "running";

  const run = async () => {
    if (inputMode === "url") {
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

      if (inputMode === "repo") {
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
      const result = await generateScript(combinedText, format, isMultiPage);
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

        {/* Generate button */}
        <button onClick={run} disabled={busy} style={{
          width:"100%", padding:"18px", borderRadius:11, border:"none",
          background: busy ? "#111" : `linear-gradient(135deg,${meta.color}dd,${meta.color})`,
          color: busy ? "#2a2a2a" : "#000", fontSize:17, fontWeight:900,
          cursor: busy ? "not-allowed" : "pointer", letterSpacing:"0.1em",
          fontFamily:BRAND.headingFont, textTransform:"uppercase",
          transition:"all 0.2s", boxShadow: busy ? "none" : `0 0 30px ${meta.glow}`,
          marginBottom:10
        }}>
          {busy ? `● ${statusMsg}` : `▶  GENERATE ${meta.tag}`}
        </button>

        {/* ElevenLabs credit balance — always visible */}
        <div style={{ textAlign:"right", marginBottom:6 }}>
          <CreditBalance balance={elBalance} error={elError} />
        </div>

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
              <button onClick={()=>{setPhase("idle");setOutput("");setError("");setSourceWordCount(0);}} style={btnS("#282828")}>↺ New</button>
            </div>
            {/* Voice engine selector */}
            <VoiceEngineSelector engine={voiceEngine} onChange={setVoiceEngine} meta={meta} elBalance={elBalance} elError={elError} output={output} format={format} />
          </div>

          {/* audio player */}
          {format !== "video" && <AudioPlayer script={output} format={format} voiceEngine={voiceEngine} />}

          {/* export row */}
          <ExportMp3Unified output={output} format={format} meta={meta} voiceEngine={voiceEngine} onExportDone={refreshBalance} />

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
