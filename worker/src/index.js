/* ─────────────────────────────────────────────────────────────────────────────
   PageCast Worker — Cloudflare Worker
   All API keys live here (as secrets). The frontend never sees them.

   Routes:
     GET  /?url=<url>[&links=true]   — Fetch & clean a public URL
     POST /generate                  — Proxy to Anthropic Messages API
     POST /tts                       — Proxy to ElevenLabs TTS API

   Secrets (set via `wrangler secret put`):
     ANTHROPIC_API_KEY
     ELEVENLABS_API_KEY
───────────────────────────────────────────────────────────────────────────── */

const MAX_TEXT_LENGTH = 15000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Route: POST /generate — Anthropic API proxy
    if (request.method === "POST" && path === "/generate") {
      return handleGenerate(request, env);
    }

    // Route: POST /tts — ElevenLabs TTS proxy
    if (request.method === "POST" && path === "/tts") {
      return handleTTS(request, env);
    }

    // Route: GET /subscription — ElevenLabs subscription/usage info
    if (request.method === "GET" && path === "/subscription") {
      return handleSubscription(env);
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
