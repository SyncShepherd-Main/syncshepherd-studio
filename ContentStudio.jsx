import { useState, useRef, useEffect, useCallback } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   CORE: Claude fetches the URL server-side using the web_search tool.
   No browser fetch. No CORS. No proxies. Works on any public URL.
───────────────────────────────────────────────────────────────────────────── */

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

function buildSystemPrompt(format) {
  const shared = `You are a world-class broadcast media producer. Your job is two steps:

STEP 1 — READ THE PAGE: Use your web_search tool to fetch and read the full content at the URL the user provides. Read every section thoroughly. Do not summarise or skip any part.

STEP 2 — PRODUCE THE SCRIPT: Convert all of the content into the format specified below. Cover every single point, section, and detail from the page. Do not leave anything out.`;

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

async function generateWithWebSearch(url, format, onStatus) {
  onStatus("Claude is reading the page...");

  const res1 = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      system: buildSystemPrompt(format),
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: `Please read the full content at this URL and then produce the complete ${FORMAT_META[format].tag} script:\n\n${url}`
      }]
    })
  });

  if (!res1.ok) {
    const err = await res1.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res1.status}`);
  }

  const data1 = await res1.json();

  // Claude returned text directly without needing tool loop
  if (data1.stop_reason === "end_turn") {
    const txt = data1.content?.filter(b => b.type === "text").map(b => b.text).join("\n");
    if (txt && txt.length > 200) return txt;
  }

  // Claude wants to use the web_search tool — run the agentic turn
  if (data1.stop_reason === "tool_use") {
    onStatus("Claude is fetching the page content...");

    const toolUseBlocks = data1.content.filter(b => b.type === "tool_use");
    const toolResults = toolUseBlocks.map(block => ({
      type: "tool_result",
      tool_use_id: block.id,
      content: "Web search complete. Please now produce the full script based on all content you retrieved from the page."
    }));

    onStatus(`Generating your ${FORMAT_META[format].tag}...`);

    const res2 = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system: buildSystemPrompt(format),
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [
          {
            role: "user",
            content: `Please read the full content at this URL and then produce the complete ${FORMAT_META[format].tag} script:\n\n${url}`
          },
          { role: "assistant", content: data1.content },
          { role: "user",      content: toolResults  }
        ]
      })
    });

    if (!res2.ok) {
      const err = await res2.json().catch(() => ({}));
      throw new Error(err?.error?.message || `API error ${res2.status}`);
    }

    const data2 = await res2.json();
    const text = data2.content?.filter(b => b.type === "text").map(b => b.text).join("\n");
    if (!text || text.length < 100) throw new Error("No script was generated. The page may require a login or may be empty.");
    return text;
  }

  // Fallback: extract any text blocks from first response
  const fallback = data1.content?.filter(b => b.type === "text").map(b => b.text).join("\n");
  if (fallback && fallback.length > 100) return fallback;
  throw new Error("Could not generate content. The page may be behind a login or paywall.");
}

/* ─── UI Components ───────────────────────────────────────────────────────── */

function Ticker() {
  const items = ["SERVER-SIDE FETCH","NO CORS LIMITS","URL → BROADCAST READY","VIDEO · PODCAST · TTS","POWERED BY CLAUDE AI","READS ANY PUBLIC PAGE"];
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
      flex:1, minWidth:150, border:`1.5px solid ${selected ? meta.color : "#1c1c1c"}`,
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
  const meta = FORMAT_META[format];

  const clean = format === "podcast"
    ? script.replace(/^(ALEX|MORGAN):\s*/gm,"").replace(/^\[.*?\]\n?/gm,"")
    : script.replace(/^\[.*?\]\n?/gm,"");

  const wc = useRef(clean.split(/\s+/).length);

  useEffect(() => {
    const load = () => {
      const v = speechSynthesis.getVoices().filter(v => v.lang.startsWith("en"));
      setVoices(v);
      const best = v.find(x => /google|samantha|daniel|karen|moira/i.test(x.name)) || v[0];
      if (best) setVoice(best);
    };
    load();
    speechSynthesis.onvoiceschanged = load;
    return () => speechSynthesis.cancel();
  },[]);

  const play = useCallback(() => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    if (voice) u.voice = voice;
    u.rate = speed;
    u.onboundary = e => {
      if (e.name === "word") setPct(Math.min(clean.slice(0,e.charIndex).split(/\s+/).length / wc.current * 100, 100));
    };
    u.onend = () => { setPlaying(false); setPaused(false); setPct(100); };
    u.onerror = () => { setPlaying(false); setPaused(false); };
    speechSynthesis.speak(u);
    setPlaying(true); setPaused(false);
  },[clean, voice, speed]);

  const pause  = () => { speechSynthesis.pause();  setPlaying(false); setPaused(true); };
  const resume = () => { speechSynthesis.resume(); setPlaying(true);  setPaused(false); };
  const stop   = () => { speechSynthesis.cancel(); setPlaying(false); setPaused(false); setPct(0); };

  const bars = [26,16,30,12,24,18,28,14,22,20];
  const mins = Math.max(1, Math.round(wc.current / (speed * 145)));

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
            onChange={e => { setSpeed(+e.target.value); if (playing||paused) stop(); }}
            style={{ width:72, accentColor:meta.color }} />
          <span style={{ fontSize:11, color:meta.color, fontFamily:"monospace", width:28 }}>{speed.toFixed(1)}×</span>
          <select value={voice?.name||""} onChange={e=>setVoice(voices.find(v=>v.name===e.target.value))}
            style={{ background:"#111", border:"1px solid #222", borderRadius:6, color:"#666", fontSize:11, padding:"3px 6px", maxWidth:130, fontFamily:"monospace" }}>
            {voices.map(v=><option key={v.name}>{v.name}</option>)}
          </select>
        </div>
      </div>
      <div style={{ height:3, background:"#181818", borderRadius:2, marginBottom:14, overflow:"hidden" }}>
        <div style={{ height:"100%", width:`${pct}%`, background:`linear-gradient(to right,${meta.color},${meta.color}70)`, transition:"width 0.4s linear", borderRadius:2 }} />
      </div>
      <div style={{ display:"flex", gap:8, alignItems:"center" }}>
        {playing
          ? <button onClick={pause}  style={btnS(meta.color)}>⏸ Pause</button>
          : paused
            ? <button onClick={resume} style={btnS(meta.color)}>▶ Resume</button>
            : <button onClick={play}   style={btnS(meta.color, true)}>▶ Play Audio</button>}
        <button onClick={stop} style={btnS("#2a2a2a")}>⏹</button>
        <span style={{ flex:1 }} />
        <span style={{ fontSize:11, color:"#333", fontFamily:"monospace" }}>~{mins} min</span>
      </div>
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

/* ─── Main App ────────────────────────────────────────────────────────────── */

export default function ContentStudio() {
  const [url, setUrl]         = useState("");
  const [format, setFormat]   = useState("podcast");
  const [phase, setPhase]     = useState("idle");
  const [statusMsg, setStatus]= useState("");
  const [output, setOutput]   = useState("");
  const [error, setError]     = useState("");
  const [copied, setCopied]   = useState(false);
  const outputRef = useRef(null);
  const meta = FORMAT_META[format];
  const busy = phase === "running";

  const run = async () => {
    const u = url.trim();
    if (!u) { setError("Please enter a URL."); return; }
    if (!u.startsWith("http")) { setError("URL must start with http:// or https://"); return; }
    setError(""); setOutput(""); setPhase("running");
    try {
      const result = await generateWithWebSearch(u, format, setStatus);
      setOutput(result);
      setPhase("done");
      setTimeout(() => outputRef.current?.scrollIntoView({ behavior:"smooth", block:"start" }), 150);
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
            {busy ? statusMsg : phase === "done" ? "● OUTPUT READY" : "CONTENT STUDIO"}
          </span>
        </div>
        <span style={{ fontSize:10, color:"#1e1e1e", fontFamily:"'Courier New',monospace", letterSpacing:"0.12em" }}>SERVER-SIDE · NO CORS</span>
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
          Content<br />
          <span style={{ color:meta.color, transition:"color 0.3s" }}>Studio</span>
        </h1>
        <p style={{ fontSize:15, color:"#3a3a3a", maxWidth:440, margin:"16px auto 0", lineHeight:1.7 }}>
          Paste any public URL. Claude reads the entire page from Anthropic's servers — no browser limits, no copy-paste, no proxies needed.
        </p>
      </div>

      <div style={{ maxWidth:760, margin:"0 auto", padding:"44px 22px 0" }}>

        {/* URL input */}
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
          <div style={{ fontSize:11, color:"#262626", fontFamily:"'Courier New',monospace", marginTop:7, paddingLeft:2 }}>
            Works on articles, blogs, business sites, docs, news — any publicly accessible page.
          </div>
        </div>

        {/* Format cards */}
        <div style={{ display:"flex", gap:10, marginBottom:26, flexWrap:"wrap" }}>
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
                <div style={{ fontSize:13, color:"#444", marginTop:2 }}>{output.split(/\s+/).length.toLocaleString()} words generated</div>
              </div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={copy}     style={btnS(meta.color)}>{copied ? "✓ Copied" : "⎘ Copy"}</button>
              <button onClick={download} style={btnS(meta.color)}>↓ Download</button>
              <button onClick={()=>{setPhase("idle");setOutput("");setError("");}} style={btnS("#282828")}>↺ New</button>
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

          {/* export tip */}
          <div style={{ marginTop:14, background:"#080808", border:"1px solid #141414", borderRadius:8, padding:"12px 18px", fontSize:11, color:"#303030", fontFamily:"'Courier New',monospace", lineHeight:1.8 }}>
            <span style={{ color:"#444" }}>EXPORT TIP —</span> For premium AI voice: paste script into <strong style={{color:"#444"}}>ElevenLabs.io</strong> or <strong style={{color:"#444"}}>Murf.ai</strong> → download MP3.
            {format==="video" && " For video: visual cues map directly to cut points in Premiere Pro, CapCut, or Descript."}
          </div>
        </div>
      )}
    </div>
  );
}
