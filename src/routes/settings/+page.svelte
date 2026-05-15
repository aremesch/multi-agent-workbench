<script lang="ts">
  import { apiFetch } from '$lib/client/api';
  import type { ActionData, PageData } from './$types';
  import {
    ALL_THEMES,
    MOBILE_QUICK_KEYS_MODES,
    type MobileQuickKeysMode,
    type ThemeId
  } from '$lib/shared/dashboard';
  import { invalidateAll } from '$app/navigation';
  import { currentTheme, setTheme } from '$lib/client/stores/theme';
  import { currentLocale, setLocale } from '$lib/client/stores/locale';
  import { registerPush } from '$lib/client/push';
  import { SUPPORTED_LOCALES, LOCALE_NAMES, t as translate, type Locale } from '$lib/i18n';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // ── Push notification state ────────────────────────────────────────
  const NOTIFY_KINDS = ['prompt_detected', 'task_done', 'error', 'exited'] as const;
  // svelte-ignore state_referenced_locally
  let pushKinds = $state<string[]>([...(data.pushNotifyKinds ?? NOTIFY_KINDS)]);
  let pushPermission = $state<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );

  async function enablePush(): Promise<void> {
    const parentData = (data as unknown as { vapidPublicKey?: string });
    const vapidKey = parentData.vapidPublicKey ?? '';
    if (!vapidKey) return;
    await registerPush(vapidKey);
    pushPermission = Notification.permission;
  }

  // ── Queue concurrency settings ─────────────────────────────────────
  // svelte-ignore state_referenced_locally
  let queueGlobalLimit = $state<number>(data.queueConcurrency.maxConcurrentGlobal);
  // svelte-ignore state_referenced_locally
  let queuePerRepoLimit = $state<number>(data.queueConcurrency.maxConcurrentPerRepo);
  let queueSaving = $state(false);
  let queueSavedFlash = $state(false);

  async function saveQueueConcurrency(): Promise<void> {
    queueSaving = true;
    queueSavedFlash = false;
    try {
      const res = await apiFetch('/api/user/queue-concurrency', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          maxConcurrentGlobal: Math.max(0, Math.floor(Number(queueGlobalLimit) || 0)),
          maxConcurrentPerRepo: Math.max(0, Math.floor(Number(queuePerRepoLimit) || 0)),
          perRepoOverrides: data.queueConcurrency.perRepoOverrides ?? {}
        })
      });
      if (res.ok) {
        queueSavedFlash = true;
        await invalidateAll();
        setTimeout(() => { queueSavedFlash = false; }, 2000);
      }
    } finally {
      queueSaving = false;
    }
  }

  async function toggleNotifyKind(kind: string, enabled: boolean): Promise<void> {
    if (enabled && !pushKinds.includes(kind)) {
      pushKinds = [...pushKinds, kind];
    } else if (!enabled) {
      pushKinds = pushKinds.filter((k) => k !== kind);
    }
    await apiFetch('/api/user/push-preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kinds: pushKinds })
    });
  }

  // Agent defaults: per-cli-kind toggle state.
  let agentDefaults = $state<Record<string, Record<string, boolean>>>({});

  // Initialize from server data.
  $effect(() => {
    const init: Record<string, Record<string, boolean>> = {};
    for (const kind of data.cliKinds) {
      const userDefs = data.spawnDefaults[kind.kind]?.optionalArgs ?? {};
      const toggles: Record<string, boolean> = {};
      for (const opt of kind.optionalArgs) {
        toggles[opt.id] = userDefs[opt.id] ?? opt.default;
      }
      init[kind.kind] = toggles;
    }
    agentDefaults = init;
  });

  async function saveSpawnDefault(cliKind: string, optId: string, value: boolean): Promise<void> {
    const current = agentDefaults[cliKind] ?? {};
    current[optId] = value;
    agentDefaults[cliKind] = { ...current };
    await apiFetch('/api/user/spawn-defaults', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cliKind, optionalArgs: agentDefaults[cliKind] })
    });
  }

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

  // ── Mobile quick-keys preference ───────────────────────────────────
  // svelte-ignore state_referenced_locally
  let mobileQuickKeysMode = $state<MobileQuickKeysMode>(data.mobileQuickKeysMode);
  async function chooseMobileQuickKeysMode(mode: MobileQuickKeysMode): Promise<void> {
    mobileQuickKeysMode = mode;
    await apiFetch('/api/user/mobile-quickkeys-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    // Refresh layout/page data so AgentTerminalPanel picks up the new mode
    // without requiring a hard reload.
    await invalidateAll();
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

  <section class="group" aria-labelledby="quickkeys-heading">
    <header class="group-head">
      <h2 id="quickkeys-heading">{t('settings.mobileQuickKeys.title')}</h2>
      <p class="muted">{t('settings.mobileQuickKeys.desc')}</p>
    </header>

    <fieldset class="quickkeys-modes" aria-labelledby="quickkeys-heading">
      <legend class="sr-only">{t('settings.mobileQuickKeys.title')}</legend>
      {#each MOBILE_QUICK_KEYS_MODES as mode (mode)}
        {@const selected = mobileQuickKeysMode === mode}
        <label class="mode-card" class:selected>
          <input
            class="sr-only"
            type="radio"
            name="mobileQuickKeysMode"
            value={mode}
            checked={selected}
            onchange={() => chooseMobileQuickKeysMode(mode)}
          />
          <span class="mode-meta">
            <span class="mode-title">{t(`settings.mobileQuickKeys.mode.${mode}`)}</span>
            <span class="mode-desc">{t(`settings.mobileQuickKeys.mode.${mode}.desc`)}</span>
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

  <section class="group" aria-labelledby="agent-defaults-heading">
    <header class="group-head">
      <h2 id="agent-defaults-heading">{t('settings.agentDefaults')}</h2>
      <p class="muted">{t('settings.agentDefaultsDesc')}</p>
    </header>

    {#each data.cliKinds as kind (kind.kind)}
      <div class="cli-kind-block">
        <h3 class="cli-kind-name">{kind.displayName}</h3>
        {#if kind.optionalArgs.length === 0}
          <p class="muted small">{t('settings.noOptionalFlags')}</p>
        {:else}
          {#each kind.optionalArgs as opt (opt.id)}
            <label class="defaults-toggle">
              <input
                type="checkbox"
                checked={agentDefaults[kind.kind]?.[opt.id] ?? opt.default}
                onchange={(e) => saveSpawnDefault(kind.kind, opt.id, (e.target as HTMLInputElement).checked)}
              />
              <span class="defaults-label">
                <span>{opt.label}</span>
                {#if opt.description}
                  <span class="defaults-desc">{opt.description}</span>
                {/if}
              </span>
            </label>
          {/each}
        {/if}
      </div>
    {/each}
  </section>

  <section id="git" class="group" aria-labelledby="git-heading">
    <header class="group-head">
      <h2 id="git-heading">{t('settings.git.title')}</h2>
      <p class="muted">{t('settings.git.desc')}</p>
    </header>

    <form method="post" action="?/gitIdentity" class="identity-form">
      <label>
        <span>{t('settings.git.nameLabel')}</span>
        <input
          name="gitAuthorName"
          type="text"
          maxlength="100"
          autocomplete="name"
          value={form?.gitAuthorName ?? data.gitIdentity.name ?? ''}
        />
      </label>
      <label>
        <span>{t('settings.git.emailLabel')}</span>
        <input
          name="gitAuthorEmail"
          type="email"
          maxlength="254"
          autocomplete="email"
          value={form?.gitAuthorEmail ?? data.gitIdentity.email ?? ''}
        />
        <span class="field-hint">{t('settings.git.githubNoreplyHint')}</span>
      </label>
      <p class="muted small">{t('settings.git.appliesToNewAgents')}</p>
      {#if form?.error}
        <p class="err">{form.error}</p>
      {/if}
      {#if form?.gitIdentitySaved}
        <p class="ok">{t('settings.git.saved')}</p>
      {/if}
      <div>
        <button type="submit" class="save-btn">{t('settings.git.save')}</button>
      </div>
    </form>
  </section>

  <section class="group" aria-labelledby="notifications-heading">
    <header class="group-head">
      <h2 id="notifications-heading">{t('settings.notifications')}</h2>
      <p class="muted">{t('settings.notificationsDesc')}</p>
    </header>

    {#if !data.vapidConfigured}
      <p class="muted small">{t('settings.pushNotConfigured')}</p>
    {:else if pushPermission === 'granted'}
      <p class="push-status enabled">{t('settings.pushEnabled')}</p>
      <p class="notify-when-label">{t('settings.notifyWhen')}</p>
      {#each NOTIFY_KINDS as kind (kind)}
        <label class="defaults-toggle">
          <input
            type="checkbox"
            checked={pushKinds.includes(kind)}
            onchange={(e) => toggleNotifyKind(kind, (e.target as HTMLInputElement).checked)}
          />
          <span class="defaults-label">
            <span>{t(`settings.notify.${kind}`)}</span>
          </span>
        </label>
      {/each}
    {:else if pushPermission === 'denied'}
      <p class="muted small">Push notifications are blocked by your browser. Allow them in site settings to enable.</p>
    {:else}
      <button class="push-enable-btn" type="button" onclick={enablePush}>
        {t('settings.pushEnable')}
      </button>
    {/if}
  </section>

  <section class="group" aria-labelledby="queue-heading">
    <h2 id="queue-heading">{t('queue.settings.title')}</h2>
    <div class="queue-row">
      <label class="queue-field">
        <span>{t('queue.settings.maxGlobal')}</span>
        <input
          type="number"
          min="0"
          step="1"
          bind:value={queueGlobalLimit}
        />
      </label>
      <label class="queue-field">
        <span>{t('queue.settings.maxPerRepo')}</span>
        <input
          type="number"
          min="0"
          step="1"
          bind:value={queuePerRepoLimit}
        />
      </label>
    </div>
    <div class="queue-actions">
      <button type="button" class="queue-save" onclick={saveQueueConcurrency} disabled={queueSaving}>
        {t('queue.settings.save')}
      </button>
      {#if queueSavedFlash}
        <span class="muted small">{t('queue.settings.savedFlash')}</span>
      {/if}
    </div>
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
  .quickkeys-modes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
    gap: 0.75rem;
    border: none;
    padding: 0;
    margin: 0;
  }
  .mode-card {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.75rem;
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
  .mode-card:hover {
    background: var(--md-sys-color-surface-container-high);
  }
  .mode-card.selected {
    background: var(--md-sys-color-secondary-container);
    border-color: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-secondary-container);
  }
  .mode-meta {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .mode-title {
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--md-sys-color-on-surface);
  }
  .mode-card.selected .mode-title {
    color: var(--md-sys-color-on-secondary-container);
  }
  .mode-desc {
    font-size: 0.8rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  .mode-card.selected .mode-desc {
    color: var(--md-sys-color-on-secondary-container);
    opacity: 0.85;
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
  .cli-kind-block {
    margin-bottom: 1rem;
  }
  .cli-kind-block:last-child {
    margin-bottom: 0;
  }
  .cli-kind-name {
    font-size: 0.95rem;
    font-weight: 500;
    margin: 0 0 0.5rem;
    color: var(--md-sys-color-on-surface);
  }
  .small {
    font-size: 0.85rem;
    margin: 0;
  }
  .defaults-toggle {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    cursor: pointer;
    font-size: 0.9rem;
    margin-bottom: 0.4rem;
  }
  .defaults-toggle input[type='checkbox'] {
    margin-top: 0.15rem;
  }
  .defaults-label {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    color: var(--md-sys-color-on-surface);
  }
  .defaults-desc {
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.8rem;
  }
  .push-status.enabled {
    color: var(--md-sys-color-primary);
    font-size: 0.9rem;
    font-weight: 500;
    margin: 0 0 0.75rem;
  }
  .notify-when-label {
    font-size: 0.9rem;
    color: var(--md-sys-color-on-surface-variant);
    margin: 0 0 0.5rem;
  }
  .push-enable-btn {
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    border: none;
    padding: 0.5rem 1.25rem;
    border-radius: var(--md-sys-shape-corner-md);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: opacity var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
  }
  .push-enable-btn:hover {
    opacity: 0.9;
  }
  .identity-form {
    display: grid;
    gap: 0.75rem;
    max-width: 32rem;
  }
  .identity-form label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.9rem;
    color: var(--md-sys-color-on-surface);
  }
  .identity-form input {
    padding: 0.5rem 0.6rem;
    border-radius: var(--md-sys-shape-corner-sm);
    border: 1px solid var(--md-sys-color-outline-variant);
    background: var(--md-sys-color-surface-container);
    color: var(--md-sys-color-on-surface);
    font-size: 0.9rem;
  }
  .identity-form input:focus {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 1px;
  }
  .field-hint {
    font-size: 0.8rem;
    color: var(--md-sys-color-on-surface-variant);
    font-weight: normal;
  }
  .err {
    color: var(--md-sys-color-error);
    margin: 0;
    font-size: 0.9rem;
  }
  .ok {
    color: var(--md-sys-color-primary);
    margin: 0;
    font-size: 0.9rem;
  }
  .save-btn {
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    border: none;
    padding: 0.5rem 1.25rem;
    border-radius: var(--md-sys-shape-corner-md);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: opacity var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
  }
  .save-btn:hover {
    opacity: 0.9;
  }
  .queue-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: 0.75rem;
  }
  .queue-field {
    display: grid;
    gap: 0.3rem;
  }
  .queue-field input[type='number'] {
    width: 6rem;
    padding: 0.45rem 0.6rem;
    border-radius: var(--md-sys-shape-corner-sm);
    border: 1px solid var(--md-sys-color-outline-variant);
    background: var(--md-sys-color-surface);
    color: var(--md-sys-color-on-surface);
    font: inherit;
  }
  .queue-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    margin-top: 1rem;
  }
  .queue-save {
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    border: none;
    padding: 0.5rem 1.25rem;
    border-radius: var(--md-sys-shape-corner-md);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }
  .queue-save:hover {
    opacity: 0.9;
  }
  .small {
    font-size: 0.8rem;
  }
</style>
