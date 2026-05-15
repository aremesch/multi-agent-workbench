<script lang="ts">
  import type { PageData } from './$types';
  import { useT } from '$lib/client/i18n.svelte';
  import { apiFetch } from '$lib/client/api';
  import { invalidateAll } from '$app/navigation';
  import RoleEditDialog from '$lib/client/components/RoleEditDialog.svelte';
  import ConfirmDialog from '$lib/client/components/ConfirmDialog.svelte';
  import type { RoleRow } from '$lib/server/db/types';

  let { data }: { data: PageData } = $props();
  const t = useT();

  let editorOpen = $state(false);
  let editingRole = $state<RoleRow | null>(null);

  let confirmOpen = $state(false);
  let confirmTarget = $state<RoleRow | null>(null);
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  function openCreate(): void {
    editingRole = null;
    editorOpen = true;
  }
  function openEdit(role: RoleRow): void {
    editingRole = role;
    editorOpen = true;
  }
  function closeEditor(): void {
    editorOpen = false;
    editingRole = null;
  }
  async function onSaved(): Promise<void> {
    closeEditor();
    await invalidateAll();
  }

  function requestDelete(role: RoleRow): void {
    deleteError = null;
    confirmTarget = role;
    confirmOpen = true;
  }
  function cancelDelete(): void {
    confirmOpen = false;
    confirmTarget = null;
  }
  async function confirmDelete(): Promise<void> {
    if (!confirmTarget) return;
    deleting = true;
    deleteError = null;
    try {
      const res = await apiFetch(`/api/roles/${confirmTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        deleteError = body.error ?? t('roles.error.deleteFailed');
        return;
      }
      confirmOpen = false;
      confirmTarget = null;
      await invalidateAll();
    } catch {
      deleteError = t('spawn.error.networkError');
    } finally {
      deleting = false;
    }
  }

  function describeModel(role: RoleRow): string {
    const adapter = data.cliKinds.find((k) => k.kind === role.cli_kind);
    const cap = adapter?.capabilities.model;
    if (!cap) return '—';
    const id = role.default_model ?? cap.default ?? '';
    return cap.values.find((v) => v.id === id)?.label ?? id ?? '—';
  }
  function describeMode(role: RoleRow): string {
    const adapter = data.cliKinds.find((k) => k.kind === role.cli_kind);
    const cap = adapter?.capabilities.permissionMode;
    if (!cap) return '—';
    const id = role.default_permission_mode ?? cap.default ?? '';
    return cap.values.find((v) => v.id === id)?.label ?? id ?? '—';
  }
  function trimPrompt(s: string): string {
    const trimmed = s.replace(/\s+/g, ' ').trim();
    return trimmed.length > 60 ? trimmed.slice(0, 60).trimEnd() + '…' : trimmed;
  }
</script>

<header class="head">
  <h1>{t('roles.title')}</h1>
  <button type="button" class="btn-primary" onclick={openCreate}>{t('roles.newRole')}</button>
</header>

{#if data.roles.length === 0}
  <p class="muted">{t('roles.noRoles')}</p>
{:else}
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>{t('roles.colName')}</th>
          <th>{t('roles.colCliKind')}</th>
          <th>{t('roles.colModel')}</th>
          <th>{t('roles.colMode')}</th>
          <th>{t('roles.colSystemPrompt')}</th>
          <th class="actions-col">{t('roles.colActions')}</th>
        </tr>
      </thead>
      <tbody>
        {#each data.roles as r (r.id)}
          <tr>
            <td><strong>{r.name}</strong></td>
            <td><code>{r.cli_kind}</code></td>
            <td>{describeModel(r)}</td>
            <td>{describeMode(r)}</td>
            <td class="prompt-cell">{trimPrompt(r.system_prompt) || t('roles.noSystemPrompt')}</td>
            <td class="actions-col">
              <button type="button" class="btn-small" onclick={() => openEdit(r)}>
                {t('common.edit')}
              </button>
              <button
                type="button"
                class="btn-small destructive"
                onclick={() => requestDelete(r)}
              >
                {t('common.delete')}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<p><a href="/" class="muted">{t('roles.backToDashboard')}</a></p>

<RoleEditDialog
  open={editorOpen}
  role={editingRole}
  cliKinds={data.cliKinds}
  onSaved={onSaved}
  onCancel={closeEditor}
/>

<ConfirmDialog
  open={confirmOpen}
  title={t('roles.confirmDeleteTitle')}
  body={confirmTarget
    ? t('roles.confirmDeleteBody', { name: confirmTarget.name })
    : ''}
  confirmLabel={deleting ? t('roles.deleting') : t('common.delete')}
  cancelLabel={t('spawn.cancel')}
  tone="destructive"
  onConfirm={confirmDelete}
  onCancel={cancelDelete}
/>

{#if deleteError}
  <p class="err">{deleteError}</p>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  h1 {
    margin: 0;
  }
  .muted {
    color: #6b7280;
  }
  .table-wrap {
    overflow-x: auto;
    border: 1px solid #1f2937;
    border-radius: 0.5rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  th,
  td {
    padding: 0.5rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid #1f2937;
    vertical-align: top;
  }
  thead th {
    background: #111827;
    color: #9ca3af;
    font-weight: 500;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
  code {
    background: #1f2937;
    padding: 0.1em 0.35em;
    border-radius: 0.25em;
    font-size: 0.78rem;
  }
  .prompt-cell {
    color: #d1d5db;
    max-width: 22rem;
  }
  .actions-col {
    white-space: nowrap;
    width: 1%;
  }
  .actions-col button + button {
    margin-left: 0.35rem;
  }
  .btn-small {
    background: #1f2937;
    color: #e5e7eb;
    border: 1px solid #374151;
    padding: 0.25rem 0.6rem;
    border-radius: 0.3rem;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .btn-small:hover {
    background: #273549;
  }
  .btn-small.destructive {
    background: #7f1d1d;
    border-color: #7f1d1d;
    color: #fee2e2;
  }
  .btn-small.destructive:hover {
    background: #991b1b;
  }
  .btn-primary {
    padding: 0.45rem 0.85rem;
    border-radius: 0.375rem;
    background: #2563eb;
    color: #fff;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
  }
  .btn-primary:hover {
    background: #1d4ed8;
  }
  .err {
    color: #f87171;
  }
  a {
    color: #93c5fd;
  }
</style>
