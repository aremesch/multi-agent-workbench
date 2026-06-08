<script lang="ts">
  /**
   * Read-only viewer for an archived agent's original definition: the role's
   * system prompt, the task prompt/body it was given, and the frozen runtime
   * picks (model, permission mode, CLI, source branch).
   *
   * Data is passed in directly by the archive page loader — no fetch. Mirrors
   * the structure of {@link PlanViewerModal} for a consistent modal surface.
   */

  import Modal from './Modal.svelte';
  import { useT } from '$lib/client/i18n.svelte';

  export interface AgentDefinitionView {
    roleName: string;
    systemPrompt: string;
    taskTitle: string | null;
    taskBody: string | null;
    model: string | null;
    permissionMode: string | null;
    cliKind: string;
    sourceBranch: string | null;
  }

  const t = useT();

  let {
    definition,
    open,
    onClose
  }: {
    definition: AgentDefinitionView | null;
    open: boolean;
    onClose: () => void;
  } = $props();

  function dash(v: string | null | undefined): string {
    return v && v.length > 0 ? v : t('archive.definition.empty');
  }
</script>

<Modal {open} {onClose} title={t('archive.definition.title')}>
  <div class="def-panel">
    {#if definition}
      <dl class="meta">
        <dt>{t('archive.definition.role')}</dt>
        <dd>{dash(definition.roleName)}</dd>
        <dt>{t('archive.definition.cli')}</dt>
        <dd>{dash(definition.cliKind)}</dd>
        <dt>{t('archive.definition.model')}</dt>
        <dd>{dash(definition.model)}</dd>
        <dt>{t('archive.definition.permissionMode')}</dt>
        <dd>{dash(definition.permissionMode)}</dd>
        <dt>{t('archive.definition.branch')}</dt>
        <dd>{dash(definition.sourceBranch)}</dd>
        <dt>{t('archive.definition.task')}</dt>
        <dd>{dash(definition.taskTitle)}</dd>
      </dl>

      <section class="block">
        <h3>{t('archive.definition.prompt')}</h3>
        <pre>{definition.taskBody ?? t('archive.definition.empty')}</pre>
      </section>

      <section class="block">
        <h3>{t('archive.definition.systemPrompt')}</h3>
        <pre>{definition.systemPrompt || t('archive.definition.empty')}</pre>
      </section>
    {/if}
  </div>
</Modal>

<style>
  .def-panel {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    width: min(92vw, 52rem);
    max-height: min(86vh, 56rem);
    overflow: auto;
    color: #e5e7eb;
    font-size: 0.9rem;
  }
  .meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.3rem 0.9rem;
    margin: 0;
  }
  .meta dt {
    color: #9ca3af;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    align-self: center;
  }
  .meta dd {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    color: #e5e7eb;
    word-break: break-word;
  }
  .block h3 {
    margin: 0 0 0.35rem;
    font-size: 0.78rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #9ca3af;
  }
  .block pre {
    margin: 0;
    background: #0b0f17;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    padding: 0.6rem 0.75rem;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
    line-height: 1.5;
    color: #d1d5db;
    max-height: 26rem;
    overflow: auto;
  }
</style>
