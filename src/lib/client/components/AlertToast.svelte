<script lang="ts">
  import { goto } from '$app/navigation';
  import { useT } from '$lib/client/i18n.svelte';
  import { dismissToast, type ToastEntry } from '$lib/client/stores/alertToasts';
  import { apiFetch } from '$lib/client/api';

  const t = useT();

  let { entry }: { entry: ToastEntry } = $props();

  function dismiss(): void {
    dismissToast(entry.id);
  }

  /**
   * Open the agent's terminal modal AND fire-and-forget the per-agent
   * ack endpoint. The ack flips `acknowledged_at` on every unacked
   * alert for that agent + clears `attention_at`, so the sidebar dot
   * resets and the dedup window doesn't suppress legitimate follow-ups.
   *
   * Toast is dismissed immediately for snappy feedback even if the goto
   * is still resolving (SvelteKit navigation is fast but not zero).
   */
  async function openAgent(): Promise<void> {
    const target = entry.url || `/repos/${entry.agentId}`;
    const id = entry.id;
    const agentId = entry.agentId;
    dismissToast(id);
    try {
      await goto(target);
    } finally {
      // Fire-and-forget; the route is idempotent and a network blip
      // here is no worse than the user clicking "open" twice.
      apiFetch(`/api/agents/${encodeURIComponent(agentId)}/alerts/ack`, {
        method: 'POST'
      }).catch(() => {});
    }
  }
</script>

<div class="toast" data-severity={entry.severity} role="status" aria-live="polite">
  <div class="text">
    <div class="title">{entry.reason}</div>
    {#if entry.body}
      <div class="body">{entry.body}</div>
    {/if}
  </div>
  <div class="actions">
    <button type="button" class="primary" onclick={openAgent}>
      {t('toast.openAgent')}
    </button>
    <button
      type="button"
      class="close"
      aria-label={t('toast.dismiss')}
      onclick={dismiss}
    >×</button>
  </div>
</div>

<style>
  .toast {
    pointer-events: auto;
    display: flex;
    gap: 0.65rem;
    align-items: flex-start;
    background: var(--md-sys-color-surface-container-high, #1f2937);
    color: var(--md-sys-color-on-surface, #f3f4f6);
    border: 1px solid var(--md-sys-color-outline-variant, #374151);
    border-left: 3px solid var(--toast-accent, #60a5fa);
    border-radius: 0.5rem;
    padding: 0.65rem 0.75rem;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    max-width: 22rem;
    min-width: 14rem;
    animation: slide-in 200ms ease-out;
  }
  .toast[data-severity='warning'] {
    --toast-accent: #f59e0b;
  }
  .toast[data-severity='error'],
  .toast[data-severity='critical'] {
    --toast-accent: #ef4444;
  }
  .text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .title {
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .body {
    font-size: 0.8rem;
    color: var(--md-sys-color-on-surface-variant, #9ca3af);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    word-break: break-word;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    align-items: flex-end;
  }
  .primary {
    background: var(--md-sys-color-primary, #60a5fa);
    color: var(--md-sys-color-on-primary, #0a0a0a);
    border: none;
    padding: 0.3rem 0.7rem;
    border-radius: 0.35rem;
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
  .primary:hover {
    opacity: 0.9;
  }
  .close {
    background: transparent;
    border: none;
    color: var(--md-sys-color-on-surface-variant, #9ca3af);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0.1rem 0.35rem;
  }
  .close:hover {
    color: var(--md-sys-color-on-surface, #f3f4f6);
  }
  @keyframes slide-in {
    from {
      opacity: 0;
      transform: translateX(20%);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }
</style>
