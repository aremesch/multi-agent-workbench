<script lang="ts">
  /**
   * Reusable confirm dialog. Wraps the base <Modal> with a body slot, a
   * cancel button and a confirm button. Set `tone="destructive"` to
   * paint the confirm button red — used by the agent-window kebab's
   * Exit Agent action and reusable for any other irreversible operation
   * the dashboard adds later.
   */

  import Modal from './Modal.svelte';

  let {
    open,
    title,
    body,
    confirmLabel,
    cancelLabel,
    tone = 'default',
    onConfirm,
    onCancel
  }: {
    open: boolean;
    title: string;
    body: string;
    confirmLabel: string;
    cancelLabel: string;
    tone?: 'default' | 'destructive';
    onConfirm: () => void;
    onCancel: () => void;
  } = $props();
</script>

<Modal {open} onClose={onCancel} {title}>
  <div class="confirm-panel">
    <p class="confirm-body">{body}</p>
    <div class="confirm-actions">
      <button type="button" class="btn-secondary" onclick={onCancel}>
        {cancelLabel}
      </button>
      <button
        type="button"
        class="btn-primary"
        class:destructive={tone === 'destructive'}
        onclick={onConfirm}
      >
        {confirmLabel}
      </button>
    </div>
  </div>
</Modal>

<style>
  .confirm-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: min(90vw, 28rem);
    padding: 0.25rem 0.5rem 0;
  }
  .confirm-body {
    margin: 0;
    color: #e5e7eb;
    font-size: 0.95rem;
    line-height: 1.45;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.5rem;
  }
  .btn-secondary,
  .btn-primary {
    border: 1px solid #1f2937;
    background: #111827;
    color: #e5e7eb;
    padding: 0.45rem 0.95rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    cursor: pointer;
    transition: background var(--md-sys-motion-duration-short, 150ms)
      var(--md-sys-motion-easing-standard, ease);
  }
  .btn-secondary:hover,
  .btn-primary:hover {
    background: #1f2937;
  }
  .btn-primary {
    background: #1d4ed8;
    border-color: #1d4ed8;
  }
  .btn-primary:hover {
    background: #1e40af;
  }
  .btn-primary.destructive {
    background: #b91c1c;
    border-color: #b91c1c;
  }
  .btn-primary.destructive:hover {
    background: #991b1b;
  }
</style>
