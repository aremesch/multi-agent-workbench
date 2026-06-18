# Fix: start-project spawn fails for long prompts ("command too long")

## Context

The **start-project** task for the **dossier** repo never starts. The queue
entry (`01KVCNC77R71ESJ623P9JYSGA1`) is stuck `blocked` with:

```
spawnFailed: Command failed with exit code 1: tmux -L maw new-session -d -s … sh -lc 'cd …/dossier && exec env … claude … --permission-mode plan 'Ich möchte …''
…
command too long
```

### Root cause

`Tmux.newSession` (`src/lib/server/tmux/TmuxSession.ts:135-168`) builds the whole
spawn as one shell string —

```
cd <cwd> && exec env VAR=val … 'claude' '--session-id' … '<PROMPT>'
```

— and hands it to `tmux new-session … sh -lc <shellLine>` as a **command-line
argument**. tmux's client serializes that argv into a single `imsg` to the tmux
server, and `imsg` payloads are capped at ~16 KB. When the argument crosses that
limit tmux's client refuses with `command too long` and exits 1, before `claude`
is ever exec'd.

For dossier the initial prompt is `taskBody` **plus the entire plan markdown**
(`composeBodyWithPlan`, `spawnFromInputs.ts:81`/`:256`), which is ~16 KB on its
own — so the assembled command blows the limit. Ordinary short prompts stay
under it, which is why only large start-project prompts fail. The failure is in
the transport layer (tmux argv length), not in the prompt, the adapter, or the
worktree.

`spawnFailed` is a **soft** error (`Scheduler.ts:625`), so the entry is parked at
`blocked` and the scheduler keeps retrying it — meaning the moment the transport
is fixed, the existing dossier entry will spawn on its own.

## Approach

Stop putting the long shell line on tmux's command line. Write it to a private,
self-deleting temp script and launch that instead:

```
tmux … new-session -d -s <session> -x C -y R sh -l <scriptPath>
```

The script file carries the full `env … command args` (including the giant
prompt), so tmux's argv stays tiny and the `imsg` limit is never approached.
This is a single surgical change at the one chokepoint every adapter funnels
through, so it fixes long prompts for **all** CLI kinds without touching the
adapter schema, the `cli-arg` delivery contract, or `composeBodyWithPlan`.

Apply it **unconditionally** (not only above a size threshold) so the dossier
path and the everyday path run identical, well-exercised code — no rarely-hit
branch guarding the exact case that just broke.

### Change — `src/lib/server/tmux/TmuxSession.ts` (`newSession`)

- Keep building `shellLine` exactly as today (same `shQuote` escaping, same
  `cd … && exec env …` shape — preserves the careful quoting/`exec` semantics).
- Write the script body to a unique path keyed by the session name (collision-free,
  since the session name embeds the agent ULID), e.g.
  `join(os.tmpdir(), `maw-spawn-${opts.session}.sh`)`, mode `0o700`:

  ```sh
  #!/bin/sh
  rm -f -- "$0"
  <shellLine>
  ```

  `rm -f -- "$0"` self-deletes the script as its first action; POSIX keeps the
  already-open script fd readable after unlink, so `sh` still executes the
  following `exec env …` line. No reaper needed and nothing leaks on the happy
  path.
- Replace the `'sh','-lc',shellLine` tail of the tmux argv with `'sh','-l',scriptPath`
  (`-l` preserves the current login-shell behavior).
- Wrap the `execa` call so that if tmux itself fails, we best-effort
  `fs.unlink(scriptPath)` before rethrowing (covers the only leak case — sh never
  ran to self-delete).
- Add the imports: `writeFile`/`unlink` from `node:fs/promises`, `join` from
  `node:path`, `tmpdir` from `node:os`.

No change to callers — `launchCliRuntime` (`AgentSupervisor.ts:788`) keeps calling
`Tmux.newSession` unchanged.

### Tests — `src/lib/server/tmux/TmuxSession.test.ts`

The `Tmux.newSession` suite (around lines 97-168) currently asserts the tmux argv
ends in `'-lc'` and that the shell string contains `'bash' '-lc' 'echo hi'`. Update it to the
script-file shape:

- Assert the tmux argv tail is `sh -l <path>` and `<path>` is under `os.tmpdir()`
  and contains the session name.
- Read back the written script (mock or spy on `fs/promises.writeFile`, or write
  to a real temp dir) and assert it starts with `rm -f -- "$0"` and contains the
  fully-quoted `exec env … 'bash' '-lc' 'echo hi'` line.
- Add a regression test: a multi-KB prompt (e.g. 64 KB) produces a **short** tmux
  argv (the long content lives only in the script file) — this is the assertion
  that would have caught the bug.
- Add a cleanup test: when `execa` rejects, `newSession` unlinks the script and
  rethrows.

## Recovering the wedged dossier task

The code fix removes the cause; the existing blocked entry then needs a clean
slate to retry into:

1. The prior spawn left agent `01KVD71ECKJCRYCVJ7HXF3CCTT` stranded at status
   `spawning` with no tmux session. Archive it via the (already-resilient,
   PR #9) kill path — `POST /api/agents/01KVD71ECKJCRYCVJ7HXF3CCTT/stop` (or
   delete) — so it stops counting against the repo's concurrency cap. A server
   restart's reattach sweep should also reconcile it (no live session → archived).
2. With the zombie cleared and the fix deployed, the scheduler re-promotes the
   `blocked` entry `01KVCNC77R71ESJ623P9JYSGA1` and spawns it normally.

## Verification

1. `pnpm test src/lib/server/tmux/TmuxSession.test.ts` — unit coverage for the
   new script-file path, the long-prompt regression, and failure cleanup.
2. `pnpm test` (or at least the agents/queue suites) — confirm no regression in
   `AgentSupervisor` / spawn / reattach behavior.
3. End-to-end against the live install (`~/maw`), after build + restart:
   - Archive the stranded `spawning` agent (step 1 above).
   - Watch the dossier entry: it should move `blocked → ready → running`, a
     `maw-agent-…` tmux session should appear (`tmux -L maw ls`), and `claude`
     should come up in the dossier worktree with the full German prompt
     pre-filled in plan mode.
   - Confirm `queue_entries.last_error` for `01KVCNC77R71ESJ623P9JYSGA1` clears
     and `agent_id` links to the new running agent.
   - Sanity-check a normal short-prompt spawn still works (no behavior change for
     the common case) and that `/tmp/maw-spawn-*.sh` does not accumulate.

## Files

- `src/lib/server/tmux/TmuxSession.ts` — `newSession`: write+run self-deleting
  script instead of `sh -lc <shellLine>` (the fix).
- `src/lib/server/tmux/TmuxSession.test.ts` — update/extend `newSession` tests.
