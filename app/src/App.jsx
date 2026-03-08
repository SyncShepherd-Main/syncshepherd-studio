import { useState, useRef, useEffect, useCallback } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   PageCast — URL → Broadcast Engine
   Phase 2: Cloudflare Worker fetch + Anthropic API pipeline
   No browser fetch. No CORS. No proxies. Server-side only.
───────────────────────────────────────────────────────────────────────────── */

const WORKER_URL = import.meta.env.VITE_WORKER_URL || "http://localhost:8787";
const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";
const ELEVENLABS_API_KEY = import.meta.env.VITE_ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = import.meta.env.VITE_ELEVENLABS_VOICE_ID || "";
const ELEVENLABS_VOICE_ID_ALEX = import.meta.env.VITE_ELEVENLABS_VOICE_ID_ALEX || import.meta.env.VITE_ELEVENLABS_VOICE_ID || "";
const ELEVENLABS_VOICE_ID_MORGAN = import.meta.env.VITE_ELEVENLABS_VOICE_ID_MORGAN || "XrExE9yKIg1WjnnlVkGX"; // Matilda

const FORMAT_META = {
  video: {
    label: "🎬 Video Script",
    tag: "VIDEO",
    color: "#e05c2a",
    glow: "rgba(224,92,42,0.4)",
    desc: "Scene-by-scene with visual cues & B-roll"
  },
  podcast: {
    label: "🎙 Dual-Host Podcast",
    tag: "PODCAST",
    color: "#2ab8e0",
    glow: "rgba(42,184,224,0.4)",
    desc: "Two hosts, full dialogue, natural flow"
  },
  tts: {
    label: "📢 TTS Narration",
    tag: "NARRATION",
    color: "#60c860",
    glow: "rgba(96,200,96,0.4)",
    desc: "Audio-optimised spoken-word prose"
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
- 1000–1500 words`
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
  if (!ANTHROPIC_API_KEY) {
    throw new Error("Anthropic API key not configured — set VITE_ANTHROPIC_API_KEY in .env");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
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

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }

  const data = await res.json();
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

/** Fetch a single TTS clip from ElevenLabs */
async function fetchTTSClip(text, voiceId) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: { message: `HTTP ${res.status}` } }));
    throw new Error(err?.detail?.message || err?.detail || `ElevenLabs error ${res.status}`);
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
    const voiceId = seg.speaker === "MORGAN" ? ELEVENLABS_VOICE_ID_MORGAN : ELEVENLABS_VOICE_ID_ALEX;
    const buffer = await fetchTTSClip(seg.text, voiceId);
    audioBuffers.push(buffer);
  }

  return concatAudioBuffers(audioBuffers);
}

/** Generate single-voice MP3 for video/tts formats */
async function generateSingleVoiceMp3(scriptText, format) {
  const cleaned = cleanScriptForTTS(scriptText, format);
  const buffer = await fetchTTSClip(cleaned, ELEVENLABS_VOICE_ID);
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

/* ─── UI Components ───────────────────────────────────────────────────────── */

function Ticker() {
  const items = ["SERVER-SIDE FETCH","NO CORS LIMITS","URL → BROADCAST READY","VIDEO · PODCAST · TTS","POWERED BY CLAUDE AI","READS ANY PUBLIC PAGE","MP3 EXPORT VIA ELEVENLABS"];
  return (
    <div style={{ overflow:"hidden", borderTop:"1px solid #1a1a1a", borderBottom:"1px solid #1a1a1a", background:"#060606", height:26, display:"flex", alignItems:"center" }}>
      <div style={{ display:"inline-flex", gap:48, animation:"ticker 22s linear infinite", whiteSpace:"nowrap", paddingLeft:"100%" }}>
        {[...items,...items].map((t,i) => (
          <span key={i} style={{ fontSize:10, letterSpacing:"0.2em", color:"#383838", fontFamily:"'Courier New',monospace", textTransform:"uppercase" }}>
            <span style={{ color:"#e05c2a", marginRight:10 }}>◆</span>{t}
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
      flex:"1 1 200px", minWidth:200, border:`1.5px solid ${selected ? meta.color : "#1c1c1c"}`,
      borderRadius:10, background: selected ? `${meta.color}10` : "#0c0c0c",
      padding:"16px 14px", cursor:"pointer", textAlign:"left", transition:"all 0.2s",
      boxShadow: selected ? `0 0 28px ${meta.glow}` : "none", position:"relative", overflow:"hidden"
    }}>
      {selected && <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:`linear-gradient(to right,${meta.color},transparent)` }} />}
      <div style={{ fontSize:22, marginBottom:6 }}>{meta.label.split(" ")[0]}</div>
      <div style={{ fontSize:11, fontWeight:700, color: selected ? meta.color : "#444", letterSpacing:"0.1em", fontFamily:"'Courier New',monospace", marginBottom:6 }}>{meta.tag}</div>
      <div style={{ fontSize:12, color:"#3a3a3a", lineHeight:1.5 }}>{meta.desc}</div>
    </button>
  );
}

function ScriptBlock({ content, format }) {
  const meta = FORMAT_META[format];
  return (
    <div style={{ padding:"28px 28px 36px", fontFamily:"'Georgia',serif" }}>
      {content.split("\n").map((line, i) => {
        if (!line.trim()) return <div key={i} style={{ height:8 }} />;

        if (format === "video" && /^\[(VISUAL|B-ROLL|GRAPHIC|ON-SCREEN|END CARD)[^\]]*\]/i.test(line)) {
          return (
            <div key={i} style={{ display:"flex", gap:10, margin:"14px 0", alignItems:"flex-start" }}>
              <span style={{ fontSize:9, color:meta.color, fontFamily:"'Courier New',monospace", letterSpacing:"0.1em", paddingTop:4, flexShrink:0 }}>▶ CUE</span>
              <div style={{ background:`${meta.color}12`, border:`1px solid ${meta.color}28`, borderRadius:6, padding:"8px 14px", fontSize:13, color:"#999", fontStyle:"italic", flex:1, fontFamily:"'Courier New',monospace", lineHeight:1.6 }}>
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
              <span style={{ width:60, flexShrink:0, fontSize:10, fontWeight:700, color:"#2ab8e0", fontFamily:"'Courier New',monospace", letterSpacing:"0.08em", paddingTop:4 }}>ALEX</span>
              <p style={{ margin:0, flex:1, fontSize:15, color:"#ccc", lineHeight:1.8 }}>{alex[1]}</p>
            </div>
          );
          if (morgan) return (
            <div key={i} style={{ display:"flex", gap:14, margin:"12px 0" }}>
              <span style={{ width:60, flexShrink:0, fontSize:10, fontWeight:700, color:"#e0a02a", fontFamily:"'Courier New',monospace", letterSpacing:"0.08em", paddingTop:4 }}>MORGAN</span>
              <p style={{ margin:0, flex:1, fontSize:15, color:"#ccc", lineHeight:1.8 }}>{morgan[1]}</p>
            </div>
          );
          if (/^\[.+\]$/.test(line.trim())) return (
            <div key={i} style={{ fontSize:12, color:"#444", fontStyle:"italic", fontFamily:"'Courier New',monospace", margin:"4px 0 4px 74px" }}>{line}</div>
          );
        }

        if (/^(SCENE|SEGMENT|SECTION|INTRO|OUTRO|HOOK|CONCLUSION|BODY)\b/i.test(line) || /^#{1,3} /.test(line)) {
          return (
            <div key={i} style={{ borderLeft:`3px solid ${meta.color}`, paddingLeft:14, margin:"28px 0 10px", fontSize:12, fontWeight:700, color:meta.color, letterSpacing:"0.14em", fontFamily:"'Courier New',monospace", textTransform:"uppercase" }}>
              {line.replace(/^#+\s*/,"")}
            </div>
          );
        }

        return <p key={i} style={{ margin:"0 0 2px", fontSize:15, color:"#c0c0c0", lineHeight:1.85 }}>{line}</p>;
      })}
    </div>
  );
}

function AudioPlayer({ script, format }) {
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused]   = useState(false);
  const [speed, setSpeed]     = useState(1);
  const [voices, setVoices]   = useState([]);
  const [voice, setVoice]     = useState(null);
  const [pct, setPct]         = useState(0);
  const [mp3Url, setMp3Url]   = useState(null);
  const [mp3Loading, setMp3Loading] = useState(false);
  const [mp3Error, setMp3Error] = useState("");
  const audioRef = useRef(null);
  const chunksRef = useRef([]);
  const chunkIndexRef = useRef(0);
  const meta = FORMAT_META[format];

  const clean = format === "podcast"
    ? script.replace(/^(ALEX|MORGAN):\s*/gm,"").replace(/\[.*?\]/g,"").replace(/\*\*/g,"")
    : script.replace(/\[.*?\]/g,"").replace(/\*\*/g,"");

  const wc = useRef(clean.split(/\s+/).length);

  // Split text into chunks for SpeechSynthesis (max ~150 words each)
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

  useEffect(() => {
    const load = () => {
      const v = speechSynthesis.getVoices().filter(v => v.lang.startsWith("en"));
      setVoices(v);
      const best = v.find(x => /google|samantha|daniel|karen|moira/i.test(x.name)) || v[0];
      if (best) setVoice(best);
    };
    load();
    speechSynthesis.onvoiceschanged = load;
    return () => {
      speechSynthesis.cancel();
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    };
  },[]);

  // Track MP3 playback progress
  useEffect(() => {
    if (!mp3Url || !audioRef.current) return;
    const audio = audioRef.current;
    const onTime = () => setPct(audio.duration ? (audio.currentTime / audio.duration) * 100 : 0);
    const onEnd = () => { setPlaying(false); setPaused(false); setPct(100); };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnd);
    return () => { audio.removeEventListener("timeupdate", onTime); audio.removeEventListener("ended", onEnd); };
  }, [mp3Url]);

  const speakChunk = useCallback((index) => {
    const chunks = chunksRef.current;
    if (index >= chunks.length) {
      setPlaying(false); setPaused(false); setPct(100);
      return;
    }
    const u = new SpeechSynthesisUtterance(chunks[index]);
    if (voice) u.voice = voice;
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
  }, [voice, speed]);

  const playBrowser = useCallback(() => {
    speechSynthesis.cancel();
    chunksRef.current = getChunks();
    chunkIndexRef.current = 0;
    speakChunk(0);
    setPlaying(true); setPaused(false); setPct(0);
  }, [getChunks, speakChunk]);

  const [loadingMsg, setLoadingMsg] = useState("");

  const playMp3InBrowser = async () => {
    if (mp3Url) {
      // Already have MP3 — just play it
      audioRef.current.currentTime = 0;
      audioRef.current.playbackRate = speed;
      audioRef.current.play();
      setPlaying(true); setPaused(false);
      return;
    }
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      // Fall back to browser speech
      playBrowser();
      return;
    }
    // Generate MP3 via ElevenLabs (multi-voice for podcast)
    setMp3Loading(true); setMp3Error(""); setLoadingMsg("Preparing audio...");
    try {
      const blob = await generateMp3Blob(script, format, (msg) => setLoadingMsg(msg));
      const blobUrl = URL.createObjectURL(blob);
      setMp3Url(blobUrl);
      const audio = new Audio(blobUrl);
      audio.playbackRate = speed;
      audioRef.current = audio;
      audio.play();
      setPlaying(true); setPaused(false);
    } catch (err) {
      setMp3Error(err.message);
      playBrowser();
    } finally {
      setMp3Loading(false); setLoadingMsg("");
    }
  };

  const pause_ = () => {
    if (audioRef.current && mp3Url) { audioRef.current.pause(); }
    else { speechSynthesis.pause(); }
    setPlaying(false); setPaused(true);
  };
  const resume_ = () => {
    if (audioRef.current && mp3Url) { audioRef.current.play(); }
    else { speechSynthesis.resume(); }
    setPlaying(true); setPaused(false);
  };
  const stop_ = () => {
    if (audioRef.current && mp3Url) { audioRef.current.pause(); audioRef.current.currentTime = 0; }
    speechSynthesis.cancel();
    setPlaying(false); setPaused(false); setPct(0);
  };

  const bars = [26,16,30,12,24,18,28,14,22,20];
  const mins = Math.max(1, Math.round(wc.current / (speed * 145)));
  const hasElevenLabs = ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID;

  return (
    <div style={{ background:"#0a0a0a", border:`1px solid ${meta.color}35`, borderRadius:12, padding:"18px 22px", marginBottom:20 }}>
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
          <span style={{ fontSize:10, color:"#333", fontFamily:"monospace" }}>SPEED</span>
          <input type="range" min="0.6" max="2.5" step="0.1" value={speed}
            onChange={e => { setSpeed(+e.target.value); if (playing||paused) stop_(); }}
            style={{ width:72, accentColor:meta.color }} />
          <span style={{ fontSize:11, color:meta.color, fontFamily:"monospace", width:28 }}>{speed.toFixed(1)}×</span>
          {!hasElevenLabs && (
            <select value={voice?.name||""} onChange={e=>setVoice(voices.find(v=>v.name===e.target.value))}
              style={{ background:"#111", border:"1px solid #222", borderRadius:6, color:"#666", fontSize:11, padding:"3px 6px", maxWidth:130, fontFamily:"monospace" }}>
              {voices.map(v=><option key={v.name}>{v.name}</option>)}
            </select>
          )}
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
              ? <button disabled style={{...btnS(meta.color), opacity:0.5, cursor:"wait"}}>{loadingMsg || "Loading AI voice..."}</button>
              : <button onClick={playMp3InBrowser} style={btnS(meta.color, true)}>
                  {hasElevenLabs ? "▶ Play (AI Voice)" : "▶ Play Audio"}
                </button>}
        <button onClick={stop_} style={btnS("#2a2a2a")}>⏹</button>
        {mp3Url && <span style={{ fontSize:10, color:"#2a6", fontFamily:"monospace" }}>{format === "podcast" ? "● Dual-voice loaded" : "● AI voice loaded"}</span>}
        <span style={{ flex:1 }} />
        <span style={{ fontSize:11, color:"#333", fontFamily:"monospace" }}>~{mins} min</span>
      </div>
      {mp3Error && <div style={{ fontSize:11, color:"#e06050", fontFamily:"monospace", marginTop:8 }}>Voice error: {mp3Error} — using browser voice</div>}
    </div>
  );
}

const btnS = (color, primary=false) => ({
  background: primary ? color : "transparent",
  border:`1px solid ${color}`, borderRadius:7,
  color: primary ? "#000" : color, padding:"8px 18px",
  cursor:"pointer", fontSize:13, fontFamily:"'Courier New',monospace",
  letterSpacing:"0.05em", fontWeight: primary ? 700 : 400, transition:"all 0.15s"
});

/* ─── Gary's Garden Repo Browser (Task 3) ─────────────────────────────────── */

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

  if (loading) return <div style={{ color: "#333", fontSize: 12, fontFamily: "monospace", padding: "12px 0" }}>Loading repo files...</div>;
  if (error) return <div style={{ color: "#e06050", fontSize: 12, fontFamily: "monospace", padding: "12px 0" }}>{error}</div>;

  return (
    <div>
      <div style={{
        maxHeight: 220, overflowY: "auto", background: "#0a0a0a", border: "1px solid #1c1c1c",
        borderRadius: 10, padding: "8px 0",
        scrollbarWidth: "thin", scrollbarColor: "#222 #0a0a0a"
      }}>
        {repoFiles.map(path => (
          <label key={path} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "7px 14px",
            cursor: "pointer", fontSize: 13, color: selectedPages.includes(path) ? "#e0e0e0" : "#555",
            fontFamily: "'Courier New',monospace", transition: "background 0.15s",
            background: selectedPages.includes(path) ? "#111" : "transparent",
          }}>
            <input
              type="checkbox"
              checked={selectedPages.includes(path)}
              onChange={() => toggle(path)}
              style={{ accentColor: "#60c860" }}
            />
            <span style={{ fontSize: 11, color: "#333", width: 28 }}>{/\.md$/i.test(path) ? "MD" : "HTML"}</span>
            {path}
          </label>
        ))}
      </div>
      {selectedPages.length > 0 && (
        <div style={{ fontSize: 11, color: "#444", fontFamily: "monospace", marginTop: 8, paddingLeft: 2 }}>
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
    { id: "repo", label: "Gary's Garden 🌱" },
  ];
  return (
    <div style={{ display: "flex", gap: 0, marginBottom: 14 }}>
      {tabs.map(tab => (
        <button key={tab.id} onClick={() => setInputMode(tab.id)} style={{
          flex: 1, padding: "10px 16px", cursor: "pointer",
          background: inputMode === tab.id ? "#111" : "#080808",
          border: `1px solid ${inputMode === tab.id ? color : "#1a1a1a"}`,
          borderBottom: inputMode === tab.id ? `2px solid ${color}` : "1px solid #1a1a1a",
          color: inputMode === tab.id ? color : "#444",
          fontSize: 12, fontFamily: "'Courier New',monospace", letterSpacing: "0.08em",
          fontWeight: inputMode === tab.id ? 700 : 400, transition: "all 0.2s",
          borderRadius: tab.id === "url" ? "8px 0 0 0" : "0 8px 0 0",
        }}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/* ─── Export MP3 Button (Task 7) ──────────────────────────────────────────── */

function ExportMp3Button({ output, format, meta }) {
  const [exportStatus, setExportStatus] = useState("idle"); // idle | exporting | done | error
  const [exportError, setExportError] = useState("");

  const cleaned = cleanScriptForTTS(output, format);
  const charCount = cleaned.length;

  const [exportMsg, setExportMsg] = useState("");

  const handleExport = async () => {
    setExportStatus("exporting");
    setExportError(""); setExportMsg("");
    try {
      await exportToMp3(output, format, (msg) => setExportMsg(msg));
      setExportStatus("done");
      setTimeout(() => setExportStatus("idle"), 3000);
    } catch (err) {
      setExportStatus("error");
      setExportError(err.message);
    }
  };

  const noKey = !ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={handleExport}
          disabled={noKey || exportStatus === "exporting"}
          title={noKey ? "Add VITE_ELEVENLABS_API_KEY and VITE_ELEVENLABS_VOICE_ID to .env to enable MP3 export" : "Export as MP3 via ElevenLabs"}
          style={{
            ...btnS(meta.color, exportStatus === "idle"),
            opacity: noKey ? 0.35 : 1,
            cursor: noKey || exportStatus === "exporting" ? "not-allowed" : "pointer",
            position: "relative",
          }}
        >
          {exportStatus === "exporting" && (
            <span style={{ display: "inline-block", animation: "blink 1s ease-in-out infinite" }}>🔊 {exportMsg || "Rendering audio..."}</span>
          )}
          {exportStatus === "done" && "✓ Downloaded"}
          {exportStatus === "error" && "⚠ Retry MP3"}
          {exportStatus === "idle" && "🔊 Export MP3"}
        </button>
        <span style={{ fontSize: 10, color: "#333", fontFamily: "monospace" }}>
          ~{charCount.toLocaleString()} chars · ~{charCount} credits
        </span>
      </div>
      {exportStatus === "error" && exportError && (
        <div style={{ fontSize: 11, color: meta.color, fontFamily: "monospace", marginTop: 6 }}>
          ElevenLabs error: {exportError}
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
        // Gary's Garden mode — fetch each selected page via raw.githubusercontent.com
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
    <div style={{ minHeight:"100vh", background:"#080808", color:"#d0d0d0", fontFamily:"'Georgia',serif" }}>

      {/* top bar */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 28px", height:52, borderBottom:"1px solid #141414", background:"#050505" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ width:7, height:7, borderRadius:"50%", display:"inline-block",
            background: busy ? "#e05c2a" : "#222",
            boxShadow: busy ? "0 0 8px #e05c2a" : "none",
            animation: busy ? "blink 1s ease-in-out infinite" : "none" }} />
          <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}`}</style>
          <span style={{ fontSize:10, fontFamily:"'Courier New',monospace", letterSpacing:"0.18em", color:"#2a2a2a", textTransform:"uppercase" }}>
            {busy ? statusMsg : phase === "done" ? "● OUTPUT READY" : "PAGECAST"}
          </span>
        </div>
        <span style={{ fontSize:10, color:"#1e1e1e", fontFamily:"'Courier New',monospace", letterSpacing:"0.12em" }}>SYNCSHEPHERD STUDIO</span>
      </div>

      <Ticker />

      {/* hero */}
      <div style={{ textAlign:"center", padding:"54px 24px 44px", borderBottom:"1px solid #101010", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", top:"60%", left:"50%", transform:"translate(-50%,-50%)", width:700, height:400,
          background:`radial-gradient(ellipse, ${meta.color}06 0%, transparent 65%)`, pointerEvents:"none", transition:"background 0.4s" }} />
        <div style={{ fontSize:10, letterSpacing:"0.3em", color:"#2e2e2e", fontFamily:"'Courier New',monospace", marginBottom:18, textTransform:"uppercase" }}>
          ◆ URL-to-Broadcast Engine · Server-Side Fetch
        </div>
        <h1 style={{ margin:"0 0 10px", fontSize:"clamp(38px,6vw,70px)", fontWeight:900, lineHeight:1.0, letterSpacing:"-0.02em", color:"#efefef" }}>
          Page<br />
          <span style={{ color:meta.color, transition:"color 0.3s" }}>Cast</span>
        </h1>
        <p style={{ fontSize:15, color:"#3a3a3a", maxWidth:440, margin:"16px auto 0", lineHeight:1.7 }}>
          Paste any public URL or select from Gary's Garden. The Worker fetches the full page server-side — no browser limits, no CORS, no proxies.
        </p>
      </div>

      <div style={{ maxWidth:760, margin:"0 auto", padding:"44px 22px 0" }}>

        {/* Input mode tabs */}
        <InputModeTabs inputMode={inputMode} setInputMode={setInputMode} color={meta.color} />

        {/* URL input (url mode) */}
        {inputMode === "url" && (
          <div style={{ marginBottom:20 }}>
            <div style={{ position:"relative" }}>
              <span style={{ position:"absolute", left:16, top:"50%", transform:"translateY(-50%)", fontSize:12, color:"#2a2a2a", fontFamily:"'Courier New',monospace", pointerEvents:"none" }}>URL →</span>
              <input
                type="url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !busy && run()}
                placeholder="https://any-public-website.com/page"
                disabled={busy}
                style={{ width:"100%", background:"#0c0c0c", border:"1px solid #1c1c1c", borderRadius:10,
                  padding:"16px 16px 16px 70px", color:"#e0e0e0", fontSize:15,
                  fontFamily:"'Courier New',monospace", outline:"none", boxSizing:"border-box", transition:"border-color 0.2s" }}
                onFocus={e => e.target.style.borderColor = meta.color}
                onBlur={e => e.target.style.borderColor = "#1c1c1c"}
              />
            </div>
            {/* Crawl links checkbox (Task 4) */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "#333", fontFamily: "'Courier New',monospace" }}>
                <input
                  type="checkbox"
                  checked={crawlLinks}
                  onChange={e => setCrawlLinks(e.target.checked)}
                  style={{ accentColor: meta.color }}
                />
                Include linked pages (crawl up to 10)
              </label>
            </div>
            <div style={{ fontSize:11, color:"#262626", fontFamily:"'Courier New',monospace", marginTop:7, paddingLeft:2 }}>
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
          width:"100%", padding:"17px", borderRadius:11, border:"none",
          background: busy ? "#111" : `linear-gradient(135deg,${meta.color}dd,${meta.color})`,
          color: busy ? "#2a2a2a" : "#000", fontSize:15, fontWeight:900,
          cursor: busy ? "not-allowed" : "pointer", letterSpacing:"0.1em",
          fontFamily:"'Courier New',monospace", textTransform:"uppercase",
          transition:"all 0.2s", boxShadow: busy ? "none" : `0 0 30px ${meta.glow}`,
          marginBottom:10
        }}>
          {busy ? `● ${statusMsg}` : `▶  GENERATE ${meta.tag}`}
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
            <div style={{ fontSize:14, color:"#e06050", marginBottom:6 }}><strong>⚠ Error</strong> — {error}</div>
            <div style={{ fontSize:13, color:"#555" }}>
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
                <div style={{ fontSize:10, color:meta.color, letterSpacing:"0.2em", fontFamily:"'Courier New',monospace" }}>{meta.tag} · OUTPUT READY</div>
                <div style={{ fontSize:13, color:"#444", marginTop:2 }}>
                  {sourceWordCount > 0 && <>{sourceWordCount.toLocaleString()} words in → </>}
                  {output.split(/\s+/).length.toLocaleString()} words out
                </div>
              </div>
            </div>
            <div style={{ display:"flex", gap:8, flexWrap: "wrap" }}>
              <button onClick={copy}     style={btnS(meta.color)}>{copied ? "✓ Copied" : "⎘ Copy"}</button>
              <button onClick={download} style={btnS(meta.color)}>↓ Download</button>
              <ExportMp3Button output={output} format={format} meta={meta} />
              <button onClick={()=>{setPhase("idle");setOutput("");setError("");setSourceWordCount(0);}} style={btnS("#282828")}>↺ New</button>
            </div>
          </div>

          {/* audio player (podcast + tts only) */}
          {format !== "video" && <AudioPlayer script={output} format={format} />}

          {/* script viewer */}
          <div style={{ background:"#0c0c0c", border:"1px solid #1a1a1a", borderRadius:14, overflow:"hidden", boxShadow:"0 4px 50px rgba(0,0,0,0.6)" }}>
            <div style={{ background:"#080808", borderBottom:"1px solid #181818", padding:"10px 24px", display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:9, background:meta.color, color:"#000", padding:"2px 8px", borderRadius:3, fontFamily:"'Courier New',monospace", fontWeight:700, letterSpacing:"0.1em" }}>{meta.tag}</span>
              {format==="podcast" && <span style={{ fontSize:11, color:"#333", fontFamily:"monospace" }}>ALEX <span style={{color:"#2ab8e0"}}>●</span>  MORGAN <span style={{color:"#e0a02a"}}>●</span></span>}
              {format==="video"   && <span style={{ fontSize:11, color:"#333", fontFamily:"monospace" }}>[VISUAL CUES] highlighted</span>}
            </div>
            <ScriptBlock content={output} format={format} />
          </div>
        </div>
      )}
    </div>
  );
}
