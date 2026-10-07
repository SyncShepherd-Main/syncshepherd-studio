/* ─────────────────────────────────────────────────────────────────────────────
   Public listen + read-along page for a shared PDF narration.
   Served by the Worker at /s/<id>. Audio + PDF come from R2 via /s/<id>/<file>.
───────────────────────────────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build";

/** Content-Security-Policy for the share page (pdf.js from jsDelivr, its worker via blob:) */
export const SHARE_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "worker-src blob:",
  "connect-src 'self' https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src 'self' blob: data:",
  "media-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function renderSharePage(id, meta) {
  const title = escapeHtml(meta.title || "Shared narration");
  const voice = escapeHtml((meta.voice || "").replace(/^./, c => c.toUpperCase()));
  const pages = meta.segments.length ? meta.segments[meta.segments.length - 1].page : 0;
  const chapters = Array.isArray(meta.chapters) ? meta.chapters : [];
  // Safe to embed inside <script>: no "<" can close the tag
  const data = JSON.stringify({ segments: meta.segments, chapters }).replace(/</g, "\\u003c");
  const base = `/s/${id}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@700;900&family=Roboto:wght@400;500&family=Roboto+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root {
    --blue: #0f70b7; --gold: #eeaf00; --navy: #192534;
    --bg: #0e1117; --card: #141a23; --border: #253040;
    --text: #c8d0d8; --muted: #8899aa;
    --heading: 'Heebo', sans-serif; --body: 'Roboto', sans-serif; --mono: 'Roboto Mono', 'Courier New', monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--body); }
  .bar { position: sticky; top: 0; z-index: 3; background: var(--navy); border-bottom: 1px solid var(--border); box-shadow: 0 4px 30px rgba(0,0,0,0.5); }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 16px; }
  .bar .wrap { padding-top: 14px; padding-bottom: 12px; }
  .brand { font-family: var(--heading); font-weight: 700; font-size: 12px; letter-spacing: 0.14em; color: var(--gold); }
  h1 { font-family: var(--heading); font-weight: 900; color: #fff; font-size: clamp(20px, 4vw, 28px); line-height: 1.2; margin: 6px 0 4px; overflow-wrap: anywhere; }
  .meta { font-family: var(--mono); font-size: 13px; color: var(--muted); margin-bottom: 12px; }
  audio { width: 100%; display: block; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-top: 10px; font-family: var(--mono); font-size: 13px; }
  .controls label { display: flex; align-items: center; gap: 6px; color: var(--text); cursor: pointer; }
  .controls select { background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; font-family: var(--mono); font-size: 13px; }
  .controls a { color: var(--gold); text-decoration: none; }
  .controls a:hover { text-decoration: underline; }
  .controls .spacer { flex: 1; }
  .btn { background: transparent; color: var(--gold); border: 1px solid var(--gold); border-radius: 6px; padding: 5px 10px; font-family: var(--mono); font-size: 13px; cursor: pointer; }
  .btn:hover { background: rgba(238,175,0,0.12); }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .seg button { background: transparent; color: var(--muted); border: 0; padding: 5px 12px; font-family: var(--mono); font-size: 13px; cursor: pointer; }
  .seg button[aria-pressed="true"] { background: var(--blue); color: #fff; }
  .now { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-top: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .now b { color: var(--text); font-weight: 400; }
  .resume { display: none; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; padding: 8px 12px; border: 1px solid rgba(238,175,0,0.4); background: rgba(238,175,0,0.08); border-radius: 8px; font-size: 14px; }
  .resume.show { display: flex; }
  main { padding: 28px 0 80px; }
  .page-mark { font-family: var(--mono); font-size: 12px; letter-spacing: 0.14em; color: var(--blue); border-top: 1px solid var(--border); padding-top: 10px; margin: 28px 0 12px; }
  .page-mark:first-child { margin-top: 0; }
  p { margin: 0 0 4px; font-size: 18px; line-height: 1.85; }
  .s { cursor: pointer; border-radius: 4px; padding: 1px 2px; transition: background 0.2s, color 0.2s; }
  .s:hover { background: rgba(15,112,183,0.15); }
  .s.on { background: rgba(238,175,0,0.2); color: #fff; box-shadow: 0 0 0 2px rgba(238,175,0,0.2); }
  #pdfview { display: none; }
  #pdfview.show { display: block; }
  #text.hide { display: none; }
  .pdfbar { display: flex; align-items: center; justify-content: center; gap: 12px; font-family: var(--mono); font-size: 13px; margin-bottom: 12px; }
  .pdfpage { background: #fff; border-radius: 4px; box-shadow: 0 4px 30px rgba(0,0,0,0.5); overflow: hidden; min-height: 200px; display: flex; align-items: center; justify-content: center; color: #333; }
  .pdfpage canvas { display: block; width: 100%; height: auto; }
  /* Contents drawer */
  .scrim { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 4; }
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(380px, 100%); background: var(--card); border-left: 1px solid var(--border); z-index: 5; transform: translateX(100%); transition: transform 0.2s; display: flex; flex-direction: column; }
  body.toc-open .scrim { display: block; }
  body.toc-open .drawer { transform: none; }
  .drawer header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); font-family: var(--heading); font-weight: 700; color: #fff; letter-spacing: 0.06em; }
  .drawer ol { list-style: none; margin: 0; padding: 8px 0; overflow-y: auto; flex: 1; }
  .drawer li button { width: 100%; text-align: left; background: transparent; border: 0; color: var(--text); padding: 9px 16px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; font-family: var(--body); font-size: 15px; line-height: 1.4; }
  .drawer li button:hover { background: rgba(15,112,183,0.15); }
  .drawer li.l2 button { padding-left: 32px; font-size: 14px; color: var(--muted); }
  .drawer li.l3 button { padding-left: 48px; font-size: 13px; color: var(--muted); }
  .drawer li.on button { background: rgba(238,175,0,0.15); color: #fff; }
  .drawer .ttl { flex: 1; }
  .drawer .tm { font-family: var(--mono); font-size: 12px; color: var(--muted); white-space: nowrap; }
  footer { font-family: var(--mono); font-size: 12px; color: var(--muted); text-align: center; padding: 0 16px 40px; }
  @media (max-width: 520px) { p { font-size: 17px; } .controls .spacer { display: none; } }
</style>
</head>
<body>
<div class="bar">
  <div class="wrap">
    <div class="brand">SYNCSHEPHERD STUDIO</div>
    <h1>${title}</h1>
    <div class="meta">${pages} page${pages === 1 ? "" : "s"}${voice ? ` · narrated by ${voice}` : ""}</div>
    <audio id="audio" controls preload="metadata" src="${base}/audio.mp3"></audio>
    <div class="controls">
      ${chapters.length ? `<button class="btn" id="toc-btn" aria-controls="toc">☰ Contents</button>` : ""}
      <span class="seg" role="group" aria-label="View">
        <button id="view-text" aria-pressed="true">Text</button><button id="view-pdf" aria-pressed="false">PDF</button>
      </span>
      <label>Speed
        <select id="speed">
          <option value="0.75">0.75×</option><option value="1" selected>1×</option>
          <option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option>
        </select>
      </label>
      <label><input type="checkbox" id="follow" checked> Follow along</label>
      <span class="spacer"></span>
      <a href="${base}/audio.mp3" download="${title}.mp3">↓ MP3</a>
      <a href="${base}/source.pdf" download="${title}.pdf">↓ PDF</a>
    </div>
    <div class="resume" id="resume" role="status">
      <span id="resume-msg"></span>
      <button class="btn" id="restart">Start over</button>
    </div>
    ${chapters.length ? `<div class="now" id="now-line">Now: <b id="now-chapter"></b></div>` : ""}
  </div>
</div>

<main class="wrap">
  <div id="text"></div>
  <div id="pdfview" aria-label="PDF">
    <div class="pdfbar">
      <button class="btn" id="pdf-prev" aria-label="Previous page">◀</button>
      <span>Page <span id="pdf-pg">1</span> of ${pages}</span>
      <button class="btn" id="pdf-next" aria-label="Next page">▶</button>
    </div>
    <div class="pdfpage" id="pdf-page">Loading PDF…</div>
  </div>
</main>
<footer>Tap any sentence to jump there · Space to play / pause · Your place is saved on this device</footer>

${chapters.length ? `<div class="scrim" id="scrim"></div>
<aside class="drawer" id="toc" aria-label="Contents">
  <header>CONTENTS <button class="btn" id="toc-close" aria-label="Close contents">✕</button></header>
  <ol id="toc-list"></ol>
</aside>` : ""}

<script id="data" type="application/json">${data}</script>
<script>
(function () {
  var D = JSON.parse(document.getElementById("data").textContent);
  var segs = D.segments, chapters = D.chapters || [];
  var $ = function (id) { return document.getElementById(id); };
  var audio = $("audio"), textEl = $("text"), follow = $("follow");
  var els = [];
  var STORE = "pagecast.pos.${id}";
  // We scroll to the listener's place ourselves; don't let the browser restore an old scroll
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  function fmt(t) {
    t = Math.max(0, Math.floor(t));
    var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }
  function indexAt(list, t) {
    var lo = 0, hi = list.length - 1, ans = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (list[mid].t <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function seek(t, play) {
    audio.currentTime = t + 0.01;
    if (play) audio.play();
    sync(true);
  }

  // ── Text: one paragraph per page, one span per sentence ──
  var lastPage = null, para = null;
  segs.forEach(function (s) {
    if (s.page !== lastPage) {
      var mark = document.createElement("div");
      mark.className = "page-mark";
      mark.textContent = "PAGE " + s.page;
      textEl.appendChild(mark);
      para = document.createElement("p");
      textEl.appendChild(para);
      lastPage = s.page;
    }
    var span = document.createElement("span");
    span.className = "s";
    span.textContent = s.text + " ";
    span.addEventListener("click", function () { seek(s.t, true); });
    para.appendChild(span);
    els.push(span);
  });

  // ── Contents drawer ──
  var tocItems = [];
  if (chapters.length) {
    var list = $("toc-list");
    chapters.forEach(function (c) {
      var li = document.createElement("li");
      li.className = "l" + Math.min(3, c.level || 1);
      var b = document.createElement("button");
      var ttl = document.createElement("span"); ttl.className = "ttl"; ttl.textContent = c.title;
      var tm = document.createElement("span"); tm.className = "tm"; tm.textContent = fmt(c.t) + " · p" + c.page;
      b.appendChild(ttl); b.appendChild(tm);
      b.addEventListener("click", function () { closeToc(); seek(c.t, true); showPdfPage(c.page, true); });
      li.appendChild(b); list.appendChild(li); tocItems.push(li);
    });
    $("toc-btn").addEventListener("click", function () {
      document.body.classList.add("toc-open");
      var on = list.querySelector("li.on");
      if (on) on.scrollIntoView({ block: "center" });
    });
    $("toc-close").addEventListener("click", closeToc);
    $("scrim").addEventListener("click", closeToc);
  }
  function closeToc() { document.body.classList.remove("toc-open"); }

  // ── PDF view (pdf.js, loaded on first open) ──
  var pdfDoc = null, pdfLoading = null, pdfPage = 1, renderTask = null, view = "text";
  try { view = localStorage.getItem("pagecast.view") || "text"; } catch (e) {}
  function loadPdf() {
    if (pdfLoading) return pdfLoading;
    pdfLoading = import("${PDFJS_CDN}/pdf.min.mjs").then(function (pdfjs) {
      return fetch("${PDFJS_CDN}/pdf.worker.min.mjs").then(function (r) { return r.blob(); }).then(function (b) {
        pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([b], { type: "text/javascript" }));
        return pdfjs.getDocument({ url: "${base}/source.pdf", isEvalSupported: false }).promise;
      });
    }).then(function (doc) { pdfDoc = doc; return doc; })
      .catch(function () { $("pdf-page").textContent = "The PDF couldn't be shown here — use ↓ PDF to open it."; });
    return pdfLoading;
  }
  function showPdfPage(n, force) {
    n = Math.max(1, Math.min(${pages} || 1, n));
    if (n === pdfPage && !force && pdfDoc) return;
    pdfPage = n;
    $("pdf-pg").textContent = n;
    if (view !== "pdf") return;
    loadPdf().then(function (doc) {
      if (!doc || n !== pdfPage) return;
      return doc.getPage(n).then(function (page) {
        if (n !== pdfPage) return;
        var box = $("pdf-page");
        var width = box.clientWidth || 700;
        var vp1 = page.getViewport({ scale: 1 });
        var dpr = window.devicePixelRatio || 1;
        var vp = page.getViewport({ scale: (width / vp1.width) * dpr });
        var canvas = document.createElement("canvas");
        canvas.width = vp.width; canvas.height = vp.height;
        if (renderTask) renderTask.cancel();
        renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
        return renderTask.promise.then(function () {
          if (n !== pdfPage) return;
          box.innerHTML = ""; box.appendChild(canvas);
        }).catch(function () {});
      });
    });
  }
  function setView(v) {
    view = v;
    try { localStorage.setItem("pagecast.view", v); } catch (e) {}
    $("view-text").setAttribute("aria-pressed", v === "text");
    $("view-pdf").setAttribute("aria-pressed", v === "pdf");
    textEl.classList.toggle("hide", v === "pdf");
    $("pdfview").classList.toggle("show", v === "pdf");
    if (v === "pdf") showPdfPage(pdfPage, true);
    else if (current >= 0) els[current].scrollIntoView({ block: "center" });
  }
  $("view-text").addEventListener("click", function () { setView("text"); });
  $("view-pdf").addEventListener("click", function () { setView("pdf"); });
  $("pdf-prev").addEventListener("click", function () { showPdfPage(pdfPage - 1); });
  $("pdf-next").addEventListener("click", function () { showPdfPage(pdfPage + 1); });

  // ── Sync highlight, chapter, PDF page to the audio ──
  var current = -1, currentCh = -2;
  function sync(jumped) {
    if (!segs.length) return;
    var i = Math.max(0, indexAt(segs, audio.currentTime));
    if (i !== current) {
      if (current >= 0) els[current].classList.remove("on");
      current = i;
      els[i].classList.add("on");
      if (follow.checked && (jumped || !audio.paused)) {
        if (view === "text") els[i].scrollIntoView({ block: "center", behavior: jumped ? "auto" : "smooth" });
        if (segs[i].page !== pdfPage) showPdfPage(segs[i].page);
      }
    }
    if (chapters.length) {
      var c = indexAt(chapters, audio.currentTime);
      if (c !== currentCh) {
        if (currentCh >= 0) tocItems[currentCh].classList.remove("on");
        currentCh = c;
        if (c >= 0) tocItems[c].classList.add("on");
        $("now-chapter").textContent = c >= 0 ? chapters[c].title : "Beginning";
      }
    }
  }
  var raf = null;
  function loop() { sync(false); raf = requestAnimationFrame(loop); }
  audio.addEventListener("play", function () { if (!raf) loop(); $("resume").classList.remove("show"); });
  audio.addEventListener("pause", function () { cancelAnimationFrame(raf); raf = null; sync(false); save(); });
  audio.addEventListener("seeked", function () { sync(true); });

  // ── Remember where the listener is (this device) ──
  var lastSaved = 0;
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ t: audio.currentTime, at: Date.now() })); } catch (e) {}
  }
  audio.addEventListener("timeupdate", function () {
    if (Math.abs(audio.currentTime - lastSaved) >= 5) { lastSaved = audio.currentTime; save(); }
  });
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", function () { if (document.hidden) save(); });

  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) {}
  var endT = segs.length ? segs[segs.length - 1].t : 0;
  function resume() {
    if (!saved || !(saved.t > 15) || saved.t > endT) return; // nothing saved, or finished last time
    audio.currentTime = saved.t; // before metadata loads this sets the start position
    var c = chapters.length ? indexAt(chapters, saved.t) : -1;
    $("resume-msg").textContent = "Picked up where you left off — " + fmt(saved.t) + (c >= 0 ? " · " + chapters[c].title : "");
    $("resume").classList.add("show");
    sync(true);
  }
  resume();
  $("restart").addEventListener("click", function () {
    $("resume").classList.remove("show");
    seek(0, false);
    try { localStorage.removeItem(STORE); } catch (e) {}
  });

  document.getElementById("speed").addEventListener("change", function (e) { audio.playbackRate = +e.target.value; });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeToc();
    if (e.code !== "Space" || /INPUT|SELECT|TEXTAREA|AUDIO|BUTTON/.test(e.target.tagName)) return;
    e.preventDefault();
    audio.paused ? audio.play() : audio.pause();
  });

  setView(view);
  sync(false);
})();
</script>
</body>
</html>`;
}

/** Password form for a protected share page (title deliberately not shown) */
export function renderLockPage(id, error) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Password required</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@700;900&family=Roboto:wght@400;500&family=Roboto+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root { --blue: #0f70b7; --gold: #eeaf00; --navy: #192534; --bg: #0e1117; --card: #141a23; --border: #253040; --text: #c8d0d8; --muted: #8899aa; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font-family: 'Roboto', sans-serif; }
  main { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
  form { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 28px 24px; }
  .brand { font-family: 'Heebo', sans-serif; font-weight: 700; font-size: 12px; letter-spacing: 0.14em; color: var(--gold); }
  h1 { font-family: 'Heebo', sans-serif; font-weight: 900; color: #fff; font-size: 24px; margin: 8px 0 6px; }
  p { margin: 0 0 18px; font-size: 15px; line-height: 1.6; color: var(--muted); }
  input { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: #fff; font-size: 17px; padding: 12px 14px; font-family: 'Roboto Mono', monospace; }
  input:focus { outline: none; border-color: var(--blue); }
  button { width: 100%; margin-top: 12px; background: var(--blue); color: #fff; border: 0; border-radius: 8px; padding: 12px; font-family: 'Heebo', sans-serif; font-weight: 700; font-size: 16px; letter-spacing: 0.06em; cursor: pointer; }
  .err { color: #e06050; font-size: 14px; margin: 10px 0 0; font-family: 'Roboto Mono', monospace; }
</style>
</head>
<body>
<main>
  <form method="post" action="/s/${id}/unlock">
    <div class="brand">SYNCSHEPHERD STUDIO</div>
    <h1>Password required</h1>
    <p>Enter the password you were given to listen and read along. You'll only need to enter it once on this device.</p>
    <input type="password" name="password" autocomplete="current-password" aria-label="Password" autofocus required>
    <button type="submit">Unlock</button>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
  </form>
</main>
</body>
</html>`;
}

export function renderNotFoundPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Link not found</title>
<style>body{margin:0;background:#0e1117;color:#c8d0d8;font-family:Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;text-align:center}</style></head>
<body><div><h1 style="color:#fff">Link not found</h1><p>This share link doesn't exist or has been removed.</p></div></body></html>`;
}
