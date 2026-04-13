<script lang="ts">
  import { ALL_THEMES, type ThemeId } from '$lib/shared/dashboard';
  import { currentTheme, setTheme } from '$lib/client/stores/theme';
  import { currentLocale, setLocale } from '$lib/client/stores/locale';
  import { SUPPORTED_LOCALES, LOCALE_NAMES, t as translate, type Locale } from '$lib/i18n';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let active = $state<ThemeId>($currentTheme);
  $effect(() => {
    active = $currentTheme;
  });

  let activeLocale = $state<Locale>($currentLocale);
  $effect(() => {
    activeLocale = $currentLocale;
  });

  async function choose(id: ThemeId): Promise<void> {
    await setTheme(id);
  }

  async function chooseLocale(loc: Locale): Promise<void> {
    await setLocale(loc);
  }
</script>

<section class="wrap">
  <header class="head">
    <h1>{t('settings.title')}</h1>
    <p class="muted">{t('settings.subtitle')}</p>
  </header>

  <section class="group" aria-labelledby="appearance-heading">
    <header class="group-head">
      <h2 id="appearance-heading">{t('settings.appearance')}</h2>
      <p class="muted">{t('settings.appearanceDesc')}</p>
    </header>

    <fieldset class="themes" aria-label={t('settings.themeLabel')}>
      <legend class="sr-only">{t('settings.themeLabel')}</legend>
      {#each ALL_THEMES as theme (theme.id)}
        {@const selected = active === theme.id}
        <label class="card" class:selected>
          <input
            class="sr-only"
            type="radio"
            name="theme"
            value={theme.id}
            checked={selected}
            onchange={() => choose(theme.id)}
          />
          <span
            class="preview"
            style="background: {theme.swatches.surface}; color: {theme.swatches.primary};"
          >
            <span class="swatch" style="background: {theme.swatches.primary};"></span>
            <span class="swatch" style="background: {theme.swatches.accent};"></span>
            <span class="swatch ring" style="border-color: {theme.swatches.primary};"></span>
          </span>
          <span class="meta">
            <span class="title">
              {theme.label}
              <span class="mode">{theme.mode}</span>
            </span>
            <span class="desc">{t(`theme.desc.${theme.id}`)}</span>
          </span>
          <span class="check" aria-hidden="true">
            {#if selected}
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M9 16.2l-3.5-3.6L4 14.1 9 19l11-11-1.5-1.5L9 16.2z"
                />
              </svg>
            {/if}
          </span>
        </label>
      {/each}
    </fieldset>
  </section>

  <section class="group" aria-labelledby="language-heading">
    <header class="group-head">
      <h2 id="language-heading">{t('settings.language')}</h2>
      <p class="muted">{t('settings.languageDesc')}</p>
    </header>

    <fieldset class="locales" aria-label={t('settings.language')}>
      <legend class="sr-only">{t('settings.language')}</legend>
      {#each SUPPORTED_LOCALES as loc (loc)}
        {@const selected = activeLocale === loc}
        <label class="locale-card" class:selected>
          <input
            class="sr-only"
            type="radio"
            name="locale"
            value={loc}
            checked={selected}
            onchange={() => chooseLocale(loc)}
          />
          <span class="locale-name">{LOCALE_NAMES[loc]}</span>
          <span class="locale-code">{loc.toUpperCase()}</span>
          <span class="check" aria-hidden="true">
            {#if selected}
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M9 16.2l-3.5-3.6L4 14.1 9 19l11-11-1.5-1.5L9 16.2z"
                />
              </svg>
            {/if}
          </span>
        </label>
      {/each}
    </fieldset>
  </section>
</section>

<style>
  .wrap {
    max-width: 56rem;
    margin: 0 auto;
  }
  .head {
    margin-bottom: 2rem;
  }
  h1 {
    font-size: 1.75rem;
    font-weight: 500;
    margin: 0 0 0.25rem;
    color: var(--md-sys-color-on-surface);
  }
  h2 {
    font-size: 1.1rem;
    font-weight: 500;
    margin: 0 0 0.25rem;
    color: var(--md-sys-color-on-surface);
  }
  .muted {
    margin: 0;
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.9rem;
  }
  .group {
    background: var(--md-sys-color-surface-container-low);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-lg);
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }
  .group-head {
    margin-bottom: 1.25rem;
  }
  .themes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
    gap: 0.75rem;
    border: none;
    padding: 0;
    margin: 0;
  }
  .locales {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 0.75rem;
    border: none;
    padding: 0;
    margin: 0;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .card {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 0.9rem;
    align-items: center;
    padding: 0.85rem 1rem;
    background: var(--md-sys-color-surface-container);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-md);
    cursor: pointer;
    transition:
      background var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
      border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
  }
  .card:hover {
    background: var(--md-sys-color-surface-container-high);
  }
  .card.selected {
    background: var(--md-sys-color-secondary-container);
    border-color: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-secondary-container);
  }
  .locale-card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.85rem 1rem;
    background: var(--md-sys-color-surface-container);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-md);
    cursor: pointer;
    transition:
      background var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
      border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
  }
  .locale-card:hover {
    background: var(--md-sys-color-surface-container-high);
  }
  .locale-card.selected {
    background: var(--md-sys-color-secondary-container);
    border-color: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-secondary-container);
  }
  .locale-name {
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--md-sys-color-on-surface);
  }
  .locale-card.selected .locale-name {
    color: var(--md-sys-color-on-secondary-container);
  }
  .locale-code {
    font-size: 0.7rem;
    color: var(--md-sys-color-on-surface-variant);
    background: var(--md-sys-color-surface-container-highest);
    padding: 0.05rem 0.4rem;
    border-radius: var(--md-sys-shape-corner-full);
    letter-spacing: 0.05em;
  }
  .preview {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 5.5rem;
    height: 3rem;
    padding: 0 0.55rem;
    border-radius: var(--md-sys-shape-corner-sm);
    border: 1px solid var(--md-sys-color-outline-variant);
    overflow: hidden;
  }
  .swatch {
    width: 1rem;
    height: 1rem;
    border-radius: var(--md-sys-shape-corner-full);
    flex: 0 0 1rem;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.1);
  }
  .swatch.ring {
    background: transparent;
    border: 2px solid;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .title {
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--md-sys-color-on-surface);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .card.selected .title {
    color: var(--md-sys-color-on-secondary-container);
  }
  .mode {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--md-sys-color-on-surface-variant);
    background: var(--md-sys-color-surface-container-highest);
    padding: 0.05rem 0.4rem;
    border-radius: var(--md-sys-shape-corner-full);
  }
  .desc {
    font-size: 0.8rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  .card.selected .desc {
    color: var(--md-sys-color-on-secondary-container);
    opacity: 0.85;
  }
  .check {
    display: inline-flex;
    width: 1.5rem;
    height: 1.5rem;
    align-items: center;
    justify-content: center;
    color: var(--md-sys-color-primary);
    margin-left: auto;
  }
</style>
