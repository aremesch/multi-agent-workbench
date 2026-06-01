# Fix: Eliminate duplicate bootstrap via globalThis singletons

## Context

`server.js` is bundled by esbuild into `build/server.js`, which inlines its own
copies of `bootstrap.ts` and `ws/hub.ts`. SvelteKit's adapter-node output
(`build/handler.js`) dynamically imports its own chunk copies of `bootstrap.ts`.
Result: **two separate module scopes, two `started` flags, two supervisors, two
WS hubs**. The WS upgrade handler in `server.js` attaches to hub instance A
(with empty supervisor A), while SvelteKit routes use supervisor B (the one that
actually spawns agents). Client WS subscribes succeed but receive no data
because supervisor A has no agent runtimes.

Evidence: journal shows `[maw] booting` **twice** per startup; WS connects
(101) but terminal stays blank.

## Approach

Use `globalThis` to store singletons so they survive across module scopes.
Both the esbuild-bundled copy and SvelteKit's chunk copy of `bootstrap.ts`
will check/set the same `globalThis` slot. Whichever runs first wins; the
second is a no-op.

### Changes

**`src/lib/server/bootstrap.ts`** — store `started`, `supervisor`, and
`registry` on `globalThis` instead of module-level `let`:

```ts
const G = globalThis as unknown as {
  __maw_started?: Promise<void>;
  __maw_supervisor?: AgentSupervisor;
  __maw_registry?: AdapterRegistry;
};

export function bootstrap(): Promise<void> {
  if (G.__maw_started) return G.__maw_started;
  G.__maw_started = (async () => { /* ... existing init, assign G.__maw_supervisor / G.__maw_registry ... */ })();
  return G.__maw_started;
}

export function getSupervisor(): AgentSupervisor {
  if (!G.__maw_supervisor) throw new Error('bootstrap() has not completed');
  return G.__maw_supervisor;
}
```

**`src/lib/server/ws/hub.ts`** — same pattern for the hub singleton:

```ts
const G = globalThis as unknown as { __maw_ws_hub?: WsHub };

export function getWsHub(): WsHub {
  if (!G.__maw_ws_hub) G.__maw_ws_hub = new WsHub();
  return G.__maw_ws_hub;
}
```

### Files to modify

| File | Change |
|------|--------|
| `src/lib/server/bootstrap.ts` | Move `started`, `supervisor`, `registry` to `globalThis.__maw_*` |
| `src/lib/server/ws/hub.ts` | Move hub singleton to `globalThis.__maw_ws_hub` |

No changes to `server.js`, `scripts/bundle-server.mjs`, or `package.json`.

## Verification

1. `pnpm check` passes (0 errors)
2. `pnpm build` succeeds
3. `node build/server.js` prints `[maw] booting` exactly **once**
4. Deploy to prod → open agent dialog → terminal shows content
