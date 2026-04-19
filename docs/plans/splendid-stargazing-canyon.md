# README Update — v0.2 PWA & Push

## Context

`README.md` is frozen at v0.1 mid-era (CRUD UI + dashboard v2). Since
then v0.2 Phase A (PWA installable shell) and Phase B (Web Push alert
pipeline) have landed, plus several v0.1 polish plans (terminal
scrollback v2, JSONL history, left-sidebar treeview, sidebar polish,
inline spawn, archive dashboard, i18n, change-password, security
hardening, M3 theming) and v0.2 configurable spawn args. The README's
"Status", "Stack", "Repository layout", "Environment", and "Roadmap"
sections are all stale. Goal: bring README current, with extra focus on
the PWA story since that's the project's headline feature.

## Scope

Only edit `README.md`. No code changes. The CLAUDE.md "Current status"
section already tracks detail — README should stay higher-level and
user-facing (install / run / what you get), not duplicate the running
log.

## Sections to revise

### Remove `## Status` entirely

Delete the v0.1-mid status bullets and the "Not yet" paragraph. Git
history is the activity log; forward-looking work lives under
`docs/plans/`. README stays evergreen.

### New `## PWA & Push Notifications` section (replaces Status slot)

Headline feature — deserves its own section. Cover:

1. **Install**: open the deployed URL on Android Chrome or desktop
   Chrome/Edge and use "Install app". `static/manifest.webmanifest` +
   `src/service-worker.ts` drive installability; an offline fallback
   page is cached at install time.
2. **Enable push**: in Settings → Notifications, grant permission and
   subscribe. Requires VAPID keys configured on the server
   (`MAW_VAPID_PUBLIC_KEY`, `MAW_VAPID_PRIVATE_KEY`,
   `MAW_VAPID_SUBJECT`). Generate with
   `pnpm dlx web-push generate-vapid-keys`.
3. **What you get notified about**: permission prompts, idle-waiting,
   crashes, errors — detected per adapter. Tap the notification to
   open the PWA directly on the agent that needs attention.
4. **HTTPS required**: service workers and Web Push only work over
   HTTPS (localhost is exempt for dev). Put MAW behind a TLS-
   terminating reverse proxy (Caddy/nginx) for phone installs.
5. **Disable push per-agent**: turn off skip-permissions in the spawn
   form so the agent actually prompts and you get a notification.

### `## Stack`

Add:
- Service worker (`src/service-worker.ts`) + web app manifest for PWA.
- `web-push` for VAPID-signed Web Push fan-out.
- Production bundle: `esbuild` single-file server, no `tsx` / `src/`
  needed on prod hosts.

### `## Repository layout`

Add:
- `static/` — manifest, icons, offline fallback.
- `src/service-worker.ts` — cache + push + notificationclick.
- `src/lib/server/push/` — `PushService`, alert fan-out.
- `src/lib/i18n/` (or equivalent locales dir; confirm on execution).

### `## Environment`

Clarify VAPID entries are now required for push (not "v0.2 TBD"):
generation command, and that `MAW_VAPID_SUBJECT` must be `mailto:` or
a URL. Mention that leaving them unset disables push cleanly (app
still runs).

### `## Roadmap` → rename to `## Plans` (or keep) — pointer-only

Drop the executed/not-executed annotations and the inline forward list.
Just: "Persisted plans live in [`docs/plans/`](docs/plans/)." Anything
more detailed belongs in the plan files or git log.

Also update the intro paragraph at the top of the README: drop the
"(v0.2) will push…" future tense — PWA + push are current behavior.

## Files

- `README.md` — sole file edited.

## Verification

- `pnpm check` (no code changed, should stay clean).
- Render README on GitHub or `glow README.md` — all links under
  `docs/plans/` resolve, no broken references.
- Spot-check that mentioned env vars match `.env.example` and that
  mentioned routes (`/repos/[id]`, `/repos/[id]/archive`, Settings →
  Notifications) exist in `src/routes/`.
