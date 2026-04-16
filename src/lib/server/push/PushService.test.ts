import { beforeEach, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// Mocks — web-push, config, and db.queries are all stand-ins. `vi.hoisted`
// is required because vi.mock hoists above the file's const declarations, so
// the factories must reference symbols that are also hoisted.
// -----------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  setVapidDetailsMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  listPushSubsForUserMock: vi.fn(),
  deletePushSubByEndpointMock: vi.fn(),
  config: {
    vapidPublicKey: 'PUB',
    vapidPrivateKey: 'PRIV',
    vapidSubject: 'mailto:x@y'
  }
}));

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: (...a: unknown[]) => mocks.setVapidDetailsMock(...a),
    sendNotification: (...a: unknown[]) => mocks.sendNotificationMock(...a)
  }
}));

vi.mock('../config.js', () => ({
  getConfig: () => mocks.config
}));

vi.mock('../db/queries.js', () => ({
  listPushSubsForUser: (...a: unknown[]) => mocks.listPushSubsForUserMock(...a),
  deletePushSubByEndpoint: (...a: unknown[]) => mocks.deletePushSubByEndpointMock(...a)
}));

import { PushService } from './PushService.js';

beforeEach(() => {
  mocks.setVapidDetailsMock.mockReset();
  mocks.sendNotificationMock.mockReset();
  mocks.listPushSubsForUserMock.mockReset();
  mocks.deletePushSubByEndpointMock.mockReset();
  mocks.config.vapidPublicKey = 'PUB';
  mocks.config.vapidPrivateKey = 'PRIV';
  mocks.config.vapidSubject = 'mailto:x@y';
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

function samplePayload() {
  return {
    title: 'agent paused',
    body: 'permission prompt',
    data: { agentId: 'a1', alertId: 'al1', url: '/agents/a1' }
  };
}

describe('PushService.init', () => {
  it('configures web-push when both VAPID keys are present', () => {
    const svc = new PushService();
    svc.init();
    expect(mocks.setVapidDetailsMock).toHaveBeenCalledWith('mailto:x@y', 'PUB', 'PRIV');
  });

  it('enters disabled mode when the public key is missing (no throw, log-only)', () => {
    mocks.config.vapidPublicKey = '';
    const svc = new PushService();
    svc.init();
    expect(mocks.setVapidDetailsMock).not.toHaveBeenCalled();
  });

  it('enters disabled mode when the private key is missing', () => {
    mocks.config.vapidPrivateKey = '';
    const svc = new PushService();
    svc.init();
    expect(mocks.setVapidDetailsMock).not.toHaveBeenCalled();
  });
});

describe('PushService.notifyUser — disabled path', () => {
  it('is a silent no-op when init() was skipped (no VAPID)', async () => {
    mocks.config.vapidPublicKey = '';
    const svc = new PushService();
    svc.init();
    await svc.notifyUser('u1', samplePayload());
    expect(mocks.listPushSubsForUserMock).not.toHaveBeenCalled();
    expect(mocks.sendNotificationMock).not.toHaveBeenCalled();
  });

  it('short-circuits when the user has zero subscriptions', async () => {
    const svc = new PushService();
    svc.init();
    mocks.listPushSubsForUserMock.mockReturnValue([]);
    await svc.notifyUser('u1', samplePayload());
    expect(mocks.sendNotificationMock).not.toHaveBeenCalled();
  });
});

describe('PushService.notifyUser — fan-out', () => {
  it('sends one notification per sub with the correct push subscription shape', async () => {
    const subs = [
      { endpoint: 'https://push/1', p256dh: 'p1', auth: 'a1' },
      { endpoint: 'https://push/2', p256dh: 'p2', auth: 'a2' }
    ];
    mocks.listPushSubsForUserMock.mockReturnValue(subs);
    mocks.sendNotificationMock.mockResolvedValue({});
    const svc = new PushService();
    svc.init();
    await svc.notifyUser('u1', samplePayload());
    expect(mocks.sendNotificationMock).toHaveBeenCalledTimes(2);
    expect(mocks.sendNotificationMock.mock.calls[0][0]).toEqual({
      endpoint: 'https://push/1',
      keys: { p256dh: 'p1', auth: 'a1' }
    });
    expect(mocks.sendNotificationMock.mock.calls[0][2]).toEqual({ TTL: 300 });
  });

  it('serializes the payload as JSON', async () => {
    mocks.listPushSubsForUserMock.mockReturnValue([{ endpoint: 'e', p256dh: 'p', auth: 'a' }]);
    mocks.sendNotificationMock.mockResolvedValue({});
    const svc = new PushService();
    svc.init();
    const payload = samplePayload();
    await svc.notifyUser('u1', payload);
    const [, json] = mocks.sendNotificationMock.mock.calls[0];
    expect(JSON.parse(json as string)).toEqual(payload);
  });
});

describe('PushService.notifyUser — dead-sub cleanup', () => {
  it('deletes subs whose endpoint returns 404', async () => {
    mocks.listPushSubsForUserMock.mockReturnValue([
      { endpoint: 'dead', p256dh: 'p', auth: 'a' },
      { endpoint: 'alive', p256dh: 'p', auth: 'a' }
    ]);
    mocks.sendNotificationMock.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === 'dead') throw { statusCode: 404 };
    });
    const svc = new PushService();
    svc.init();
    await svc.notifyUser('u1', samplePayload());
    expect(mocks.deletePushSubByEndpointMock).toHaveBeenCalledTimes(1);
    expect(mocks.deletePushSubByEndpointMock).toHaveBeenCalledWith('dead');
  });

  it('deletes subs whose endpoint returns 410 (gone)', async () => {
    mocks.listPushSubsForUserMock.mockReturnValue([{ endpoint: 'gone', p256dh: 'p', auth: 'a' }]);
    mocks.sendNotificationMock.mockRejectedValue({ statusCode: 410 });
    const svc = new PushService();
    svc.init();
    await svc.notifyUser('u1', samplePayload());
    expect(mocks.deletePushSubByEndpointMock).toHaveBeenCalledWith('gone');
  });

  it('does NOT delete on transient errors (e.g. 5xx)', async () => {
    mocks.listPushSubsForUserMock.mockReturnValue([{ endpoint: 'flaky', p256dh: 'p', auth: 'a' }]);
    mocks.sendNotificationMock.mockRejectedValue({ statusCode: 503 });
    const svc = new PushService();
    svc.init();
    await svc.notifyUser('u1', samplePayload());
    expect(mocks.deletePushSubByEndpointMock).not.toHaveBeenCalled();
  });

  it('never throws out of notifyUser even when sendNotification itself throws', async () => {
    mocks.listPushSubsForUserMock.mockReturnValue([{ endpoint: 'e', p256dh: 'p', auth: 'a' }]);
    mocks.sendNotificationMock.mockRejectedValue(new Error('network down'));
    const svc = new PushService();
    svc.init();
    await expect(svc.notifyUser('u1', samplePayload())).resolves.toBeUndefined();
  });
});
