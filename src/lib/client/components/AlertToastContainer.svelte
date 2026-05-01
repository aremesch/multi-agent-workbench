<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { getMawWsClient } from '$lib/client/ws';
  import { alertToasts, pushToast } from '$lib/client/stores/alertToasts';
  import AlertToast from './AlertToast.svelte';

  /**
   * Global host for foreground alert toasts. Mounted once in the root
   * layout so every page sees the same stack. Subscribes to the
   * user-alerts WS channel on mount and unsubscribes on destroy.
   *
   * Pointer-events on the wrapper itself are `none` so the toast stack
   * doesn't intercept clicks on the underlying page; individual toasts
   * re-enable them on the `.toast` rule. This lets users keep
   * interacting with the dashboard while toasts are visible.
   */

  let unsub: (() => void) | null = null;

  onMount(() => {
    const ws = getMawWsClient();
    unsub = ws.subscribeUserAlerts((msg) => {
      pushToast(msg);
    });
  });

  onDestroy(() => {
    if (unsub) {
      unsub();
      unsub = null;
    }
  });
</script>

<div class="stack" aria-live="polite" aria-relevant="additions">
  {#each $alertToasts as entry (entry.id)}
    <AlertToast {entry} />
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    pointer-events: none;
  }
  @media (max-width: 640px) {
    .stack {
      left: 0.5rem;
      right: 0.5rem;
      top: 0.5rem;
    }
  }
</style>
