/**
 * In-memory per-key sliding-window rate limiter.
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
