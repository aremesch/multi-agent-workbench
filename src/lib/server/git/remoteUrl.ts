import type { AgentRemote } from '$lib/shared/types';

/**
 * Parse a git origin URL (SSH or HTTPS) into a web-browsable base URL for
 * commit links. Returns null for unrecognized forms (e.g. local paths).
 */
export function parseRemoteUrl(originUrl: string | null | undefined): AgentRemote | null {
  if (!originUrl) return null;
  const url = originUrl.trim();
  if (!url) return null;

  let host = '';
  let pathPart = '';

  const sshMatch = url.match(/^(?:ssh:\/\/)?(?:[\w.-]+@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  const httpsMatch = url.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);

  if (httpsMatch) {
    host = httpsMatch[1] ?? '';
    pathPart = httpsMatch[2] ?? '';
  } else if (sshMatch) {
    host = sshMatch[1] ?? '';
    pathPart = sshMatch[2] ?? '';
  }

  if (!host || !pathPart) return null;

  const provider: AgentRemote['provider'] =
    host === 'github.com' ? 'github' : host.includes('.') ? 'gitea' : 'unknown';
  const webBase = `https://${host}/${pathPart}`;
  return { provider, webBase };
}
