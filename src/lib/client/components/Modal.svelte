<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * A content-sized <dialog> wrapper.
   *
   * The modal never imposes a fixed footprint: `.maw-modal-inner` is
   * `width: auto; height: auto`, capped at 96vw / 94vh. Whatever the
   * caller renders into `children` is what determines how big the
   * popup is — add a control, it grows; remove one, it shrinks.
   *
   * Callers that need the body to fill the available viewport (e.g. the
   * terminal panel, which wants its xterm to eat the whole popup) should
   * give their own root element an explicit size or set `flex: 1` via
   * their own stylesheet — the modal body is a flex column, so children
   * with `flex: 1` stretch naturally.
   *
   * `headerRight` is an optional snippet rendered on the right edge of
   * the modal's title bar, between the title and the close button. The
   * dashboard uses it to show an agent's live status pill next to the
   * role/cli caption.
   */
  let {
    open,
    onClose,
    title,
    headerRight,
    children
  }: {
    open: boolean;
    onClose: () => void;
    title?: string;
    headerRight?: Snippet;
    children: Snippet;
  } = $props();

  let dialog: HTMLDialogElement | undefined = $state();

  // Native <dialog> gives us Esc dismissal, focus trapping and a backdrop
  // for free. We just drive showModal()/close() from the `open` prop.
  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });

  function onDialogClose(): void {
    if (open) onClose();
  }

  // Backdrop click: native <dialog> fires a click with the dialog itself as
  // target when the user clicks outside the content. We let the content stop
  // propagation so clicks inside never count as backdrop clicks.
  function onBackdropClick(e: MouseEvent): void {
    if (e.target === dialog) onClose();
  }
</script>

<dialog
  bind:this={dialog}
  class="maw-modal"
  onclose={onDialogClose}
  onclick={onBackdropClick}
>
  <div class="maw-modal-inner" role="document">
    <header class="maw-modal-head">
      <h2>{title ?? ''}</h2>
      {#if headerRight}
        <div class="head-right">{@render headerRight()}</div>
      {/if}
      <button type="button" class="close" aria-label="Close" onclick={onClose}>×</button>
    </header>
    <div class="maw-modal-body">
      {@render children()}
    </div>
  </div>
</dialog>

<style>
  .maw-modal {
    border: none;
    padding: 0;
    background: transparent;
    color: #e5e5e5;
    max-width: none;
    max-height: none;
    /* Tailwind preflight resets margin to 0 on *, which strips the
       margin: auto the browser UA stylesheet applies to dialog:modal
       for viewport centering. Restore it. */
    margin: auto;
  }
  .maw-modal::backdrop {
    background: rgba(0, 0, 0, 0.65);
  }
  .maw-modal-inner {
    background: #0b0f17;
    border: 1px solid #1f2937;
    border-radius: 0.75rem;
    /* Content-sized. The caps leave a small border around the viewport so
       the backdrop is visible — that's the "small border" the workbench
       asks for. */
    width: auto;
    height: auto;
    max-width: 96vw;
    max-height: 94vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  }
  .maw-modal-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid #1f2937;
    background: #111827;
  }
  .maw-modal-head h2 {
    margin: 0;
    font-size: 1rem;
    color: #e5e7eb;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The right-side slot pushes the close button flush-right and lets the
     title take whatever remains. */
  .head-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  /* When there is no headerRight snippet, give the close button its own
     auto-margin so it still hugs the right edge. */
  .maw-modal-head h2 + .close {
    margin-left: auto;
  }
  .close {
    background: transparent;
    border: none;
    color: #9ca3af;
    font-size: 1.5rem;
    cursor: pointer;
    line-height: 1;
    padding: 0 0.4rem;
  }
  .close:hover {
    color: #f3f4f6;
  }
  .maw-modal-body {
    /* Grow to fill whatever vertical space the content's intrinsic size
       leaves behind — crucial for the terminal panel (its .panel root is
       `height: 100%`, so the xterm inside it stretches to the available
       viewport minus the head). */
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: auto;
    padding: 0.75rem;
  }
</style>
