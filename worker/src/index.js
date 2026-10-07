/* ─────────────────────────────────────────────────────────────────────────────
   PageCast Worker — Cloudflare Worker
   All API keys live here (as secrets). The frontend never sees them.

   Routes:
     GET  /?url=<url>[&links=true]   — Fetch & clean a public URL
     POST /generate                  — Proxy to Anthropic Messages API
     POST /tts                       — Proxy to ElevenLabs TTS API
     POST /tts-openai                — Proxy to OpenAI TTS API
     POST /share                     — Start a share page (read-along timings) → { id }
     POST /share/<id>/<file>/start|complete, PUT …/part — Multipart upload of PDF / MP3 to R2
     POST /share/<id>/finish         — Verify uploads, publish → { url }
     GET  /s/<id>[/audio.mp3|/source.pdf] — Public listen + read-along page and its files
     POST /s/<id>/unlock             — Password form for protected share pages (sets a cookie)

   Every route except /s/… requires the X-PageCast-Key header. The app reaches the
   Worker through its Pages Function (/api/*, behind Zero Trust), which adds it.

   Secrets (set via `wrangler secret put`):
     ANTHROPIC_API_KEY
     ELEVENLABS_API_KEY
     OPENAI_API_KEY
     PAGECAST_KEY      — shared with the Pages Function (WORKER_KEY there)

   Bindings:
     SHARES — R2 bucket for share pages
───────────────────────────────────────────────────────────────────────────── */

import { renderSharePage, renderNotFoundPage, renderLockPage } from "./sharePage.js";

const MAX_TEXT_LENGTH = 15000;
const SHARE_PART_MAX_BYTES = 20 * 1024 * 1024;  // client sends 10 MB parts
const SHARE_MAX_PARTS = { "source.pdf": 10, "audio.mp3": 100 }; // up to ~1 GB of audio
const SHARE_UPLOAD_WINDOW_MS = 3 * 60 * 60 * 1000; // uploads must finish within 3 hours
const SHARE_PW_ITERATIONS = 10000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-PageCast-Key",
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Public: GET /s/<id>[/audio.mp3|/source.pdf] — share page + files
    const shareMatch = path.match(/^\/s\/([a-f0-9]{32})(?:\/(audio\.mp3|source\.pdf))?$/);
    if ((request.method === "GET" || request.method === "HEAD") && shareMatch) {
      return handleShareGet(request, env, shareMatch[1], shareMatch[2]);
    }

    // Public: POST /s/<id>/unlock — password form for a protected share page
    const unlockMatch = path.match(/^\/s\/([a-f0-9]{32})\/unlock$/);
    if (request.method === "POST" && unlockMatch) {
      return handleShareUnlock(request, env, unlockMatch[1]);
    }

    // Everything else is PageCast-only (fails closed if the key isn't configured)
    if (!env.PAGECAST_KEY || !timingSafeEqual(request.headers.get("X-PageCast-Key") || "", env.PAGECAST_KEY)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // Route: POST /generate — Anthropic API proxy
    if (request.method === "POST" && path === "/generate") {
      return handleGenerate(request, env);
    }

    // Route: POST /tts — ElevenLabs TTS proxy
    if (request.method === "POST" && path === "/tts") {
      return handleTTS(request, env);
    }

    // Route: POST /tts-openai — OpenAI TTS proxy
    if (request.method === "POST" && path === "/tts-openai") {
      return handleTTSOpenAI(request, env);
    }

    // Route: POST /share … — create a public listen + read-along page
    if (request.method === "POST" && path === "/share") {
      return handleShareCreate(request, env);
    }
    const uploadMatch = path.match(/^\/share\/([a-f0-9]{32})(?:\/(audio\.mp3|source\.pdf)\/(start|part|complete)|\/(finish))$/);
    if (uploadMatch && (request.method === "POST" || request.method === "PUT")) {
      return handleShareUpload(request, env, url, uploadMatch[1], uploadMatch[2], uploadMatch[3] || uploadMatch[4]);
    }

    // Route: GET /subscription — ElevenLabs subscription/usage info
    if (request.method === "GET" && path === "/subscription") {
      return handleSubscription(env);
    }

    // Route: GET /openai-billing — OpenAI billing/usage info
    if (request.method === "GET" && path === "/openai-billing") {
      return handleOpenAIBilling(url, env);
    }

    // Route: GET /?url= — Fetch proxy (original)
    if (request.method === "GET") {
      return handleFetch(url);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

/* ─── /generate — Anthropic Messages API Proxy ────────────────────────────── */

async function handleGenerate(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY not configured on worker" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { model, max_tokens, system, messages } = body;
  if (!messages || !Array.isArray(messages)) {
    return jsonResponse({ error: "Missing messages array" }, 400);
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-20250514",
        max_tokens: max_tokens || 4000,
        system: system || "",
        messages,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return jsonResponse({ error: data?.error?.message || `Anthropic API error ${res.status}` }, res.status);
    }
    return jsonResponse(data, 200);
  } catch (err) {
    return jsonResponse({ error: `Anthropic proxy error: ${err.message}` }, 500);
  }
}

/* ─── /tts — ElevenLabs TTS Proxy ─────────────────────────────────────────── */

async function handleTTS(request, env) {
  if (!env.ELEVENLABS_API_KEY) {
    return jsonResponse({ error: "ELEVENLABS_API_KEY not configured on worker" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { text, voice_id, model_id, voice_settings } = body;
  if (!text || !voice_id) {
    return jsonResponse({ error: "Missing text or voice_id" }, 400);
  }

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`, {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: model_id || "eleven_turbo_v2",
        voice_settings: voice_settings || { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      return jsonResponse({ error: err?.detail?.message || err?.detail || `ElevenLabs error ${res.status}` }, res.status);
    }

    // Stream the audio back
    return new Response(res.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResponse({ error: `ElevenLabs proxy error: ${err.message}` }, 500);
  }
}

/* ─── /tts-openai — OpenAI TTS Proxy ──────────────────────────────────────── */

async function handleTTSOpenAI(request, env) {
  if (!env.OPENAI_API_KEY) {
    return jsonResponse({ error: "OPENAI_API_KEY not configured on worker" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { text, voice, model } = body;
  if (!text) {
    return jsonResponse({ error: "Missing text" }, 400);
  }

  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || "tts-1",
        input: text,
        voice: voice || "onyx",
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
      return jsonResponse({ error: err?.error?.message || `OpenAI TTS error ${res.status}` }, res.status);
    }

    return new Response(res.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResponse({ error: `OpenAI TTS proxy error: ${err.message}` }, 500);
  }
}

/* ─── /openai-billing — OpenAI Usage & Balance ─────────────────────────────── */

async function handleOpenAIBilling(url, env) {
  if (!env.OPENAI_API_KEY) {
    return jsonResponse({ error: "OPENAI_API_KEY not configured on worker" }, 500);
  }

  const headers = {
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };

  // Get current month's usage via /v1/organization/costs
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startTime = Math.floor(startOfMonth.getTime() / 1000);

  const result = { monthly_cost: null, balance: null, error: null };

  // Try organization costs endpoint (requires org-level key)
  try {
    const costsRes = await fetch(
      `https://api.openai.com/v1/organization/costs?start_time=${startTime}&limit=1&group_by=project_id`,
      { headers }
    );
    if (costsRes.ok) {
      const costsData = await costsRes.json();
      // Sum up all costs in the response
      let totalCents = 0;
      if (costsData.data) {
        for (const bucket of costsData.data) {
          if (bucket.results) {
            for (const r of bucket.results) {
              totalCents += r.amount?.value || 0;
            }
          }
        }
      }
      result.monthly_cost = totalCents / 100; // Convert cents to dollars
    }
  } catch {
    // Costs endpoint not available
  }

  // Try credit grants / balance endpoint
  try {
    const balRes = await fetch("https://api.openai.com/dashboard/billing/credit_grants", { headers });
    if (balRes.ok) {
      const balData = await balRes.json();
      result.balance = {
        total_granted: balData.total_granted,
        total_used: balData.total_used,
        total_available: balData.total_available,
      };
    }
  } catch {
    // Balance endpoint not available
  }

  // If neither worked, return what we can
  if (result.monthly_cost === null && result.balance === null) {
    return jsonResponse({ error: "Billing info unavailable — API key may lack org permissions", rate: 0.015 }, 200);
  }

  result.rate = 0.015; // $0.015 per 1K chars for tts-1
  return jsonResponse(result, 200);
}

/* ─── /subscription — ElevenLabs Usage Info ────────────────────────────────── */

async function handleSubscription(env) {
  if (!env.ELEVENLABS_API_KEY) {
    return jsonResponse({ error: "ELEVENLABS_API_KEY not configured on worker" }, 500);
  }

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    });

    if (!res.ok) {
      return jsonResponse({ error: `ElevenLabs API error ${res.status}` }, res.status);
    }

    const data = await res.json();
    return jsonResponse({
      character_count: data.character_count,
      character_limit: data.character_limit,
    }, 200);
  } catch (err) {
    return jsonResponse({ error: `ElevenLabs subscription error: ${err.message}` }, 500);
  }
}

/* ─── GET /?url= — Fetch Proxy (original) ─────────────────────────────────── */

async function handleFetch(url) {
  const targetUrl = url.searchParams.get("url");
  const includeLinks = url.searchParams.get("links") === "true";

  if (!targetUrl) {
    return jsonResponse({ error: "Missing ?url= parameter" }, 400);
  }

  if (!targetUrl.startsWith("https://") && !targetUrl.startsWith("http://")) {
    return jsonResponse({ error: "URL must start with http:// or https://" }, 400);
  }

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "PageCast/1.0 (Content Fetcher)",
        "Accept": "text/html, text/plain, text/markdown, */*",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      return jsonResponse({ error: `Upstream returned HTTP ${res.status}` }, 400);
    }

    const contentType = res.headers.get("content-type") || "";
    const raw = await res.text();

    let text;
    let links = [];

    if (contentType.includes("text/html") || raw.trim().startsWith("<!") || raw.trim().startsWith("<html")) {
      if (includeLinks) {
        links = extractInternalLinks(raw, targetUrl);
      }
      text = htmlToText(raw);
    } else {
      text = raw;
    }

    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + "\n\n[Content truncated at 15,000 characters]";
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length;

    const result = {
      url: targetUrl,
      text,
      wordCount,
      fetchedAt: new Date().toISOString(),
    };

    if (includeLinks) {
      result.links = links;
    }

    return jsonResponse(result, 200);
  } catch (err) {
    return jsonResponse({ error: `Fetch failed: ${err.message}` }, 400);
  }
}

/* ─── /share — Public listen + read-along pages (R2) ──────────────────────── */

async function handleShareCreate(request, env) {
  if (!env.SHARES) {
    return jsonResponse({ error: "Share storage (R2) not configured on worker" }, 500);
  }

  let meta;
  try {
    meta = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const segments = Array.isArray(meta.segments) ? meta.segments.slice(0, 100000).map(s => ({
    t: Number(s.t) || 0,
    page: Math.max(1, parseInt(s.page, 10) || 1),
    text: String(s.text || "").slice(0, 5000),
  })) : [];

  const id = crypto.randomUUID().replace(/-/g, "");
  const pdfName = String(meta.pdfName || "document.pdf").slice(0, 200);
  const stored = {
    title: String(meta.title || pdfName.replace(/\.pdf$/i, "")).slice(0, 200),
    voice: String(meta.voice || "").slice(0, 40),
    pdfName,
    createdAt: new Date().toISOString(),
    ready: false,
    segments,
  };
  // Optional password: store only a salted PBKDF2 hash, plus a random cookie token
  const password = String(meta.password || "").slice(0, 200);
  if (password) {
    stored.pwSalt = randomHex(16);
    stored.pwHash = await hashPassword(password, stored.pwSalt);
    stored.unlockToken = randomHex(32);
  }
  await env.SHARES.put(`shares/${id}/meta.json`, JSON.stringify(stored), { httpMetadata: { contentType: "application/json" } });
  return jsonResponse({ id }, 200);
}

async function handleShareUpload(request, env, url, id, file, action) {
  if (!env.SHARES) {
    return jsonResponse({ error: "Share storage (R2) not configured on worker" }, 500);
  }

  // Only shares that exist, aren't published yet, and are recent can take uploads
  const metaObj = await env.SHARES.get(`shares/${id}/meta.json`);
  if (!metaObj) return jsonResponse({ error: "Share not found" }, 404);
  const meta = await metaObj.json();
  if (meta.ready) return jsonResponse({ error: "Share already published" }, 409);
  if (Date.now() - Date.parse(meta.createdAt) > SHARE_UPLOAD_WINDOW_MS) {
    return jsonResponse({ error: "Upload window expired — create the share page again" }, 410);
  }

  const key = file && `shares/${id}/${file}`;
  try {
    if (action === "start" && request.method === "POST") {
      const contentType = file === "audio.mp3" ? "audio/mpeg" : "application/pdf";
      const mpu = await env.SHARES.createMultipartUpload(key, { httpMetadata: { contentType } });
      return jsonResponse({ uploadId: mpu.uploadId }, 200);
    }

    if (action === "part" && request.method === "PUT") {
      const uploadId = url.searchParams.get("uploadId");
      const n = parseInt(url.searchParams.get("n"), 10);
      const size = parseInt(request.headers.get("Content-Length") || "0", 10);
      if (!uploadId || !(n >= 1 && n <= SHARE_MAX_PARTS[file])) return jsonResponse({ error: "Bad part number" }, 400);
      if (!size || size > SHARE_PART_MAX_BYTES) return jsonResponse({ error: "Bad part size" }, 413);
      const part = await env.SHARES.resumeMultipartUpload(key, uploadId).uploadPart(n, request.body);
      return jsonResponse(part, 200); // { partNumber, etag }
    }

    if (action === "complete" && request.method === "POST") {
      const { uploadId, parts } = await request.json();
      if (!uploadId || !Array.isArray(parts) || !parts.length) return jsonResponse({ error: "Missing parts" }, 400);
      const sorted = parts.map(p => ({ partNumber: p.partNumber, etag: p.etag })).sort((a, b) => a.partNumber - b.partNumber);
      await env.SHARES.resumeMultipartUpload(key, uploadId).complete(sorted);
      return jsonResponse({ ok: true }, 200);
    }

    if (action === "finish" && request.method === "POST") {
      const pdfHead = await env.SHARES.get(`shares/${id}/source.pdf`, { range: { offset: 0, length: 5 } });
      const audioHead = await env.SHARES.head(`shares/${id}/audio.mp3`);
      if (!pdfHead || !audioHead) return jsonResponse({ error: "Upload incomplete" }, 400);
      if (await pdfHead.text() !== "%PDF-") {
        await env.SHARES.delete([`shares/${id}/source.pdf`, `shares/${id}/audio.mp3`, `shares/${id}/meta.json`]);
        return jsonResponse({ error: "That file isn't a PDF" }, 400);
      }
      meta.ready = true;
      await env.SHARES.put(`shares/${id}/meta.json`, JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
      return jsonResponse({ id, url: `${url.origin}/s/${id}` }, 200);
    }
  } catch (err) {
    return jsonResponse({ error: `Upload error: ${err.message}` }, 500);
  }
  return jsonResponse({ error: "Not found" }, 404);
}

async function handleShareGet(request, env, id, file) {
  const pageHeaders = {
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  };
  if (!env.SHARES) {
    return new Response(renderNotFoundPage(), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", ...pageHeaders } });
  }

  const metaObj = await env.SHARES.get(`shares/${id}/meta.json`);
  const meta = metaObj ? await metaObj.json() : null;
  if (!meta || !meta.ready) {
    return file
      ? new Response("Not found", { status: 404, headers: pageHeaders })
      : new Response(renderNotFoundPage(), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", ...pageHeaders } });
  }

  // Password-protected: needs this share's unlock cookie
  const locked = meta.pwHash && !timingSafeEqual(getCookie(request, `pc_${id}`) || "", meta.unlockToken);
  if (locked) {
    return file
      ? new Response("Password required", { status: 401, headers: pageHeaders })
      : lockPageResponse(id, "", 200);
  }
  const cacheControl = meta.pwHash ? "private, no-store" : "public, max-age=300";

  if (!file) {
    return new Response(renderSharePage(id, meta), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": cacheControl,
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; media-src 'self'; base-uri 'none'; form-action 'none'",
        ...pageHeaders,
      },
    });
  }

  // Audio / PDF — Range support so the player can seek
  const rangeHeader = request.headers.get("Range");
  let obj;
  try {
    obj = await env.SHARES.get(`shares/${id}/${file}`, rangeHeader ? { range: request.headers } : {});
  } catch {
    return new Response("Range Not Satisfiable", { status: 416, headers: pageHeaders });
  }
  if (!obj) return new Response("Not found", { status: 404, headers: pageHeaders });

  const headers = new Headers(pageHeaders);
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", meta.pwHash ? "private, max-age=86400" : "public, max-age=86400");
  if (file === "source.pdf") headers.set("Content-Disposition", "inline");

  if (rangeHeader && obj.range) {
    const size = obj.size;
    const offset = "suffix" in obj.range ? size - obj.range.suffix : (obj.range.offset || 0);
    const length = "suffix" in obj.range ? obj.range.suffix : (obj.range.length ?? size - offset);
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

async function handleShareUnlock(request, env, id) {
  const metaObj = env.SHARES && await env.SHARES.get(`shares/${id}/meta.json`);
  const meta = metaObj ? await metaObj.json() : null;
  if (!meta || !meta.ready) {
    return new Response(renderNotFoundPage(), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" } });
  }
  if (!meta.pwHash) return Response.redirect(new URL(`/s/${id}`, request.url).toString(), 303);

  let password = "";
  try {
    password = String((await request.formData()).get("password") || "").slice(0, 200);
  } catch { /* empty form */ }

  if (!password || !timingSafeEqual(await hashPassword(password, meta.pwSalt), meta.pwHash)) {
    await new Promise(r => setTimeout(r, 1000)); // slow down guessing
    return lockPageResponse(id, "That password didn't work. Try again.", 401);
  }

  return new Response(null, {
    status: 303,
    headers: {
      "Location": `/s/${id}`,
      "Set-Cookie": `pc_${id}=${meta.unlockToken}; Path=/s/${id}; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

function lockPageResponse(id, error, status) {
  return new Response(renderLockPage(id, error), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'",
    },
  });
}

/* ─── Crypto / cookie helpers ──────────────────────────────────────────────── */

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: SHARE_PW_ITERATIONS }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(request, name) {
  const match = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

/* ─── HTML helpers ─────────────────────────────────────────────────────────── */

function htmlToText(html) {
  let text = html;
  text = text.replace(/<(script|style|nav|footer|header|aside|noscript|iframe|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, "\n");
  text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "\n• ");
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    const clean = content.replace(/<[^>]+>/g, "").trim();
    return `\n\n${clean.toUpperCase()}\n`;
  });
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&amp;/gi, "&");
  text = text.replace(/&lt;/gi, "<");
  text = text.replace(/&gt;/gi, ">");
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/&rsquo;/gi, "\u2019");
  text = text.replace(/&lsquo;/gi, "\u2018");
  text = text.replace(/&rdquo;/gi, "\u201D");
  text = text.replace(/&ldquo;/gi, "\u201C");
  text = text.replace(/&mdash;/gi, "\u2014");
  text = text.replace(/&ndash;/gi, "\u2013");
  text = text.replace(/&#\d+;/g, "");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function extractInternalLinks(html, sourceUrl) {
  const source = new URL(sourceUrl);
  const domain = source.hostname;
  const links = new Set();
  const hrefRegex = /<a[^>]+href=["']([^"'#]+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    let href = match[1].trim();
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|svg|css|js|zip|mp3|mp4|woff|woff2)$/i.test(href)) continue;
    try {
      const resolved = new URL(href, sourceUrl);
      if (resolved.hostname === domain && resolved.pathname !== source.pathname) {
        links.add(resolved.origin + resolved.pathname);
      }
    } catch {
      // Skip malformed URLs
    }
    if (links.size >= 10) break;
  }
  return [...links];
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
