import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  getConfig: vi.fn()
}));

import { getConfig } from '../config.js';
import { clientIp, clientIpFromRaw } from './clientIp.js';

type Cfg = ReturnType<typeof getConfig>;

function cfg(trustProxy: boolean): Cfg {
  return { trustProxy } as unknown as Cfg;
}

describe('clientIp (SvelteKit RequestEvent)', () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeEvent(
    opts: { xff?: string | null; addr?: string; addrThrows?: boolean } = {}
  ): Parameters<typeof clientIp>[0] {
    const { xff = null, addr = '', addrThrows = false } = opts;
    return {
      request: {
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'x-forwarded-for' ? xff : null
        }
      },
      getClientAddress: () => {
        if (addrThrows) throw new Error('no address');
        return addr;
      }
    } as unknown as Parameters<typeof clientIp>[0];
  }

  it('uses socket peer when trustProxy=false, ignoring xff', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(false));
    expect(clientIp(makeEvent({ xff: '1.2.3.4', addr: '10.0.0.1' }))).toBe('10.0.0.1');
  });

  it('reads first xff entry when trustProxy=true', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(true));
    expect(clientIp(makeEvent({ xff: '1.2.3.4, 10.0.0.1', addr: '10.0.0.99' }))).toBe(
      '1.2.3.4'
    );
  });

  it('trims whitespace around the first xff entry', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(true));
    expect(
      clientIp(makeEvent({ xff: '  1.2.3.4  ,  10.0.0.1', addr: '10.0.0.99' }))
    ).toBe('1.2.3.4');
  });

  it('falls back to socket peer when trustProxy=true but xff is missing', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(true));
    expect(clientIp(makeEvent({ xff: null, addr: '10.0.0.1' }))).toBe('10.0.0.1');
  });

  it('preserves IPv6 addresses', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(true));
    expect(clientIp(makeEvent({ xff: '2001:db8::1, 10.0.0.1' }))).toBe('2001:db8::1');
  });

  it('returns - when getClientAddress throws', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(false));
    expect(clientIp(makeEvent({ addrThrows: true }))).toBe('-');
  });

  it('returns - when getClientAddress returns empty string', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(false));
    expect(clientIp(makeEvent({ addr: '' }))).toBe('-');
  });
});

describe('clientIpFromRaw (raw Node IncomingMessage)', () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses socket.remoteAddress when trustProxy=false', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(false));
    expect(
      clientIpFromRaw({
        headers: { 'x-forwarded-for': '1.2.3.4' },
        socket: { remoteAddress: '10.0.0.1' }
      })
    ).toBe('10.0.0.1');
  });

  it('reads xff first entry when trustProxy=true', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(true));
    expect(
      clientIpFromRaw({
        headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
        socket: { remoteAddress: '10.0.0.99' }
      })
    ).toBe('1.2.3.4');
  });

  it('handles xff delivered as an array', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(true));
    expect(
      clientIpFromRaw({
        headers: { 'x-forwarded-for': ['1.2.3.4', '10.0.0.1'] },
        socket: { remoteAddress: '10.0.0.99' }
      })
    ).toBe('1.2.3.4');
  });

  it('falls back to socket peer when trustProxy=true but xff missing', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(true));
    expect(
      clientIpFromRaw({ headers: {}, socket: { remoteAddress: '10.0.0.1' } })
    ).toBe('10.0.0.1');
  });

  it('returns - when neither xff nor socket is available', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(false));
    expect(clientIpFromRaw({ headers: {} })).toBe('-');
  });

  it('returns - when socket.remoteAddress is null', () => {
    vi.mocked(getConfig).mockReturnValue(cfg(false));
    expect(clientIpFromRaw({ headers: {}, socket: { remoteAddress: null } })).toBe('-');
  });
});
