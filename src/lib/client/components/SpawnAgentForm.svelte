<script lang="ts">
  import { apiFetch } from '$lib/client/api';
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { onDestroy, untrack } from 'svelte';
  import { useT } from '$lib/client/i18n.svelte';
  import DirectoryPickerDialog from './DirectoryPickerDialog.svelte';
  import {
    DEFAULT_BROWSER_TARGET_URL,
    isAnyBrowserKind,
    parseBrowserTargetUrl
  } from '$lib/shared/browserTarget';

  const t = useT();

  export interface SpawnRoleOption {
    id: string;
    name: string;
    cli_kind: string;
    default_model: string | null;
    default_permission_mode: string | null;
  }
  export interface SpawnRepoOption {
    id: string;
    path: string;
  }
  export interface OptionalArgMeta {
    id: string;
    flag: string;
    label: string;
    description?: string;
    default: boolean;
  }
  export interface CapabilityValueMeta {
    id: string;
    label: string;
  }
  export interface CapabilityMeta {
    label: string;
    values: CapabilityValueMeta[];
    default: string | null;
  }
  export interface CliKindOption {
    kind: string;
    displayName: string;
    createWorktree: boolean;
    initialInputDelivery: 'none' | 'cli-arg';
    optionalArgs: OptionalArgMeta[];
    capabilities: {
      model: CapabilityMeta | null;
      permissionMode: CapabilityMeta | null;
    };
  }
  export type SpawnDefaults = Record<
    string,
    {
      optionalArgs: Record<string, boolean>;
      /** Capability-value id pre-selected when no role override is set. */
      defaultModel?: string | null;
      /** Capability-value id pre-selected when no role override is set. */
      defaultPermissionMode?: string | null;
    }
  >;
  /**
   * Existing queue entry the user can pick as a dependency in queue mode.
   * Only entries that can still meaningfully gate another are passed in
   * (pending / blocked / ready / running); the parent filters out terminal
   * entries because depending on a `done` / `failed` / `cancelled` entry
   * has no effect.
   */
  export interface QueueDepOption {
    id: string;
    title: string;
    status: string;
  }
  /**
   * Form submission mode. 'spawn' (default) posts to /agents/new and
   * redirects to the new agent. 'queue' bypasses the SvelteKit action and
   * hands a structured payload to `onQueue` so the parent can POST it to
   * /api/queue with its own queue-specific fields (priority, deps, …).
   */
  export interface QueuePayload {
    role_id: string;
    repo_id: string;
    task_title: string;
    task_body: string;
    target_url: string;
    branch: string;
    with_worktree: boolean | null;
    model: string | null;
    permission_mode: string | null;
    optional_args: Record<string, boolean>;
    priority: number;
    scheduled_for: number | null;
    exclusive: boolean;
    depends_on: string[];
    /** User intent: true = eligible for auto-promotion ("Run" button),
     *  false = parked in the task list backlog ("Save" button). */
    queued: boolean;
    plan_md: string | null;
  }

  /**
   * Out-of-band image attachments passed alongside the JSON payload.
   * `pending` are new File objects to upload after the row is written;
   * `removed` are filenames of already-staged attachments to delete (edit
   * mode). The parent reconciles these against /api/queue/:id/attachments
   * after the POST/PUT so a screenshot upload failure never loses the
   * task's text.
   */
  export interface PendingAttachments {
    pending: File[];
    removed: string[];
  }

  export interface ExistingAttachment {
    filename: string;
    mime: string;
    size: number;
  }
  /**
   * Pre-fill values for edit mode. When supplied the form seeds every field
   * from an existing queue entry and swaps the Save/Run pair for a single
   * "Save changes" button that routes through `onEdit`. Omitted (null) keeps
   * the create/spawn behavior untouched.
   */
  export interface SpawnInitialValues {
    roleId: string;
    repoId: string;
    taskTitle: string;
    taskBody: string;
    targetUrl: string;
    branch: string;
    withWorktree: boolean;
    model: string | null;
    permissionMode: string | null;
    optionalArgs: Record<string, boolean>;
    priority: number;
    /** '' or a datetime-local string ('YYYY-MM-DDTHH:mm'). */
    scheduledForLocal: string;
    exclusive: boolean;
    dependsOn: string[];
    planMd: string;
  }

  let {
    roles,
    repos,
    cliKinds,
    spawnDefaults = {},
    defaultRepoId,
    mode = 'spawn',
    queueDepOptions = [],
    initialValues = null,
    existingAttachments = [],
    /**
     * Called with the new agent id after a successful spawn. The dashboard
     * uses this to close the modal + navigate to the agent detail page.
     * If omitted, the component falls back to a plain navigation.
     */
    onSuccess,
    onQueue,
    onEdit,
    onCancel
  }: {
    roles: SpawnRoleOption[];
    repos: SpawnRepoOption[];
    cliKinds: CliKindOption[];
    spawnDefaults?: SpawnDefaults;
    /** Pre-select this repo when the dialog mounts (e.g. the sidebar's
     *  currently-selected repo). Falls back to repos[0] when null/unknown. */
    defaultRepoId?: string | null;
    mode?: 'spawn' | 'queue';
    queueDepOptions?: QueueDepOption[];
    /** When set, the form pre-fills from this entry and runs in edit mode
     *  (single "Save changes" button → `onEdit`). Only meaningful with
     *  mode='queue'. */
    initialValues?: SpawnInitialValues | null;
    /** Already-staged attachments to show in edit mode (metadata only —
     *  the server never exposes the bytes). */
    existingAttachments?: ExistingAttachment[];
    onSuccess?: (agentId: string) => void;
    /** Required when mode='queue'. Receives the assembled payload + any
     *  out-of-band image attachments; the parent owns the API call, the
     *  attachment reconciliation and error mapping. Resolves with true on
     *  success so the form can clear its submitting state. */
    onQueue?: (
      payload: QueuePayload,
      attachments?: PendingAttachments
    ) => Promise<{ ok: boolean; error?: string }>;
    /** Required when editing (initialValues set). Same contract as onQueue;
     *  the parent PUTs to /api/queue/:id. */
    onEdit?: (
      payload: QueuePayload,
      attachments?: PendingAttachments
    ) => Promise<{ ok: boolean; error?: string }>;
    onCancel?: () => void;
  } = $props();

  /** Edit mode = an existing entry was passed in to pre-fill. */
  const isEdit = $derived(initialValues != null);

  // Roles are read-only here. CRUD lives at /roles.
  let repoOptions = $state<SpawnRepoOption[]>(untrack(() => [...repos]));

  let selectedRoleId = $state(
    untrack(() => {
      const iv = initialValues;
      if (iv && roles.some((r) => r.id === iv.roleId)) return iv.roleId;
      return roles[0]?.id ?? '';
    })
  );
  let selectedRepoId = $state(
    untrack(() => {
      const iv = initialValues;
      if (iv && repos.some((r) => r.id === iv.repoId)) return iv.repoId;
      if (defaultRepoId && repos.some((r) => r.id === defaultRepoId)) return defaultRepoId;
      return repos[0]?.id ?? '';
    })
  );

  // ── Inline repo creation ────────────────────────────────────────────────
  let showNewRepo = $state(false);
  let newRepoPath = $state('');
  let newRepoOriginUrl = $state('');
  let newRepoCloneUrl = $state<string | null>(null);
  let newRepoError = $state<string | null>(null);
  let savingRepo = $state(false);
  let pickerOpen = $state(false);

  // ── Task title + body + slug preview ───────────────────────────────────
  let taskTitle = $state(untrack(() => initialValues?.taskTitle ?? ''));
  let taskBodyValue = $state(untrack(() => initialValues?.taskBody ?? ''));
  const taskSlug = $derived(
    taskTitle
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '')
  );

  // ── Advanced: optional args toggles ──────────────────────────────────────
  let showAdvanced = $state(false);
  /** Toggle states keyed by optionalArg id. Recomputed when the selected role changes. */
  let optArgToggles = $state<Record<string, boolean>>(
    untrack(() => ({ ...(initialValues?.optionalArgs ?? {}) }))
  );

  // ── Selected adapter (resolved from role) ────────────────────────────────
  const selectedRole = $derived(roles.find((r) => r.id === selectedRoleId) ?? null);
  const selectedAdapter = $derived(
    selectedRole ? cliKinds.find((k) => k.kind === selectedRole.cli_kind) ?? null : null
  );

  /** The optionalArgs metadata for the currently selected role's CLI kind. */
  const selectedOptionalArgs = $derived(selectedAdapter?.optionalArgs ?? []);

  /** True when the currently selected role is either browser flavor.
   *  Hides the task body field and reveals the preview URL field. */
  const isBrowserSelected = $derived.by(() => {
    if (!selectedRole) return false;
    return isAnyBrowserKind(selectedRole.cli_kind);
  });

  // Worktree / branch UI is shown only for adapters that take a worktree.
  const showGitFields = $derived(selectedAdapter?.createWorktree ?? false);

  // Task body field is shown only when the adapter accepts an initial prompt
  // via CLI argv. delivery: 'none' means the adapter has no way to receive
  // the body, so we hide the field entirely (the user puts preamble in the
  // role's system prompt instead).
  const showTaskBody = $derived(
    !isBrowserSelected && selectedAdapter?.initialInputDelivery === 'cli-arg'
  );

  // ── Branch picker (fetched per repo) ────────────────────────────────────
  interface BranchData {
    branches: string[];
    current: string | null;
  }
  let branchCache = $state<Record<string, BranchData>>({});
  let branchLoading = $state(false);
  let branchError = $state<string | null>(null);
  let selectedBranch = $state(untrack(() => initialValues?.branch ?? ''));
  let withWorktree = $state(untrack(() => initialValues?.withWorktree ?? true));

  /** Keep an already-selected branch if it is valid for this repo (so the
   *  seeded edit branch survives the async load), else fall back to the
   *  repo's current/first branch. Behavior-preserving for create, where
   *  selectedBranch starts ''. */
  function pickBranch(cached: BranchData): string {
    if (selectedBranch && cached.branches.includes(selectedBranch)) return selectedBranch;
    return cached.current ?? cached.branches[0] ?? '';
  }

  async function loadBranches(repoId: string): Promise<void> {
    if (!repoId) return;
    if (branchCache[repoId]) {
      const cached = branchCache[repoId];
      selectedBranch = pickBranch(cached);
      return;
    }
    branchLoading = true;
    branchError = null;
    try {
      const res = await apiFetch(`/api/repos/${encodeURIComponent(repoId)}/branches`);
      const data = (await res.json()) as { branches?: string[]; current?: string | null; error?: string };
      if (!res.ok || !Array.isArray(data.branches)) {
        branchError = data.error ?? t('spawn.error.branchListFailed', { message: '' });
        return;
      }
      const cached: BranchData = {
        branches: data.branches,
        current: data.current ?? null
      };
      branchCache = { ...branchCache, [repoId]: cached };
      selectedBranch = pickBranch(cached);
    } catch {
      branchError = t('spawn.error.networkError');
    } finally {
      branchLoading = false;
    }
  }

  // ── Capability picks (model, permission_mode) ───────────────────────────
  let selectedModel = $state<string | null>(untrack(() => initialValues?.model ?? null));
  let selectedPermissionMode = $state<string | null>(
    untrack(() => initialValues?.permissionMode ?? null)
  );

  // ── Reactive resets when role / repo / adapter changes ──────────────────

  // Tracks the role whose capability defaults have been applied. Seeded to
  // the initial role in edit mode so the first effect pass keeps the seeded
  // values instead of resetting to role defaults; a genuine role change
  // (different id) re-derives as before. Plain `let` → not reactive.
  let optArgsRoleApplied: string | null = untrack(() =>
    initialValues ? selectedRoleId : null
  );
  let modelCapsRoleApplied: string | null = untrack(() =>
    initialValues ? selectedRoleId : null
  );

  // Re-derive toggle values when the selected role (and thus CLI kind) changes.
  $effect(() => {
    if (!selectedRole || !selectedAdapter) {
      optArgToggles = {};
      optArgsRoleApplied = null;
      return;
    }
    if (optArgsRoleApplied === selectedRole.id) return;
    optArgsRoleApplied = selectedRole.id;
    const userDefs = spawnDefaults[selectedRole.cli_kind]?.optionalArgs ?? {};
    const toggles: Record<string, boolean> = {};
    for (const opt of selectedAdapter.optionalArgs) {
      toggles[opt.id] = userDefs[opt.id] ?? opt.default;
    }
    optArgToggles = toggles;
  });

  // Pre-fill model / permission_mode following the precedence ladder:
  //   1. role default (per-role explicit choice)
  //   2. user spawn-default (Settings → Agent defaults — per cli-kind)
  //   3. adapter's `capabilities.*.default`
  //   4. first value in the adapter's `capabilities.*.values`
  // Each layer is taken only when the next-higher layer is absent OR
  // resolves to a value the adapter no longer advertises (handles JSONC
  // edits / stale storage cleanly).
  $effect(() => {
    if (!selectedRole || !selectedAdapter) {
      selectedModel = null;
      selectedPermissionMode = null;
      modelCapsRoleApplied = null;
      return;
    }
    if (modelCapsRoleApplied === selectedRole.id) return;
    modelCapsRoleApplied = selectedRole.id;
    const userDefs = spawnDefaults[selectedRole.cli_kind];
    const modelCap = selectedAdapter.capabilities.model;
    if (modelCap) {
      const inValues = (id: string | null | undefined): id is string =>
        !!id && modelCap.values.some((v) => v.id === id);
      const roleDefault = selectedRole.default_model;
      const userDefault = userDefs?.defaultModel ?? null;
      selectedModel = inValues(roleDefault)
        ? roleDefault
        : inValues(userDefault)
          ? userDefault
          : modelCap.default ?? modelCap.values[0]?.id ?? null;
    } else {
      selectedModel = null;
    }
    const modeCap = selectedAdapter.capabilities.permissionMode;
    if (modeCap) {
      const inValues = (id: string | null | undefined): id is string =>
        !!id && modeCap.values.some((v) => v.id === id);
      const roleDefault = selectedRole.default_permission_mode;
      const userDefault = userDefs?.defaultPermissionMode ?? null;
      selectedPermissionMode = inValues(roleDefault)
        ? roleDefault
        : inValues(userDefault)
          ? userDefault
          : modeCap.default ?? modeCap.values[0]?.id ?? null;
    } else {
      selectedPermissionMode = null;
    }
  });

  // Load branches whenever a git-enabled repo+role pair becomes active.
  $effect(() => {
    if (!showGitFields) return;
    if (!selectedRepoId) return;
    void loadBranches(selectedRepoId);
  });

  // Browser-kind preview URL
  let targetUrl = $state(
    untrack(() =>
      initialValues?.targetUrl ? initialValues.targetUrl : DEFAULT_BROWSER_TARGET_URL
    )
  );
  const targetUrlValid = $derived(parseBrowserTargetUrl(targetUrl).ok);

  // ── Queue-mode extras (priority, deps, scheduled-for, exclusive, plan) ──
  let queuePriority = $state(untrack(() => initialValues?.priority ?? 0));
  let queueScheduledForLocal = $state(
    untrack(() => initialValues?.scheduledForLocal ?? '')
  ); // 'YYYY-MM-DDTHH:mm' or empty
  let queueExclusive = $state(untrack(() => initialValues?.exclusive ?? false));
  let queueDeps = $state<string[]>(untrack(() => [...(initialValues?.dependsOn ?? [])]));
  let queuePlanMd = $state(untrack(() => initialValues?.planMd ?? ''));
  let queuePlanOpen = $state(untrack(() => Boolean(initialValues?.planMd)));

  // ── Image attachments (queue mode, cli-arg adapters only) ───────────────
  // Client-side mirror of the server limits (imageUploadCore.ts /
  // taskAttachmentUploads.ts). Kept in sync by hand, like AgentTerminalPanel.
  const ATTACH_MAX_BYTES = 5 * 1024 * 1024;
  const ATTACH_MIMES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp'
  ]);
  const ATTACH_MAX_COUNT = 10;
  let pendingFiles = $state<File[]>([]);
  let existingFiles = $state<ExistingAttachment[]>(
    untrack(() => [...existingAttachments])
  );
  let removedFilenames = $state<string[]>([]);
  let attachError = $state<string | null>(null);
  let attachInput: HTMLInputElement | undefined = $state();
  const objUrls = new Map<File, string>();

  // Only adapters that take a cli-arg initial prompt can receive @<path>
  // references (and only the queue path stages attachments at all).
  const attachmentsEnabled = $derived(mode === 'queue' && showTaskBody);
  const visibleExisting = $derived(
    existingFiles.filter((f) => !removedFilenames.includes(f.filename))
  );
  const attachCount = $derived(visibleExisting.length + pendingFiles.length);

  function objUrl(file: File): string {
    let u = objUrls.get(file);
    if (!u) {
      u = URL.createObjectURL(file);
      objUrls.set(file, u);
    }
    return u;
  }

  function addFiles(list: FileList | File[]): void {
    attachError = null;
    for (const f of Array.from(list)) {
      if (!ATTACH_MIMES.has(f.type)) {
        attachError = t('queueAttachments.error.mime');
        continue;
      }
      if (f.size <= 0 || f.size > ATTACH_MAX_BYTES) {
        attachError = t('queueAttachments.error.size');
        continue;
      }
      if (attachCount + 1 > ATTACH_MAX_COUNT) {
        attachError = t('queueAttachments.error.tooMany');
        break;
      }
      pendingFiles = [...pendingFiles, f];
    }
  }

  function onAttachInputChange(ev: Event): void {
    const input = ev.currentTarget as HTMLInputElement;
    if (input.files) addFiles(input.files);
    // Reset so picking the same file again re-fires change.
    input.value = '';
  }

  function removePending(file: File): void {
    pendingFiles = pendingFiles.filter((f) => f !== file);
    const u = objUrls.get(file);
    if (u) {
      URL.revokeObjectURL(u);
      objUrls.delete(file);
    }
  }

  function removeExisting(filename: string): void {
    if (!removedFilenames.includes(filename)) {
      removedFilenames = [...removedFilenames, filename];
    }
  }

  // Paste / drag-and-drop — mirror AgentTerminalPanel's surfaces so the
  // task dialog accepts screenshots the same way the running-agent modal
  // does. Both paths funnel into addFiles() so validation, the chip list
  // and removal are reused as-is.
  let dragDepth = $state(0);
  const dragActive = $derived(dragDepth > 0);

  function renamePastedImage(file: File): File {
    // Clipboard images usually arrive as a generic "image.png". Rewrap
    // with a timestamped name so each chip is distinguishable and the
    // server-side staging keeps its uniqueness guarantee for chips that
    // would otherwise have collided client-side.
    const extFromMime = file.type.split('/')[1] ?? 'png';
    const renamed = `pasted-${Date.now()}.${extFromMime}`;
    return new File([file], renamed, { type: file.type });
  }

  function onFormPasteCapture(ev: ClipboardEvent): void {
    if (!attachmentsEnabled) return;
    const items = ev.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          // Only consume the paste when we actually intercept an image —
          // plain text pastes into title / body must still flow through.
          ev.preventDefault();
          ev.stopPropagation();
          addFiles([renamePastedImage(f)]);
          return;
        }
      }
    }
  }

  function hasFilesInDrag(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    return dt.types ? dt.types.includes('Files') : false;
  }

  function onFormDragEnter(ev: DragEvent): void {
    if (!attachmentsEnabled) return;
    if (!hasFilesInDrag(ev.dataTransfer)) return;
    ev.preventDefault();
    dragDepth++;
  }

  function onFormDragOver(ev: DragEvent): void {
    if (!attachmentsEnabled) return;
    if (!hasFilesInDrag(ev.dataTransfer)) return;
    // Required for `drop` to fire — and stops the browser from
    // navigating away if the user misses the form and drops elsewhere.
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  }

  function onFormDragLeave(ev: DragEvent): void {
    if (!attachmentsEnabled) return;
    if (!hasFilesInDrag(ev.dataTransfer)) return;
    ev.preventDefault();
    if (dragDepth > 0) dragDepth--;
  }

  function onFormDrop(ev: DragEvent): void {
    if (!attachmentsEnabled) return;
    if (!ev.dataTransfer) return;
    const files = Array.from(ev.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/')
    );
    if (files.length === 0) return;
    ev.preventDefault();
    dragDepth = 0;
    addFiles(files);
  }

  onDestroy(() => {
    for (const u of objUrls.values()) URL.revokeObjectURL(u);
    objUrls.clear();
  });
  // worktree=off implies exclusive — surface that in the UI when applicable.
  const exclusiveForced = $derived(mode === 'queue' && showGitFields && !withWorktree);
  const effectiveExclusive = $derived(exclusiveForced || queueExclusive);

  // ── Spawn form ──────────────────────────────────────────────────────────
  let error = $state<string | null>(null);
  let submitting = $state(false);

  /** Convert datetime-local input string to unix seconds, or null. */
  function parseScheduledFor(local: string): number | null {
    if (!local) return null;
    const d = new Date(local);
    const ts = d.getTime();
    if (Number.isNaN(ts)) return null;
    return Math.floor(ts / 1000);
  }

  /** Gather every form field into the queue-API payload shape.
   *  `queued` is supplied by the caller — Save sends false (Backlog), Run
   *  sends true (Queue). */
  function gatherQueuePayload(queued: boolean): QueuePayload {
    const planMd = queuePlanMd.trim();
    return {
      role_id: selectedRoleId,
      repo_id: selectedRepoId,
      task_title: taskTitle,
      task_body: showTaskBody ? (taskBodyValue ?? '') : '',
      target_url: isBrowserSelected ? targetUrl : '',
      branch: showGitFields ? selectedBranch : '',
      with_worktree: showGitFields ? withWorktree : null,
      model: selectedModel,
      permission_mode: selectedPermissionMode,
      optional_args: { ...optArgToggles },
      priority: Math.floor(Number.isFinite(queuePriority) ? queuePriority : 0),
      scheduled_for: parseScheduledFor(queueScheduledForLocal),
      exclusive: effectiveExclusive,
      depends_on: [...queueDeps],
      queued,
      plan_md: planMd === '' ? null : planMd
    };
  }

  /** Out-of-band attachments to hand the parent, or undefined when the
   *  adapter can't take them / there's nothing to reconcile. */
  function attachmentsArg(): PendingAttachments | undefined {
    if (!attachmentsEnabled) return undefined;
    if (pendingFiles.length === 0 && removedFilenames.length === 0) {
      return undefined;
    }
    return { pending: pendingFiles, removed: removedFilenames };
  }

  /** Queue-mode submit handler. The two submit buttons pass `queued=false`
   *  (Save → Backlog) or `queued=true` (Run → Queue). The surrounding
   *  <form> intercepts plain submit + Enter via `submitQueue(false)`. */
  async function submitQueue(queued: boolean): Promise<void> {
    if (!onQueue) return;
    error = null;
    submitting = true;
    try {
      const result = await onQueue(gatherQueuePayload(queued), attachmentsArg());
      if (!result.ok) error = result.error ?? t('queue.error.saveFailed');
    } catch (err) {
      error = (err as Error).message ?? t('queue.error.saveFailed');
    } finally {
      submitting = false;
    }
  }

  /** Edit-mode submit. Mirrors `submitQueue` but routes to `onEdit` (PUT).
   *  `queued` is irrelevant — the PUT endpoint ignores it (admission stays
   *  controlled by the dedicated /queue & /backlog endpoints). */
  async function submitEdit(): Promise<void> {
    if (!onEdit) return;
    error = null;
    submitting = true;
    try {
      const result = await onEdit(gatherQueuePayload(false), attachmentsArg());
      if (!result.ok) error = result.error ?? t('queue.error.saveFailed');
    } catch (err) {
      error = (err as Error).message ?? t('queue.error.saveFailed');
    } finally {
      submitting = false;
    }
  }

  const anyInlineOpen = $derived(showNewRepo);

  /**
   * We POST to `/agents/new` (its action handler owns the whole spawn
   * pipeline — worktree create, row insert, supervisor.spawn, …) from
   * wherever this form lives. `use:enhance` lets us intercept the result
   * so the dashboard-hosted modal can close itself and navigate instead
   * of doing a full page transition.
   */
  function submit() {
    return async ({
      result,
      update
    }: {
      result: {
        type: 'success' | 'failure' | 'redirect' | 'error';
        status?: number;
        location?: string;
        data?: Record<string, unknown>;
        error?: Error;
      };
      update: (opts?: { reset?: boolean }) => Promise<void>;
    }): Promise<void> => {
      submitting = false;
      if (result.type === 'redirect' && result.location) {
        const match = /\/agents\/([^/?#]+)/.exec(result.location);
        const agentId = match?.[1];
        if (agentId && onSuccess) {
          onSuccess(agentId);
          return;
        }
        await goto(result.location);
        return;
      }
      if (result.type === 'failure') {
        const msg = (result.data?.error as string | undefined) ?? t('spawn.error.spawnFailed');
        error = msg;
        return;
      }
      if (result.type === 'error') {
        error = result.error?.message ?? t('spawn.error.spawnFailed');
        return;
      }
      await update();
    };
  }

  function onSubmitStart(): void {
    error = null;
    submitting = true;
  }

  async function createRepo(): Promise<void> {
    newRepoError = null;
    savingRepo = true;
    try {
      const res = await apiFetch('/api/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: newRepoPath,
          origin_url: newRepoOriginUrl || undefined,
          clone_url: newRepoCloneUrl || undefined
        })
      });
      const data = (await res.json()) as { id?: string; path?: string; error?: string };
      if (!res.ok || !data.id) {
        newRepoError = data.error ?? t('spawn.error.failedAddRepo');
        return;
      }
      const created: SpawnRepoOption = {
        id: data.id,
        path: data.path ?? newRepoPath
      };
      repoOptions = [...repoOptions, created];
      selectedRepoId = created.id;
      showNewRepo = false;
      newRepoPath = '';
      newRepoOriginUrl = '';
      newRepoCloneUrl = null;
    } catch {
      newRepoError = t('spawn.error.networkError');
    } finally {
      savingRepo = false;
    }
  }
</script>

<div class="wrap" class:wide={mode === 'queue'}>
  <!-- In queue mode the form never POSTs to /agents/new; the submit button is
       type=button and routes through `submitQueue()`. We still wrap fields in
       a <form> so native HTML field validation (required, type=url) fires. -->
  <form
    method={mode === 'spawn' ? 'post' : 'dialog'}
    action={mode === 'spawn' ? '/agents/new' : undefined}
    use:enhance={mode === 'spawn'
      ? () => {
          onSubmitStart();
          return submit();
        }
      : undefined}
    onsubmit={mode === 'queue'
      ? (e) => {
          e.preventDefault();
          // In edit mode Enter saves the changes. Otherwise hitting Enter
          // inside any input defaults to Save → Backlog so the user never
          // accidentally launches an agent. The dedicated "Run" button
          // explicitly opts in to auto-promotion.
          if (isEdit) void submitEdit();
          else void submitQueue(false);
        }
      : undefined}
    onpastecapture={onFormPasteCapture}
    ondragenter={onFormDragEnter}
    ondragover={onFormDragOver}
    ondragleave={onFormDragLeave}
    ondrop={onFormDrop}
  >
    {#if attachmentsEnabled && dragActive}
      <div class="drop-overlay" aria-hidden="true">
        <span>{t('queueAttachments.dropOverlay')}</span>
      </div>
    {/if}
    <!-- Role field -->
    <div class="field">
      <div class="field-row">
        <label class="grow">
          <span>{t('spawn.role')}</span>
          <select name="role_id" bind:value={selectedRoleId} required>
            {#each roles as r (r.id)}
              <option value={r.id}>{r.name} ({r.cli_kind})</option>
            {/each}
          </select>
        </label>
        <a href="/roles" class="manage-link" title={t('spawn.manageRolesHint')}>
          {t('spawn.manageRoles')}
        </a>
      </div>
    </div>

    <!-- Repo field — full width while the add-repo sub-form is expanded so
         its path/origin inputs aren't cramped into a half column. -->
    <div class="field" class:span-2={showNewRepo}>
      <div class="field-row">
        <label class="grow">
          <span>{t('spawn.repo')}</span>
          <select name="repo_id" bind:value={selectedRepoId} required>
            {#each repoOptions as r (r.id)}
              <option value={r.id}>{r.path}</option>
            {/each}
          </select>
        </label>
        <button
          type="button"
          class="inline-add"
          onclick={() => { showNewRepo = !showNewRepo; newRepoError = null; }}
          title={t('spawn.titleAddRepo')}
        >
          {showNewRepo ? t('spawn.collapseRepo') : t('spawn.newRepo')}
        </button>
      </div>

      {#if showNewRepo}
        <div class="inline-form">
          <label>
            <span>Path <span class="muted">({t('spawn.absPath')})</span></span>
            <div class="path-row">
              <input bind:value={newRepoPath} placeholder="/home/user/myrepo" />
              <button
                type="button"
                class="browse-btn"
                onclick={() => { pickerOpen = true; }}
              >{t('picker.browse')}</button>
            </div>
          </label>
          <label>
            <span>{t('spawn.httpsOriginUrl')} <span class="muted">({t('spawn.optional')})</span></span>
            <input bind:value={newRepoOriginUrl} placeholder="https://github.com/…" />
          </label>
          {#if newRepoCloneUrl}
            <p class="muted clone-hint">↪ {t('picker.sshOriginUrl')}: <code>{newRepoCloneUrl}</code></p>
          {/if}
          {#if newRepoError}
            <p class="err">{newRepoError}</p>
          {/if}
          <div class="inline-actions">
            <button
              type="button"
              class="cancel"
              onclick={() => { showNewRepo = false; newRepoError = null; newRepoPath = ''; newRepoOriginUrl = ''; newRepoCloneUrl = null; }}
              disabled={savingRepo}
            >{t('spawn.cancel')}</button>
            <button
              type="button"
              onclick={createRepo}
              disabled={savingRepo || !newRepoPath}
            >{savingRepo ? t('spawn.adding') : t('spawn.addRepo')}</button>
          </div>
        </div>
      {/if}
    </div>

    {#if showGitFields}
      <div class="field">
        <label>
          <span>{t('spawn.branch')}</span>
          {#if branchLoading}
            <span class="muted slug-preview">{t('spawn.loadingBranches')}</span>
          {:else if branchError}
            <span class="err">{branchError}</span>
          {:else}
            {@const data = branchCache[selectedRepoId]}
            <select name="branch" bind:value={selectedBranch} required>
              {#if data}
                {#each data.branches as b (b)}
                  <option value={b}>{b}{data.current === b ? ` — ${t('spawn.currentBranch')}` : ''}</option>
                {/each}
              {/if}
            </select>
          {/if}
        </label>
        <label class="checkbox-row">
          <input type="checkbox" bind:checked={withWorktree} />
          <span>{t('spawn.withWorktree')}</span>
        </label>
        <!-- Always submit a value so the server can distinguish "checkbox
             present and unchecked" from "checkbox not rendered". -->
        <input type="hidden" name="with_worktree" value={String(withWorktree)} />
      </div>
    {/if}

    {#if selectedAdapter?.capabilities.model}
      <label>
        <span>{selectedAdapter.capabilities.model.label}</span>
        <select name="model" bind:value={selectedModel}>
          {#each selectedAdapter.capabilities.model.values as v (v.id)}
            <option value={v.id}>{v.label}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if selectedAdapter?.capabilities.permissionMode}
      <label>
        <span>{selectedAdapter.capabilities.permissionMode.label}</span>
        <select name="permission_mode" bind:value={selectedPermissionMode}>
          {#each selectedAdapter.capabilities.permissionMode.values as v (v.id)}
            <option value={v.id}>{v.label}</option>
          {/each}
        </select>
      </label>
    {/if}

    <label class="span-2">
      <span>{isBrowserSelected ? t('spawn.sessionLabel') : t('spawn.taskTitle')}</span>
      <input name="task_title" bind:value={taskTitle} required />
      {#if !isBrowserSelected && taskSlug && showGitFields}
        <span class="slug-preview">worktree: {taskSlug}/</span>
      {/if}
    </label>
    {#if isBrowserSelected}
      <label class="span-2">
        <span>{t('spawn.previewUrl')}</span>
        <input
          name="target_url"
          type="url"
          inputmode="url"
          autocomplete="off"
          bind:value={targetUrl}
          placeholder={DEFAULT_BROWSER_TARGET_URL}
          required
        />
        <span class="muted slug-preview">{t('spawn.previewUrl.help')}</span>
        {#if !targetUrlValid && targetUrl.trim() !== ''}
          <span class="err">{t('spawn.error.browserUrl.invalid')}</span>
        {/if}
      </label>
    {:else if showTaskBody}
      <label class="span-2">
        <span>{t('spawn.taskBody')} <span class="muted">({t('spawn.sentAsInitialInput')})</span></span>
        <textarea name="task_body" rows="6" bind:value={taskBodyValue}></textarea>
      </label>
    {/if}
    {#if attachmentsEnabled}
      <div class="span-2 attach">
        <span class="attach-label">{t('queueAttachments.label')}</span>
        {#if attachCount === 0}
          <p class="muted hint">{t('queueAttachments.empty')}</p>
        {:else}
          <ul class="attach-grid">
            {#each visibleExisting as a (a.filename)}
              <li class="attach-chip">
                <span class="attach-name" title={a.filename}>{a.filename}</span>
                <button
                  type="button"
                  class="attach-x"
                  aria-label={t('queueAttachments.remove')}
                  onclick={() => removeExisting(a.filename)}
                >×</button>
              </li>
            {/each}
            {#each pendingFiles as f (f)}
              <li class="attach-chip">
                <img class="attach-thumb" src={objUrl(f)} alt={f.name} />
                <span class="attach-name" title={f.name}>{f.name}</span>
                <button
                  type="button"
                  class="attach-x"
                  aria-label={t('queueAttachments.remove')}
                  onclick={() => removePending(f)}
                >×</button>
              </li>
            {/each}
          </ul>
        {/if}
        <button
          type="button"
          class="attach-add"
          onclick={() => attachInput?.click()}
        >
          {t('queueAttachments.add')}
        </button>
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          bind:this={attachInput}
          onchange={onAttachInputChange}
        />
        {#if attachError}<span class="err">{attachError}</span>{/if}
      </div>
    {/if}
    {#if selectedOptionalArgs.length > 0}
      <div class="advanced-section span-2">
        <button
          type="button"
          class="advanced-toggle"
          onclick={() => { showAdvanced = !showAdvanced; }}
        >
          <span class="arrow">{showAdvanced ? '▾' : '▸'}</span>
          {t('spawn.advanced')}
        </button>
        {#if showAdvanced}
          <div class="advanced-body">
            {#each selectedOptionalArgs as opt (opt.id)}
              <label class="toggle-row">
                <input
                  type="checkbox"
                  bind:checked={optArgToggles[opt.id]}
                />
                <span class="toggle-label">
                  <span>{opt.label}</span>
                  {#if opt.description}
                    <span class="toggle-desc">{opt.description}</span>
                  {/if}
                </span>
              </label>
              <input type="hidden" name="optionalArgs[{opt.id}]" value={String(optArgToggles[opt.id] ?? false)} />
            {/each}
          </div>
        {:else}
          <!-- Submit current toggle values even when collapsed -->
          {#each selectedOptionalArgs as opt (opt.id)}
            <input type="hidden" name="optionalArgs[{opt.id}]" value={String(optArgToggles[opt.id] ?? false)} />
          {/each}
        {/if}
      </div>
    {/if}
    {#if mode === 'queue'}
      <fieldset class="queue-extras span-2">
        <legend>{t('queue.action.addToQueue')}</legend>
        <label class="queue-field">
          <span>{t('queue.field.priority')}</span>
          <input
            type="number"
            step="1"
            bind:value={queuePriority}
          />
          <span class="muted hint">{t('queue.field.priorityHint')}</span>
        </label>
        <label class="queue-field">
          <span>{t('queue.field.scheduledFor')}</span>
          <input
            type="datetime-local"
            bind:value={queueScheduledForLocal}
          />
          <span class="muted hint">{t('queue.field.scheduledForHint')}</span>
        </label>
        <label class="queue-toggle">
          <input
            type="checkbox"
            bind:checked={queueExclusive}
            disabled={exclusiveForced}
          />
          <span>
            {t('queue.field.exclusive')}
            {#if exclusiveForced}
              <span class="muted"> (worktree off → required)</span>
            {/if}
          </span>
        </label>
        <span class="muted hint">{t('queue.field.exclusiveHint')}</span>
        <div class="queue-deps">
          <span class="deps-title">{t('queue.field.dependsOn')}</span>
          {#if queueDepOptions.length === 0}
            <p class="muted hint">{t('queue.field.dependsOnEmpty')}</p>
          {:else}
            <div class="deps-list">
              {#each queueDepOptions as dep (dep.id)}
                <label class="dep-row">
                  <input
                    type="checkbox"
                    checked={queueDeps.includes(dep.id)}
                    onchange={(e) => {
                      const checked = (e.currentTarget as HTMLInputElement).checked;
                      if (checked) queueDeps = [...queueDeps, dep.id];
                      else queueDeps = queueDeps.filter((id) => id !== dep.id);
                    }}
                  />
                  <span class="dep-label">
                    {dep.title}
                    <span class="muted"> ({dep.status})</span>
                  </span>
                </label>
              {/each}
            </div>
            <span class="muted hint">{t('queue.field.dependsOnHint')}</span>
          {/if}
        </div>
        <details
          class="queue-plan"
          bind:open={queuePlanOpen}
        >
          <summary>{t('queue.field.plan')}</summary>
          <textarea
            class="plan-textarea"
            rows="8"
            placeholder={t('queue.field.planPlaceholder')}
            bind:value={queuePlanMd}
          ></textarea>
          <span class="muted hint">{t('queue.field.planHint')}</span>
        </details>
      </fieldset>
    {/if}
    {#if error}
      <p class="err span-2">{error}</p>
    {/if}
    {#if mode === 'queue' && !isEdit}
      <p class="muted hint actions-hint span-2">{t('queue.action.runHint')}</p>
    {/if}
    <div class="actions span-2">
      {#if onCancel}
        <button type="button" class="cancel" onclick={onCancel} disabled={submitting}>
          {t('spawn.cancel')}
        </button>
      {:else}
        <a href="/" class="cancel">{t('spawn.cancel')}</a>
      {/if}
      {#if mode === 'queue' && isEdit}
        <!-- Edit mode: a single primary action. The PUT endpoint re-validates
             and resets the entry to `pending`; it does not touch the queued
             bit, so backlog stays backlog and queued stays queued. -->
        <button
          type="button"
          class="btn-run"
          onclick={() => void submitEdit()}
          disabled={submitting ||
            anyInlineOpen ||
            !selectedRoleId ||
            !selectedRepoId ||
            !taskSlug ||
            (isBrowserSelected && !targetUrlValid)}
        >
          {t('queue.action.saveEdit')}
        </button>
      {:else if mode === 'queue'}
        <!-- Save → Backlog (queued=0). Default action so pressing Enter
             inside any field never accidentally launches an agent. -->
        <button
          type="button"
          class="btn-save"
          onclick={() => void submitQueue(false)}
          disabled={submitting ||
            anyInlineOpen ||
            !selectedRoleId ||
            !selectedRepoId ||
            !taskSlug ||
            (isBrowserSelected && !targetUrlValid)}
        >
          {t('queue.action.save')}
        </button>
        <!-- Run → Queue (queued=1). Lets the scheduler auto-promote when a
             slot opens; subject to the user's concurrency caps. -->
        <button
          type="button"
          class="btn-run"
          onclick={() => void submitQueue(true)}
          disabled={submitting ||
            anyInlineOpen ||
            !selectedRoleId ||
            !selectedRepoId ||
            !taskSlug ||
            (isBrowserSelected && !targetUrlValid)}
        >
          {t('queue.action.run')}
        </button>
      {:else}
        <button
          type="submit"
          disabled={submitting ||
            anyInlineOpen ||
            !selectedRoleId ||
            !selectedRepoId ||
            !taskSlug ||
            (isBrowserSelected && !targetUrlValid)}
        >
          {submitting ? t('spawn.spawning') : t('spawn.spawn')}
        </button>
      {/if}
    </div>
  </form>
</div>

{#if pickerOpen}
  <DirectoryPickerDialog
    open={pickerOpen}
    initialPath={newRepoPath || undefined}
    onClose={() => { pickerOpen = false; }}
    onSelect={({ path, cloneUrl }) => {
      newRepoPath = path;
      newRepoCloneUrl = cloneUrl;
      pickerOpen = false;
    }}
  />
{/if}

<style>
  .wrap {
    /* A comfortable intrinsic width so inputs and the Project — Path
       repo option line have room to breathe, while still shrinking on
       narrow viewports (the Modal's `size="fit"` only clamps at 95vw). */
    width: 28rem;
    max-width: 100%;
  }
  /* Queue create/edit runs in a Modal with far more room than the spawn
     dialog. Widen it and lay the short fields two-up so the tall form
     stops forcing vertical scroll. Spawn mode never gets `.wide`, so its
     28rem single column is untouched. */
  .wrap.wide {
    width: min(56rem, 92vw);
  }
  form {
    display: grid;
    gap: 0.75rem;
    /* Anchor the drop overlay over the form during a drag. */
    position: relative;
  }
  /* Translucent overlay while a file is dragged over the form. Pointer
     events disabled so the underlying drop handler still fires. Mirrors
     AgentTerminalPanel's .drop-overlay so paste / drop UX is consistent
     between the two dialogs. */
  .drop-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 23, 42, 0.72);
    color: #e5e7eb;
    font-size: 1.1rem;
    font-weight: 600;
    border: 2px dashed #60a5fa;
    border-radius: 0.375rem;
    pointer-events: none;
    z-index: 5;
  }
  @media (min-width: 640px) {
    .wrap.wide form {
      grid-template-columns: 1fr 1fr;
      column-gap: 1rem;
      align-items: start;
    }
    .wrap.wide form > .span-2 {
      grid-column: 1 / -1;
    }
    /* Inside the queue-extras fieldset: priority + scheduled-for sit
       side by side; everything verbose spans the full width. */
    .wrap.wide .queue-extras {
      grid-template-columns: 1fr 1fr;
      column-gap: 1rem;
      align-items: start;
    }
    .wrap.wide .queue-extras > legend,
    .wrap.wide .queue-extras > .queue-toggle,
    .wrap.wide .queue-extras > .muted.hint,
    .wrap.wide .queue-extras > .queue-deps,
    .wrap.wide .queue-extras > .queue-plan {
      grid-column: 1 / -1;
    }
  }
  .field {
    display: grid;
    gap: 0.4rem;
  }
  .field-row {
    display: flex;
    gap: 0.4rem;
    align-items: flex-end;
  }
  .field-row .grow {
    flex: 1;
    min-width: 0;
  }
  input,
  select,
  textarea {
    width: 100%;
    box-sizing: border-box;
  }
  label {
    display: grid;
    gap: 0.25rem;
    color: #e5e7eb;
    font-size: 0.9rem;
  }
  input,
  select,
  textarea {
    padding: 0.5rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #111;
    color: #e5e5e5;
    font-family: inherit;
  }
  textarea {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.85rem;
  }
  .inline-add {
    padding: 0.45rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #1a1a1a;
    color: #93c5fd;
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
    white-space: nowrap;
    flex-shrink: 0;
    align-self: flex-end;
  }
  .inline-add:hover {
    background: #1e293b;
  }
  .manage-link {
    align-self: flex-end;
    padding: 0.45rem 0.2rem;
    font-size: 0.8rem;
    color: #93c5fd;
    text-decoration: none;
    white-space: nowrap;
  }
  .manage-link:hover {
    color: #bfdbfe;
    text-decoration: underline;
  }
  .checkbox-row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .checkbox-row input[type='checkbox'] {
    width: auto;
  }
  .inline-form {
    border-left: 2px solid #2563eb;
    padding-left: 0.75rem;
    display: grid;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .inline-form label {
    font-size: 0.85rem;
  }
  .inline-form input {
    padding: 0.4rem 0.5rem;
    font-size: 0.85rem;
  }
  .path-row {
    display: flex;
    gap: 0.4rem;
    align-items: stretch;
  }
  .path-row input {
    flex: 1;
    min-width: 0;
  }
  .browse-btn {
    padding: 0.4rem 0.7rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #1a1a1a;
    color: #93c5fd;
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .browse-btn:hover {
    background: #1e293b;
  }
  .inline-actions {
    display: flex;
    gap: 0.4rem;
    justify-content: flex-end;
  }
  .inline-actions button:not(.cancel) {
    padding: 0.4rem 0.75rem;
    border-radius: 0.375rem;
    background: #2563eb;
    border: none;
    color: #fff;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
  }
  .inline-actions button:not(.cancel):disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .err {
    color: #f87171;
    margin: 0;
  }
  .muted {
    color: #6b7280;
  }
  .clone-hint {
    margin: 0;
    font-size: 0.75rem;
  }
  .clone-hint code {
    font-family: ui-monospace, Menlo, monospace;
    background: #111827;
    padding: 0.05rem 0.25rem;
    border-radius: 0.2rem;
    color: #93c5fd;
  }
  .slug-preview {
    color: #6b7280;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.75rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    align-items: center;
  }
  .cancel {
    color: #9ca3af;
    text-decoration: none;
    padding: 0.55rem 0.75rem;
    background: transparent;
    border: none;
    cursor: pointer;
    font: inherit;
  }
  .cancel:hover:not(:disabled) {
    color: #e5e7eb;
  }
  button[type='submit'],
  .btn-run,
  .btn-save {
    padding: 0.55rem 1rem;
    border-radius: 0.375rem;
    border: none;
    color: #fff;
    cursor: pointer;
    font: inherit;
  }
  button[type='submit'],
  .btn-run {
    background: #2563eb;
  }
  .btn-save {
    background: transparent;
    color: #e5e7eb;
    border: 1px solid #374151;
  }
  .btn-save:hover:not(:disabled) {
    background: #1f2937;
  }
  button[type='submit']:disabled,
  .btn-run:disabled,
  .btn-save:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .actions-hint {
    margin: -0.25rem 0 0;
    text-align: right;
  }
  .queue-plan summary {
    cursor: pointer;
    color: #93c5fd;
    font-size: 0.85rem;
    padding: 0.1rem 0;
  }
  .queue-plan summary:hover {
    color: #bfdbfe;
  }
  .queue-plan[open] summary {
    margin-bottom: 0.35rem;
  }
  .plan-textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.8rem;
    padding: 0.5rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #111;
    color: #e5e5e5;
    resize: vertical;
  }
  a {
    color: #93c5fd;
  }
  .advanced-section {
    display: grid;
    gap: 0.4rem;
  }
  .advanced-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: none;
    border: none;
    color: #93c5fd;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    padding: 0;
  }
  .advanced-toggle:hover {
    color: #bfdbfe;
  }
  .arrow {
    font-size: 0.75rem;
  }
  .advanced-body {
    border-left: 2px solid #374151;
    padding-left: 0.75rem;
    display: grid;
    gap: 0.5rem;
  }
  .toggle-row {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .toggle-row input[type='checkbox'] {
    width: auto;
    margin-top: 0.15rem;
  }
  .toggle-label {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .toggle-desc {
    color: #6b7280;
    font-size: 0.8rem;
  }
  .queue-extras {
    border: 1px solid #1f2937;
    border-radius: 0.4rem;
    padding: 0.6rem 0.8rem 0.7rem;
    display: grid;
    gap: 0.5rem;
    background: #0d1117;
  }
  .queue-extras legend {
    padding: 0 0.4rem;
    color: #93c5fd;
    font-size: 0.85rem;
  }
  .queue-field {
    display: grid;
    gap: 0.25rem;
  }
  .queue-field input[type='number'] {
    max-width: 8rem;
  }
  .queue-field input[type='datetime-local'] {
    max-width: 14rem;
  }
  .queue-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .queue-toggle input[type='checkbox'] {
    width: auto;
  }
  .queue-deps {
    display: grid;
    gap: 0.3rem;
  }
  .deps-title {
    color: #e5e7eb;
    font-size: 0.85rem;
  }
  .deps-list {
    display: grid;
    gap: 0.25rem;
    max-height: 9rem;
    overflow-y: auto;
    padding-right: 0.25rem;
    border-left: 2px solid #374151;
    padding-left: 0.6rem;
  }
  .dep-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    font-size: 0.85rem;
  }
  .dep-row input[type='checkbox'] {
    width: auto;
  }
  .dep-label {
    color: #e5e7eb;
  }
  .hint {
    color: #6b7280;
    font-size: 0.75rem;
  }
  /* ── Image attachments ──────────────────────────────────────────── */
  .attach {
    display: grid;
    gap: 0.45rem;
  }
  .attach-label {
    color: #e5e7eb;
    font-size: 0.9rem;
  }
  .attach-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .attach-chip {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    max-width: 14rem;
    padding: 0.25rem 0.35rem 0.25rem 0.5rem;
    border: 1px solid var(--md-sys-color-outline-variant, #374151);
    border-radius: var(--md-sys-shape-corner-sm, 8px);
    background: var(--md-sys-color-surface-container-high, #1f1f1f);
    font-size: 0.8rem;
  }
  .attach-thumb {
    width: 1.75rem;
    height: 1.75rem;
    object-fit: cover;
    border-radius: 0.25rem;
    flex-shrink: 0;
  }
  .attach-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #e5e7eb;
  }
  .attach-x {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: var(--md-sys-shape-corner-full, 9999px);
    background: transparent;
    color: var(--md-sys-color-on-surface-variant, #9ca3af);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
  }
  .attach-x:hover {
    background: color-mix(in srgb, var(--md-sys-color-error, #ef4444) 16%, transparent);
    color: var(--md-sys-color-error, #ef4444);
  }
  .attach-add {
    justify-self: start;
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--md-sys-color-outline-variant, #374151);
    border-radius: var(--md-sys-shape-corner-sm, 8px);
    background: transparent;
    color: #93c5fd;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
  }
  .attach-add:hover {
    background: color-mix(in srgb, var(--md-sys-color-on-surface, #e5e7eb) 8%, transparent);
  }
</style>
