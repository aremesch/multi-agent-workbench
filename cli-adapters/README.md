# CLI Adapters

Each `*.jsonc` file in this directory describes how MAW drives one
coding-agent CLI inside a tmux pane: how to spawn it, how to send input,
how to recognise prompts/ready/errors in its output, and how to rebuild
its terminal view on reconnect. Files are hot-reloaded at runtime by
`AdapterRegistry` and consumed by `ConfigDrivenAdapter`.

The source of truth for validation is the Zod schema at
`src/lib/server/agents/adapters/adapter.config.schema.ts`. The JSON
Schema at `schemas/adapter.schema.json` exists only for editor
autocomplete — keep both in sync when adding fields.

## File layout

```jsonc
{
  "$schema": "../schemas/adapter.schema.json",
  "kind": "...",
  "displayName": "...",
  "scrollbackMode": "visible",
  "historySource": { "kind": "claude-jsonl" },
  "spawn":         { ... },
  "input":         { ... },
  "patterns":      [ ... ],
  "idleDetection": { ... },
  "defaults":      { ... }
}
```

## Top-level fields

| Field | Required | Type | Notes |
|---|---|---|---|
| `$schema` | no | string | Editor autocomplete only. Always `"../schemas/adapter.schema.json"`. |
| `kind` | **yes** | string | Stable adapter key (e.g. `claude-code`). Must be unique across the directory. Persisted on agent rows and referenced in UI code. |
| `displayName` | **yes** | string | Human-readable label shown in the spawn form. |
| `scrollbackMode` | no | `"visible"` \| `"history"` | How the hub captures the reconnect snapshot. **Default `"visible"`.** Use `"visible"` for TUI CLIs that repaint the whole pane (Claude Code, Codex, Gemini) — `capture-pane -S 0` only. Use `"history"` for line-based CLIs/REPLs — `capture-pane -S -500` piped through `collapseRepeatingTailBlocks`. |
| `historySource` | no | object | Out-of-band structured transcript reader used *in addition* to the live capture. Currently only `{ "kind": "claude-jsonl" }` is supported — it reads `~/.claude/projects/<encoded-cwd>/<cli_session_id>.jsonl` and ships it as a `history_snapshot` WS frame ahead of the live scrollback. Pair with `scrollbackMode: "visible"` to recover the pre-scroll history the visible capture drops. |
| `mobileQuickKeys` | no | array | On-screen key-chord buttons rendered under xterm on touch devices (or when the user forces them on via `/settings`). Soft keyboards don't expose arrow keys / Esc / Shift+Tab / Ctrl+C — each adapter declares the ones its CLI needs. See [mobileQuickKeys](#mobilequickkeys). Default `[]` (adapter opts out). |
| `spawn` | **yes** | object | How to launch the CLI. See below. |
| `input` | **yes** | object | How the hub sends keystrokes via `tmux send-keys`. See below. |
| `patterns` | no | array | Regex matchers applied to streaming output to drive the state machine and emit events. |
| `idleDetection` | no | object | How the hub decides the agent is idle (for status indicators / alerts). |
| `defaults` | no | object | Adapter-level defaults such as auto-answered prompts. |

## `spawn`

| Field | Required | Type | Notes |
|---|---|---|---|
| `command` | **yes** | string | Executable name or path. Resolved via `PATH` inside the tmux session. |
| `args` | no | string[] | Positional args passed verbatim after template substitution (see below). Default `[]`. |
| `optionalArgs` | no | object[] | User-toggleable flags, merged at spawn time based on saved user settings. Each entry: `id` (stable key in settings), `flag` (the actual CLI flag), `label`, optional `description`, optional `default` (boolean, default `false`). |
| `env` | no | object<string,string> | Extra env vars. Values are template-substituted, so `"{{env.ANTHROPIC_API_KEY}}"` forwards the parent env var. Default `{}`. |
| `initialInput` | no | string | Text typed into the CLI on first ready. Usually `"{{task.body}}"`. |

### Template variables

Both `spawn.args`, `spawn.env` values and `spawn.initialInput` support
`{{name}}` substitution. Available names:

- `worktree` — absolute path of the agent's worktree (`cwd`).
- `agent.id` — MAW agent row id.
- `agent.cliSessionId` — UUID minted at spawn. For `claude-code`, pass
  this as `--session-id` so the JSONL transcript path is deterministic.
- `role.systemPrompt` — role prompt text.
- `role.toolConfig` — role tool config as JSON.
- `task.title` / `task.body` — task fields, empty string if no task.
- `env.<NAME>` — value of env var `<NAME>` from the spawn env (e.g.
  `{{env.ANTHROPIC_API_KEY}}`).

Missing keys substitute to the empty string. Substitution is
string-replace only — no expressions.

## `input`

| Field | Type | Notes |
|---|---|---|
| `encoding` | `"literal"` | Only mode today: `tmux send-keys -l` sends bytes verbatim. |
| `submitKey` | string | tmux key name appended after literal input (default `"Enter"`). |
| `promptAnswers` | object<string,string[]> | Named answer sequences. Keys are referenced by `patterns[].choices` (e.g. `"yes": ["y", "Enter"]`, `"abort": ["C-c"]`). Each entry is a list of tmux key names sent in order. |

## `patterns`

Array of regex matchers applied to the tail of the output stream after
each PTY read. Last-matching `kind` wins for the state machine.

| Field | Required | Type | Notes |
|---|---|---|---|
| `id` | **yes** | string | Stable identifier (referenced by `defaults.autoAnswer.patternId`). |
| `kind` | **yes** | enum | One of `ready`, `working`, `prompt_detected`, `task_done`, `error`, `exited`. Drives the agent state machine and downstream alerts. |
| `regex` | **yes** | string | JS regex source. Named capture groups (`(?<tool>...)`) become event fields. |
| `flags` | no | string | Regex flags (e.g. `"i"`, `"m"`). |
| `scope` | no | `"tail"` \| `"tail_line"` | What slice to match against. `tail` = recent byte buffer; `tail_line` = just the last line. Default `"tail"`. |
| `choices` | no | string[] | For `prompt_detected`: names from `input.promptAnswers` that the UI (and `defaults.autoAnswer`) can send. |
| `severity` | no | enum | `info` \| `warning` \| `error` \| `critical`. Feeds alert/push-notification priority. |
| `description` | no | string | Human-readable hint for the UI and docs. |

## `mobileQuickKeys`

Array of key-chord buttons rendered below xterm on touch devices. Each
button fires its `keys` bytes through the same `send_keys` WS path as
xterm's own keystrokes — no special server support required. Values are
raw UTF-8; use JSON escapes for control bytes (`\u001b[A` for cursor
up, `\u0003` for Ctrl+C, `\t` for Tab).

| Field | Required | Type | Notes |
|---|---|---|---|
| `id` | **yes** | string | Stable id, unique within this adapter. Lowercase kebab (`/^[a-z0-9-]+$/`). |
| `label` | **yes** | string | Short on-button text. Unicode glyphs welcome (`↑`, `⇧⇥`, `^C`). |
| `keys` | **yes** | string | Raw UTF-8 bytes to send. VT sequences and control bytes both work. |

Example — `claude-code.jsonc`:

```jsonc
"mobileQuickKeys": [
  { "id": "up",        "label": "↑",   "keys": "\u001b[A" },
  { "id": "down",      "label": "↓",   "keys": "\u001b[B" },
  { "id": "shift-tab", "label": "⇧⇥", "keys": "\u001b[Z" },
  { "id": "esc",       "label": "Esc", "keys": "\u001b"   }
]
```

Visibility is a joint decision between the adapter (declares the keys)
and the user (`ui.mobileQuickKeys` in `/settings` — `auto` / `always` /
`never`). `auto` (default) shows the bar on any touch device
(`matchMedia('(pointer: coarse)')`).

## `idleDetection`

| Field | Type | Notes |
|---|---|---|
| `method` | `"cursor_at_prompt"` \| `"inactivity"` | `cursor_at_prompt` matches `promptLineRegex` against the cursor line; `inactivity` flips idle after `inactivityMs` of silence. Default `"inactivity"`. |
| `promptLineRegex` | string | Required for `cursor_at_prompt`. |
| `inactivityMs` | number | Positive integer ms. Default `2000`. |

## `defaults`

| Field | Type | Notes |
|---|---|---|
| `autoAnswer` | object[] | Auto-reply to specific prompts without user confirmation. Each entry: `patternId` (must match a `patterns[].id`), optional `when` (map of capture-group name → required value for the rule to fire), `answer` (a key from `input.promptAnswers`). Use sparingly — it bypasses the push-notification approval flow. |

## Adding a new adapter

1. **Copy a close sibling.** `shell.jsonc` for line-based CLIs,
   `claude-code.jsonc` for full TUI CLIs. Save as `<kind>.jsonc`;
   pick a unique `kind` (also update any hard-coded references in
   the UI if your adapter is to be user-selectable).
2. **Set the spawn spec.** Point `command` at the binary; forward
   any secrets via `env` with `{{env.FOO}}`; wire the task prompt
   via `initialInput: "{{task.body}}"` if the CLI accepts text on
   stdin; expose user toggles via `optionalArgs`.
3. **Pick `scrollbackMode`.** TUI/ink-style CLI that repaints →
   `"visible"`. Line-based REPL/shell → `"history"`. If in doubt,
   leave it at the default `"visible"` and iterate.
4. **Pick `historySource`** (optional). Only `claude-jsonl` exists
   today. Add it if the CLI writes a compatible JSONL transcript
   and you set `scrollbackMode: "visible"`.
5. **Define `input.promptAnswers`.** Map human-meaningful names
   (`yes`, `no`, `1`, `abort`, …) to the exact tmux key sequences
   the CLI expects. `promptAnswers` values feed both `patterns[].choices`
   and `defaults.autoAnswer`.
6. **Write `patterns`.** Start with `ready` (prompt is back, agent
   idle) and whatever `prompt_detected` lines the CLI shows when it
   wants permission. Add `task_done` and `error` as you discover
   real lines. Use named capture groups to surface data to the UI.
7. **Pick `idleDetection`.** If the CLI shows a recognisable prompt
   line, use `cursor_at_prompt` with a tight regex — this is more
   accurate than time-based inactivity. Otherwise use `inactivity`.
8. **Tune against a real session.** Run the CLI manually, copy the
   raw bytes to a file, then iterate patterns with
   `pnpm test:adapter cli-adapters/<kind>.jsonc <session.txt>`.
   The registry hot-reloads, so no restart needed while you tweak.
9. **Validate end-to-end.** `pnpm check` for typing, then spawn an
   agent of this kind from the UI and exercise reconnect (close the
   modal, reopen it) and prompt-handling (let it ask for permission,
   answer from the UI).
10. **Do not** mirror schema changes only in `adapter.schema.json`.
    If your adapter needs a new field, add it to the Zod schema
    *first* (`adapter.config.schema.ts`) — that's the validator — and
    then update `adapter.schema.json` for editor autocomplete.
