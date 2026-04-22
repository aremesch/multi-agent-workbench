<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';
  import ArchivedAgentLogModal from '$lib/client/components/ArchivedAgentLogModal.svelte';
  import Modal from '$lib/client/components/Modal.svelte';
  import { apiFetch } from '$lib/client/api';
  import { formatDurationHMS, formatTimestamp, formatTokens } from '$lib/shared/format';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let { data }: { data: PageData } = $props();

  let openAgentId = $state<string | null>(null);
  let openAgentTitle = $state<string>('');
  let expanded = $state<Record<string, boolean>>({});

  /** Delete-confirm state machine. `stage` drives which body the modal renders. */
  type DeleteStage = 'closed' | 'confirm' | 'dirty' | 'working' | 'error';
  let deleteStage = $state<DeleteStage>('closed');
  let deleteAgentId = $state<string | null>(null);
  let deleteAgentTitle = $state<string>('');
  let dirtyFiles = $state<string[]>([]);
  let deleteError = $state<string>('');

  let refreshing = $state<Record<string, boolean>>({});
  let refreshToast = $state<Record<string, string>>({});

  function viewLog(entry: PageData['archivedAgents'][number]): void {
    openAgentId = entry.agent.id;
    openAgentTitle = `${entry.agent.role_name} — ${entry.agent.cli_kind} (${entry.agent.status})`;
  }
  function closeLog(): void {
    openAgentId = null;
  }
  function toggle(agentId: string): void {
    expanded[agentId] = !expanded[agentId];
  }
  function commitUrl(sha: string): string | null {
    return data.remote ? `${data.remote.webBase}/commit/${sha}` : null;
  }
  /** Collapse git's hard-wrapped lines into flowing text, keeping paragraph breaks. */
  function reflowBody(body: string): string {
    return body
      .replace(/\r\n/g, '\n')
      .split(/\n{2,}/)
      .map((para) => para.replace(/\n/g, ' '))
      .join('\n\n');
  }

  async function refreshCommits(agentId: string): Promise<void> {
    refreshing[agentId] = true;
    refreshToast[agentId] = '';
    try {
      const res = await apiFetch(`/api/agents/${agentId}/commits`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        preserved?: number;
        captured?: number;
        error?: string;
      };
      if (!res.ok) {
        refreshToast[agentId] = t('archive.refresh.error', {
          message: body.error ?? `HTTP ${res.status}`
        });
        return;
      }
      if (typeof body.preserved === 'number') {
        refreshToast[agentId] = t('archive.refresh.preserved');
      }
      await invalidateAll();
    } catch (err) {
      refreshToast[agentId] = t('archive.refresh.error', {
        message: err instanceof Error ? err.message : String(err)
      });
    } finally {
      refreshing[agentId] = false;
    }
  }

  function askDelete(entry: PageData['archivedAgents'][number]): void {
    deleteAgentId = entry.agent.id;
    deleteAgentTitle = `${entry.agent.role_name} — ${entry.agent.cli_kind}`;
    dirtyFiles = [];
    deleteError = '';
    deleteStage = 'confirm';
  }
  function closeDelete(): void {
    if (deleteStage === 'working') return;
    deleteStage = 'closed';
    deleteAgentId = null;
  }
  async function runDelete(force: boolean): Promise<void> {
    if (!deleteAgentId) return;
    deleteStage = 'working';
    deleteError = '';
    const qs = force ? 'removeWorktree=1&force=1' : 'removeWorktree=1';
    try {
      const res = await apiFetch(`/api/agents/${deleteAgentId}?${qs}`, { method: 'DELETE' });
      if (res.status === 204) {
        deleteStage = 'closed';
        deleteAgentId = null;
        await invalidateAll();
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as {
          code?: string;
          changedFiles?: string[];
        };
        if (body.code === 'worktree_dirty') {
          dirtyFiles = body.changedFiles ?? [];
          deleteStage = 'dirty';
          return;
        }
        deleteError = body.code ?? `HTTP ${res.status}`;
        deleteStage = 'error';
        return;
      }
      deleteError = `HTTP ${res.status}`;
      deleteStage = 'error';
    } catch (err) {
      deleteError = err instanceof Error ? err.message : String(err);
      deleteStage = 'error';
    }
  }
</script>

<header class="head">
  <a class="back" href={`/repos/${data.repo.id}`}>← {data.repo.path}</a>
  <h1>{t('archive.title')}</h1>
</header>

<main>
  {#if data.archivedAgents.length === 0}
    <p class="empty">{t('archive.noArchived')}</p>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th aria-label={t('sidebar.expand')}></th>
            <th>{t('archive.th.title')}</th>
            <th>{t('archive.th.role')}</th>
            <th>{t('archive.th.cli')}</th>
            <th>{t('archive.th.status')}</th>
            <th>{t('archive.th.exit')}</th>
            <th>{t('archive.th.started')}</th>
            <th>{t('archive.th.ended')}</th>
            <th class="num">{t('archive.th.total')}</th>
            <th class="num">{t('archive.th.active')}</th>
            <th class="num">{t('archive.th.idle')}</th>
            <th class="num">{t('archive.th.in')}</th>
            <th class="num">{t('archive.th.out')}</th>
            <th class="num">{t('archive.th.cacheW')}</th>
            <th class="num">{t('archive.th.cacheR')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each data.archivedAgents as entry (entry.agent.id)}
            <tr class="summary-row" class:has-commits={entry.commits.length > 0}>
              <td class="toggle-cell">
                <button
                  type="button"
                  class="toggle"
                  aria-expanded={expanded[entry.agent.id] ? 'true' : 'false'}
                  aria-label={expanded[entry.agent.id] ? t('archive.collapseCommits') : t('archive.expandCommits')}
                  disabled={entry.commits.length === 0}
                  onclick={() => toggle(entry.agent.id)}
                >
                  {expanded[entry.agent.id] ? '▾' : '▸'}
                  <span class="count">{entry.commits.length}</span>
                </button>
              </td>
              <td class="agent-name">{entry.agent.task_title ?? '—'}</td>
              <td>{entry.agent.role_name}</td>
              <td>{entry.agent.cli_kind}</td>
              <td><span class="status status-{entry.agent.status}">{entry.agent.status}</span></td>
              <td title={entry.run?.reason ?? ''}>
                {entry.run?.exit_code ?? '—'}
                {#if entry.run?.reason}
                  <span class="reason">· {entry.run.reason}</span>
                {/if}
              </td>
              <td>{formatTimestamp(entry.run?.started_at ?? entry.agent.created_at)}</td>
              <td>{formatTimestamp(entry.run?.ended_at ?? entry.agent.updated_at)}</td>
              <td class="num">{formatDurationHMS(entry.totalSec)}</td>
              <td class="num">{formatDurationHMS(entry.stats.activeSec)}</td>
              <td class="num">{formatDurationHMS(entry.stats.idleSec)}</td>
              <td class="num">{formatTokens(entry.tokens?.inputTokens)}</td>
              <td class="num">{formatTokens(entry.tokens?.outputTokens)}</td>
              <td class="num">{formatTokens(entry.tokens?.cacheCreationTokens)}</td>
              <td class="num">{formatTokens(entry.tokens?.cacheReadTokens)}</td>
              <td class="actions-cell">
                <button type="button" class="view-btn" onclick={() => viewLog(entry)}
                  >{t('archive.viewLogs')}</button
                >
                <button
                  type="button"
                  class="refresh-btn"
                  aria-label={t('archive.refresh.btn')}
                  title={refreshToast[entry.agent.id] || t('archive.refresh.btn')}
                  disabled={refreshing[entry.agent.id]}
                  onclick={() => refreshCommits(entry.agent.id)}
                >
                  {#if refreshing[entry.agent.id]}
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                      stroke="currentColor" stroke-width="2" stroke-linecap="round"
                      stroke-linejoin="round" aria-hidden="true" class="spin">
                      <path d="M21 12a9 9 0 1 1-3-6.7" />
                      <path d="M21 4v5h-5" />
                    </svg>
                  {:else}
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                      stroke="currentColor" stroke-width="2" stroke-linecap="round"
                      stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-3-6.7" />
                      <path d="M21 4v5h-5" />
                    </svg>
                  {/if}
                </button>
                <button
                  type="button"
                  class="delete-btn"
                  aria-label={t('archive.delete.btn')}
                  title={t('archive.delete.btn')}
                  onclick={() => askDelete(entry)}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 6h18" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6" />
                    <path d="M14 11v6" />
                  </svg>
                </button>
              </td>
            </tr>
            {#if expanded[entry.agent.id] && entry.commits.length > 0}
              <tr class="commits-row">
                <td colspan="16">
                  <ul class="commits">
                    {#each entry.commits as c (c.sha)}
                      <li>
                        {#if commitUrl(c.sha)}
                          <a
                            class="sha"
                            class:stale={!c.reachable}
                            href={commitUrl(c.sha)}
                            target="_blank"
                            rel="noopener"
                            title={c.reachable
                              ? `${c.author} · ${c.date}`
                              : t('archive.commit.stale')}>{c.shortSha}</a
                          >
                        {:else}
                          <span
                            class="sha"
                            class:stale={!c.reachable}
                            title={c.reachable
                              ? `${c.author} · ${c.date}`
                              : t('archive.commit.stale')}>{c.shortSha}</span
                          >
                        {/if}
                        <span class="subject">{c.subject}</span>
                        {#if c.body}
                          <p class="body">{reflowBody(c.body)}</p>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
        {#if data.archivedAgents.length > 0}
          <tfoot>
            <tr class="totals-row">
              <td></td>
              <td class="totals-label">{t('archive.th.total.row')}</td>
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <td class="num">{formatDurationHMS(data.totals.totalSec)}</td>
              <td class="num">{formatDurationHMS(data.totals.activeSec)}</td>
              <td class="num">{formatDurationHMS(data.totals.idleSec)}</td>
              <td class="num"
                >{data.totals.tokenRowCount > 0
                  ? formatTokens(data.totals.inputTokens)
                  : '—'}</td
              >
              <td class="num"
                >{data.totals.tokenRowCount > 0
                  ? formatTokens(data.totals.outputTokens)
                  : '—'}</td
              >
              <td class="num"
                >{data.totals.tokenRowCount > 0
                  ? formatTokens(data.totals.cacheCreationTokens)
                  : '—'}</td
              >
              <td class="num"
                >{data.totals.tokenRowCount > 0
                  ? formatTokens(data.totals.cacheReadTokens)
                  : '—'}</td
              >
              <td></td>
            </tr>
          </tfoot>
        {/if}
      </table>
    </div>
    <p class="note">
      {t('archive.note')}
    </p>
  {/if}
</main>

<ArchivedAgentLogModal
  agentId={openAgentId}
  title={openAgentTitle}
  open={openAgentId !== null}
  onClose={closeLog}
/>

<Modal
  open={deleteStage !== 'closed'}
  onClose={closeDelete}
  title={t('archive.delete.title')}
>
  <div class="delete-modal">
    {#if deleteStage === 'confirm' || deleteStage === 'working'}
      <p class="delete-agent-name">{deleteAgentTitle}</p>
      <p>{t('archive.delete.confirm')}</p>
      <div class="delete-actions">
        <button
          type="button"
          class="btn-ghost"
          onclick={closeDelete}
          disabled={deleteStage === 'working'}>{t('common.cancel')}</button
        >
        <button
          type="button"
          class="btn-danger"
          onclick={() => runDelete(false)}
          disabled={deleteStage === 'working'}>{t('archive.delete.confirmBtn')}</button
        >
      </div>
    {:else if deleteStage === 'dirty'}
      <p class="delete-agent-name">{deleteAgentTitle}</p>
      <p class="warn">{t('archive.delete.confirmDirty')}</p>
      <ul class="dirty-list">
        {#each dirtyFiles.slice(0, 10) as f (f)}
          <li>{f}</li>
        {/each}
      </ul>
      {#if dirtyFiles.length > 10}
        <p class="dirty-more">{t('archive.delete.dirtyMore', { count: dirtyFiles.length - 10 })}</p>
      {/if}
      <div class="delete-actions">
        <button type="button" class="btn-ghost" onclick={closeDelete}
          >{t('common.cancel')}</button
        >
        <button type="button" class="btn-danger" onclick={() => runDelete(true)}
          >{t('archive.delete.forceBtn')}</button
        >
      </div>
    {:else if deleteStage === 'error'}
      <p class="warn">{t('archive.delete.error', { message: deleteError })}</p>
      <div class="delete-actions">
        <button type="button" class="btn-ghost" onclick={closeDelete}
          >{t('common.close')}</button
        >
      </div>
    {/if}
  </div>
</Modal>

<style>
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .head h1 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 500;
    color: var(--md-sys-color-on-surface);
  }
  .back {
    font-size: 0.85rem;
    color: var(--md-sys-color-on-surface-variant);
    text-decoration: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .back:hover {
    color: var(--md-sys-color-on-surface);
  }
  .empty {
    color: var(--md-sys-color-on-surface-variant);
    font-style: italic;
  }
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: 0.5rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  th,
  td {
    padding: 0.5rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
    white-space: nowrap;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  th {
    font-weight: 500;
    color: var(--md-sys-color-on-surface-variant);
    background: var(--md-sys-color-surface-container-high);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
  tbody tr:hover {
    background: color-mix(in srgb, var(--md-sys-color-on-surface) 4%, transparent);
  }
  .agent-name {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
  }
  .reason {
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.75rem;
  }
  .status {
    font-size: 0.7rem;
    padding: 0.1rem 0.45rem;
    border-radius: 0.25rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    background: #1f2937;
    color: #9ca3af;
  }
  .status-exited {
    background: #374151;
    color: #d1d5db;
  }
  .status-crashed {
    background: #7f1d1d;
    color: #fecaca;
  }
  .view-btn {
    font-size: 0.8rem;
    padding: 0.3rem 0.7rem;
    border-radius: 0.25rem;
    background: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
    border: none;
    cursor: pointer;
  }
  .view-btn:hover {
    filter: brightness(1.1);
  }
  .actions-cell {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .delete-btn {
    background: transparent;
    border: none;
    color: var(--md-sys-color-on-surface-variant);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .delete-btn:hover {
    background: color-mix(in srgb, #dc2626 20%, transparent);
    color: #fca5a5;
  }
  .totals-row td {
    font-weight: 600;
    background: color-mix(in srgb, var(--md-sys-color-on-surface) 5%, transparent);
    border-top: 2px solid var(--md-sys-color-outline-variant);
    border-bottom: none;
  }
  .totals-label {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .delete-modal {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 22rem;
    max-width: 36rem;
    font-size: 0.9rem;
    color: #e5e7eb;
  }
  .delete-modal p {
    margin: 0;
  }
  .delete-agent-name {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #9ca3af;
    font-size: 0.8rem;
  }
  .delete-modal .warn {
    color: #fca5a5;
  }
  .dirty-list {
    margin: 0;
    padding: 0.35rem 0 0.35rem 1.25rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    color: #d1d5db;
    max-height: 10rem;
    overflow-y: auto;
    list-style: disc;
  }
  .dirty-more {
    font-size: 0.75rem;
    color: #9ca3af;
    font-style: italic;
  }
  .delete-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .btn-ghost {
    background: transparent;
    border: 1px solid #374151;
    color: #d1d5db;
    padding: 0.35rem 0.9rem;
    border-radius: 0.25rem;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .btn-ghost:hover:not(:disabled) {
    background: #1f2937;
  }
  .btn-danger {
    background: #991b1b;
    border: 1px solid #b91c1c;
    color: #fecaca;
    padding: 0.35rem 0.9rem;
    border-radius: 0.25rem;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .btn-danger:hover:not(:disabled) {
    background: #b91c1c;
    color: #fef2f2;
  }
  .btn-ghost:disabled,
  .btn-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .toggle-cell {
    width: 2.5rem;
    padding-right: 0;
  }
  .toggle {
    background: transparent;
    border: none;
    color: var(--md-sys-color-on-surface-variant);
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0.15rem 0.35rem;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-variant-numeric: tabular-nums;
  }
  .toggle:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .toggle .count {
    font-size: 0.7rem;
    opacity: 0.75;
  }
  .commits-row > td {
    background: color-mix(in srgb, var(--md-sys-color-on-surface) 3%, transparent);
    padding: 0.5rem 0.75rem 0.75rem;
    white-space: normal;
  }
  .commits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .commits li {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 0.6rem;
    align-items: baseline;
    font-size: 0.8rem;
    padding-bottom: 0.35rem;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }
  .commits li:last-child {
    padding-bottom: 0;
    border-bottom: none;
  }
  .commits .sha {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    color: var(--md-sys-color-primary);
    text-decoration: none;
  }
  .commits a.sha:hover {
    text-decoration: underline;
  }
  .commits .sha.stale {
    opacity: 0.55;
    text-decoration: line-through dotted;
  }
  .commits a.sha.stale:hover {
    text-decoration: line-through underline;
  }
  .refresh-btn {
    background: transparent;
    border: none;
    color: var(--md-sys-color-on-surface-variant);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .refresh-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
    color: var(--md-sys-color-on-surface);
  }
  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .refresh-btn .spin {
    animation: archive-refresh-spin 0.9s linear infinite;
  }
  @keyframes archive-refresh-spin {
    to { transform: rotate(360deg); }
  }
  .commits .subject {
    color: var(--md-sys-color-on-surface);
  }
  .commits .body {
    grid-column: 2;
    margin: 0.15rem 0 0;
    font-size: 0.75rem;
    color: var(--md-sys-color-on-surface-variant);
    white-space: pre-line;
    line-height: 1.45;
  }
  .note {
    margin-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--md-sys-color-on-surface-variant);
    font-style: italic;
  }
</style>
