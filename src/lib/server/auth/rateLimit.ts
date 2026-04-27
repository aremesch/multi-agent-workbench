/**
 * In-memory per-key sliding-window rate limiter for SvelteKit form actions.
 *
 * Better-auth's built-in rate limiter only fires on its own HTTP routes
 * (/api/auth/*). The /login form action calls `auth.api.signInEmail`
 * directly — that path bypasses better-auth's middleware, so we still
 * need a small limiter sitting in front of the action.
 *
 * Good enough for MAW's single-node deployment; fail2ban handles anything
 * distributed. Not meant to replace CAPTCHAs or upstream WAF limits.
 */

const buckets = new Map<string, number[]>();

export function checkRate(key: string, count: number, windowSeconds: number): boolean {
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;
  const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  buckets.set(key, hits);

  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      if ((v[v.length - 1] ?? 0) < cutoff) buckets.delete(k);
    }
  }

  return hits.length <= count;
}
