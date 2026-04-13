<script lang="ts">
  import type { PageData } from './$types';
  import ArchivedAgentLogModal from '$lib/client/components/ArchivedAgentLogModal.svelte';
  import { formatDurationHMS, formatTimestamp } from '$lib/shared/format';

  let { data }: { data: PageData } = $props();

  function fmtTokens(n: number | null | undefined): string {
    if (n == null || n === 0) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  let openAgentId = $state<string | null>(null);
  let openAgentTitle = $state<string>('');

  function viewLog(entry: PageData['archivedAgents'][number]): void {
    openAgentId = entry.agent.id;
    openAgentTitle = `${entry.agent.role_name} — ${entry.agent.cli_kind} (${entry.agent.status})`;
  }
  function closeLog(): void {
    openAgentId = null;
  }
</script>

<header class="head">
  <a class="back" href={`/repos/${data.repo.id}`}>← {data.repo.path}</a>
  <h1>Archive</h1>
</header>

<main>
  {#if data.archivedAgents.length === 0}
    <p class="empty">No archived agents for this repo.</p>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>CLI</th>
            <th>Status</th>
            <th>Exit</th>
            <th>Started</th>
            <th>Ended</th>
            <th class="num">Total</th>
            <th class="num">Active</th>
            <th class="num">Idle</th>
            <th class="num">In</th>
            <th class="num">Out</th>
            <th class="num">Cache W</th>
            <th class="num">Cache R</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each data.archivedAgents as entry (entry.agent.id)}
            <tr>
              <td class="agent-name">{entry.agent.name ?? '—'}</td>
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
              <td class="num">{fmtTokens(entry.tokens?.inputTokens)}</td>
              <td class="num">{fmtTokens(entry.tokens?.outputTokens)}</td>
              <td class="num">{fmtTokens(entry.tokens?.cacheCreationTokens)}</td>
              <td class="num">{fmtTokens(entry.tokens?.cacheReadTokens)}</td>
              <td>
                <button type="button" class="view-btn" onclick={() => viewLog(entry)}
                  >View logs</button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="note">
      Active/idle is a 30s-gap heuristic over the persisted terminal log. Token counts are
      sourced from Claude Code's JSONL transcript (available for claude-code agents only).
    </p>
  {/if}
</main>

<ArchivedAgentLogModal
  agentId={openAgentId}
  title={openAgentTitle}
  open={openAgentId !== null}
  onClose={closeLog}
/>

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
    color: var(--md-sys-color-on-surface);
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
  .note {
    margin-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--md-sys-color-on-surface-variant);
    font-style: italic;
  }
</style>
