<script lang="ts">
  import Modal from './Modal.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { apiFetch } from '$lib/client/api';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let {
    open,
    repoId,
    onClose,
    onSaved,
    onDeleted
  }: {
    open: boolean;
    repoId: string | null;
    onClose: () => void;
    onSaved?: (updated: { id: string; origin_url: string | null }) => void;
    onDeleted?: (id: string) => void;
  } = $props();

  let loading = $state(false);
  let saving = $state(false);
  let deleting = $state(false);
  let confirmDelete = $state(false);
  let error = $state<string | null>(null);
  let path = $state('');
  let originUrl = $state('');

  let lastLoadedId: string | null = null;

  $effect(() => {
    if (!open || !repoId) {
      lastLoadedId = null;
      return;
    }
    if (lastLoadedId === repoId) return;
    lastLoadedId = repoId;
    const id = repoId;
    error = null;
    loading = true;
    confirmDelete = false;
    path = '';
    originUrl = '';
    void (async () => {
      try {
        const res = await apiFetch(`/api/repos/${encodeURIComponent(id)}`);
        const data = (await res.json()) as {
          path?: string;
          origin_url?: string | null;
          error?: string;
        };
        if (!res.ok) {
          error = data.error ?? t('repoEdit.failedLoad');
          return;
        }
        path = data.path ?? '';
        originUrl = data.origin_url ?? '';
      } catch {
        error = t('spawn.error.networkError');
      } finally {
        loading = false;
      }
    })();
  });

  async function save(): Promise<void> {
    if (!repoId) return;
    error = null;
    saving = true;
    try {
      const res = await apiFetch(`/api/repos/${encodeURIComponent(repoId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origin_url: originUrl.trim() || null })
      });
      const data = (await res.json()) as {
        ok?: boolean;
        origin_url?: string | null;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        error = data.error ?? t('repoEdit.failedSave');
        return;
      }
      onSaved?.({ id: repoId, origin_url: data.origin_url ?? null });
      onClose();
    } catch {
      error = t('spawn.error.networkError');
    } finally {
      saving = false;
    }
  }

  async function remove(): Promise<void> {
    if (!repoId) return;
    confirmDelete = false;
    error = null;
    deleting = true;
    try {
      const res = await apiFetch(`/api/repos/${encodeURIComponent(repoId)}`, {
        method: 'DELETE'
      });
      if (res.status === 204) {
        onDeleted?.(repoId);
        onClose();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        code?: string;
        agents?: number;
        openTasks?: number;
        error?: string;
      };
      if (res.status === 409 && data.code === 'repo_in_use') {
        error = t('repoEdit.inUse', {
          agents: data.agents ?? 0,
          tasks: data.openTasks ?? 0
        });
        return;
      }
      error = data.error ?? t('repoEdit.failedDelete');
    } catch {
      error = t('spawn.error.networkError');
    } finally {
      deleting = false;
    }
  }
</script>

<Modal {open} {onClose} title={t('repoEdit.title')}>
  <div class="wrap">
    {#if loading}
      <p class="muted">{t('repoEdit.loading')}</p>
    {:else}
      <label>
        <span>{t('repoEdit.path')} <span class="muted">({t('repoEdit.pathReadOnlyHint')})</span></span>
        <input value={path} readonly disabled />
      </label>
      <label>
        <span>{t('spawn.originUrl')} <span class="muted">({t('spawn.optional')})</span></span>
        <input bind:value={originUrl} placeholder="https://github.com/…" />
      </label>
      {#if error}
        <p class="err">{error}</p>
      {/if}
      <div class="actions">
        <button
          type="button"
          class="delete"
          onclick={() => (confirmDelete = true)}
          disabled={saving || deleting || !repoId}
        >
          {deleting ? t('repoEdit.deleting') : t('repoEdit.delete')}
        </button>
        <span class="spacer"></span>
        <button type="button" class="cancel" onclick={onClose} disabled={saving || deleting}>
          {t('spawn.cancel')}
        </button>
        <button type="button" onclick={save} disabled={saving || deleting || !repoId}>
          {saving ? t('repoEdit.saving') : t('repoEdit.save')}
        </button>
      </div>
    {/if}
  </div>
</Modal>

<ConfirmDialog
  open={confirmDelete}
  title={t('repoEdit.confirmDeleteTitle')}
  body={t('repoEdit.confirmDeleteBody', { path })}
  confirmLabel={t('repoEdit.delete')}
  cancelLabel={t('spawn.cancel')}
  tone="destructive"
  onConfirm={remove}
  onCancel={() => (confirmDelete = false)}
/>

<style>
  .wrap {
    width: 24rem;
    max-width: 100%;
    display: grid;
    gap: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
    color: #e5e7eb;
    font-size: 0.9rem;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #111;
    color: #e5e5e5;
    font-family: inherit;
  }
  input:disabled {
    color: #9ca3af;
    cursor: not-allowed;
  }
  .muted {
    color: #6b7280;
  }
  .err {
    color: #f87171;
    margin: 0;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .actions .spacer {
    flex: 1;
  }
  .actions button {
    padding: 0.45rem 0.9rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #2563eb;
    color: #fff;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
  }
  .actions button.cancel {
    background: #1a1a1a;
    color: #e5e7eb;
  }
  .actions button.delete {
    background: #1a1a1a;
    border-color: #7f1d1d;
    color: #f87171;
  }
  .actions button.delete:hover:not(:disabled) {
    background: #7f1d1d;
    color: #fff;
  }
  .actions button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
