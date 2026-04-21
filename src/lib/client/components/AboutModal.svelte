<script lang="ts">
  import Modal from './Modal.svelte';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let {
    open,
    onClose
  }: {
    open: boolean;
    onClose: () => void;
  } = $props();
</script>

<Modal {open} {onClose} title={t('about.title')}>
  <div class="about-body">
    <p class="app-name">{t('nav.appTitle')}</p>

    <dl class="fields">
      <dt>{t('about.version')}</dt>
      <dd>{__APP_VERSION__}</dd>

      <dt>{t('about.build')}</dt>
      <dd>{__APP_BUILD_NUMBER__}</dd>

      <dt>{t('about.buildDate')}</dt>
      <dd>{__APP_BUILD_DATE__}</dd>
    </dl>

    <p class="tagline">{t('about.tagline')}</p>
  </div>
</Modal>

<style>
  .about-body {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 22rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.875rem;
    color: #e5e7eb;
  }
  .app-name {
    margin: 0;
    font-weight: 600;
    color: #f3f4f6;
  }
  .fields {
    margin: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 1.5rem;
    row-gap: 0.375rem;
  }
  .fields dt {
    color: #9ca3af;
  }
  .fields dd {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    color: #e5e7eb;
    word-break: break-all;
  }
  .tagline {
    margin: 0;
    color: #9ca3af;
    max-width: 32rem;
  }
</style>
