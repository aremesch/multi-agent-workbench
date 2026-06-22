<script lang="ts">
  import type { PageData } from './$types';
  import { apiFetch } from '$lib/client/api';
  import { goto } from '$app/navigation';
  import type { ProjectMemoryRow } from '$lib/server/db/types';

  let { data }: { data: PageData } = $props();

  // ---- create run ----
  let title = $state('');
  let planMd = $state('');
  let repoId = $state(data.repos[0]?.id ?? '');
  let roleId = $state(data.roles[0]?.id ?? '');
  let qcRoleId = $state(data.roles[0]?.id ?? '');
  let creating = $state(false);
  let createError = $state<string | null>(null);

  async function createRun(): Promise<void> {
    creating = true;
    createError = null;
    try {
      const res = await apiFetch('/api/supervisor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, planMd, repoId, roleId, qcRoleId })
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) {
        createError = body.error ?? 'Failed to create run';
        return;
      }
      await goto(`/supervisor/${body.id}`);
    } finally {
      creating = false;
    }
  }

  // ---- settings ----
  let settings = $state({ ...data.settings });
  let savingSettings = $state(false);
  let settingsSaved = $state(false);

  async function saveSettings(): Promise<void> {
    savingSettings = true;
    settingsSaved = false;
    try {
      const res = await apiFetch('/api/supervisor/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) settingsSaved = true;
    } finally {
      savingSettings = false;
    }
  }

  // ---- project memory ----
  let memory = $state<ProjectMemoryRow[]>([]);
  let memoryRepoId = $state(data.repos[0]?.id ?? '');

  async function loadMemory(): Promise<void> {
    if (!memoryRepoId) return;
    const res = await apiFetch(`/api/supervisor/memory?repo_id=${encodeURIComponent(memoryRepoId)}`);
    if (res.ok) memory = ((await res.json()) as { lessons: ProjectMemoryRow[] }).lessons;
  }

  async function retireLesson(id: string, active: boolean): Promise<void> {
    await apiFetch('/api/supervisor/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, active })
    });
    await loadMemory();
  }

  $effect(() => {
    void memoryRepoId;
    void loadMemory();
  });

  function phaseLabel(p: string): string {
    return p.replace(/_/g, ' ');
  }
</script>

<svelte:head><title>Supervisor — MAW</title></svelte:head>

<div class="mx-auto max-w-4xl space-y-8 p-4">
  <h1 class="text-2xl font-semibold">Supervisor</h1>

  <!-- Create -->
  <section class="rounded-lg border border-border p-4">
    <h2 class="mb-3 text-lg font-medium">New run</h2>
    {#if data.repos.length === 0 || data.roles.length === 0}
      <p class="text-sm text-muted-foreground">Add a repo and at least one role first.</p>
    {:else}
      <div class="space-y-3">
        <input
          class="w-full rounded border border-input bg-background px-3 py-2 text-sm"
          placeholder="Run title"
          bind:value={title}
        />
        <textarea
          class="h-40 w-full rounded border border-input bg-background px-3 py-2 font-mono text-sm"
          placeholder="Paste the large product plan here…"
          bind:value={planMd}
        ></textarea>
        <div class="grid grid-cols-3 gap-3">
          <label class="text-sm">
            Repo
            <select class="mt-1 w-full rounded border border-input bg-background px-2 py-1.5 text-sm" bind:value={repoId}>
              {#each data.repos as r (r.id)}<option value={r.id}>{r.path}</option>{/each}
            </select>
          </label>
          <label class="text-sm">
            Coding role
            <select class="mt-1 w-full rounded border border-input bg-background px-2 py-1.5 text-sm" bind:value={roleId}>
              {#each data.roles as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
            </select>
          </label>
          <label class="text-sm">
            QC role
            <select class="mt-1 w-full rounded border border-input bg-background px-2 py-1.5 text-sm" bind:value={qcRoleId}>
              {#each data.roles as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
            </select>
          </label>
        </div>
        {#if createError}<p class="text-sm text-destructive">{createError}</p>{/if}
        <button
          class="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={creating || !title || !planMd}
          onclick={createRun}
        >
          {creating ? 'Planning…' : 'Create & plan'}
        </button>
      </div>
    {/if}
  </section>

  <!-- Runs -->
  <section class="rounded-lg border border-border p-4">
    <h2 class="mb-3 text-lg font-medium">Runs</h2>
    {#if data.runs.length === 0}
      <p class="text-sm text-muted-foreground">No runs yet.</p>
    {:else}
      <ul class="divide-y divide-border">
        {#each data.runs as run (run.id)}
          <li>
            <a class="flex items-center justify-between py-2 hover:underline" href={`/supervisor/${run.id}`}>
              <span>{run.title}</span>
              <span class="rounded bg-muted px-2 py-0.5 text-xs">{phaseLabel(run.phase)}</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Settings -->
  <section class="rounded-lg border border-border p-4">
    <h2 class="mb-3 text-lg font-medium">Settings</h2>
    <div class="grid grid-cols-2 gap-3 text-sm">
      <label>Autonomy
        <select class="mt-1 w-full rounded border border-input bg-background px-2 py-1.5" bind:value={settings.autonomy}>
          <option value="bypassPermissions">Full auto (bypassPermissions)</option>
          <option value="auto_safe">Auto-answer safe (acceptEdits)</option>
          <option value="defer_all">Defer everything</option>
        </select>
      </label>
      <label>Execution
        <select class="mt-1 w-full rounded border border-input bg-background px-2 py-1.5" bind:value={settings.executionMode}>
          <option value="sequential">Sequential</option>
          <option value="parallel">Parallel (dep-aware)</option>
        </select>
      </label>
      <label>Fix-loop cap
        <input type="number" min="0" max="20" class="mt-1 w-full rounded border border-input bg-background px-2 py-1.5" bind:value={settings.fixLoopCap} />
      </label>
      <label>Stall timeout (s, 0=off)
        <input type="number" min="0" class="mt-1 w-full rounded border border-input bg-background px-2 py-1.5" bind:value={settings.stallTimeoutSec} />
      </label>
      <label>LLM model (planner/QC)
        <input class="mt-1 w-full rounded border border-input bg-background px-2 py-1.5" bind:value={settings.model} />
      </label>
      <label>Token budget (0=∞)
        <input type="number" min="0" class="mt-1 w-full rounded border border-input bg-background px-2 py-1.5" bind:value={settings.tokenBudget} />
      </label>
      <label class="col-span-2">Planner prompt (blank = default)
        <textarea class="mt-1 h-20 w-full rounded border border-input bg-background px-2 py-1.5 font-mono text-xs" bind:value={settings.plannerPrompt}></textarea>
      </label>
    </div>
    <div class="mt-3 flex items-center gap-3">
      <button class="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" disabled={savingSettings} onclick={saveSettings}>
        {savingSettings ? 'Saving…' : 'Save settings'}
      </button>
      {#if settingsSaved}<span class="text-sm text-muted-foreground">Saved.</span>{/if}
    </div>
    <p class="mt-2 text-xs text-muted-foreground">The QC review prompt is the system prompt of the QC role you pick per run.</p>
  </section>

  <!-- Project memory -->
  <section class="rounded-lg border border-border p-4">
    <h2 class="mb-3 text-lg font-medium">Project memory (recurring issues)</h2>
    {#if data.repos.length > 0}
      <select class="mb-3 rounded border border-input bg-background px-2 py-1.5 text-sm" bind:value={memoryRepoId}>
        {#each data.repos as r (r.id)}<option value={r.id}>{r.path}</option>{/each}
      </select>
      {#if memory.length === 0}
        <p class="text-sm text-muted-foreground">No lessons recorded yet.</p>
      {:else}
        <ul class="space-y-2">
          {#each memory as m (m.id)}
            <li class="flex items-start justify-between gap-3 text-sm" class:opacity-50={m.active === 0}>
              <span><span class="font-mono text-xs">[{m.category} ×{m.hit_count}]</span> {m.lesson}</span>
              <button class="shrink-0 text-xs underline" onclick={() => retireLesson(m.id, m.active === 0)}>
                {m.active === 0 ? 'reactivate' : 'retire'}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>
</div>
