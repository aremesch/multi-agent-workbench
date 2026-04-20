# Implementation Plan: v0.2 Phase B — Push Notifications

## Context

Phase A landed the PWA shell. Phase B wires up the alert pipeline: when an agent needs attention (permission prompt, task done, error, exit), push a notification to the user's phone. All DB tables, query functions, types, config, and dependencies already exist — this is glue work.

## Steps

### 1. Create `src/lib/server/push/PushService.ts`
- Singleton wrapping `web-push`, initialised with VAPID keys from config
- `notifyUser(userId, payload)` fans out to all push subscriptions, cleans up 404/410
- Export `PushPayload` interface

### 2. Wire PushService into `src/lib/server/bootstrap.ts`
- Import PushService, store on globalThis alongside supervisor/registry
- Call `pushService.init()` during bootstrap sequence (after config, before supervisor)
- Export `getPushService()` getter following existing `getSupervisor()` pattern

### 3. Alert pipeline in `src/lib/server/agents/AgentRuntime.ts`
- After event insertion + state updates in `onChunk()` (line ~191), add alert logic
- `shouldAlert()`: true for `prompt_detected`, `task_done`, `error`; false for `ready`, `working`, `exited` (handled by supervisor)
- Dedup: skip if unacked alert for same (agent, patternId) within 30s
- Check user's `push.notify_kinds` setting — skip if user opted out of this event kind
- Insert alert row, emit `'alert'` event, call `getPushService().notifyUser()`

### 4. Alert on agent exit in `src/lib/server/agents/AgentSupervisor.ts`
- In `finishAsExited()` (line ~208), after `updateAgentStatus()`:
  - Need agent's `user_id` and `repo_id` — get from `getAgent(agentId)` since runtime.agent may not have these after stop
  - Check user's push preferences for 'exited' kind
  - Insert alert + push notification

### 5. WS hub broadcast in `src/lib/server/ws/hub.ts`
- In `handleSubscribe()`, add `runtime.on('alert', onAlert)` listener
- Send `SC_Alert` message to subscribed clients
- Add cleanup to subscription teardown

### 6. API routes
- `src/routes/api/push/subscribe/+server.ts` — POST, upserts push subscription
- `src/routes/api/push/unsubscribe/+server.ts` — POST, deletes by endpoint
- `src/routes/api/user/push-preferences/+server.ts` — PUT, saves notification kind preferences

### 7. Client push registration — `src/lib/client/push.ts`
- `registerPush(vapidPublicKey)`: request permission, subscribe via PushManager, POST to `/api/push/subscribe`
- `urlBase64ToUint8Array()` helper for applicationServerKey

### 8. Layout integration
- `src/routes/+layout.server.ts`: add `vapidPublicKey` to returned data
- `src/routes/+layout.svelte`: call `registerPush()` on mount when user is logged in and vapidPublicKey is set

### 9. Service worker push handlers — `src/service-worker.ts`
- Replace Phase B comments with `push` and `notificationclick` event listeners
- Push: show notification with title/body/icon/tag
- Click: focus existing MAW tab or open new window at the deep-link URL

### 10. Settings UI — `src/routes/settings/+page.svelte`
- Add "Notifications" section with enable/disable button and per-event-kind checkboxes
- `src/routes/settings/+page.server.ts`: load push preferences from user settings

### 11. VAPID key generation script
- `scripts/generate-vapid-keys.mjs`
- Add `vapid:gen` script to `package.json`

## Key Files

| File | Action |
|------|--------|
| `src/lib/server/push/PushService.ts` | Create |
| `src/lib/server/bootstrap.ts` | Modify (add PushService init + getter) |
| `src/lib/server/agents/AgentRuntime.ts` | Modify (alert pipeline in onChunk) |
| `src/lib/server/agents/AgentSupervisor.ts` | Modify (alert on exit) |
| `src/lib/server/ws/hub.ts` | Modify (broadcast SC_Alert) |
| `src/routes/api/push/subscribe/+server.ts` | Create |
| `src/routes/api/push/unsubscribe/+server.ts` | Create |
| `src/routes/api/user/push-preferences/+server.ts` | Create |
| `src/lib/client/push.ts` | Create |
| `src/routes/+layout.server.ts` | Modify (pass vapidPublicKey) |
| `src/routes/+layout.svelte` | Modify (call registerPush on mount) |
| `src/service-worker.ts` | Modify (push + notificationclick handlers) |
| `src/routes/settings/+page.svelte` | Modify (notification preferences UI) |
| `src/routes/settings/+page.server.ts` | Modify (load push preferences) |
| `scripts/generate-vapid-keys.mjs` | Create |
| `package.json` | Modify (add vapid:gen script) |

## Verification

- `pnpm check` — zero errors
- Manual: generate VAPID keys, open PWA, grant permission, spawn agent, verify push arrives
