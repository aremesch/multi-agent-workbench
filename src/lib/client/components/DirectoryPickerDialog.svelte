<script lang="ts">
  import Modal from './Modal.svelte';
  import { apiFetch } from '$lib/client/api';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  interface Entry {
    name: string;
    isGitRepo: boolean;
  }
  interface ListResponse {
    root: string;
    path: string;
    parent: string | null;
    entries: Entry[];
  }
  interface ErrorResponse {
    error?: string;
  }
  interface MkdirResponse {
    path?: string;
    error?: string;
  }

  interface TreeNode {
    path: string;
    name: string;
    isGitRepo: boolean;
    expanded: boolean;
    loaded: boolean;
    loading: boolean;
    loadError: string | null;
    children: TreeNode[];
    mkdirOpen: boolean;
    mkdirName: string;
    mkdirError: string | null;
    mkdirSaving: boolean;
  }

  let {
    open,
    initialPath,
    onSelect,
    onClose
  }: {
    open: boolean;
    initialPath?: string;
    onSelect: (result: { path: string; cloneUrl: string | null }) => void;
    onClose: () => void;
  } = $props();

  let loadingRoot = $state(false);
  let rootError = $state<string | null>(null);
  let root = $state<string | null>(null);
  let rootChildren = $state<TreeNode[]>([]);
  let showHidden = $state(false);
  let selectedPath = $state<string | null>(null);
  let rootMkdirOpen = $state(false);
  let rootMkdirName = $state('');
  let rootMkdirError = $state<string | null>(null);
  let rootMkdirSaving = $state(false);
  let sshUrl = $state('');

  const HIDDEN_KEY = 'maw.picker.showHidden';

  let lastOpen = false;
  $effect(() => {
    if (!open) {
      lastOpen = false;
      return;
    }
    if (lastOpen) return;
    lastOpen = true;
    try {
      showHidden = localStorage.getItem(HIDDEN_KEY) === '1';
    } catch {
      showHidden = false;
    }
    selectedPath = initialPath ?? null;
    sshUrl = '';
    rootMkdirOpen = false;
    rootMkdirName = '';
    rootMkdirError = null;
    void loadRoot();
  });

  function makeNode(parentPath: string, e: Entry): TreeNode {
    const sep = parentPath.endsWith('/') ? '' : '/';
    return {
      path: parentPath + sep + e.name,
      name: e.name,
      isGitRepo: e.isGitRepo,
      expanded: false,
      loaded: false,
      loading: false,
      loadError: null,
      children: [],
      mkdirOpen: false,
      mkdirName: '',
      mkdirError: null,
      mkdirSaving: false
    };
  }

  type FetchResult = { ok: true; data: ListResponse } | { ok: false; error: string };

  async function fetchList(path: string | null): Promise<FetchResult> {
    const qs = new URLSearchParams();
    if (path) qs.set('path', path);
    if (showHidden) qs.set('hidden', '1');
    try {
      const res = await apiFetch('/api/fs/list?' + qs.toString());
      const raw = (await res.json()) as ListResponse & ErrorResponse;
      if (!res.ok) return { ok: false, error: raw.error ?? t('picker.error.load') };
      return { ok: true, data: raw };
    } catch {
      return { ok: false, error: t('spawn.error.networkError') };
    }
  }

  async function loadRoot(): Promise<void> {
    loadingRoot = true;
    rootError = null;
    const res = await fetchList(null);
    loadingRoot = false;
    if (!res.ok) {
      rootError = res.error;
      return;
    }
    root = res.data.root;
    rootChildren = res.data.entries.map((e) => makeNode(res.data.path, e));
  }

  async function toggleExpand(node: TreeNode): Promise<void> {
    if (node.loading) return;
    if (node.expanded) {
      node.expanded = false;
      return;
    }
    if (node.loaded) {
      node.expanded = true;
      return;
    }
    node.loading = true;
    node.loadError = null;
    const res = await fetchList(node.path);
    node.loading = false;
    if (!res.ok) {
      node.loadError = res.error;
      node.expanded = true;
      return;
    }
    node.children = res.data.entries.map((e) => makeNode(node.path, e));
    node.loaded = true;
    node.expanded = true;
  }

  async function reloadChildren(parentPath: string | null, node: TreeNode | null): Promise<void> {
    const res = await fetchList(parentPath);
    if (!res.ok) {
      if (node) node.loadError = res.error;
      else rootError = res.error;
      return;
    }
    const fresh = res.data.entries.map((e) => makeNode(res.data.path, e));
    if (node) {
      // Preserve expansion / loaded state of still-present children.
      const byPath = new Map(node.children.map((c) => [c.path, c] as const));
      for (const f of fresh) {
        const prev = byPath.get(f.path);
        if (prev) {
          f.expanded = prev.expanded;
          f.loaded = prev.loaded;
          f.children = prev.children;
        }
      }
      node.children = fresh;
      node.loaded = true;
      node.expanded = true;
    } else {
      const byPath = new Map(rootChildren.map((c) => [c.path, c] as const));
      for (const f of fresh) {
        const prev = byPath.get(f.path);
        if (prev) {
          f.expanded = prev.expanded;
          f.loaded = prev.loaded;
          f.children = prev.children;
        }
      }
      rootChildren = fresh;
    }
  }

  function toggleHidden(): void {
    showHidden = !showHidden;
    try {
      localStorage.setItem(HIDDEN_KEY, showHidden ? '1' : '0');
    } catch {
      /* ignore */
    }
    // Simplest: reload root; expanded nodes keep their loaded state per reloadChildren semantics.
    // A full reload of all expanded branches would be nicer but costly; root refresh is enough
    // because the hidden-toggle change is a UX convenience, not a correctness requirement.
    void loadRoot();
  }

  function selectNode(node: TreeNode): void {
    selectedPath = node.path;
  }

  function selectRoot(): void {
    if (root) selectedPath = root;
  }

  async function createRootDir(): Promise<void> {
    if (!root) return;
    rootMkdirError = null;
    rootMkdirSaving = true;
    try {
      const res = await apiFetch('/api/fs/mkdir', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parent: root, name: rootMkdirName })
      });
      const data = (await res.json()) as MkdirResponse;
      if (!res.ok || !data.path) {
        rootMkdirError = data.error ?? t('picker.error.mkdirFailed', { message: '' });
        return;
      }
      const newPath = data.path;
      await reloadChildren(root, null);
      selectedPath = newPath;
      rootMkdirOpen = false;
      rootMkdirName = '';
    } catch {
      rootMkdirError = t('spawn.error.networkError');
    } finally {
      rootMkdirSaving = false;
    }
  }

  async function createChildDir(node: TreeNode): Promise<void> {
    node.mkdirError = null;
    node.mkdirSaving = true;
    try {
      const res = await apiFetch('/api/fs/mkdir', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parent: node.path, name: node.mkdirName })
      });
      const data = (await res.json()) as MkdirResponse;
      if (!res.ok || !data.path) {
        node.mkdirError = data.error ?? t('picker.error.mkdirFailed', { message: '' });
        return;
      }
      const newPath = data.path;
      await reloadChildren(node.path, node);
      selectedPath = newPath;
      node.mkdirOpen = false;
      node.mkdirName = '';
    } catch {
      node.mkdirError = t('spawn.error.networkError');
    } finally {
      node.mkdirSaving = false;
    }
  }

  function openNewDir(): void {
    if (!selectedPath || !root) return;
    if (selectedPath === root) {
      rootMkdirOpen = true;
      rootMkdirName = '';
      rootMkdirError = null;
      return;
    }
    const target = findNode(rootChildren, selectedPath);
    if (!target) return;
    // Ensure the target is expanded so the mkdir form is visible under it.
    if (!target.loaded) {
      void toggleExpand(target).then(() => {
        target.mkdirOpen = true;
        target.mkdirName = '';
        target.mkdirError = null;
      });
    } else {
      target.expanded = true;
      target.mkdirOpen = true;
      target.mkdirName = '';
      target.mkdirError = null;
    }
  }

  function findNode(nodes: TreeNode[], path: string): TreeNode | null {
    for (const n of nodes) {
      if (n.path === path) return n;
      if (n.expanded) {
        const hit = findNode(n.children, path);
        if (hit) return hit;
      }
    }
    return null;
  }

  function confirmSelect(): void {
    if (!selectedPath) return;
    const trimmed = sshUrl.trim();
    onSelect({ path: selectedPath, cloneUrl: trimmed ? trimmed : null });
  }
</script>

<Modal {open} {onClose} title={t('picker.title')}>
  <div class="wrap">
    {#if rootError}
      <p class="err" role="alert">{rootError}</p>
    {/if}

    <!-- Tree -->
    <div class="tree" aria-busy={loadingRoot}>
      {#if loadingRoot}
        <p class="muted">{t('picker.loading')}</p>
      {:else if root}
        <!-- Implicit root row -->
        <div class="row root-row" class:selected={selectedPath === root}>
          <span class="disclosure empty" aria-hidden="true"></span>
          <button type="button" class="name-btn" onclick={selectRoot} title={root}>
            <span class="icon">🏠</span>
            <span class="name">~</span>
            <span class="abs">{root}</span>
          </button>
        </div>

        {#if rootMkdirOpen}
          <div class="mkdir-row" style="padding-left: 1.5rem;">
            <input
              class="mkdir-input"
              placeholder={t('picker.newDirectory.namePlaceholder')}
              bind:value={rootMkdirName}
              onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createRootDir(); } else if (e.key === 'Escape') { rootMkdirOpen = false; } }}
            />
            <button
              type="button"
              class="mkdir-btn primary"
              disabled={rootMkdirSaving || !rootMkdirName.trim()}
              onclick={() => void createRootDir()}
            >
              {rootMkdirSaving ? t('picker.newDirectory.creating') : t('picker.newDirectory.create')}
            </button>
            <button
              type="button"
              class="mkdir-btn"
              disabled={rootMkdirSaving}
              onclick={() => { rootMkdirOpen = false; rootMkdirName = ''; rootMkdirError = null; }}
            >{t('picker.newDirectory.cancel')}</button>
          </div>
          {#if rootMkdirError}
            <p class="err mkdir-err" style="padding-left: 1.5rem;">{rootMkdirError}</p>
          {/if}
        {/if}

        <!-- Top-level children -->
        {#each rootChildren as node (node.path)}
          {@render treeNode(node, 1)}
        {/each}

        {#if rootChildren.length === 0}
          <p class="muted empty">{t('picker.empty')}</p>
        {/if}
      {/if}
    </div>

    <!-- SSH URL + hidden toggle -->
    <div class="ssh-block">
      <label class="ssh-label">
        <span>{t('picker.sshOriginUrl')} <span class="muted">({t('spawn.optional')})</span></span>
        <input bind:value={sshUrl} placeholder="git@github.com:user/repo.git" />
      </label>
      <p class="hint">{t('picker.sshOriginUrlHint')}</p>
    </div>

    <!-- Footer -->
    <div class="footer">
      <div class="footer-left">
        <label class="hidden-toggle">
          <input type="checkbox" checked={showHidden} onchange={toggleHidden} />
          <span>{t('picker.showHidden')}</span>
        </label>
        <button
          type="button"
          class="mkdir-btn"
          disabled={!selectedPath}
          onclick={openNewDir}
          title={t('picker.newDirectory')}
        >+ {t('picker.newDirectory')}</button>
      </div>
      <div class="selected-line">
        {#if selectedPath}
          <span class="muted">{t('picker.selectedPath', { path: selectedPath })}</span>
        {:else}
          <span class="muted">{t('picker.selectNothing')}</span>
        {/if}
      </div>
      <div class="actions">
        <button type="button" class="cancel" onclick={onClose}>{t('spawn.cancel')}</button>
        <button
          type="button"
          class="primary"
          onclick={confirmSelect}
          disabled={!selectedPath || loadingRoot}
        >
          {t('picker.selectHere')}
        </button>
      </div>
    </div>
  </div>
</Modal>

{#snippet treeNode(node: TreeNode, depth: number)}
  <div class="row" class:selected={selectedPath === node.path} style="padding-left: {depth * 1.25}rem;">
    <button
      type="button"
      class="disclosure"
      aria-expanded={node.expanded}
      aria-label={node.expanded ? 'Collapse' : 'Expand'}
      onclick={() => void toggleExpand(node)}
    >
      {node.loading ? '…' : node.expanded ? '▾' : '▸'}
    </button>
    <button type="button" class="name-btn" onclick={() => selectNode(node)}>
      <span class="icon">📁</span>
      <span class="name">{node.name}</span>
      {#if node.isGitRepo}<span class="badge">{t('picker.gitRepo')}</span>{/if}
    </button>
  </div>

  {#if node.expanded}
    {#if node.loadError}
      <p class="err" style="padding-left: {(depth + 1) * 1.25}rem;">{node.loadError}</p>
    {/if}

    {#if node.mkdirOpen}
      <div class="mkdir-row" style="padding-left: {(depth + 1) * 1.25}rem;">
        <input
          class="mkdir-input"
          placeholder={t('picker.newDirectory.namePlaceholder')}
          bind:value={node.mkdirName}
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createChildDir(node); } else if (e.key === 'Escape') { node.mkdirOpen = false; } }}
        />
        <button
          type="button"
          class="mkdir-btn primary"
          disabled={node.mkdirSaving || !node.mkdirName.trim()}
          onclick={() => void createChildDir(node)}
        >
          {node.mkdirSaving ? t('picker.newDirectory.creating') : t('picker.newDirectory.create')}
        </button>
        <button
          type="button"
          class="mkdir-btn"
          disabled={node.mkdirSaving}
          onclick={() => { node.mkdirOpen = false; node.mkdirName = ''; node.mkdirError = null; }}
        >{t('picker.newDirectory.cancel')}</button>
      </div>
      {#if node.mkdirError}
        <p class="err mkdir-err" style="padding-left: {(depth + 1) * 1.25}rem;">{node.mkdirError}</p>
      {/if}
    {/if}

    {#each node.children as child (child.path)}
      {@render treeNode(child, depth + 1)}
    {/each}

    {#if node.loaded && node.children.length === 0 && !node.mkdirOpen}
      <p class="muted" style="padding-left: {(depth + 1) * 1.25}rem;">{t('picker.empty')}</p>
    {/if}
  {/if}
{/snippet}

<style>
  .wrap {
    width: 34rem;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    max-height: 75vh;
  }
  .tree {
    flex: 1 1 auto;
    min-height: 10rem;
    overflow-y: auto;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    background: #0b0f17;
    padding: 0.25rem 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3rem 0.5rem;
    color: #e5e7eb;
    font-size: 0.9rem;
    border-radius: 0.25rem;
  }
  .row.selected {
    background: #1e3a8a;
  }
  .root-row {
    font-weight: 600;
  }
  .disclosure {
    width: 1.25rem;
    height: 1.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: #9ca3af;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0;
    flex-shrink: 0;
  }
  .disclosure.empty {
    cursor: default;
  }
  .disclosure:hover:not(.empty) {
    color: #e5e7eb;
  }
  .name-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font: inherit;
    padding: 0.1rem 0.25rem;
    border-radius: 0.25rem;
    min-width: 0;
  }
  .name-btn:hover {
    background: #111827;
  }
  .row.selected .name-btn:hover {
    background: #1e40af;
  }
  .icon {
    flex-shrink: 0;
  }
  .name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .abs {
    color: #6b7280;
    font-size: 0.75rem;
    font-family: ui-monospace, Menlo, monospace;
    margin-left: 0.35rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .badge {
    flex-shrink: 0;
    padding: 0.05rem 0.35rem;
    border-radius: 999px;
    background: #1e293b;
    color: #93c5fd;
    font-size: 0.7rem;
    font-family: ui-monospace, Menlo, monospace;
  }
  .muted {
    color: #6b7280;
    padding: 0.3rem 0.5rem;
    margin: 0;
    font-size: 0.85rem;
  }
  .empty {
    font-style: italic;
  }
  .err {
    color: #f87171;
    margin: 0;
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
  }
  .mkdir-err {
    padding-top: 0;
  }
  .mkdir-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.5rem;
  }
  .mkdir-input {
    flex: 1;
    min-width: 0;
    padding: 0.3rem 0.5rem;
    border-radius: 0.25rem;
    border: 1px solid #374151;
    background: #111;
    color: #e5e5e5;
    font: inherit;
    font-size: 0.85rem;
  }
  .mkdir-btn {
    padding: 0.3rem 0.6rem;
    border-radius: 0.25rem;
    border: 1px solid #374151;
    background: #1a1a1a;
    color: #e5e7eb;
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .mkdir-btn.primary {
    background: #2563eb;
    border-color: #2563eb;
    color: #fff;
  }
  .mkdir-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .mkdir-btn:hover:not(:disabled):not(.primary) {
    background: #1e293b;
  }
  .ssh-block {
    display: grid;
    gap: 0.25rem;
  }
  .ssh-label {
    display: grid;
    gap: 0.25rem;
    color: #e5e7eb;
    font-size: 0.9rem;
  }
  .ssh-label input {
    width: 100%;
    padding: 0.5rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #111;
    color: #e5e5e5;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.85rem;
    box-sizing: border-box;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
  .footer {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .footer-left {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .hidden-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    color: #9ca3af;
    cursor: pointer;
  }
  .selected-line {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.75rem;
  }
  .actions {
    display: flex;
    gap: 0.4rem;
  }
  .actions button {
    padding: 0.45rem 0.85rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #1a1a1a;
    color: #e5e7eb;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
  }
  .actions button.primary {
    background: #2563eb;
    border-color: #2563eb;
    color: #fff;
  }
  .actions button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  @media (max-width: 30rem) {
    .footer {
      grid-template-columns: 1fr;
    }
    .selected-line {
      order: 3;
    }
    .actions {
      order: 2;
      justify-content: flex-end;
    }
  }
</style>
