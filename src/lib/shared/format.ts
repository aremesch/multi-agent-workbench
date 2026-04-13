export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.floor(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Format seconds as hh:mm:ss (or m:ss when under an hour). */
export function formatDurationHMS(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${m}:${ss}`;
}

export function formatTimestamp(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const d = new Date(sec * 1000);
  return d.toLocaleString();
}
