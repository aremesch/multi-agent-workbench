import type { RequestEvent } from '@sveltejs/kit';
import { getConfig } from '../config.js';

/**
 * Resolve the client IP for an inbound HTTP request. Honors `X-Forwarded-For`
 * only when `MAW_TRUST_PROXY=1`; otherwise falls back to the socket peer
 * reported by SvelteKit. Returns '-' if neither is available so log lines
 * stay parseable.
 */
export function clientIp(event: RequestEvent): string {
  if (getConfig().trustProxy) {
    const xff = event.request.headers.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  try {
    return event.getClientAddress() || '-';
  } catch {
    return '-';
  }
}

/**
 * IP resolution for the raw Node request used by the WebSocket upgrade
 * handler (no SvelteKit RequestEvent available).
 */
export function clientIpFromRaw(req: {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null };
}): string {
  if (getConfig().trustProxy) {
    const h = req.headers['x-forwarded-for'];
    const xff = Array.isArray(h) ? h[0] : h;
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress ?? '-';
}
