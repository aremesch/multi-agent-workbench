/**
 * Singleton registry of live PlaywrightSessions, keyed by agent id.
 *
 * The supervisor calls `start()` on browser-stream agent spawn, `stop()`
 * on kill / exit, and `get()` on every WS hub frame-ack / input-forward
 * to look up the running session.
 *
 * Sessions don't persist across server restarts — Playwright loses the
 * Chromium child process when MAW dies. The supervisor's reattach-on-boot
 * branches on `isStreamKind` and re-launches the session from scratch
 * (the agent's `target_url` row carries everything needed to rebuild it).
 */

import { PlaywrightSession, type PlaywrightSessionOptions } from './PlaywrightSession.js';

class Manager {
  private sessions = new Map<string, PlaywrightSession>();

  async start(opts: PlaywrightSessionOptions): Promise<PlaywrightSession> {
    // Idempotent: if a session is already running for this agent id, return
    // it untouched. Avoids leaking a Chromium when a reattach-on-boot races
    // with a manual reconnect.
    const existing = this.sessions.get(opts.agentId);
    if (existing) return existing;

    const session = new PlaywrightSession(opts);
    this.sessions.set(opts.agentId, session);
    try {
      await session.start();
    } catch (err) {
      this.sessions.delete(opts.agentId);
      await session.stop().catch(() => {});
      throw err;
    }
    return session;
  }

  get(agentId: string): PlaywrightSession | undefined {
    return this.sessions.get(agentId);
  }

  async stop(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;
    this.sessions.delete(agentId);
    await session.stop().catch(() => {});
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) await this.stop(id);
  }

  list(): string[] {
    return Array.from(this.sessions.keys());
  }
}

const G = globalThis as unknown as { __maw_playwright_sessions?: Manager };
export function getPlaywrightSessions(): Manager {
  if (!G.__maw_playwright_sessions) G.__maw_playwright_sessions = new Manager();
  return G.__maw_playwright_sessions;
}
