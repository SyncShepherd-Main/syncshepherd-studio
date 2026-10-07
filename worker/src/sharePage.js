/* ─────────────────────────────────────────────────────────────────────────────
   Public listen + read-along page for a shared PDF narration.
   Served by the Worker at /s/<id>. Audio + PDF come from R2 via /s/<id>/<file>.
───────────────────────────────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function renderSharePage(id, meta) {
  const title = escapeHtml(meta.title || "Shared narration");
  const voice = escapeHtml((meta.voice || "").replace(/^./, c => c.toUpperCase()));
  const pages = meta.segments.length ? meta.segments[meta.segments.length - 1].page : 0;
  // Safe to embed inside <script>: no "<" can close the tag
  const data = JSON.stringify({ segments: meta.segments }).replace(/</g, "\\u003c");
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
  .bar { position: sticky; top: 0; z-index: 2; background: var(--navy); border-bottom: 1px solid var(--border); box-shadow: 0 4px 30px rgba(0,0,0,0.5); }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 16px; }
  .bar .wrap { padding-top: 14px; padding-bottom: 14px; }
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
  main { padding: 28px 0 80px; }
  .page-mark { font-family: var(--mono); font-size: 12px; letter-spacing: 0.14em; color: var(--blue); border-top: 1px solid var(--border); padding-top: 10px; margin: 28px 0 12px; }
  .page-mark:first-child { margin-top: 0; }
  p { margin: 0 0 4px; font-size: 18px; line-height: 1.85; }
  .s { cursor: pointer; border-radius: 4px; padding: 1px 2px; transition: background 0.2s, color 0.2s; }
  .s:hover { background: rgba(15,112,183,0.15); }
  .s.now { background: rgba(238,175,0,0.2); color: #fff; box-shadow: 0 0 0 2px rgba(238,175,0,0.2); }
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
      <label>Speed
        <select id="speed">
          <option value="0.75">0.75×</option><option value="1" selected>1×</option>
          <option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option>
        </select>
      </label>
      <label><input type="checkbox" id="follow" checked> Auto-scroll</label>
      <span class="spacer"></span>
      <a id="pdf-link" href="${base}/source.pdf#page=1" target="_blank" rel="noopener">Open PDF at page <span id="pg">1</span> ↗</a>
      <a href="${base}/audio.mp3" download="${title}.mp3">↓ MP3</a>
      <a href="${base}/source.pdf" download="${title}.pdf">↓ PDF</a>
    </div>
  </div>
</div>

<main class="wrap" id="text"></main>
<footer>Tap any sentence to jump there · Space to play / pause</footer>

<script id="data" type="application/json">${data}</script>
<script>
(function () {
  var segs = JSON.parse(document.getElementById("data").textContent).segments;
  var audio = document.getElementById("audio");
  var main = document.getElementById("text");
  var follow = document.getElementById("follow");
  var pdfLink = document.getElementById("pdf-link");
  var pg = document.getElementById("pg");
  var els = [];

  // Build the text: one paragraph per page, one span per sentence
  var lastPage = null, para = null;
  segs.forEach(function (s, i) {
    if (s.page !== lastPage) {
      var mark = document.createElement("div");
      mark.className = "page-mark";
      mark.textContent = "PAGE " + s.page;
      main.appendChild(mark);
      para = document.createElement("p");
      main.appendChild(para);
      lastPage = s.page;
    }
    var span = document.createElement("span");
    span.className = "s";
    span.textContent = s.text + " ";
    span.addEventListener("click", function () {
      audio.currentTime = s.t + 0.01;
      audio.play();
    });
    para.appendChild(span);
    els.push(span);
  });

  function indexAt(t) {
    var lo = 0, hi = segs.length - 1, ans = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (segs[mid].t <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  var current = -1;
  function sync() {
    if (!segs.length) return;
    var i = indexAt(audio.currentTime);
    if (i === current) return;
    if (current >= 0) els[current].classList.remove("now");
    current = i;
    els[i].classList.add("now");
    pg.textContent = segs[i].page;
    pdfLink.href = "${base}/source.pdf#page=" + segs[i].page;
    if (follow.checked && !audio.paused) els[i].scrollIntoView({ block: "center", behavior: "smooth" });
  }

  var raf = null;
  function loop() { sync(); raf = requestAnimationFrame(loop); }
  audio.addEventListener("play", function () { if (!raf) loop(); });
  audio.addEventListener("pause", function () { cancelAnimationFrame(raf); raf = null; sync(); });
  audio.addEventListener("seeked", sync);

  document.getElementById("speed").addEventListener("change", function (e) { audio.playbackRate = +e.target.value; });

  document.addEventListener("keydown", function (e) {
    if (e.code !== "Space" || /INPUT|SELECT|TEXTAREA|AUDIO|BUTTON/.test(e.target.tagName)) return;
    e.preventDefault();
    audio.paused ? audio.play() : audio.pause();
  });
})();
</script>
</body>
</html>`;
}

export function renderNotFoundPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Link not found</title>
<style>body{margin:0;background:#0e1117;color:#c8d0d8;font-family:Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;text-align:center}</style></head>
<body><div><h1 style="color:#fff">Link not found</h1><p>This share link doesn't exist or has been removed.</p></div></body></html>`;
}
