<script lang="ts">
  import Modal from './Modal.svelte';
  import { apiFetch } from '$lib/client/api';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let {
    open,
    repoId,
    onClose,
    onSaved
  }: {
    open: boolean;
    repoId: string | null;
    onClose: () => void;
    onSaved?: (updated: { id: string; origin_url: string | null }) => void;
  } = $props();

  let loading = $state(false);
  let saving = $state(false);
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
        <button type="button" class="cancel" onclick={onClose} disabled={saving}>
          {t('spawn.cancel')}
        </button>
        <button type="button" onclick={save} disabled={saving || !repoId}>
          {saving ? t('repoEdit.saving') : t('repoEdit.save')}
        </button>
      </div>
    {/if}
  </div>
</Modal>

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
    gap: 0.4rem;
    justify-content: flex-end;
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
  .actions button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
