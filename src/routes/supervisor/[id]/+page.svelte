<script lang="ts">
  import type { PageData } from './$types';
  import { apiFetch } from '$lib/client/api';
  import { onMount, onDestroy } from 'svelte';
  import type { SupervisorRunRow, SupervisorStepRow, SupervisorRunEventRow } from '$lib/server/db/types';

  let { data }: { data: PageData } = $props();

  type StepWithVerdict = SupervisorStepRow & {
    verdict: { verdict: string; summary?: string; issues?: { category: string; severity: string; detail: string }[] } | null;
  };

  let run = $state<SupervisorRunRow | null>(null);
  let steps = $state<StepWithVerdict[]>([]);
  let events = $state<SupervisorRunEventRow[]>([]);
  let busy = $state(false);

  async function refresh(): Promise<void> {
    const res = await apiFetch(`/api/supervisor/${data.runId}`);
    if (!res.ok) return;
    const body = (await res.json()) as { run: SupervisorRunRow; steps: StepWithVerdict[]; events: SupervisorRunEventRow[] };
    run = body.run;
    steps = body.steps;
    events = body.events;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    void refresh();
    timer = setInterval(() => void refresh(), 3000);
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  async function post(path: string, body: unknown): Promise<void> {
    busy = true;
    try {
      await apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      await refresh();
    } finally {
      busy = false;
    }
  }

  const approveAll = () => post(`/api/supervisor/${data.runId}/approve`, {});
  const stopNormal = () => post(`/api/supervisor/${data.runId}/stop`, { mode: 'normal' });
  const stopEmergency = () => post(`/api/supervisor/${data.runId}/stop`, { mode: 'emergency' });

  function sendBack(step: StepWithVerdict): void {
    const notes = prompt(`Requested changes for "${step.title}":`);
    if (notes === null) return;
    void post(`/api/supervisor/${data.runId}/step/${step.id}`, { action: 'send_back', notes });
  }
  const resolve = (step: StepWithVerdict, resolution: 'resume' | 'skip') =>
    post(`/api/supervisor/${data.runId}/step/${step.id}`, { action: 'resolve', resolution });

  function badge(phase: string): string {
    if (phase === 'done' || phase === 'pushed') return 'bg-green-600/20 text-green-700 dark:text-green-400';
    if (phase === 'blocked_on_human' || phase === 'failed') return 'bg-destructive/20 text-destructive';
    if (phase === 'pending') return 'bg-muted text-muted-foreground';
    return 'bg-blue-600/20 text-blue-700 dark:text-blue-400';
  }
  const phaseLabel = (p: string) => p.replace(/_/g, ' ');
  const isTerminal = $derived(run ? ['done', 'stopped', 'failed'].includes(run.phase) : false);
</script>

<svelte:head><title>{run?.title ?? 'Run'} — Supervisor</title></svelte:head>

<div class="mx-auto max-w-4xl space-y-6 p-4">
  <a href="/supervisor" class="text-sm text-muted-foreground hover:underline">← All runs</a>

  {#if run}
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">{run.title}</h1>
      <span class="rounded bg-muted px-2 py-1 text-sm">{phaseLabel(run.phase)}</span>
    </div>

    <div class="flex flex-wrap gap-2">
      {#if run.phase === 'awaiting_approval'}
        <button class="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={busy} onclick={approveAll}>
          Approve all &amp; run
        </button>
      {/if}
      {#if !isTerminal}
        <button class="rounded border border-border px-4 py-2 text-sm disabled:opacity-50" disabled={busy} onclick={stopNormal}>
          Stop (finish current)
        </button>
        <button class="rounded bg-destructive px-4 py-2 text-sm text-destructive-foreground disabled:opacity-50" disabled={busy} onclick={stopEmergency}>
          Emergency stop
        </button>
      {/if}
    </div>

    {#if run.error}<p class="rounded bg-destructive/10 p-2 text-sm text-destructive">{run.error}</p>{/if}

    <!-- Steps -->
    <section class="space-y-3">
      <h2 class="text-lg font-medium">Steps</h2>
      {#each steps as step (step.id)}
        <div class="rounded-lg border border-border p-3">
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium">{step.seq + 1}. {step.title}</span>
            <span class="rounded px-2 py-0.5 text-xs {badge(step.phase)}">{phaseLabel(step.phase)}</span>
          </div>
          <p class="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{step.body}</p>

          {#if step.approval_state !== 'approved'}
            <span class="mt-1 inline-block text-xs text-muted-foreground">approval: {step.approval_state}</span>
          {/if}

          {#if step.verdict}
            <div class="mt-2 rounded bg-muted/50 p-2 text-xs">
              <strong>QC: {step.verdict.verdict}</strong>
              {#if step.verdict.summary}<p>{step.verdict.summary}</p>{/if}
              {#if step.verdict.issues?.length}
                <ul class="mt-1 list-disc pl-4">
                  {#each step.verdict.issues as iss (iss.category + iss.detail)}<li>[{iss.severity}] {iss.category}: {iss.detail}</li>{/each}
                </ul>
              {/if}
            </div>
          {/if}

          {#if step.blocked_reason && step.phase === 'blocked_on_human'}
            <p class="mt-2 text-sm text-destructive">⚠ {step.blocked_reason}</p>
            <div class="mt-1 flex gap-2">
              <button class="rounded border border-border px-3 py-1 text-xs" disabled={busy} onclick={() => resolve(step, 'resume')}>Retry step</button>
              <button class="rounded border border-border px-3 py-1 text-xs" disabled={busy} onclick={() => resolve(step, 'skip')}>Skip step</button>
            </div>
          {/if}

          {#if run.phase === 'awaiting_approval'}
            <div class="mt-2 flex gap-2">
              <button class="rounded border border-border px-3 py-1 text-xs" disabled={busy} onclick={() => sendBack(step)}>Send back with changes</button>
            </div>
          {/if}

          {#if step.branch}<p class="mt-1 font-mono text-xs text-muted-foreground">branch: {step.branch}{step.fix_iterations ? ` · fixes: ${step.fix_iterations}` : ''}</p>{/if}
        </div>
      {/each}
    </section>

    <!-- Timeline -->
    <section>
      <h2 class="mb-2 text-lg font-medium">Timeline</h2>
      <ul class="space-y-1 text-xs text-muted-foreground">
        {#each [...events].reverse() as ev (ev.id)}
          <li><span class="font-mono">{new Date(ev.ts * 1000).toLocaleTimeString()}</span> — {ev.kind.replace(/_/g, ' ')}</li>
        {/each}
      </ul>
    </section>
  {:else}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {/if}
</div>
