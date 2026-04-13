/**
 * PushService — singleton wrapping `web-push` for sending push notifications.
 *
 * Initialised during bootstrap alongside the supervisor. If VAPID keys are
 * not configured, all `notifyUser()` calls silently no-op.
 */

import webpush from 'web-push';
import { getConfig } from '../config.js';
import { listPushSubsForUser, deletePushSubByEndpoint } from '../db/queries.js';

export interface PushPayload {
  title: string;
  body: string;
  data: {
    agentId: string;
    alertId: string;
    /** Deep-link URL the PWA opens on tap. */
    url: string;
  };
}

export class PushService {
  private ready = false;

  init(): void {
    const cfg = getConfig();
    if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) {
      console.warn('[push] VAPID keys not set — push disabled');
      return;
    }
    webpush.setVapidDetails(cfg.vapidSubject, cfg.vapidPublicKey, cfg.vapidPrivateKey);
    this.ready = true;
    console.log('[push] VAPID configured — push enabled');
  }

  async notifyUser(userId: string, payload: PushPayload): Promise<void> {
    if (!this.ready) return;
    const subs = listPushSubsForUser(userId);
    if (subs.length === 0) return;
    const json = JSON.stringify(payload);
    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            json,
            { TTL: 60 * 5 }
          );
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            deletePushSubByEndpoint(sub.endpoint);
          }
        }
      })
    );
  }
}
