/* ─────────────────────────────────────────────────────────────────────────────
   PageCast Fetch Worker — Cloudflare Worker
   Accepts ?url=<https://...> and returns cleaned page text as JSON.
   Optionally returns internal links when ?links=true is set.
───────────────────────────────────────────────────────────────────────────── */

const MAX_TEXT_LENGTH = 15000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
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
        // Extract links before stripping HTML
        if (includeLinks) {
          links = extractInternalLinks(raw, targetUrl);
        }
        text = htmlToText(raw);
      } else {
        // Markdown, plain text, etc. — return as-is
        text = raw;
      }

      // Trim to max length
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
  },
};

/**
 * Strip HTML to readable text.
 * Workers don't have DOMParser, so we use regex-based extraction.
 */
function htmlToText(html) {
  let text = html;

  // Remove script, style, nav, footer, header, aside, noscript blocks
  text = text.replace(/<(script|style|nav|footer|header|aside|noscript|iframe|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Convert common block elements to newlines
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, "\n");
  text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "\n• ");

  // Convert heading tags to uppercase markers
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    const clean = content.replace(/<[^>]+>/g, "").trim();
    return `\n\n${clean.toUpperCase()}\n`;
  });

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&amp;/gi, "&");
  text = text.replace(/&lt;/gi, "<");
  text = text.replace(/&gt;/gi, ">");
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/&rsquo;/gi, "'");
  text = text.replace(/&lsquo;/gi, "'");
  text = text.replace(/&rdquo;/gi, "\u201D");
  text = text.replace(/&ldquo;/gi, "\u201C");
  text = text.replace(/&mdash;/gi, "\u2014");
  text = text.replace(/&ndash;/gi, "\u2013");
  text = text.replace(/&#\d+;/g, "");

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Extract internal links from HTML.
 * Returns up to 10 absolute URLs on the same domain.
 */
function extractInternalLinks(html, sourceUrl) {
  const source = new URL(sourceUrl);
  const domain = source.hostname;
  const links = new Set();

  const hrefRegex = /<a[^>]+href=["']([^"'#]+)["']/gi;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    let href = match[1].trim();

    // Skip non-page links
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|svg|css|js|zip|mp3|mp4|woff|woff2)$/i.test(href)) continue;

    // Resolve relative URLs
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
