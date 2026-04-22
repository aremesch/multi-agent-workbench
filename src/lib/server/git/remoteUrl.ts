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
  let scheme = 'https';

  const sshMatch = url.match(/^(?:ssh:\/\/)?(?:[\w.-]+@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  const httpMatch = url.match(/^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);

  if (httpMatch) {
    scheme = httpMatch[1] ?? 'https';
    host = httpMatch[2] ?? '';
    pathPart = httpMatch[3] ?? '';
  } else if (sshMatch) {
    host = sshMatch[1] ?? '';
    pathPart = sshMatch[2] ?? '';
  }

  if (!host || !pathPart) return null;

  const provider: AgentRemote['provider'] =
    host === 'github.com' ? 'github' : host.includes('.') ? 'gitea' : 'unknown';
  const webBase = `${scheme}://${host}/${pathPart}`;
  return { provider, webBase };
}
