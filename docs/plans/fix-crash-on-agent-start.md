# Fix crash on agent start — unsafe shell quoting in the tmux spawn line

## Context

Starting the `polyrepo-support` task (and any task whose CLI invocation
carries certain characters) fails immediately with:

```
spawnFailed: agent process exited immediately on launch — captured output:
sh: 1: Syntax error: end of file unexpected   Pane is dead (status 2)
```

The agent never gets off the ground: the `sh -lc` wrapper that tmux runs
exits with status 2 before the CLI is even exec'd, and the spawn-diagnostics
path (`AgentRuntime.verifyPaneAlive` → `Tmux.captureDeadPaneTail`) surfaces
the dead pane as `spawnFailed`.

A second symptom in the same report — a follow-on `401 "Please run /login"` —
is a **separate, already-fixed** concern (see §3); this plan confirms that and
does not change that code.

## Root cause

`Tmux.newSession` builds the shell line using `JSON.stringify` as if it were a
shell-quoting function. It is not.

`src/lib/server/tmux/TmuxSession.ts:106-110`:

```js
const envParts = Object.entries(opts.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
const cmdParts = [opts.command, ...opts.args].map((s) => JSON.stringify(s));
const shellLine = `cd ${JSON.stringify(opts.cwd)} && exec env ${envParts.join(' ')} ${cmdParts.join(' ')}`;
```

`JSON.stringify` wraps a value in **double quotes** and escapes only `"` and
`\`. But inside POSIX shell double-quotes, `$` and `` ` `` remain special, and
JSON never escapes them. So a value containing an unbalanced backtick or `` $( ``
opens a command substitution that is never closed → the shell hits end-of-input
inside the substitution → `Syntax error: end of file unexpected`.

For `polyrepo-support` the trigger is the **task body**: the claude-code adapter
(`cli-adapters/claude-code.jsonc`) delivers `{{task.body}}` as a positional CLI
arg (`initialInput.delivery: "cli-arg"`, `placement: "positional-last"`), so the
body's text flows verbatim into `cmdParts`. A task body that contains a shell
snippet, a markdown code span, or an example like `` `whoami` `` / `$(...)`
breaks the spawn line. Even-but-paired backticks would instead try to *execute*
the substitution (a different failure); an odd backtick or unclosed `$(` gives
the exact EOF error observed.

## Fix

Replace `JSON.stringify`-quoting with correct POSIX single-quote escaping in
`TmuxSession.ts`. Inside single quotes the shell treats every character
literally; the only thing that needs escaping is a single quote itself, via the
standard `'\''` idiom (close quote, escaped quote, reopen quote).

Add one small, exported, pure helper and use it everywhere a value is
interpolated into a shell string:

```js
/**
 * POSIX single-quote shell escaping. Everything inside '…' is literal;
 * an embedded ' is emitted as '\'' (close, escaped quote, reopen).
 * Safe for arbitrary bytes incl. $ ` " \ newlines.
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
```

Then in `newSession` (`TmuxSession.ts:106-110`):

```js
const envParts = Object.entries(opts.env).map(([k, v]) => `${k}=${shQuote(v)}`);
const cmdParts = [opts.command, ...opts.args].map(shQuote);
const shellLine = `cd ${shQuote(opts.cwd)} && exec env ${envParts.join(' ')} ${cmdParts.join(' ')}`;
```

Notes:

- **Env keys stay unquoted** — `env NAME=value` requires the `NAME` part bare,
  and keys are fixed identifiers (adapter config + the MAW_* / GIT_* vars merged
  in `AgentSupervisor`), so they're safe. Only the *value* is quoted.
- **Apply the same helper to `Tmux.pipePane`** (`TmuxSession.ts:148`), which
  currently does `cat >> ${JSON.stringify(fifoPath)}`. The fifo path is
  internally generated and low-risk, but routing it through `shQuote` keeps a
  single quoting strategy (DRY) and removes the last `JSON.stringify`-as-quote
  usage in the file.
- **No interaction with the pending exit-code work.** The separate plan
  `docs/plans/v0.3-spawn-shell-exit-stderr-capture.md` rewrites this same shell
  line to drop `exec` and append exit/stderr sidecar capture. This fix is
  orthogonal (it changes *how values are quoted*, not the line's structure) and
  composes cleanly with that future change — both should use `shQuote`.

## §3 — 401 "Please run /login" (verify only, no code change)

The empty-`ANTHROPIC_API_KEY` 401 regression is already guarded on this branch
by commit `32b36ed`:

- `src/lib/server/agents/adapters/ConfigDrivenAdapter.ts:194-201` drops any
  `spawn.env` entry whose substituted value is `''`, so `ANTHROPIC_API_KEY=""`
  is **never** shipped to tmux when MAW has no key configured.
- `src/lib/server/agents/claudeConfigDir.ts:69-73,108-125` symlinks the user's
  `~/.claude/.credentials.json` into each agent's `CLAUDE_CONFIG_DIR`, so the
  CLI falls back to OAuth and shares refreshed tokens across agents.
- `ConfigDrivenAdapter.test.ts` already covers both the empty (omitted) and
  non-empty (passed-through) cases.

The 401 in the report was almost certainly **expired OAuth credentials**, which
the user resolved in-session via `/login` ("Login successful"). The fix below
does not reintroduce the empty-key path — after `shQuote`, any value that *did*
slip through empty would render as `KEY=''`, exactly the case the adapter
filtering already prevents. Verification step 5 re-confirms this guard.

## Critical files

- `src/lib/server/tmux/TmuxSession.ts` — add exported `shQuote`; replace the
  three `JSON.stringify` interpolations in `newSession` (lines 106-110) and the
  one in `pipePane` (line 148).
- `src/lib/server/tmux/TmuxSession.test.ts` — update the existing assertions
  (lines 88-91 currently expect double-quoted `"/some/cwd"`, `FOO="bar"`,
  `"bash" "-lc" "echo hi"`) to the single-quoted forms, and add the adversarial
  regression tests below.

## Verification

1. **Rename the plan file** to match the branch/worktree per repo convention:
   `git mv docs/plans/the-following-happens-on-wondrous-waterfall.md docs/plans/fix-crash-on-agent-start.md`.
2. **Unit — escaping shape:** assert the new shell line uses single quotes:
   `cd '/some/cwd'`, `FOO='bar'`, `QUOTED='a b'`, `'bash' '-lc' 'echo hi'`.
3. **Unit — adversarial regression (the actual bug):** call `Tmux.newSession`
   with an arg/env value containing the metacharacters that broke it —
   `` echo `whoami` ``, `$(rm -rf /)`, `it's a "test"`, and an embedded newline.
   Assert each renders as a single-quoted token (`` 'echo `whoami`' ``,
   `'$(rm -rf /)'`, `'it'\''s a "test"'`). Add a direct unit test for `shQuote`
   covering the empty string and a lone `'`.
4. **Unit — real `sh` syntax check:** in a test that does *not* mock execa,
   build the line for a hostile body and run `sh -n -c <shellLine>` (parse-only,
   no execution); it must exit 0 (no `Syntax error`). This proves syntactic
   validity for arbitrary input rather than asserting a specific escaping.
5. **Unit — 401 guard still holds:** confirm the existing
   `ConfigDrivenAdapter.test.ts` empty-`ANTHROPIC_API_KEY` test passes (value
   omitted, not emitted as `KEY=''`).
6. **Suite:** `pnpm test` (or the project's vitest invocation) green.
7. **E2E — reproduce + confirm fix:** create a task whose body contains a
   backtick/`$(...)` snippet (mirrors `polyrepo-support`) and spawn a
   claude-code agent. Before the fix this dies with `Syntax error: end of file
   unexpected`; after, the agent starts, the pane is live, and the body reaches
   the CLI intact. Spot-check `tmux -L maw capture-pane` shows the CLI running.
