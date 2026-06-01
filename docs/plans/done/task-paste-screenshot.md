# Paste & drop image attachments in the new-task dialog

## Context

The running-agent dialog (`AgentTerminalPanel.svelte`) lets the user paste a
screenshot from the clipboard or drop an image file onto the modal; the
image is uploaded to the agent's worktree and the resulting `@<rel>`
reference is typed straight into the prompt via the `send_keys` WebSocket
channel. This is the "same mechanism" the user is asking for.

The new-task dialog (`SpawnAgentForm.svelte`, queue mode) already has the
"Bild hinzufügen…" file-picker button and a removable chip list backed by
`pendingFiles: File[]`. What it is missing is paste and drag-and-drop:
today the only way to attach an image is the file picker.

This change wires paste and drop into the existing `addFiles()` /
`pendingFiles` pipeline, so the chip list, removal, server upload
(`POST /api/queue/{id}/attachments`), staging
(`stageTaskAttachment`) and the spawn-time injection of
`Attached files: @.maw/uploads/…` into the agent's initial prompt
(`performSpawn` → `materializeIntoWorktree`) all work unchanged.
No server endpoints, payload shapes, or staging logic need to change —
the new code paths terminate inside the existing `addFiles()`.

## Approach

Modify only `SpawnAgentForm.svelte`. Five small additions, all in the
queue-mode attachments block (already gated by `attachmentsEnabled`):

1. **Paste handler.** Bind `onpastecapture` on the `<form>` element.
   Iterate `event.clipboardData.items`, take items where
   `kind === 'file'` and `type.startsWith('image/')`, call
   `getAsFile()`, rewrap with a friendlier name
   (`pasted-<Date.now()>.<ext>`) using
   `new File([blob], renamed, { type: blob.type })`, then call the
   existing `addFiles([file])`. Only call `preventDefault()` /
   `stopPropagation()` on the image branch — plain-text pastes into
   the title or body fields must still flow through untouched.
   Gate the whole handler on `attachmentsEnabled` so the spawn-mode
   and browser-target variants of the form are unaffected.

2. **Drag-and-drop handlers.** Mirror `AgentTerminalPanel`'s pattern
   (`onDragEnter`/`onDragOver`/`onDragLeave`/`onDrop` with a `dragDepth`
   counter and a derived `dragActive`). Attach them to the form root.
   `onDragOver` must `preventDefault()` so the drop event actually
   fires and the browser doesn't navigate to the dropped file. The
   `onDrop` handler filters `dataTransfer.files` for `image/*`, then
   feeds them through `addFiles()` — same path as paste. No rename on
   drop (real files already have meaningful names).

3. **Drop overlay.** When `dragActive && attachmentsEnabled`, render
   a translucent overlay over the form (similar to
   `AgentTerminalPanel`'s `.drop-overlay`) with the existing
   `agentTerminal.image.dropOverlay` translation, or a new
   `queueAttachments.dropOverlay` key if we want the wording to read
   "Bild ablegen, um es an die Aufgabe anzuhängen" (preferred for
   clarity — see i18n note below). Position the form root
   `position: relative` so the overlay anchors correctly. Pointer
   events on the overlay are disabled so drop still fires through it.

4. **Validation reuse.** Do **not** duplicate MIME/size/count checks —
   `addFiles()` already enforces `ATTACH_MIMES`, `ATTACH_MAX_BYTES`,
   `ATTACH_MAX_COUNT` and writes the relevant
   `queueAttachments.error.*` message into `attachError`, which is
   already rendered under the chip list. Paste and drop inherit this
   for free.

5. **i18n.** Add one new key in both
   `src/lib/i18n/en.ts` and `src/lib/i18n/de.ts`:
   - `queueAttachments.dropOverlay` — EN: "Drop image to attach to
     task" / DE: "Bild ablegen, um es an die Aufgabe anzuhängen".
   If you'd rather avoid the new key, the existing
   `agentTerminal.image.dropOverlay` ("Bild hier ablegen") is
   acceptable but less specific.

Out of scope: no changes to the spawn-mode form path, no changes to
`AgentTerminalPanel`, no server-side changes, no new endpoints, no
DB migration.

## Critical files

- `src/lib/client/components/SpawnAgentForm.svelte` — the only file
  with code changes. Touch points:
  - Script: add `dragDepth` state, `dragActive` derived, `onPaste`,
    `onDragEnter`/`Over`/`Leave`/`Drop`, and a small helper
    `renamePastedImage(file)`. All live next to the existing
    `addFiles()` / `pendingFiles` block (around lines 438–519).
  - Markup: add `onpastecapture` / `ondragenter` / `ondragover` /
    `ondragleave` / `ondrop` to the `<form>` element (around
    line 699). Add the `{#if attachmentsEnabled && dragActive}` overlay
    block as the first child of the form (or of `.wrap`).
  - Styles: a `.drop-overlay` rule mirroring the one in
    `AgentTerminalPanel.svelte` (lines 487-ish). The form's `<div
    class="wrap">` may need `position: relative` if the overlay is a
    child of it.
- `src/lib/i18n/en.ts`, `src/lib/i18n/de.ts` — one new key each
  (`queueAttachments.dropOverlay`). Insert alphabetically inside the
  existing `queueAttachments.*` block (en.ts ~line 517, de.ts ~line
  477).

Reused as-is (no edits, just call sites):

- `addFiles()` — validation + push to `pendingFiles`
  (`SpawnAgentForm.svelte:475`).
- `removePending()` / `removeExisting()` — chip removal already works
  for paste/drop additions (`SpawnAgentForm.svelte:501`).
- `attachmentsArg()` and the parent `onQueue` flow — pending files
  flow into `commitAttachments` in
  `src/routes/queue/+page.svelte:200` and onward to
  `POST /api/queue/{id}/attachments`.
- `stageTaskAttachment` / `materializeIntoWorktree` /
  `performSpawn` — server staging and spawn-time injection of
  `@<rel>` paths into the initial prompt are unchanged.

## Verification

Manual UI checks (run the app with the project's standard dev script):

1. Open the "new task" dialog for a coding-CLI role (e.g. claude-code)
   on a repo that supports worktrees.
2. **Paste path.** Copy a screenshot (OS snipping tool or
   Cmd/Ctrl+Shift+S in a browser) and press Ctrl/Cmd+V while focused
   in the dialog. Expect a chip to appear with a thumbnail named
   `pasted-<timestamp>.png`, identical in layout to a chip added via
   "Bild hinzufügen…". Paste a second screenshot — second chip
   appears with a different filename.
3. **Removal.** Click the × on a pasted chip. It disappears, exactly
   like a picker-added chip.
4. **Plain-text paste.** Focus the title field, paste text from
   clipboard — text is inserted normally (no chip is created,
   `preventDefault` did not fire).
5. **Drop path.** Drag an image file from the OS file manager onto
   the dialog. Overlay appears while dragging. On drop, chip is
   added. Dropping a non-image file is silently ignored (matches
   `AgentTerminalPanel`).
6. **Validation reuse.** Paste a >5 MB image → red error message
   under the chip list (`queueAttachments.error.size`). Paste an
   11th image when 10 are already attached → tooMany error.
7. **End-to-end CLI delivery.** With one chip attached, click "Run"
   (or save + promote). When the agent spawns, check the initial
   prompt the CLI receives includes the
   `Attached files:\n@.maw/uploads/<file>` block, and that the
   referenced file exists in the worktree's `.maw/uploads/`. This
   is the existing behaviour; the change only adds new ways to
   populate `pendingFiles`.
8. **Edit-mode parity.** Open an existing queued task with
   attachments, paste a new image, save. The new image should be
   uploaded via `POST /api/queue/{id}/attachments` exactly as a
   picker-added one would be — confirm with browser devtools
   network tab.

Type-check and lint after the change:

- `pnpm check` (svelte-check)
- `pnpm lint` if the project has one (skip if not configured)
