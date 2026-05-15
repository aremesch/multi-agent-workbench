<script lang="ts">
  import { invalidate, invalidateAll } from '$app/navigation';
  import { apiFetch } from '$lib/client/api';
  import { useT } from '$lib/client/i18n.svelte';
  import Modal from '$lib/client/components/Modal.svelte';
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
  const openEntriesCount = $derived(
    entries.filter((e) =>
      ['pending', 'blocked', 'ready', 'running'].includes(e.status as string)
    ).length
  );

  function groupEntries(rows: QueueEntryRow[]): {
    running: QueueEntryRow[];
    ready: QueueEntryRow[];
    blocked: QueueEntryRow[];
    completed: QueueEntryRow[];
  } {
    const running: QueueEntryRow[] = [];
    const ready: QueueEntryRow[] = [];
    const blocked: QueueEntryRow[] = [];
    const completed: QueueEntryRow[] = [];
    for (const e of rows) {
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
        case 'done':
        case 'failed':
        case 'cancelled':
          completed.push(e);
          break;
      }
    }
    return { running, ready, blocked, completed };
  }

  function statusLabel(s: QueueEntryStatus): string {
    return t(`queue.status.${s}` as never);
  }

  function statusClass(s: QueueEntryStatus): string {
    return `status status-${s}`;
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

  function formatScheduledFor(ts: number | null): string {
    if (!ts) return '—';
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch {
      return String(ts);
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
          depends_on: payload.depends_on
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
      <button type="button" class="primary" onclick={() => { createOpen = true; }}>
        + {t('queue.action.create')}
      </button>
    </div>
  </header>

  {#if entries.length === 0}
    <p class="empty">{t('queue.empty')}</p>
  {/if}

  {#if grouped.running.length > 0}
    <section>
      <h2>{t('queue.section.running')} ({grouped.running.length})</h2>
      <ul class="entries">
        {#each grouped.running as e (e.id)}
          <li class="entry">
            <div class="entry-main">
              <span class={statusClass(e.status)}>{statusLabel(e.status)}</span>
              <span class="entry-title">{e.title}</span>
              <span class="muted entry-meta">
                {roleName(e.role_id)} · {repoLabel(e.repo_id)}
                {#if e.model}· {e.model}{/if}
                {#if e.source_branch}· {e.source_branch}{/if}
              </span>
            </div>
            <div class="entry-actions">
              {#if e.agent_id}
                <a href={`/agents/${e.agent_id}`} class="link">{t('queue.action.openAgent')}</a>
              {/if}
              <button type="button" class="link danger" onclick={() => onCancelEntry(e.id)}>
                {t('queue.action.cancel')}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if grouped.ready.length > 0}
    <section>
      <h2>{t('queue.section.ready')} ({grouped.ready.length})</h2>
      <ul class="entries">
        {#each grouped.ready as e (e.id)}
          <li class="entry">
            <div class="entry-main">
              <span class={statusClass(e.status)}>{statusLabel(e.status)}</span>
              <span class="entry-title">{e.title}</span>
              <span class="muted entry-meta">
                {roleName(e.role_id)} · {repoLabel(e.repo_id)}
                {#if e.model}· {e.model}{/if}
                {#if e.priority !== 0}· prio {e.priority}{/if}
              </span>
            </div>
            <div class="entry-actions">
              <button type="button" class="link" onclick={() => onPromoteEntry(e.id)}>
                {t('queue.action.runNow')}
              </button>
              <button type="button" class="link danger" onclick={() => onCancelEntry(e.id)}>
                {t('queue.action.cancel')}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if grouped.blocked.length > 0}
    <section>
      <h2>{t('queue.section.blocked')} ({grouped.blocked.length})</h2>
      <ul class="entries">
        {#each grouped.blocked as e (e.id)}
          <li class="entry">
            <div class="entry-main">
              <span class={statusClass(e.status)}>{statusLabel(e.status)}</span>
              <span class="entry-title">{e.title}</span>
              <span class="muted entry-meta">
                {roleName(e.role_id)} · {repoLabel(e.repo_id)}
                {#if e.scheduled_for}· {t('queue.column.scheduledFor')}: {formatScheduledFor(e.scheduled_for)}{/if}
                {#if e.priority !== 0}· prio {e.priority}{/if}
              </span>
              {#if e.depends_on_json && e.depends_on_json !== '[]'}
                <span class="deps-line muted">
                  {t('queue.column.dependsOn')}:
                  {(JSON.parse(e.depends_on_json) as string[])
                    .map((id) => depTitle(id))
                    .join(', ')}
                </span>
              {/if}
              {#if e.last_error}
                <span class="err">{t('queue.lastError', { message: e.last_error })}</span>
              {/if}
            </div>
            <div class="entry-actions">
              <button type="button" class="link" onclick={() => onPromoteEntry(e.id)}>
                {t('queue.action.runNow')}
              </button>
              <button type="button" class="link danger" onclick={() => onCancelEntry(e.id)}>
                {t('queue.action.cancel')}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if grouped.completed.length > 0}
    <section>
      <h2>{t('queue.section.completed')} ({grouped.completed.length})</h2>
      <ul class="entries entries-dim">
        {#each grouped.completed as e (e.id)}
          <li class="entry">
            <div class="entry-main">
              <span class={statusClass(e.status)}>{statusLabel(e.status)}</span>
              <span class="entry-title">{e.title}</span>
              <span class="muted entry-meta">
                {roleName(e.role_id)} · {repoLabel(e.repo_id)}
              </span>
              {#if e.last_error}
                <span class="err">{t('queue.lastError', { message: e.last_error })}</span>
              {/if}
            </div>
            <div class="entry-actions">
              {#if e.agent_id}
                <a href={`/agents/${e.agent_id}`} class="link">{t('queue.action.openAgent')}</a>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

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

<style>
  .page {
    padding: 1.25rem;
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
    color: #e5e7eb;
    font-size: 1.3rem;
  }
  .subtitle {
    margin: 0.2rem 0 0;
    color: #9ca3af;
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
  .primary {
    padding: 0.55rem 0.9rem;
    border-radius: 0.4rem;
    background: #2563eb;
    border: none;
    color: #fff;
    cursor: pointer;
    font: inherit;
  }
  .primary:hover {
    background: #1d4ed8;
  }
  section {
    display: grid;
    gap: 0.5rem;
  }
  section h2 {
    margin: 0;
    color: #e5e7eb;
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
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.55rem 0.8rem;
    border: 1px solid #1f2937;
    border-radius: 0.4rem;
    background: #0b0f17;
  }
  .entry-main {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
    flex: 1;
  }
  .entry-title {
    color: #e5e7eb;
    font-weight: 500;
  }
  .entry-meta {
    font-size: 0.8rem;
  }
  .deps-line {
    font-size: 0.8rem;
  }
  .muted {
    color: #6b7280;
  }
  .status {
    display: inline-block;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: #1f2937;
    color: #93c5fd;
    margin-right: 0.4rem;
  }
  .status-running {
    background: #064e3b;
    color: #6ee7b7;
  }
  .status-ready {
    background: #1e3a8a;
    color: #bfdbfe;
  }
  .status-blocked,
  .status-pending {
    background: #1f2937;
    color: #9ca3af;
  }
  .status-done {
    background: #064e3b;
    color: #a7f3d0;
  }
  .status-failed {
    background: #7f1d1d;
    color: #fecaca;
  }
  .status-cancelled {
    background: #374151;
    color: #d1d5db;
  }
  .entry-actions {
    display: flex;
    gap: 0.6rem;
    align-items: center;
  }
  .link {
    background: transparent;
    border: none;
    color: #93c5fd;
    cursor: pointer;
    font: inherit;
    padding: 0;
    font-size: 0.85rem;
    text-decoration: none;
  }
  .link:hover {
    text-decoration: underline;
  }
  .link.danger {
    color: #fca5a5;
  }
  .empty {
    color: #9ca3af;
    font-style: italic;
  }
  .err {
    color: #fca5a5;
    font-size: 0.8rem;
  }
</style>
