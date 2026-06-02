<script lang="ts">
  import { goto } from '$app/navigation';
  import type { ActionData, PageData } from './$types';
  import { useT } from '$lib/client/i18n.svelte';
  import DirectoryPickerDialog from '$lib/client/components/DirectoryPickerDialog.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  const t = useT();

  let pickerOpen = $state(false);

  // Repos the user has ticked for import, keyed by absolute path. Already-
  // registered repos are never selectable, so they never enter this set.
  let selected = $state<Set<string>>(new Set());

  // Discovered repos that can still be imported (not already registered).
  const importable = $derived(
    (data.repos ?? []).filter((r) => !data.registeredPaths.includes(r.path))
  );
  const allSelected = $derived(
    importable.length > 0 && importable.every((r) => selected.has(r.path))
  );

  function toggle(path: string, checked: boolean): void {
    const next = new Set(selected);
    if (checked) next.add(path);
    else next.delete(path);
    selected = next;
  }

  function toggleAll(checked: boolean): void {
    selected = checked ? new Set(importable.map((r) => r.path)) : new Set();
  }

  function chooseFolder(path: string): void {
    pickerOpen = false;
    void goto(`?workspace=${encodeURIComponent(path)}`);
  }
</script>

<div class="wrap">
  <h1>{t('import.title')}</h1>
  <p class="muted">{t('import.desc', { projectName: data.project.name })}</p>

  <div class="folder-line">
    <button type="button" class="btn" onclick={() => (pickerOpen = true)}>
      {data.workspace ? t('import.changeFolder') : t('import.chooseFolder')}
    </button>
    {#if data.workspace}
      <code class="ws">{data.workspace}</code>
    {/if}
  </div>

  {#if data.browseError}
    <p class="err">{data.browseError}</p>
  {/if}

  {#if form?.errors}
    <div class="summary">
      <p class="ok">{t('import.importedCount', { count: String(form.imported?.length ?? 0) })}</p>
      <p class="err">{t('import.someFailed')}</p>
      <ul class="fail-list">
        {#each form.errors as e (e.path)}
          <li><code>{e.path}</code> — {e.error}</li>
        {/each}
      </ul>
    </div>
  {:else if form?.error}
    <p class="err">{form.error}</p>
  {/if}

  {#if data.repos !== null}
    {#if data.repos.length === 0}
      <p class="muted">{t('import.noGitChildren')}</p>
    {:else}
      <form method="post">
        <input type="hidden" name="workspace_root" value={data.workspace} />

        <div class="list-head">
          <label class="select-all">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={importable.length === 0}
              onchange={(e) => toggleAll((e.currentTarget as HTMLInputElement).checked)}
            />
            <span>{t('import.selectAll')}</span>
          </label>
          <span class="muted">{t('import.discovered', { count: String(data.repos.length) })}</span>
        </div>

        <ul class="repos">
          {#each data.repos as r (r.path)}
            {@const registered = data.registeredPaths.includes(r.path)}
            <li class:registered>
              <label class="repo-row">
                {#if registered}
                  <input type="checkbox" checked disabled />
                {:else}
                  <input
                    type="checkbox"
                    name="paths"
                    value={r.path}
                    checked={selected.has(r.path)}
                    onchange={(e) => toggle(r.path, (e.currentTarget as HTMLInputElement).checked)}
                  />
                {/if}
                <span class="repo-name">{r.name}</span>
                <code class="repo-path">{r.path}</code>
                {#if registered}<span class="badge">{t('import.alreadyAdded')}</span>{/if}
              </label>
            </li>
          {/each}
        </ul>

        <div class="actions">
          <a href={`/projects/${data.project.id}`} class="cancel">{t('spawn.cancel')}</a>
          <button type="submit" disabled={selected.size === 0}>
            {t('import.attachSelected', { count: String(selected.size) })}
          </button>
        </div>
      </form>
    {/if}
  {/if}
</div>

{#if pickerOpen}
  <DirectoryPickerDialog
    open={pickerOpen}
    initialPath={data.workspace ?? undefined}
    onClose={() => (pickerOpen = false)}
    onSelect={({ path }) => chooseFolder(path)}
  />
{/if}

<style>
  .wrap {
    max-width: 44rem;
  }
  h1 {
    margin: 0 0 0.25rem;
  }
  .muted {
    color: #6b7280;
  }
  .folder-line {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 1rem 0;
    flex-wrap: wrap;
  }
  .ws,
  .repo-path {
    background: #1f2937;
    padding: 0.1em 0.35em;
    border-radius: 0.25em;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.8rem;
  }
  .err {
    color: #f87171;
  }
  .ok {
    color: #34d399;
  }
  .summary {
    border: 1px solid #374151;
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    margin: 0.75rem 0;
  }
  .fail-list {
    margin: 0.25rem 0 0;
    padding-left: 1.1rem;
    font-size: 0.85rem;
  }
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0.75rem 0 0.5rem;
  }
  .select-all {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
  }
  .repos {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.25rem;
  }
  .repo-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    cursor: pointer;
  }
  li.registered .repo-row {
    cursor: default;
    opacity: 0.6;
  }
  .repo-name {
    font-weight: 600;
  }
  .repo-path {
    color: #9ca3af;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .badge {
    flex-shrink: 0;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: #1e293b;
    color: #93c5fd;
    font-size: 0.7rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    align-items: center;
    margin-top: 1rem;
  }
  .cancel {
    color: #9ca3af;
    text-decoration: none;
    padding: 0.55rem 0.75rem;
  }
  .btn,
  button[type='submit'] {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    background: #2563eb;
    border: none;
    color: #fff;
    cursor: pointer;
    font: inherit;
  }
  button[type='submit']:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
