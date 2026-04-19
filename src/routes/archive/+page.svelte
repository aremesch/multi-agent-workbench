<script lang="ts">
  import type { PageData } from './$types';
  import { formatDurationHMS, formatTokens } from '$lib/shared/format';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let { data }: { data: PageData } = $props();

  function archiveHref(repoId: string): string {
    return `/repos/${repoId}/archive`;
  }
</script>

<header class="head">
  <h1>{t('archive.overview.title')}</h1>
</header>

<main>
  {#if data.summaries.length === 0}
    <p class="empty">{t('archive.overview.empty')}</p>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t('archive.overview.th.project')}</th>
            <th>{t('archive.overview.th.repo')}</th>
            <th class="num">{t('archive.overview.th.agents')}</th>
            <th class="num">{t('archive.th.total')}</th>
            <th class="num">{t('archive.th.active')}</th>
            <th class="num">{t('archive.th.idle')}</th>
            <th class="num">{t('archive.th.in')}</th>
            <th class="num">{t('archive.th.out')}</th>
            <th class="num">{t('archive.th.cacheW')}</th>
            <th class="num">{t('archive.th.cacheR')}</th>
          </tr>
        </thead>
        <tbody>
          {#each data.summaries as s (s.repo.id)}
            <tr>
              <td>
                <a class="row-link" href={archiveHref(s.repo.id)}
                  >{s.repo.projectName ?? '—'}</a
                >
              </td>
              <td>
                <a class="row-link repo-path" href={archiveHref(s.repo.id)}>{s.repo.path}</a>
              </td>
              <td class="num">{s.archivedCount}</td>
              <td class="num">{formatDurationHMS(s.totals.totalSec)}</td>
              <td class="num">{formatDurationHMS(s.totals.activeSec)}</td>
              <td class="num">{formatDurationHMS(s.totals.idleSec)}</td>
              <td class="num"
                >{s.totals.tokenRowCount > 0 ? formatTokens(s.totals.inputTokens) : '—'}</td
              >
              <td class="num"
                >{s.totals.tokenRowCount > 0 ? formatTokens(s.totals.outputTokens) : '—'}</td
              >
              <td class="num"
                >{s.totals.tokenRowCount > 0
                  ? formatTokens(s.totals.cacheCreationTokens)
                  : '—'}</td
              >
              <td class="num"
                >{s.totals.tokenRowCount > 0
                  ? formatTokens(s.totals.cacheReadTokens)
                  : '—'}</td
              >
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr class="totals-row">
            <td class="totals-label">{t('archive.th.total.row')}</td>
            <td></td>
            <td class="num">{data.grand.archivedCount}</td>
            <td class="num">{formatDurationHMS(data.grand.totalSec)}</td>
            <td class="num">{formatDurationHMS(data.grand.activeSec)}</td>
            <td class="num">{formatDurationHMS(data.grand.idleSec)}</td>
            <td class="num"
              >{data.grand.tokenRowCount > 0
                ? formatTokens(data.grand.inputTokens)
                : '—'}</td
            >
            <td class="num"
              >{data.grand.tokenRowCount > 0
                ? formatTokens(data.grand.outputTokens)
                : '—'}</td
            >
            <td class="num"
              >{data.grand.tokenRowCount > 0
                ? formatTokens(data.grand.cacheCreationTokens)
                : '—'}</td
            >
            <td class="num"
              >{data.grand.tokenRowCount > 0
                ? formatTokens(data.grand.cacheReadTokens)
                : '—'}</td
            >
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="note">{t('archive.overview.note')}</p>
  {/if}
</main>

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
  th {
    font-weight: 500;
    color: var(--md-sys-color-on-surface-variant);
    background: var(--md-sys-color-surface-container-high);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
  tbody tr:hover {
    background: color-mix(in srgb, var(--md-sys-color-on-surface) 4%, transparent);
  }
  .row-link {
    color: var(--md-sys-color-on-surface);
    text-decoration: none;
  }
  .row-link:hover {
    color: var(--md-sys-color-primary);
    text-decoration: underline;
  }
  .repo-path {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
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
  .note {
    margin-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--md-sys-color-on-surface-variant);
    font-style: italic;
  }
</style>
