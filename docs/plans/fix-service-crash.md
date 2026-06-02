# Fix: EBADF crash takes down the whole backend + crash backstop

## Context

Production `journalctl` shows the MAW backend (PID 225952) died on 2026-05-23
02:09 with an **unhandled `'error'` event**:

```
Error: EBADF: bad file descriptor, close
Emitted 'error' event on a Dt instance at:
    at ReadStream.<anonymous> (build/server/chunks/bootstrap-C71EKVk7.js:28:123)
  errno: -9, code: 'EBADF', syscall: 'close'
```

`Dt` is the minified `FifoStreamer`. Each agent's terminal output flows through
a named pipe (FIFO): tmux writes via `pipe-pane`, the backend reads with a Node
`ReadStream` wrapped by `FifoStreamer`. When the underlying fd goes bad — the
likely trigger here is the dedicated `maw-tmux` server restarting under the
readers (`maw-tmux.service` has `Restart=on-failure`) — the `ReadStream`
raises an error. `FifoStreamer` re-emits it as its own `'error'` event
(`FifoStreamer.ts:84`):

```js
this.stream.on('error', (err) => this.emit('error', err));
```

But its owner `AgentRuntime` only ever wires the **data** callback
(`AgentRuntime.start()`, lines 120-125) — **nothing listens for `'error'`**.
In Node, emitting `'error'` with no listener throws, terminating the whole
process. So one agent's pipe hiccup kills the backend and **every** agent's
live stream until systemd restarts it.

**Intended outcome:** a FIFO read error must affect only the one agent (with an
automatic recovery attempt), never the process. A process-wide backstop catches
any future stray error of this class.

### Out of scope (verified, no change needed)

The SIGTERM timeout in the same log (PID 203620, 2026-05-22 19:02) is from an
**older build**. Current `server.js:84-93` already has a 2s
`setTimeout(() => process.exit(0)).unref()` fail-safe, and `maw.service` uses
`KillMode=process` + `TimeoutStopSec=5`, so the process now exits well within
the 5s window. No shutdown change required.

## Decisions (confirmed with user)

1. **Recovery:** on a FIFO stream error, log, tear down the broken streamer,
   then attempt **one** automatic re-stream (recreate FIFO + `pipe-pane`). If
   the tmux session is gone or the retry fails, leave the agent running with a
   stopped stream (recovers on next user reattach).
2. **Backstop:** add global `uncaughtException` + `unhandledRejection` handlers
   that **log loudly and keep the process alive** (no silent swallow).

## Changes

### 1. `src/lib/server/agents/AgentRuntime.ts` — handle FIFO errors + re-stream

- In the **constructor**, after `this.fifo = new FifoStreamer(...)`, attach a
  persistent error listener (EventEmitter listeners survive `start()`/`stop()`):
  ```js
  this.fifo.on('error', (err) => { void this.handleFifoError(err); });
  ```
- Add a private `handleFifoError(err)` method that:
  - No-ops if `this.stopped` (we're already tearing down — `stop()` sets
    `stopped = true` before calling `fifo.stop()`, so destroy-time errors are
    ignored).
  - Uses a re-entrancy guard (`restreamInFlight`) and a cooldown timestamp
    (`lastRestreamAt`, `RESTREAM_COOLDOWN_MS = 10_000`) so a stream that errors
    again immediately after recovery can't spin a tight loop. If a re-stream
    happened within the cooldown, log and leave the stream stopped.
  - Logs the error: `console.error('[AgentRuntime] fifo stream error for <id>; attempting re-stream:', err)`.
  - Tears down the broken reader and old pipe-pane (best-effort):
    `await Tmux.stopPipePane(session).catch(() => {})` then `await this.fifo.stop()`.
  - Bails (leaves stopped) if the session is gone:
    `if (!(await Tmux.hasSession(this.agent.tmux_session))) return;`
    (reuses the existing `Tmux.hasSession`, already used by `reapAgent`).
  - Re-establishes the stream, mirroring `start()`:
    `await this.fifo.create(); this.fifo.start((c) => this.onChunk(c)); await Tmux.pipePane(session, this.fifo.path);`
  - Logs success/failure; never rethrows.

No change to `FifoStreamer.ts` — its re-emit contract is correct; the bug was
the missing listener on the owner.

### 2. `server.js` — global crash backstop

At the **top of `main()`, before `await bootstrap()`** (so it also covers
startup), register:
```js
process.on('uncaughtException', (err) => {
  console.error('[maw] uncaughtException (process kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[maw] unhandledRejection (process kept alive):', reason);
});
```
These don't interfere with the existing `main().catch(... process.exit(1))`
bootstrap-failure path (that promise is already handled, so it never becomes an
unhandled rejection). Logging follows the established `[maw] ...` prefix
convention (no shared logger util exists).

### 3. Tests

Follow existing Vitest patterns (`*.test.ts` colocated; `pnpm test`).

- **`src/lib/server/agents/AgentRuntime.test.ts`** (exists, uses `vi.hoisted`
  mocks for FifoStreamer + Tmux): add cases driving the mocked `FifoStreamer`
  (an EventEmitter) to `emit('error', new Error('EBADF'))`:
  - The test completing without an unhandled-error crash proves the listener
    exists.
  - When `Tmux.hasSession` resolves `true`: assert `fifo.stop`, `fifo.create`,
    `fifo.start`, and `Tmux.pipePane` are called again (re-stream attempted).
  - When `Tmux.hasSession` resolves `false`: assert no `fifo.create`/`pipePane`
    (stays stopped).
  - A second error within the cooldown does not trigger a second re-stream.
- Global handlers in `server.js` are process-level and awkward to unit-test;
  cover them via the manual verification below.

## Verification

1. `pnpm test` — new + existing AgentRuntime/FifoStreamer tests pass.
2. End-to-end repro of the original crash:
   - `pnpm build` then run the server (`UV_THREADPOOL_SIZE=64 node build/server.js`
     or via the systemd unit).
   - Spawn a claude-code agent; confirm live terminal streaming works.
   - Force the EBADF condition: restart the dedicated tmux server
     (`systemctl --user restart maw-tmux` or `tmux -L maw kill-server`).
   - Confirm in `journalctl --user -u maw`:
     - **No** process exit / `EBADF` uncaught crash.
     - A `[AgentRuntime] fifo stream error ... attempting re-stream` log followed
       by a success log, and the agent's terminal output resumes.
3. Smoke-test the backstop: confirm the two `[maw] ...kept alive...` handlers
   are registered (a deliberate throwaway `Promise.reject` in a scratch check
   logs instead of crashing). Remove the scratch check before commit.

## Housekeeping

After approval, `git mv` this plan to `docs/plans/fix-service-crash.md` to match
the branch/worktree name (per repo plan-naming convention), and on completion
`git mv` it to `docs/plans/done/`.
