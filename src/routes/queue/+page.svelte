<script lang="ts">
  import { invalidate, invalidateAll } from '$app/navigation';
  import { slide } from 'svelte/transition';
  import { apiFetch } from '$lib/client/api';
  import { useT } from '$lib/client/i18n.svelte';
  import Modal from '$lib/client/components/Modal.svelte';
  import PlanViewerModal from '$lib/client/components/PlanViewerModal.svelte';
  import SpawnAgentForm, {
    type QueuePayload,
    type QueueDepOption
  } from '$lib/client/components/SpawnAgentForm.svelte';
  import type { PageData } from './$types';
  import type { QueueEntryRow, QueueEntryStatus } from '$lib/server/db/types';

  const t = useT();

  let { data }: { data: PageData } = $props();

  // `invalidateAll()` is the canonical refresh path; tracking `data.entries`
  // / `data.concurrency` as derived state keeps the UI in lockstep without
  // an explicit $effect. Local mutation would only matter for optimistic
  // updates, which v0.3 doesn't do.
  const entries = $derived<QueueEntryRow[]>(data.entries);
  const concurrency = $derived(data.concurrency);

  const grouped = $derived(groupEntries(entries));

  /**
   * Bucket rows for display. Non-terminal entries split on `queued`:
   *   queued=1 → running / ready / blocked (the auto-promotion queue)
   *   queued=0 → backlog (parked on the task list, scheduler ignores)
   * Terminal rows land in `completed` regardless of `queued`.
   */
  function groupEntries(rows: QueueEntryRow[]): {
    running: QueueEntryRow[];
    ready: QueueEntryRow[];
    blocked: QueueEntryRow[];
    backlog: QueueEntryRow[];
    completed: QueueEntryRow[];
  } {
    const running: QueueEntryRow[] = [];
    const ready: QueueEntryRow[] = [];
    const blocked: QueueEntryRow[] = [];
    const backlog: QueueEntryRow[] = [];
    const completed: QueueEntryRow[] = [];
    for (const e of rows) {
      const terminal = e.status === 'done' || e.status === 'failed' || e.status === 'cancelled';
      if (terminal) {
        completed.push(e);
        continue;
      }
      // Backlog rows are pending/blocked/ready entries the user hasn't queued.
      // `running` always implies queued=1 in practice (the scheduler only
      // promotes queued rows), so it's safe to skip the queued check there.
      if (e.queued === 0 && e.status !== 'running') {
        backlog.push(e);
        continue;
      }
      switch (e.status) {
        case 'running':
          running.push(e);
          break;
        case 'ready':
          ready.push(e);
          break;
        case 'pending':
        case 'blocked':
          blocked.push(e);
          break;
      }
    }
    return { running, ready, blocked, backlog, completed };
  }

  function statusLabel(key: string): string {
    return t(`queue.status.${key}` as never);
  }

  function roleName(roleId: string): string {
    return data.roles.find((r) => r.id === roleId)?.name ?? roleId;
  }
  function repoLabel(repoId: string): string {
    const r = data.repos.find((x) => x.id === repoId);
    if (!r) return repoId;
    return r.projectName ? `${r.projectName} — ${r.path}` : r.path;
  }

  function depTitle(id: string): string {
    return entries.find((e) => e.id === id)?.title ?? id;
  }

  function depsOf(e: QueueEntryRow): string[] {
    if (!e.depends_on_json || e.depends_on_json === '[]') return [];
    try {
      return JSON.parse(e.depends_on_json) as string[];
    } catch {
      return [];
    }
  }

  function fmtTs(ts: number | null): string {
    if (!ts) return '—';
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  // ── Inline expand ────────────────────────────────────────────────────────
  // Multiple rows may be open at once (M3 expandable list, not a single-open
  // accordion). Reassign the record so the access is reactive.
  let expanded = $state<Record<string, boolean>>({});
  function toggleExpand(id: string): void {
    expanded = { ...expanded, [id]: !expanded[id] };
  }
  function onRowKey(ev: KeyboardEvent, id: string): void {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      toggleExpand(id);
    }
  }

  // ── Add-to-queue modal ────────────────────────────────────────────────
  let createOpen = $state(false);
  const queueDepOptions = $derived<QueueDepOption[]>(
    entries
      .filter((e) =>
        ['pending', 'blocked', 'ready', 'running'].includes(e.status as string)
      )
      .map((e) => ({ id: e.id, title: e.title, status: e.status }))
  );

  async function onQueue(payload: QueuePayload): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await apiFetch('/api/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          role_id: payload.role_id,
          repo_id: payload.repo_id,
          task_title: payload.task_title,
          task_body: payload.task_body,
          target_url: payload.target_url,
          branch: payload.branch,
          with_worktree: payload.with_worktree,
          model: payload.model,
          permission_mode: payload.permission_mode,
          optional_args: payload.optional_args,
          priority: payload.priority,
          scheduled_for: payload.scheduled_for,
          exclusive: payload.exclusive,
          depends_on: payload.depends_on,
          queued: payload.queued,
          plan_md: payload.plan_md
        })
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok) return { ok: false, error: body.error };
      createOpen = false;
      await invalidateAll();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async function onCancelEntry(id: string): Promise<void> {
    if (!confirm(t('queue.confirmCancel.body'))) return;
    const res = await apiFetch(`/api/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      alert(body.error ?? t('queue.error.saveFailed'));
      return;
    }
    await invalidateAll();
  }

  async function onPromoteEntry(id: string): Promise<void> {
    const res = await apiFetch(`/api/queue/${encodeURIComponent(id)}/promote`, {
      method: 'POST'
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      alert(body.error ?? t('queue.error.saveFailed'));
      return;
    }
    await invalidateAll();
  }

  async function onSendToBacklog(id: string): Promise<void> {
    const res = await apiFetch(`/api/queue/${encodeURIComponent(id)}/backlog`, {
      method: 'POST'
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      alert(body.error ?? t('queue.error.saveFailed'));
      return;
    }
    await invalidateAll();
  }

  async function onQueueEntry(id: string): Promise<void> {
    const res = await apiFetch(`/api/queue/${encodeURIComponent(id)}/queue`, {
      method: 'POST'
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      alert(body.error ?? t('queue.error.saveFailed'));
      return;
    }
    await invalidateAll();
  }

  // ── Plan viewer modal ────────────────────────────────────────────────────
  let planTaskId = $state<string | null>(null);
  function openTaskPlan(id: string): void {
    planTaskId = id;
  }
  function closeTaskPlan(): void {
    planTaskId = null;
  }

  void invalidate;
</script>

<svelte:head>
  <title>{t('queue.title')} — Multi-Agent Workbench</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <div>
      <h1>{t('queue.title')}</h1>
      <p class="subtitle">{t('queue.subtitle')}</p>
    </div>
    <div class="head-actions">
      <span class="muted concurrency-summary">
        {concurrency.maxConcurrentGlobal} / {concurrency.maxConcurrentPerRepo}
      </span>
    </div>
  </header>

  {#if entries.length === 0}
    <p class="empty">{t('queue.empty')}</p>
  {/if}

  {#snippet planBadge(e: QueueEntryRow)}
    {#if e.plan_md}
      <button
        type="button"
        class="plan-badge"
        title={t('queue.badge.planHint')}
        onclick={(ev) => {
          ev.stopPropagation();
          openTaskPlan(e.id);
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 7V3.5L19.5 9H14ZM8 13h8v2H8v-2Zm0 4h5v2H8v-2Z"
          />
        </svg>
        {t('queue.badge.plan')}
      </button>
    {/if}
  {/snippet}

  {#snippet metaItem(label: string, value: string)}
    <div class="meta-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  {/snippet}

  {#snippet taskRow(
    e: QueueEntryRow,
    statusKey: string,
    actions: import('svelte').Snippet<[QueueEntryRow]>
  )}
    <li class="entry" class:is-expanded={expanded[e.id]}>
      <div class="entry-row">
        <div
          class="entry-head"
          role="button"
          tabindex="0"
          aria-expanded={expanded[e.id] ? 'true' : 'false'}
          aria-label={expanded[e.id] ? t('queue.action.collapse') : t('queue.action.expand')}
          onclick={() => toggleExpand(e.id)}
          onkeydown={(ev) => onRowKey(ev, e.id)}
        >
          <svg
            class="chevron"
            class:open={expanded[e.id]}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path fill="currentColor" d="M7 10l5 5 5-5H7Z" />
          </svg>
          <span class={`status status-${statusKey}`}>{statusLabel(statusKey)}</span>
          <span class="entry-title">{e.title}</span>
          {@render planBadge(e)}
        </div>
        <div class="entry-actions">{@render actions(e)}</div>
      </div>

      {#if expanded[e.id]}
        <div class="entry-detail" transition:slide={{ duration: 150 }}>
          <section class="detail-block">
            <h3>{t('queue.detail.content')}</h3>
            {#if e.body && e.body.trim()}
              <pre class="detail-body">{e.body}</pre>
            {:else}
              <p class="detail-empty">{t('queue.detail.noContent')}</p>
            {/if}
          </section>

          <dl class="detail-meta">
            {@render metaItem(t('queue.column.role'), roleName(e.role_id))}
            {@render metaItem(t('queue.column.repo'), repoLabel(e.repo_id))}
            {#if e.model}{@render metaItem(t('queue.column.model'), e.model)}{/if}
            {#if e.source_branch}
              {@render metaItem(t('queue.column.branch'), e.source_branch)}
            {/if}
            {#if e.priority !== 0}
              {@render metaItem(t('queue.column.priority'), String(e.priority))}
            {/if}
            {#if e.scheduled_for}
              {@render metaItem(
                t('queue.column.scheduledFor'),
                fmtTs(e.scheduled_for)
              )}
            {/if}
            {#if depsOf(e).length > 0}
              {@render metaItem(
                t('queue.column.dependsOn'),
                depsOf(e).map(depTitle).join(', ')
              )}
            {/if}
            {@render metaItem(t('queue.column.created'), fmtTs(e.created_at))}
            {@render metaItem(t('queue.column.updated'), fmtTs(e.updated_at))}
          </dl>

          {#if e.last_error}
            <p class="detail-error">{t('queue.lastError', { message: e.last_error })}</p>
          {/if}
        </div>
      {/if}
    </li>
  {/snippet}

  {#snippet runningActions(e: QueueEntryRow)}
    {#if e.agent_id}
      <a href={`/agents/${e.agent_id}`} class="link">{t('queue.action.openAgent')}</a>
    {/if}
    <button type="button" class="link danger" onclick={() => onCancelEntry(e.id)}>
      {t('queue.action.cancel')}
    </button>
  {/snippet}

  {#snippet readyActions(e: QueueEntryRow)}
    <button type="button" class="link" onclick={() => onPromoteEntry(e.id)}>
      {t('queue.action.runNow')}
    </button>
    <button type="button" class="link" onclick={() => onSendToBacklog(e.id)}>
      {t('queue.action.sendToBacklog')}
    </button>
    <button type="button" class="link danger" onclick={() => onCancelEntry(e.id)}>
      {t('queue.action.cancel')}
    </button>
  {/snippet}

  {#snippet blockedActions(e: QueueEntryRow)}
    <button type="button" class="link" onclick={() => onPromoteEntry(e.id)}>
      {t('queue.action.runNow')}
    </button>
    <button type="button" class="link" onclick={() => onSendToBacklog(e.id)}>
      {t('queue.action.sendToBacklog')}
    </button>
    <button type="button" class="link danger" onclick={() => onCancelEntry(e.id)}>
      {t('queue.action.cancel')}
    </button>
  {/snippet}

  {#snippet backlogActions(e: QueueEntryRow)}
    <button type="button" class="link" onclick={() => onQueueEntry(e.id)}>
      {t('queue.action.queue')}
    </button>
    <button type="button" class="link" onclick={() => onPromoteEntry(e.id)}>
      {t('queue.action.runNow')}
    </button>
    <button type="button" class="link danger" onclick={() => onCancelEntry(e.id)}>
      {t('queue.action.cancel')}
    </button>
  {/snippet}

  {#snippet completedActions(e: QueueEntryRow)}
    {#if e.agent_id}
      <a href={`/agents/${e.agent_id}`} class="link">{t('queue.action.openAgent')}</a>
    {/if}
  {/snippet}

  {#if grouped.running.length > 0}
    <section>
      <h2>{t('queue.section.running')} ({grouped.running.length})</h2>
      <ul class="entries">
        {#each grouped.running as e (e.id)}
          {@render taskRow(e, e.status, runningActions)}
        {/each}
      </ul>
    </section>
  {/if}

  {#if grouped.ready.length > 0}
    <section>
      <h2>{t('queue.section.ready')} ({grouped.ready.length})</h2>
      <ul class="entries">
        {#each grouped.ready as e (e.id)}
          {@render taskRow(e, e.status, readyActions)}
        {/each}
      </ul>
    </section>
  {/if}

  {#if grouped.blocked.length > 0}
    <section>
      <h2>{t('queue.section.blocked')} ({grouped.blocked.length})</h2>
      <ul class="entries">
        {#each grouped.blocked as e (e.id)}
          {@render taskRow(e, e.status, blockedActions)}
        {/each}
      </ul>
    </section>
  {/if}

  {#if grouped.backlog.length > 0}
    <section>
      <h2>{t('queue.section.backlog')} ({grouped.backlog.length})</h2>
      <ul class="entries">
        {#each grouped.backlog as e (e.id)}
          {@render taskRow(e, 'backlog', backlogActions)}
        {/each}
      </ul>
    </section>
  {/if}

  {#if grouped.completed.length > 0}
    <section>
      <h2>{t('queue.section.completed')} ({grouped.completed.length})</h2>
      <ul class="entries entries-dim">
        {#each grouped.completed as e (e.id)}
          {@render taskRow(e, e.status, completedActions)}
        {/each}
      </ul>
    </section>
  {/if}
</div>

<button
  type="button"
  class="fab"
  aria-label={t('queue.action.create')}
  onclick={() => {
    createOpen = true;
  }}
>
  <span aria-hidden="true">+</span>
</button>

{#if createOpen}
  <Modal open={createOpen} title={t('queue.action.create')} onClose={() => { createOpen = false; }}>
    <SpawnAgentForm
      mode="queue"
      roles={data.roles}
      repos={data.repos}
      cliKinds={data.cliKinds}
      spawnDefaults={data.spawnDefaults}
      {queueDepOptions}
      onQueue={onQueue}
      onCancel={() => { createOpen = false; }}
    />
  </Modal>
{/if}

<PlanViewerModal
  source={planTaskId ? { kind: 'task', taskId: planTaskId } : { kind: 'task', taskId: '' }}
  open={planTaskId !== null}
  onClose={closeTaskPlan}
/>

<style>
  /* Styling reads the Material Design 3 token layer defined in
     src/app.css (--md-sys-color-*, --md-sys-shape-*, --md-sys-motion-*),
     so the Tasks page recolors live with the active theme and stays
     usable down to a compact (phone) window. */
  .page {
    padding: 1.25rem;
    /* Keep the last row clear of the FAB + the device's bottom inset. */
    padding-bottom: calc(6rem + env(safe-area-inset-bottom));
    display: grid;
    gap: 1.25rem;
    max-width: 60rem;
    margin: 0 auto;
  }
  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 1rem;
  }
  h1 {
    margin: 0;
    color: var(--md-sys-color-on-surface);
    font-size: 1.3rem;
  }
  .subtitle {
    margin: 0.2rem 0 0;
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.85rem;
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .concurrency-summary {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.8rem;
  }
  /* Floating action button — matches the repo dashboard's pattern. */
  .fab {
    position: fixed;
    right: calc(2rem + env(safe-area-inset-right));
    bottom: calc(2rem + env(safe-area-inset-bottom));
    width: 3.5rem;
    height: 3.5rem;
    border-radius: var(--md-sys-shape-corner-full);
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    border: none;
    font-size: 1.75rem;
    cursor: pointer;
    box-shadow: 0 6px 18px color-mix(in srgb, var(--md-sys-color-primary) 45%, transparent);
    z-index: 30;
  }
  .fab:hover {
    background: color-mix(in srgb, var(--md-sys-color-primary) 85%, black);
  }
  section {
    display: grid;
    gap: 0.5rem;
  }
  section h2 {
    margin: 0;
    color: var(--md-sys-color-on-surface);
    font-size: 0.95rem;
    font-weight: 500;
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.4rem;
  }
  .entries-dim {
    opacity: 0.7;
  }
  .entry {
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-md);
    background: var(--md-sys-color-surface-container-low);
    transition: background var(--md-sys-motion-duration-short)
      var(--md-sys-motion-easing-standard);
  }
  .entry.is-expanded {
    background: var(--md-sys-color-surface-container);
  }
  .entry-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.55rem 0.8rem;
  }
  .entry-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem 0.5rem;
    flex: 1;
    min-width: 0;
    cursor: pointer;
    user-select: none;
    background: transparent;
    border-radius: var(--md-sys-shape-corner-sm);
  }
  .entry-head:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 2px;
  }
  .chevron {
    flex-shrink: 0;
    color: var(--md-sys-color-on-surface-variant);
    transform: rotate(-90deg);
    transition: transform var(--md-sys-motion-duration-short)
      var(--md-sys-motion-easing-standard);
  }
  .chevron.open {
    transform: rotate(0deg);
  }
  .entry-title {
    color: var(--md-sys-color-on-surface);
    font-weight: 500;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--md-sys-color-on-surface-variant);
  }
  .status {
    display: inline-block;
    flex-shrink: 0;
    padding: 0.1rem 0.5rem;
    border-radius: var(--md-sys-shape-corner-full);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: color-mix(
      in srgb,
      var(--md-sys-color-on-surface-variant) 16%,
      transparent
    );
    color: var(--md-sys-color-on-surface-variant);
  }
  .status-running,
  .status-done {
    background: color-mix(in srgb, var(--md-sys-color-success) 20%, transparent);
    color: var(--md-sys-color-success);
  }
  .status-ready {
    background: color-mix(in srgb, var(--md-sys-color-info) 20%, transparent);
    color: var(--md-sys-color-info);
  }
  .status-backlog {
    background: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
  }
  .status-failed {
    background: color-mix(in srgb, var(--md-sys-color-error) 20%, transparent);
    color: var(--md-sys-color-error);
  }
  /* blocked / pending / cancelled keep the neutral base. */
  .plan-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    flex-shrink: 0;
    padding: 0.1rem 0.45rem 0.1rem 0.4rem;
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-full);
    background: var(--md-sys-color-surface-container-high);
    color: var(--md-sys-color-primary);
    font: inherit;
    font-size: 0.7rem;
    cursor: pointer;
  }
  .plan-badge:hover {
    background: var(--md-sys-color-surface-container-highest);
  }
  .entry-actions {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    flex-shrink: 0;
  }
  .entry-actions:empty {
    display: none;
  }
  .link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--md-sys-color-primary);
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    padding: 0.3rem 0.25rem;
    min-height: 1.75rem;
    text-decoration: none;
    border-radius: var(--md-sys-shape-corner-sm);
  }
  .link:hover {
    text-decoration: underline;
  }
  .link.danger {
    color: var(--md-sys-color-error);
  }
  /* ── Expanded detail panel ──────────────────────────────────────── */
  .entry-detail {
    display: grid;
    gap: 0.85rem;
    padding: 0.75rem 0.8rem 0.9rem;
    border-top: 1px solid var(--md-sys-color-outline-variant);
  }
  .detail-block {
    display: grid;
    gap: 0.35rem;
  }
  .detail-block h3 {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--md-sys-color-on-surface-variant);
  }
  .detail-body {
    margin: 0;
    max-height: 22rem;
    overflow: auto;
    padding: 0.6rem 0.7rem;
    background: var(--md-sys-color-surface-container-lowest);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-sm);
    color: var(--md-sys-color-on-surface);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .detail-empty {
    margin: 0;
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.85rem;
    font-style: italic;
  }
  .detail-meta {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.45rem 1.25rem;
  }
  .meta-item {
    display: grid;
    gap: 0.1rem;
    min-width: 0;
  }
  .meta-item dt {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--md-sys-color-on-surface-variant);
  }
  .meta-item dd {
    margin: 0;
    font-size: 0.85rem;
    color: var(--md-sys-color-on-surface);
    overflow-wrap: anywhere;
  }
  .detail-error {
    margin: 0;
    color: var(--md-sys-color-error);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
  .empty {
    color: var(--md-sys-color-on-surface-variant);
    font-style: italic;
  }

  /* ── Compact window (M3 "compact" width class, < 600dp) ───────────
     Phones: stack the action cluster under the row, give every control
     a comfortable touch target, and collapse the metadata to one
     column so nothing is truncated or cramped. */
  @media (max-width: 600px) {
    .page {
      padding: 0.9rem;
      padding-bottom: calc(6rem + env(safe-area-inset-bottom));
      gap: 1rem;
    }
    .page-head {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.4rem;
    }
    .entry-row {
      flex-direction: column;
      align-items: stretch;
      gap: 0.55rem;
    }
    .entry-actions {
      flex-wrap: wrap;
      gap: 0.25rem;
      border-top: 1px solid var(--md-sys-color-outline-variant);
      padding-top: 0.45rem;
    }
    .link {
      flex: 1 1 auto;
      min-height: 48px;
      padding: 0.5rem 0.75rem;
      font-size: 0.9rem;
    }
    .detail-meta {
      grid-template-columns: 1fr;
      gap: 0.55rem;
    }
  }
</style>
