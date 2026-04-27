/**
 * Reverse proxy for browser-agent previews.
 *
 * The user's localhost dev server (typically Vite on `127.0.0.1:5173`) is
 * unreachable from a phone — `localhost` resolves to the phone's loopback
 * interface, not the MAW server's. To make the preview iframe work over
 * mobile, MAW exposes a same-origin path `/preview/<agentId>/*` that
 * forwards both HTTP requests and WebSocket upgrades to the agent's
 * stored `target_port` on `127.0.0.1`.
 *
 * Both the production entry (`server.js`) and the Vite dev plugin
 * (`vite.config.ts`) wire this module in: same auth, same forwarding,
 * one place to maintain.
 *
 * Auth: every request must carry a valid MAW session cookie AND the
 * agent must belong to that user — otherwise random callers on the
 * network could probe localhost ports.
 */

import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { getAgentTargetForProxy } from '../db/queries.js';
import { auth } from '../auth/betterAuth.js';

const PREVIEW_PREFIX = '/preview/';

export function isPreviewPath(path: string | undefined): boolean {
  return !!path && path.startsWith(PREVIEW_PREFIX);
}

/** Parse `/preview/<agentId>/...rest` into its components. Returns null if
 *  the path doesn't conform (no agent id, or no trailing slash before rest). */
export function parsePreviewPath(
  path: string
): { agentId: string; rest: string } | null {
  if (!path.startsWith(PREVIEW_PREFIX)) return null;
  const after = path.slice(PREVIEW_PREFIX.length);
  // Match `<agentId>` then either end-of-string OR `/...rest`.
  const slash = after.indexOf('/');
  if (slash === -1) {
    if (!after) return null;
    return { agentId: after, rest: '/' };
  }
  const agentId = after.slice(0, slash);
  if (!agentId) return null;
  const rest = after.slice(slash) || '/';
  return { agentId, rest };
}

/**
 * Read the agent id out of the request's `Referer` header when the request
 * came from a preview iframe.
 *
 * Why we need this: SPA dev servers (SvelteKit/Vite, Next, etc.) emit
 * absolute paths like `/@vite/client`, `/.svelte-kit/foo`, and `<a href="/route">`.
 * Inside a same-origin iframe at `/preview/<id>/`, the browser resolves those
 * against MAW's origin (`http://maw-host:port/...`), NOT the proxy prefix —
 * so the requests hit MAW's main listener with a bare path like `/route`.
 * Routing them by Referer lets the iframe behave like a real same-origin
 * browser tab against the upstream dev server.
 *
 * Returns null if the header is absent, malformed, doesn't point to MAW's
 * origin, or points to a non-preview path.
 */
function refererPreviewAgentId(req: IncomingMessage): string | null {
  const ref = req.headers.referer;
  if (typeof ref !== 'string') return null;
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return null;
  }
  // Same-origin guard: only trust Referer values that match the host of
  // the current request, so a malicious cross-origin page can't trick
  // MAW into proxying arbitrary requests through somebody else's agent.
  const host = req.headers.host;
  if (!host || url.host !== host) return null;
  const parsed = parsePreviewPath(url.pathname);
  return parsed?.agentId ?? null;
}

/** Fold a Node IncomingHttpHeaders into a Fetch-API `Headers` so better-auth
 *  can read the (signed) session cookie out of the Cookie header. Same
 *  pattern as `WsHub.attachAsync`. */
function toFetchHeaders(req: IncomingMessage): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out.set(k, v);
    else if (Array.isArray(v)) out.set(k, v.join(', '));
  }
  return out;
}

async function resolveAuthorizedAgent(
  req: IncomingMessage,
  agentId: string
): Promise<{ target_port: number; target_url: string } | { error: 401 | 403 | 404 }> {
  const sess = await auth.api.getSession({ headers: toFetchHeaders(req) });
  if (!sess) return { error: 401 };
  const target = getAgentTargetForProxy(agentId, sess.user.id);
  if (!target) return { error: 404 };
  return target;
}

function denyHttp(res: ServerResponse, status: 401 | 403 | 404 | 502 | 504, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/**
 * Filter request headers before forwarding upstream. Drop hop-by-hop
 * headers and the `host` header — the upstream sees a localhost target,
 * not MAW's public hostname. Preserve everything else verbatim so the
 * dev server's behavior (cookies, CSRF, content negotiation) doesn't
 * silently change.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host'
]);

function filterRequestHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [key, val] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = val;
  }
  return out;
}

/**
 * Strip / rewrite framing-protection headers on the upstream response so the
 * BrowserView iframe can render the preview. The proxy itself is the
 * security boundary: `/preview/<agentId>/*` requires a session cookie set
 * with `SameSite=Strict`, so a cross-origin iframe on attacker.com can't
 * load this path (the cookie isn't sent → 401). Removing X-Frame-Options
 * and the `frame-ancestors` directive only affects whether MAW can embed
 * the page inside its own modal — exactly what we want for the preview.
 *
 * - `x-frame-options`: dropped entirely.
 * - `content-security-policy`: `frame-ancestors` directive stripped; rest
 *   of the policy preserved so the user's app keeps its other CSP rules.
 */
function stripFramingHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers };
  delete out['x-frame-options'];

  const csp = out['content-security-policy'];
  if (csp != null) {
    const stripFA = (s: string): string =>
      s
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d && !/^frame-ancestors\b/i.test(d))
        .join('; ');
    if (Array.isArray(csp)) {
      const cleaned = csp.map(stripFA).filter((s) => s.length > 0);
      if (cleaned.length === 0) delete out['content-security-policy'];
      else out['content-security-policy'] = cleaned;
    } else if (typeof csp === 'string') {
      const cleaned = stripFA(csp);
      if (!cleaned) delete out['content-security-policy'];
      else out['content-security-policy'] = cleaned;
    }
  }

  // CSP-Report-Only doesn't block, but a violation report would still flag
  // the embed. Drop frame-ancestors there too so devtools stays quiet.
  const cspRO = out['content-security-policy-report-only'];
  if (typeof cspRO === 'string') {
    const cleaned = cspRO
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d && !/^frame-ancestors\b/i.test(d))
      .join('; ');
    if (!cleaned) delete out['content-security-policy-report-only'];
    else out['content-security-policy-report-only'] = cleaned;
  }

  return out;
}

/**
 * Rewrite a 3xx response's `Location` header so the browser stays under
 * `/preview/<agentId>/...` instead of following the redirect to MAW's
 * origin (where the path doesn't exist).
 *
 * Without this rewrite, an upstream like SvelteKit's auth-gated dev server
 * that responds with `Location: /auth` causes the iframe to navigate to
 * `localhost:5173/auth` — MAW serves 404, the user sees a 404 page instead
 * of the upstream's login flow.
 *
 * Rules:
 * - Path-absolute `Location: /foo` → `/preview/<agentId>/foo`
 * - Same-host absolute `Location: http://127.0.0.1:<port>/foo` → `/preview/<agentId>/foo`
 * - Cross-host or schemeless URLs → left alone (the user navigated themselves out)
 */
function rewriteLocationHeader(
  headers: IncomingHttpHeaders,
  agentId: string,
  upstreamHost: string,
  upstreamPort: number
): IncomingHttpHeaders {
  const loc = headers.location;
  if (typeof loc !== 'string' || loc.length === 0) return headers;

  const prefix = `${PREVIEW_PREFIX}${agentId}`;

  // Path-absolute (`/foo`, `/foo?bar`, …) — rewrite directly. Skip locations
  // already under the preview prefix so we don't double-prefix on a chained
  // redirect that came back through us.
  if (loc.startsWith('/') && !loc.startsWith('//') && !loc.startsWith(prefix + '/')) {
    return { ...headers, location: prefix + loc };
  }

  // Absolute URL on the upstream's host (e.g., `http://127.0.0.1:5175/foo`).
  // Strip the origin and prefix the path. Other hosts pass through.
  try {
    const parsed = new URL(loc);
    if (
      (parsed.hostname === upstreamHost || parsed.hostname === 'localhost') &&
      Number(parsed.port) === upstreamPort
    ) {
      const pathOnly = parsed.pathname + parsed.search + parsed.hash;
      if (!pathOnly.startsWith(prefix + '/')) {
        return { ...headers, location: prefix + pathOnly };
      }
    }
  } catch {
    // Invalid URL — leave Location alone.
  }
  return headers;
}

/**
 * Handle an incoming HTTP request. Returns true when the request was a
 * preview-route request (and was handled — either forwarded or rejected);
 * false when the caller should continue with its normal handler chain.
 *
 * The boolean is decided synchronously (path / Referer match) so callers
 * in `server.js` and `vite.config.ts` can chain `if (claimed) return;`
 * cleanly. The actual auth lookup + upstream forwarding happen in an
 * async IIFE — the response is written from inside it.
 */
export function handlePreviewRequest(req: IncomingMessage, res: ServerResponse): boolean {
  let parsed = parsePreviewPath(req.url ?? '');
  if (!parsed) {
    // Path isn't `/preview/<id>/...` — try the Referer-based fallback for
    // SPAs that emit absolute paths from inside the iframe.
    const refAgentId = refererPreviewAgentId(req);
    if (!refAgentId) return false;

    // Top-level navigation inside the iframe: redirect so the iframe URL
    // stays under /preview/<id>/. If we just forwarded inline, the iframe
    // would end up at `/foo` and subsequent absolute-path requests (CSS,
    // JS modules, fetch) would have a non-preview Referer — breaking the
    // route on the next sub-resource. Asset / fetch / xhr requests don't
    // move the iframe URL, so for those we forward inline.
    //
    // Detection is biased toward false positives over false negatives:
    // a redirect that should have been an inline forward only costs one
    // extra round-trip; missing a navigation breaks the entire frame.
    // The Accept header is the reliable cross-browser signal (modern
    // browsers send Sec-Fetch-Dest: document, but programmatic navs and
    // older Safari don't, while Accept: text/html is set consistently).
    const dest = req.headers['sec-fetch-dest'];
    const accept =
      typeof req.headers.accept === 'string' ? req.headers.accept : '';
    const isAssetDest =
      dest === 'script' ||
      dest === 'style' ||
      dest === 'image' ||
      dest === 'font' ||
      dest === 'audio' ||
      dest === 'video' ||
      dest === 'track' ||
      dest === 'manifest' ||
      dest === 'worker' ||
      dest === 'sharedworker' ||
      dest === 'serviceworker';
    const isNavigation =
      req.method === 'GET' &&
      !isAssetDest &&
      (dest === 'document' || dest === 'iframe' || /^text\/html/i.test(accept));
    if (isNavigation) {
      res.writeHead(302, {
        location: `${PREVIEW_PREFIX}${refAgentId}${req.url ?? '/'}`
      });
      res.end();
      return true;
    }
    parsed = { agentId: refAgentId, rest: req.url ?? '/' };
  }

  // Claim the request. Auth + upstream forwarding run async; if anything
  // fails, the IIFE writes the error response itself.
  const claimed = parsed;
  void (async () => {
    const authResult = await resolveAuthorizedAgent(req, claimed.agentId);
    if ('error' in authResult) {
      if (authResult.error === 401) denyHttp(res, 401, 'preview: not authenticated');
      else if (authResult.error === 403) denyHttp(res, 403, 'preview: forbidden');
      else denyHttp(res, 404, 'preview: agent not found');
      return;
    }
    forwardHttp(req, res, claimed.agentId, claimed.rest, authResult.target_port, authResult.target_url);
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[preview-proxy] http handler error:', err);
    if (!res.headersSent) denyHttp(res, 502, 'preview: internal error');
  });
  return true;
}

function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  rest: string,
  upstreamPort: number,
  upstreamUrl: string
): void {
  const upstreamReq = http.request(
    {
      host: '127.0.0.1',
      port: upstreamPort,
      method: req.method,
      path: rest,
      headers: filterRequestHeaders(req.headers)
    },
    (upstreamRes) => {
      // Status + header copy. The dev server's headers flow back unchanged
      // EXCEPT for:
      //   - X-Frame-Options / CSP frame-ancestors: stripped so the iframe
      //     can render the preview (see `stripFramingHeaders`).
      //   - Location: rewritten on 3xx so a path-absolute redirect like
      //     `/auth` stays under `/preview/<id>/...` instead of hitting MAW.
      const status = upstreamRes.statusCode ?? 502;
      let outHeaders = stripFramingHeaders(upstreamRes.headers);
      if (status >= 300 && status < 400) {
        outHeaders = rewriteLocationHeader(outHeaders, agentId, '127.0.0.1', upstreamPort);
      }
      res.writeHead(status, outHeaders);
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.setTimeout(15000, () => {
    upstreamReq.destroy(new Error('preview upstream timeout'));
  });

  upstreamReq.on('error', (err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // Most common cause: dev server isn't running on the configured port.
    // Surface a 502 so the BrowserView component can render a friendly
    // "dev server not reachable" placeholder instead of a stuck spinner.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      denyHttp(res, 502, `preview: dev server not reachable on ${upstreamUrl}`);
    } else {
      denyHttp(res, 502, `preview: upstream error: ${(err as Error).message}`);
    }
  });

  req.pipe(upstreamReq);
}

/**
 * Handle an HTTP `upgrade` event for a WebSocket request under
 * `/preview/<agentId>/*`. Required for Vite HMR — Vite serves its hot-
 * module-reload protocol over a same-origin WebSocket. Without this branch
 * the client connects to MAW's `/preview/<id>/...?token=...` upgrade
 * endpoint, MAW doesn't recognize it, and HMR silently dies.
 *
 * Returns true if the upgrade was a preview-route upgrade and was either
 * forwarded or denied; false to let the caller's chain handle it.
 */
export function handlePreviewUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  let parsed = parsePreviewPath(req.url ?? '');
  if (!parsed) {
    // Vite's HMR socket connects to a path the upstream picks (often `/`
    // or `/?token=...`); inside the preview iframe that resolves against
    // MAW's origin. Same Referer-routing trick as the HTTP handler so
    // HMR keeps working through the proxy.
    const refAgentId = refererPreviewAgentId(req);
    if (!refAgentId) return false;
    parsed = { agentId: refAgentId, rest: req.url ?? '/' };
  }

  const claimed = parsed;
  void (async () => {
    const authResult = await resolveAuthorizedAgent(req, claimed.agentId);
    if ('error' in authResult) {
      // No structured response on raw socket — just close. Legitimate
      // clients (the iframe loaded by an authed user) don't hit this path;
      // only accidental probes do.
      socket.destroy();
      return;
    }
    forwardUpgrade(req, socket, head, claimed.agentId, claimed.rest, authResult.target_port);
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[preview-proxy] upgrade handler error:', err);
    try { socket.destroy(); } catch { /* ignore */ }
  });
  return true;
}

function forwardUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  agentId: string,
  rest: string,
  upstreamPort: number
): void {
  // Open a parallel TCP connection to the upstream and replay the HTTP
  // upgrade handshake as raw bytes. Re-using `http.request({ method, headers,
  // path })` would re-encode the request line and lose the `Upgrade` /
  // `Connection` headers we explicitly want to forward.
  const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort });

  upstream.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.warn(
      `[preview-proxy] upstream WS error for agent ${agentId}: ${(err as Error).message}`
    );
    try { socket.destroy(); } catch { /* ignore */ }
  });
  socket.on('error', () => {
    try { upstream.destroy(); } catch { /* ignore */ }
  });

  upstream.on('connect', () => {
    // Reconstruct the request line + headers and forward them verbatim.
    // The `host` header is rewritten to localhost:<port> so the upstream
    // sees a request that looks local; everything else is preserved.
    const lines: string[] = [];
    lines.push(`${req.method ?? 'GET'} ${rest} HTTP/${req.httpVersion ?? '1.1'}`);
    const headers = filterRequestHeaders(req.headers);
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) {
        for (const item of v) lines.push(`${k}: ${item}`);
      } else if (typeof v === 'string') {
        lines.push(`${k}: ${v}`);
      }
    }
    lines.push(`host: 127.0.0.1:${upstreamPort}`);
    // Re-add the hop-by-hop bits we deliberately strip in HTTP forwarding;
    // they're meaningful for the upgrade handshake.
    if (req.headers.upgrade) lines.push(`upgrade: ${req.headers.upgrade}`);
    if (req.headers.connection) lines.push(`connection: ${req.headers.connection}`);
    const head1 = lines.join('\r\n') + '\r\n\r\n';
    upstream.write(head1);
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}
