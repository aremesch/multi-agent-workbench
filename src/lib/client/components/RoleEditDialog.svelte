<script lang="ts">
  /**
   * Modal form for creating or editing an agent role. Wraps `Modal.svelte`
   * with a controlled form that talks to:
   *   - POST   /api/roles          (when `role` is null  → create)
   *   - PUT    /api/roles/:id      (when `role` is given → edit)
   *
   * The shown fields depend on the selected CLI kind: if the adapter
   * advertises a `capabilities.model` (e.g. claude-code) we render the
   * model dropdown; same for `capabilities.permissionMode`. Both are
   * optional and default to the capability's own default id.
   */
  import Modal from './Modal.svelte';
  import { apiFetch } from '$lib/client/api';
  import { useT } from '$lib/client/i18n.svelte';
  import type { RoleRow } from '$lib/server/db/types';

  export interface RoleCliKindOption {
    kind: string;
    displayName: string;
    capabilities: {
      model: { label: string; values: { id: string; label: string }[]; default: string | null } | null;
      permissionMode: { label: string; values: { id: string; label: string }[]; default: string | null } | null;
    };
  }

  let {
    open,
    role,
    cliKinds,
    onSaved,
    onCancel
  }: {
    open: boolean;
    role: RoleRow | null;
    cliKinds: RoleCliKindOption[];
    onSaved: (saved: RoleRow) => void;
    onCancel: () => void;
  } = $props();

  const t = useT();

  // Form state — re-seeded whenever the dialog opens (controlled by parent).
  let name = $state('');
  let cliKind = $state('');
  let systemPrompt = $state('');
  let defaultModel = $state<string | null>(null);
  let defaultPermissionMode = $state<string | null>(null);
  let error = $state<string | null>(null);
  let submitting = $state(false);

  $effect(() => {
    if (!open) return;
    error = null;
    submitting = false;
    if (role) {
      name = role.name;
      cliKind = role.cli_kind;
      systemPrompt = role.system_prompt;
      defaultModel = role.default_model;
      defaultPermissionMode = role.default_permission_mode;
    } else {
      name = '';
      cliKind = cliKinds[0]?.kind ?? '';
      systemPrompt = '';
      const adapter = cliKinds[0];
      defaultModel = adapter?.capabilities.model?.default ?? null;
      defaultPermissionMode = adapter?.capabilities.permissionMode?.default ?? null;
    }
  });

  const selectedAdapter = $derived(cliKinds.find((k) => k.kind === cliKind));

  // Keep `defaultModel` / `defaultPermissionMode` in sync with the selected
  // adapter — if the user changes kind, the previous picks may no longer be
  // valid. Fall back to the new adapter's defaults so the dropdowns always
  // show something sensible.
  $effect(() => {
    const adapter = selectedAdapter;
    if (!adapter) {
      defaultModel = null;
      defaultPermissionMode = null;
      return;
    }
    const modelCap = adapter.capabilities.model;
    const modeCap = adapter.capabilities.permissionMode;
    if (!modelCap || !modelCap.values.some((v) => v.id === defaultModel)) {
      defaultModel = modelCap?.default ?? null;
    }
    if (!modeCap || !modeCap.values.some((v) => v.id === defaultPermissionMode)) {
      defaultPermissionMode = modeCap?.default ?? null;
    }
  });

  async function submit(): Promise<void> {
    error = null;
    if (!name.trim()) {
      error = t('common.error.nameRequired');
      return;
    }
    if (!cliKind) {
      error = t('spawn.error.unknownCliKind');
      return;
    }
    submitting = true;
    try {
      const url = role ? `/api/roles/${role.id}` : '/api/roles';
      const method = role ? 'PUT' : 'POST';
      const res = await apiFetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          cli_kind: cliKind,
          system_prompt: systemPrompt,
          default_model: defaultModel,
          default_permission_mode: defaultPermissionMode
        })
      });
      const data = (await res.json()) as RoleRow & { error?: string };
      if (!res.ok) {
        error = data.error ?? t('spawn.error.failedCreateRole');
        return;
      }
      onSaved(data);
    } catch {
      error = t('spawn.error.networkError');
    } finally {
      submitting = false;
    }
  }
</script>

<Modal {open} onClose={onCancel} title={role ? t('roles.editRole') : t('roles.newRole')}>
  <form
    class="role-form"
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <label>
      <span>{t('spawn.name')}</span>
      <input bind:value={name} required />
    </label>

    <label>
      <span>{t('spawn.cliKind')}</span>
      <select bind:value={cliKind} required>
        {#each cliKinds as k (k.kind)}
          <option value={k.kind}>{k.displayName} ({k.kind})</option>
        {/each}
      </select>
    </label>

    {#if selectedAdapter?.capabilities.model}
      <label>
        <span>{selectedAdapter.capabilities.model.label}</span>
        <select bind:value={defaultModel}>
          {#each selectedAdapter.capabilities.model.values as v (v.id)}
            <option value={v.id}>{v.label}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if selectedAdapter?.capabilities.permissionMode}
      <label>
        <span>{selectedAdapter.capabilities.permissionMode.label}</span>
        <select bind:value={defaultPermissionMode}>
          {#each selectedAdapter.capabilities.permissionMode.values as v (v.id)}
            <option value={v.id}>{v.label}</option>
          {/each}
        </select>
      </label>
    {/if}

    <label>
      <span>{t('spawn.systemPrompt')} <span class="muted">({t('spawn.optional')})</span></span>
      <textarea bind:value={systemPrompt} rows="8"></textarea>
    </label>

    {#if error}
      <p class="err">{error}</p>
    {/if}

    <div class="actions">
      <button type="button" class="cancel" onclick={onCancel} disabled={submitting}>
        {t('spawn.cancel')}
      </button>
      <button type="submit" disabled={submitting || !name.trim() || !cliKind}>
        {submitting ? t('spawn.creating') : role ? t('common.save') : t('spawn.createRole')}
      </button>
    </div>
  </form>
</Modal>

<style>
  .role-form {
    display: grid;
    gap: 0.75rem;
    width: min(92vw, 32rem);
  }
  label {
    display: grid;
    gap: 0.25rem;
    color: #e5e7eb;
    font-size: 0.9rem;
  }
  input,
  select,
  textarea {
    padding: 0.5rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #111;
    color: #e5e5e5;
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
  }
  textarea {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.85rem;
    resize: vertical;
  }
  .err {
    color: #f87171;
    margin: 0;
  }
  .muted {
    color: #6b7280;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  .cancel {
    color: #9ca3af;
    background: transparent;
    border: none;
    padding: 0.55rem 0.75rem;
    cursor: pointer;
    font: inherit;
  }
  .cancel:hover:not(:disabled) {
    color: #e5e7eb;
  }
  button[type='submit'] {
    padding: 0.55rem 1rem;
    border-radius: 0.375rem;
    background: #2563eb;
    border: none;
    color: #fff;
    cursor: pointer;
  }
  button[type='submit']:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
