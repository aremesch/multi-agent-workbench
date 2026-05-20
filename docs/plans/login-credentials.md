# Login bypass + PWA-logged-out-after-update — analysis & fix plan

## Context

Two user-reported symptoms, both happening in the prod PWA on Android:

1. **"Any username + correct password works on the first login attempt after
   the application starts."** Reproduced via the PWA, only when the user had a
   prior valid login.
2. **"After an update, the PWA is logged out."** Started recently — the user
   says it didn't behave this way a few weeks ago. Each redeploy
   (`git pull && pnpm install && pnpm build && systemctl --user restart maw`)
   appears to drop the PWA back to the login screen.

The user's `.env` has a stable `BETTER_AUTH_SECRET` (44-char base64) and the
DB is not touched on updates, so a secret-rotation explanation is ruled out.

## What the prod auth log and DB actually show

`auth.log` and `~/.local/share/maw/maw.db` on this host (the prod data dir):

- `session` table has **5 valid rows for the same user** `01KP15TRVWDS9MX36MTVVT7GXK`
  (`ar@maw.local`). Oldest still-valid session was created 2026-04-27 17:29 with
  `expiresAt` 2026-06-15 — i.e. the 30-day TTL is working as designed and the
  user's cookie *should* still be authenticating today. Yet the user has
  re-logged in several times since (2026-05-16, 2026-05-20 ×3).
- `auth.log` shows the user repeatedly failing logins between 04-27 and 05-16
  with `alexander.remesch@gmail.com` — their real Gmail address, not the
  bootstrap `ar@maw.local` — then finally getting the right email on 05-16.
  The pattern repeats on 05-19 (`gmail.com` again, fail) and 05-20 (multiple
  fake emails, then `ar@maw.local` ok).
- **There is NO `login_ok` event with a wrong email anywhere in `auth.log`.**
  Every successful sign-in used `ar@maw.local`. Every wrong-email attempt
  produced `login_fail`. So whatever the user is observing as "bypass" is
  *not* better-auth admitting a wrong email + correct password — better-auth
  is correctly rejecting them.
- One curiosity: a `session` row dated 2026-05-20T17:26:40 with userAgent
  `curl/8.14.1` and empty `ipAddress`, with **no matching `auth.log` entry**
  in that minute. That session was created via the `/api/auth/sign-in/email`
  endpoint (which forwards to `auth.handler` and bypasses the `/login` form
  action where `logAuth('login_ok', …)` is written). This is a separate small
  auditing gap, not the bypass.

## Why the "bypass" looks like one but isn't credential-checking

Combining the auth log evidence with the `/login` flow:

- The form action at `src/routes/login/+page.server.ts:17-84` calls
  `auth.api.signInEmail({ headers: request.headers, … })`. `request.headers`
  carries the user's existing `maw_session` cookie, but better-auth's
  `signInEmail` ignores it — it always does an explicit `findUserByEmail`
  followed by `password.verify` and rejects on either miss. Verified against
  `node_modules/.../better-auth/dist/api/routes/sign-in.mjs:201-235`. So the
  401 is real and `resp.ok = false`.
- After `return fail(401, …)`, SvelteKit re-renders the page, which **re-runs
  `+page.server.ts`'s `load`** (default behavior for non-`use:enhance`
  form actions, no JS on the login page).
- `+page.server.ts:11-14` short-circuits with
  `if (locals.user) throw redirect(303, '/')`. The redirect from the load
  function takes precedence over the action's `fail()`, so the browser
  receives a 303 to `/` and the user lands on the dashboard — fully
  authenticated **by the existing valid session cookie**, not by the wrong
  email they just submitted.
- `event.locals.user` was set at the top of `hooks.server.ts:28` from
  `auth.api.getSession({ headers })` against the still-valid `session` row in
  the DB; nothing in the failed action invalidates it.
- "Only correct password works" — the asymmetry — is the user's testing
  artefact, not a real difference. From the auth.log timeline at 17:27-17:29
  on 05-20: they reproduced the "bypass" once, manually clicked logout
  (`session_revoked` at 17:28:03), then re-tested wrong-email + wrong-password.
  After the manual logout the cookie was gone, so the load no longer
  redirected and they correctly saw the form error. They attributed the
  difference to the password, but the actual variable was the session cookie.

So **the bypass is a session-handling bug, not a credential-checking bug.**
Anyone with a valid prior session can "succeed" at the login form regardless
of what they type. In practice this isn't an authn bypass — the visitor
already had a session — but it's confusing UX and on principle the `/login`
action should not return success when the form was filled with garbage.

## Why the PWA gets logged out after updates (strong hypothesis)

`betterAuth.ts:79-90`:

```ts
advanced: {
  cookies: { session_token: { name: 'maw_session' } },
  useSecureCookies: !cfg.isDev,
  defaultCookieAttributes: { sameSite: 'strict' }
}
```

`sameSite: 'strict'` was set deliberately in commit `4d6c911`
(2026-04-13 "feat(security): SameSite=strict + CSP/HSTS + must-change gate")
and carried forward into the better-auth migration on 04-27. It supersedes
better-auth's own default of `lax`.

`SameSite=Strict` is the source of the perceived logouts:

- For top-level navigations **initiated from outside the site** — clicking a
  push notification, opening the PWA shortcut from the home screen on
  Android after the underlying WebView has been restarted, a redirect from
  any other origin, etc. — Chrome **does not send Strict cookies on the
  navigation itself**. The first request after that navigation reaches the
  server with no `__Secure-maw_session` cookie, so `auth.api.getSession`
  returns null, `hooks.server.ts` routes the user through `+page.server.ts:49`
  → "no `locals.user`" → redirect to `/login`. The user sees the login form,
  even though their cookie is still in the jar.
- Once the user interacts with the page (same-origin requests), Strict
  cookies *are* sent again — but by then the user has already typed an
  email/password into the form. If they type the wrong email but their
  cookie comes along on the form POST (now same-origin), the bypass from §1
  kicks in and they land on the dashboard.

This matches the user's repro pattern exactly:

1. Update → systemd restart → user opens PWA from home-screen icon or a push
   notification.
2. First navigation has no Strict cookie → user is redirected to `/login`
   → "PWA logged out".
3. User types any email + the password their manager fills → POSTs `/login`
   (now same-origin, Strict cookie attached) → action's `fail(401)` →
   load redirects via still-valid session → "logged in".

The two symptoms are the same underlying issue showing two different faces.

### Why the user thinks it's "new"

Per `git log`, `sameSite: 'strict'` has been in place since 2026-04-13. The
user only logged in successfully on the PWA on 2026-04-27 (after the better-
auth migration); between 2026-05-02 and 2026-05-16 they were locked out
because they kept guessing `alexander.remesch@gmail.com` instead of
`ar@maw.local`. So in practice they've had a *working* PWA login for only ~3
weeks, and the Strict-cookie eviction has been hitting them roughly once per
update since they actually started using the PWA daily. The "few days ago"
framing reflects when they started noticing, not when the regression
landed.

## Fix plan

Three small changes — all in `src/lib/server/auth/betterAuth.ts` and
`src/routes/login/+page.server.ts`. Each is independent.

### Fix 1 — Stop SameSite=Strict from evicting the PWA's session cookie

In `src/lib/server/auth/betterAuth.ts:88`, change

```ts
defaultCookieAttributes: { sameSite: 'strict' }
```

to

```ts
defaultCookieAttributes: { sameSite: 'lax' }
```

(or remove the override entirely — `lax` is better-auth's own default per
`getCookies` in `cookies/index.mjs`, and is the OWASP-recommended baseline
for CSRF-by-cookie protection.) Together with the existing CSRF token cookie
issued by `src/lib/server/auth/csrf.ts` and the JSON-API CSRF enforcement
(commit `dd9b8e5`), `SameSite=Lax` still rejects cross-origin POST-style
attacks — it only allows the cookie to ride along on top-level navigations,
which is exactly what the PWA needs.

This single change should make `git pull && pnpm build && systemctl restart`
stop logging the PWA out for the user.

### Fix 2 — Stop the `/login` redirect-via-load from masking failed actions

Two equivalent patches in `src/routes/login/+page.server.ts`:

- Gate the load redirect to GET only, so a failed POST doesn't get redirected
  via `locals.user`:

  ```ts
  export const load: PageServerLoad = async ({ locals, request }) => {
    if (request.method === 'GET' && locals.user) throw redirect(303, '/');
    return {};
  };
  ```

- Defensively clear the session at the top of the `login` action so any
  inbound cookie is invalidated before `signInEmail` is even called:

  ```ts
  login: async (event) => {
    const { request, cookies, locals } = event;
    cookies.delete('maw_session', { path: '/' });
    locals.user = null;
    locals.session = null;
    // ...existing logic
  }
  ```

Either change is sufficient on its own; doing both is cheap and makes the
behavior obvious to anyone reading the action later. Combined with Fix 1,
the user will start seeing real form errors when they mistype their email,
instead of the misleading "logged in anyway" experience.

### Fix 3 — Plug the `/api/auth/sign-in/email` audit gap (optional)

The catch-all at `src/routes/api/auth/[...all]/+server.ts` forwards to
`auth.handler` without writing `login_ok` / `login_fail` to `auth.log`. The
curl session in the DB with no matching log entry shows this. If we want
fail2ban-style coverage on that path too, wrap it with an `onResponse`
hook in `betterAuth.ts` (better-auth supports per-route hooks) that calls
`logAuth(...)` for `/sign-in/email` and `/sign-out` responses. Not required
for the bypass / logout fixes; surfacing here so it doesn't get lost.

## Verification

After applying Fix 1 + Fix 2, with a fresh prod restart:

- The PWA, opened from the home-screen shortcut after `systemctl restart maw`,
  should stay logged in (Lax cookie rides along on the first navigation).
- POSTing `/login` with `wrong@example.com` + the correct admin password
  (with or without a valid `maw_session` cookie) should leave the user on
  `/login` with the "invalid credentials" error — not redirect to `/`.
- Existing prod sessions in the DB keep working; no migration needed.

Add a regression test under `src/routes/login/`:

```ts
// pseudo-vitest
it('does not redirect failed sign-in to / even when a session cookie is present', async () => {
  // seed a valid session for the bootstrap user
  // POST /login?/login with wrong email + correct password + the cookie
  // expect 401 status returned from the form action, not a 303
});
```

## Critical files

- `src/lib/server/auth/betterAuth.ts` (Fix 1, possibly Fix 3)
- `src/routes/login/+page.server.ts` (Fix 2)
- `src/routes/api/auth/[...all]/+server.ts` (Fix 3, optional)

## Out-of-scope findings (not fixing here)

- **Migration `007_better_auth.sql` declares `INTEGER` for
  `session.expiresAt/createdAt/updatedAt` but better-auth/kysely actually
  stores ISO-8601 strings** (verified in the live DB — `typeof = text`). It
  happens to work because SQLite is loosely typed and kysely re-parses TEXT
  dates, but it's a schema/data drift that will bite the next person to
  write a hand-rolled SQL query against those columns. Worth a follow-up
  migration to switch the column types to `TEXT` and update the integration
  tests accordingly.
- The bootstrap-user guard `countUsers() === 0` checks only the legacy
  `users` table. If someone empties that table without also emptying
  better-auth's `user`/`account` tables, bootstrap won't re-create the
  legacy row but the better-auth rows survive — confusing state. Low risk
  in practice; leaving as-is.
