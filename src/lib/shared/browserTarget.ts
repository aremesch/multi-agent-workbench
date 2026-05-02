/**
 * Browser-agent target URL parsing + validation.
 *
 * The user types a URL like `http://localhost:5173` into the spawn form.
 * The same string gets stored on the agent row (`target_url`) for display
 * and parsed into a port (`target_port`) for the `/preview/<id>/*` reverse
 * proxy on MAW's HTTP listener.
 *
 * Constraints (all enforced here so the form action and the BrowserView
 * component agree on what's valid):
 *
 *   - Scheme MUST be `http:` — `https:` localhost dev servers are rare and
 *     would defeat the same-origin proxy advantage anyway.
 *   - Host MUST be `localhost` or `127.0.0.1` — the proxy forwards to
 *     `127.0.0.1:<port>` regardless, so any other host is a configuration
 *     error the user should fix on their dev server.
 *   - Port MUST be present and 1..65535.
 *   - Path is normalized to `/` (trailing path is irrelevant — the iframe's
 *     src is `/preview/<id>/`, the proxy strips the prefix and forwards
 *     whatever path the iframe requests).
 */

export const DEFAULT_BROWSER_TARGET_URL = 'http://localhost:5173';

/**
 * Canonical cli_kind for browser agents. Mirrors `BROWSER_KIND` in
 * `AgentSupervisor.ts` — kept here too so client-side code (which can't
 * import server modules) shares the same string.
 */
export const BROWSER_CLI_KIND = 'browser';

/**
 * Canonical cli_kind for the Playwright-driven streaming variant. The
 * server runs a real Chromium and pushes JPEG frames over WebSocket to
 * `<StreamView>`; the iframe approach (`BROWSER_CLI_KIND`) is the
 * lighter-weight alternative when the SPA URL constraints don't bite.
 */
export const BROWSER_STREAM_CLI_KIND = 'browser-stream';

export function isAnyBrowserKind(kind: string): boolean {
  return kind === BROWSER_CLI_KIND || kind === BROWSER_STREAM_CLI_KIND;
}

/**
 * The set of cli_kind strings that represent a CLI **coding** agent — one
 * that runs inside a tmux session in its own git worktree, capable of
 * editing files in the repo.
 *
 * Used to gate UI affordances that only make sense for coding agents:
 * the agent-window kebab menu (Show Plan / Show Log / Exit) is not shown
 * for browser agents (which have their own Stop button inside
 * <BrowserView>) or the `shell` smoke adapter (a dev-only test fixture
 * that runs in the repo root without a per-agent worktree).
 *
 * Adding a new coding adapter? Append its `kind` here.
 */
export const CODING_CLI_KINDS: readonly string[] = ['claude-code', 'codex', 'gemini'];

export function isCodingCliKind(kind: string): boolean {
  return CODING_CLI_KINDS.includes(kind);
}

export type BrowserTargetParseResult =
  | { ok: true; url: string; port: number }
  | { ok: false; error: 'empty' | 'invalid' | 'scheme' | 'host' | 'port' };

export function parseBrowserTargetUrl(raw: string): BrowserTargetParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'empty' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'invalid' };
  }

  if (parsed.protocol !== 'http:') return { ok: false, error: 'scheme' };
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return { ok: false, error: 'host' };
  }

  // URL parser leaves `port` empty when the URL omits it (e.g. `http://localhost`)
  // — http defaults to 80 and most dev servers don't run there. Require an
  // explicit port so the proxy never silently falls back to 80.
  if (!parsed.port) return { ok: false, error: 'port' };
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'port' };
  }

  // Canonicalize for storage: strip path/query/hash. The proxy ignores them.
  const canonical = `${parsed.protocol}//${parsed.hostname}:${port}`;
  return { ok: true, url: canonical, port };
}
