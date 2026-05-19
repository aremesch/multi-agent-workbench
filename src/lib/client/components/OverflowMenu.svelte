<script lang="ts" module>
  import type { Snippet } from 'svelte';

  /**
   * One row in an {@link OverflowMenu}. Icons stay at the call site as
   * inline SVG snippets (matches the codebase's no-icon-library convention).
   * A `dividerBefore` item is preceded by an `<hr>` separator — the rule is
   * NOT a menuitem and is skipped by assistive tech.
   */
  export interface OverflowMenuItem {
    /** Stable key for the {#each} block. */
    id: string;
    label: string;
    /** 16px inline-SVG snippet, optional. */
    icon?: Snippet;
    /** Action handler — omit when `href` is set. */
    onSelect?: () => void;
    /** Renders an `<a role="menuitem">` instead of a `<button>`. */
    href?: string;
    disabled?: boolean;
    destructive?: boolean;
    /** Render a separator before this item. */
    dividerBefore?: boolean;
  }
</script>

<script lang="ts">
  /**
   * Generic Material 3 overflow ("kebab") menu. A trigger button with
   * `aria-haspopup="menu"` toggles an absolutely-positioned
   * `<div role="menu">` of `role="menuitem"` rows. A global window
   * click + keydown listener closes on outside-click / Escape and
   * returns focus to the trigger. Behaviour is intentionally identical
   * to the original hand-rolled AgentMenu (its test is the parity gate);
   * the difference is M3 token theming and ≥48px touch targets.
   */
  let {
    items,
    label,
    align = 'end',
    trigger
  }: {
    items: OverflowMenuItem[];
    /** aria-label for the trigger button (caller supplies the i18n string). */
    label: string;
    /** Horizontal anchor of the menu surface relative to the trigger. */
    align?: 'start' | 'end';
    /** Optional trigger override; defaults to the kebab glyph. */
    trigger?: Snippet;
  } = $props();

  let menuOpen = $state(false);
  let buttonEl: HTMLButtonElement | undefined = $state();

  function toggleMenu(): void {
    menuOpen = !menuOpen;
  }
  function closeMenu(): void {
    menuOpen = false;
  }
  function pick(item: OverflowMenuItem): void {
    if (item.disabled) return;
    closeMenu();
    item.onSelect?.();
  }
  function pickLink(item: OverflowMenuItem, ev: MouseEvent): void {
    if (item.disabled) {
      ev.preventDefault();
      return;
    }
    closeMenu();
    // Let the anchor navigate normally.
  }
  function onDocClick(ev: MouseEvent): void {
    if (!menuOpen) return;
    const target = ev.target as HTMLElement | null;
    if (target && target.closest('.overflow-menu-wrap')) return;
    closeMenu();
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && menuOpen) {
      closeMenu();
      buttonEl?.focus();
    }
  }
</script>

<svelte:window onclick={onDocClick} onkeydown={onKey} />

<div class="overflow-menu-wrap">
  <button
    type="button"
    bind:this={buttonEl}
    class="kebab-btn"
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    onclick={toggleMenu}
  >
    {#if trigger}
      {@render trigger()}
    {:else}
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"
        />
      </svg>
    {/if}
  </button>
  {#if menuOpen}
    <div role="menu" class="overflow-menu" class:align-start={align === 'start'}>
      {#each items as item (item.id)}
        {#if item.dividerBefore}
          <hr aria-hidden="true" />
        {/if}
        {#if item.href}
          <a
            class="menu-item"
            class:destructive={item.destructive}
            role="menuitem"
            href={item.href}
            aria-disabled={item.disabled ? 'true' : undefined}
            onclick={(ev) => pickLink(item, ev)}
          >
            {#if item.icon}{@render item.icon()}{/if}{item.label}
          </a>
        {:else}
          <button
            type="button"
            class="menu-item"
            class:destructive={item.destructive}
            role="menuitem"
            disabled={item.disabled}
            aria-disabled={item.disabled ? 'true' : undefined}
            onclick={() => pick(item)}
          >
            {#if item.icon}{@render item.icon()}{/if}{item.label}
          </button>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .overflow-menu-wrap {
    display: inline-flex;
    position: relative;
  }
  .kebab-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border: none;
    border-radius: var(--md-sys-shape-corner-full, 9999px);
    background: transparent;
    color: var(--md-sys-color-on-surface-variant);
    cursor: pointer;
    padding: 0;
    transition: background var(--md-sys-motion-duration-short, 150ms)
        var(--md-sys-motion-easing-standard, ease),
      color var(--md-sys-motion-duration-short, 150ms)
        var(--md-sys-motion-easing-standard, ease);
  }
  .kebab-btn:hover,
  .kebab-btn:focus-visible {
    background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
    color: var(--md-sys-color-on-surface);
    outline: none;
  }
  .overflow-menu {
    position: absolute;
    right: 0;
    top: 100%;
    margin-top: 0.5rem;
    z-index: 50;
    min-width: 12rem;
    display: flex;
    flex-direction: column;
    padding: 0.25rem 0;
    background: var(--md-sys-color-surface-container);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-sm, 8px);
    box-shadow: var(--md-sys-elevation-level-2);
  }
  .overflow-menu.align-start {
    right: auto;
    left: 0;
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-height: 48px;
    padding: 0 0.875rem;
    text-align: left;
    font: inherit;
    font-size: 0.875rem;
    text-decoration: none;
    color: var(--md-sys-color-on-surface);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background var(--md-sys-motion-duration-short, 150ms)
      var(--md-sys-motion-easing-standard, ease);
  }
  .menu-item:hover:not(:disabled):not([aria-disabled='true']),
  .menu-item:focus-visible:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
    outline: none;
  }
  .menu-item:disabled,
  .menu-item[aria-disabled='true'] {
    opacity: 0.38;
    cursor: not-allowed;
  }
  .menu-item.destructive {
    color: var(--md-sys-color-error);
  }
  .menu-item.destructive:hover:not(:disabled):not([aria-disabled='true']),
  .menu-item.destructive:focus-visible:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in srgb, var(--md-sys-color-error) 12%, transparent);
  }
  hr {
    margin: 0.25rem 0;
    border: none;
    border-top: 1px solid var(--md-sys-color-outline-variant);
  }
</style>
