# task-defaults — smarter defaults for new tasks & spawns

## Context

Today, creating a new queue task from `/queue?repo=<id>` ignores the sidebar's
selected repo — the dropdown defaults to `repos[0]` regardless of which repo
the user just clicked to filter the list. The spawn form's branch picker
already defaults to the repo's checked-out branch (`pickBranch` → `cached.current`)
and `permission_mode` already defaults to `plan` for `claude-code` and
`gemini` adapters. The remaining gaps:

1. **Repo** isn't pre-selected from the sidebar context on `/queue`.
2. **Model** defaults to the adapter's hard-coded `default` value
   (`"default"` for claude-code = "let claude pick"). There's no per-user
   way to declare a preferred model.
3. Only `claude-code` ships a real model list; `gemini` has one stub
   (`default`) and `codex` has no `capabilities` block at all.

This plan plumbs through the user's intent so that:
- on `/queue?repo=<id>`, the create-task dialog pre-selects that repo;
- each cli-adapter advertises a real list of selectable models;
- the user can set a preferred default model per cli-kind in
  Settings → Agent defaults, which the spawn form honors as a new
  fallback layer (below role overrides, above adapter defaults).

The active-branch default and Plan permission mode are already in place;
this plan validates them rather than re-implementing them.

## Approach

### 1. Repo: take the sidebar's selected repo on `/queue`

`src/routes/queue/+page.svelte` already derives `repoFilter` from
`?repo=`. Pass it through to the create modal:

```svelte
<SpawnAgentForm
  …
  defaultRepoId={repoFilter}
  …
/>
```

The edit modal already pre-fills `repo_id` from the existing entry via
`initialValues.repoId`, so it stays untouched.

The dashboard (`/`) and `/agents/new` have no sidebar repo context, so
they keep their current behavior (falling back to `repos[0]`). `/repos/[id]`
already passes `defaultRepoId={data.repo.id}`.

### 2. Branch: take the active checked-out branch — verify only

`SpawnAgentForm.pickBranch` already returns `cached.current ?? cached.branches[0]`.
The `/api/repos/[id]/branches` endpoint reports `current` from `git
symbolic-ref` (HEAD), so the active branch is already pre-selected. No
code change here — just a verification step in the test plan.

### 3. Model: per-cli-kind selectable lists + per-user defaultModel

**3a. Expand model lists in adapter JSONCs** (cli-adapters/*.jsonc):

- `claude-code.jsonc`: already has `default | opus | sonnet | haiku`. No
  change to the value list; the `default` field stays `"default"`
  (the user-level setting now drives the recommended pick).
- `gemini.jsonc`: extend `capabilities.model.values` with the real
  current model ids the Gemini CLI accepts (`gemini-2.5-pro`,
  `gemini-2.5-flash`, plus the existing `default` "let gemini pick"
  entry). Document the source comment-style at the top of the block.
- `codex.jsonc`: add a new `capabilities.model` block mirroring
  claude-code's shape with the model ids Codex CLI's `--model` accepts
  (`default`, `gpt-5-codex` and any siblings). Mark as TODO-tune
  against a real install if the exact set isn't verifiable from
  source.

Codex also gets `capabilities.permissionMode` with at minimum a `plan`
entry if its CLI supports an equivalent mode; otherwise the block is
omitted (keeps the picker hidden).

**3b. Add per-user `defaultModel` to spawn defaults**

The existing pattern in `src/lib/server/db/queries.ts` stores spawn
defaults as
`user_settings` key `spawn.defaults.<cli_kind>` with body
`{ optionalArgs: Record<string, boolean> }`. Extend the body shape:

```ts
interface SpawnDefaultsBody {
  optionalArgs: Record<string, boolean>;
  defaultModel?: string | null;          // new — capability value id
  defaultPermissionMode?: string | null; // new — capability value id (optional)
}
```

(`defaultPermissionMode` added in the same pass so the UI is symmetric
with model; the role-level `default_permission_mode` already shadows it
when set.)

Touch points:

- `src/lib/server/db/queries.ts`
  - `getSpawnDefaults` → return the new optional fields. Default
    `defaultModel: null` on parse miss so existing rows are forward-compat.
  - `getSpawnDefaultsAll` → type updates flow through.
- `src/lib/client/components/SpawnAgentForm.svelte`
  - `SpawnDefaults` type adds the two optional fields.
  - The capabilities effect (lines ~358–385) gains a new fallback step
    between the role default and the adapter default:
    1. role default (per-role explicit choice — unchanged)
    2. **user spawn-default** (`spawnDefaults[cli_kind].defaultModel`,
       only if listed in `modelCap.values`) — new
    3. adapter `capabilities.model.default` — unchanged
    4. `modelCap.values[0].id` — unchanged
  - Same precedence ladder for `defaultPermissionMode`.
- `src/routes/api/user/spawn-defaults/+server.ts`
  - Accept `defaultModel?: string | null` and
    `defaultPermissionMode?: string | null` in the PUT body. Validate
    that, when non-null, the value exists in the adapter's capability
    `values` list. Reject invalid combinations with 400.
- `src/routes/settings/+page.svelte`
  - Per cli-kind block: render `<select>` for `defaultModel` (and
    `defaultPermissionMode` when the adapter exposes one). Wire to a
    new `saveSpawnCapDefault(cliKind, key, value)` that PUTs the full
    `spawn.defaults.<cliKind>` body (optionalArgs + new fields) so the
    server stays the single source of truth.
  - Existing `saveSpawnDefault` becomes a thin wrapper that calls the
    same combined save with the updated `optionalArgs`.
- i18n strings: add labels under `settings.*` for the new dropdowns.

### 4. Permission mode: Plan default — verify only

`claude-code.jsonc` (`"default": "plan"`) and `gemini.jsonc`
(`"default": "plan"`) already match. `codex.jsonc` gains a
`permissionMode` block in step 3a only if Codex CLI has an equivalent
mode; otherwise the picker stays hidden (consistent with today).

## Files to modify

- `cli-adapters/gemini.jsonc` — expand `capabilities.model.values`.
- `cli-adapters/codex.jsonc` — add `capabilities.model` (and optional
  `permissionMode`).
- `src/lib/server/db/queries.ts` — broaden `SpawnDefaultsBody` parse
  shape; add forward-compat defaults.
- `src/routes/api/user/spawn-defaults/+server.ts` — accept + validate
  new fields, store the full combined body.
- `src/routes/settings/+page.svelte` — per cli-kind `defaultModel` and
  (optional) `defaultPermissionMode` dropdowns; refactor save helper.
- `src/lib/client/components/SpawnAgentForm.svelte` — extend
  `SpawnDefaults` type; new precedence layer in the capability effect.
- `src/routes/queue/+page.svelte` — pass `defaultRepoId={repoFilter}`
  to the create modal's `SpawnAgentForm`.
- `src/lib/i18n/*.json` — labels for the new settings controls.

## Critical existing utilities to reuse

- `pickBranch` (`src/lib/client/components/SpawnAgentForm.svelte:286`)
  — already covers requirement 2.
- `getSpawnDefaults` / `setUserSetting`
  (`src/lib/server/db/queries.ts:1102–1133`) — extend in place; no new
  storage layer.
- `sanitizeCapabilityValue`
  (`src/lib/server/agents/adapters/capabilityValidation.ts`) — reuse on
  the spawn-defaults PUT to validate the chosen model id against the
  loaded adapter's capability values, so a stale value in storage can't
  poison the spawn form.
- `AdapterRegistry.list()`
  (`src/lib/server/agents/adapters/AdapterRegistry.ts:135`) — already
  exposes `capabilities.model.values`; consumers don't need a new shape.

## Verification

- **Unit / component**
  - Extend `src/lib/client/components/SpawnAgentForm.svelte.test.ts`
    with a case: `spawnDefaults['claude-code'].defaultModel = 'opus'`
    + no `initialValues` + no role default → `<select name="model">`
    mounts with `opus`. Mirror with `defaultPermissionMode`.
  - Extend the spawn-defaults server test (or add one) covering the
    new PUT body: invalid `defaultModel` (not in adapter values) →
    400; valid round-trips via `getSpawnDefaults`.
- **Integration**
  - In `/queue?repo=<id>`, click "+", observe the Repo dropdown opens
    on that repo; saving still routes to `/api/queue` correctly.
  - In Settings → Agent defaults, pick a `defaultModel` per cli-kind;
    reload; new dashboard "+" modal pre-selects that model.
- **Manual smoke**
  - Verify `claude-code` adapter still loads (no JSONC schema break).
  - Verify `gemini` + `codex` adapters load and their new model lists
    populate the spawn-form dropdown.
  - On a clean account (no user setting), verify Plan permission mode
    is still pre-selected for `claude-code` and `gemini`.

## Out of scope (report-only)

- The dashboard spawn modal has no sidebar repo context — leaving as-is
  per the original requirements. If we later want a "last-used repo"
  default there, it'd be a separate `last.repo` user setting.
- Codex's exact accepted model ids should be tuned against a real install
  before shipping; the JSONC values added here are a starting point
  flagged TODO in a comment.
