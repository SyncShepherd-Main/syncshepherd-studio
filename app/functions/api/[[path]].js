/* ─────────────────────────────────────────────────────────────────────────────
   /api/* → PageCast Worker proxy (Cloudflare Pages Function)

   Runs on the Pages domain, so it sits behind the Zero Trust login. It adds the
   shared secret the Worker requires on every non-public route; the browser never
   sees the key.

   Pages secrets / vars:
     WORKER_KEY     — same value as the Worker's PAGECAST_KEY secret
     WORKER_ORIGIN  — optional, defaults to the production Worker (local testing)
───────────────────────────────────────────────────────────────────────────── */

const DEFAULT_WORKER_ORIGIN = "https://pagecast-fetcher.syncshepherd.workers.dev";

export async function onRequest({ request, env, params }) {
  if (!env.WORKER_KEY) {
    return Response.json({ error: "WORKER_KEY not configured on Pages" }, { status: 500 });
  }

  const incoming = new URL(request.url);
  const path = Array.isArray(params.path) ? params.path.join("/") : (params.path || "");
  const target = new URL(`/${path}${incoming.search}`, env.WORKER_ORIGIN || DEFAULT_WORKER_ORIGIN);

  const headers = new Headers(request.headers);
  headers.set("X-PageCast-Key", env.WORKER_KEY);
  headers.delete("Cookie"); // the Zero Trust cookie stays on the Pages domain

  return fetch(target, {
    method: request.method,
    headers,
    // Buffered (parts are ≤ 10 MB) so the Worker sees a known length — R2 multipart needs it
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });
}
