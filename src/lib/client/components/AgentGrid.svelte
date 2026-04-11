<script lang="ts">
  import { mount, onDestroy, onMount, unmount } from 'svelte';
  import type { GridStack } from 'gridstack';
  import { loadGridStack } from '$lib/client/gridstack-loader';
  import AgentCard from '$lib/client/components/AgentCard.svelte';
  import type { AgentCardRow, LayoutEntry } from '$lib/shared/types';

  let {
    agents,
    initialLayout,
    onLayoutChange,
    onOpen
  }: {
    agents: AgentCardRow[];
    initialLayout: LayoutEntry[] | null;
    onLayoutChange: (layout: LayoutEntry[]) => void;
    onOpen: (agent: AgentCardRow) => void;
  } = $props();

  let container: HTMLDivElement | undefined = $state();
  let grid: GridStack | null = null;
  /**
   * Per-agent mount bookkeeping. Each entry holds:
   *  - `el`: the grid-stack-item DOM node we hand to gridstack
   *  - `cardEl`: the inner .grid-stack-item-content we mount AgentCard into
   *  - `dispose`: Svelte unmount handle for the AgentCard instance
   */
  const widgets = new Map<
    string,
    { el: HTMLDivElement; dispose: () => void }
  >();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleChange(): void {
    if (!grid) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!grid) return;
      const serialized = grid.save(false) as Array<{
        id?: string;
        x?: number;
        y?: number;
        w?: number;
        h?: number;
      }>;
      const layout: LayoutEntry[] = serialized
        .filter((n) => typeof n.id === 'string')
        .map((n) => ({
          agentId: n.id as string,
          x: n.x ?? 0,
          y: n.y ?? 0,
          w: n.w ?? 4,
          h: n.h ?? 3
        }));
      onLayoutChange(layout);
    }, 500);
  }

  function addWidget(agent: AgentCardRow): void {
    if (!grid || widgets.has(agent.id)) return;
    const saved = initialLayout?.find((e) => e.agentId === agent.id);

    const el = document.createElement('div');
    el.className = 'grid-stack-item';
    el.setAttribute('gs-id', agent.id);
    if (saved) {
      el.setAttribute('gs-x', String(saved.x));
      el.setAttribute('gs-y', String(saved.y));
      el.setAttribute('gs-w', String(saved.w));
      el.setAttribute('gs-h', String(saved.h));
    } else {
      el.setAttribute('gs-w', '4');
      el.setAttribute('gs-h', '3');
    }
    const content = document.createElement('div');
    content.className = 'grid-stack-item-content';
    el.appendChild(content);

    grid.makeWidget(el);

    const dispose = mount(AgentCard, {
      target: content,
      props: {
        agent,
        onOpen
      }
    });

    widgets.set(agent.id, { el, dispose: () => unmount(dispose) });
  }

  function removeWidget(agentId: string): void {
    const w = widgets.get(agentId);
    if (!w || !grid) return;
    w.dispose();
    grid.removeWidget(w.el, true);
    widgets.delete(agentId);
  }

  onMount(async () => {
    if (!container) return;
    const GridStackCtor = await loadGridStack();
    grid = GridStackCtor.init(
      {
        column: 12,
        cellHeight: 80,
        float: true,
        margin: 8,
        draggable: { handle: '.agent-card-header' }
      },
      container
    );
    grid.on('change', scheduleChange);

    for (const agent of agents) addWidget(agent);
  });

  // Reactively sync widgets with the agents prop.
  $effect(() => {
    if (!grid) return;
    const present = new Set(agents.map((a) => a.id));
    for (const id of Array.from(widgets.keys())) {
      if (!present.has(id)) removeWidget(id);
    }
    for (const agent of agents) {
      if (!widgets.has(agent.id)) addWidget(agent);
    }
  });

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of widgets.values()) w.dispose();
    widgets.clear();
    grid?.destroy(false);
    grid = null;
  });
</script>

<div bind:this={container} class="grid-stack"></div>

{#if agents.length === 0}
  <p class="empty">No live agents. Click the <strong>+</strong> button to spawn one.</p>
{/if}

<style>
  .grid-stack {
    min-height: 60vh;
  }
  /* Let our AgentCard paint its own background/border.
     Gridstack's default stylesheet sets `overflow-y: auto` on the item
     content, which gives each card a vertical scrollbar the moment the
     rendered tmux snapshot is a single pixel taller than the pane. We
     force it hidden so the snapshot clips cleanly. */
  :global(.grid-stack-item-content) {
    background: transparent !important;
    inset: 0 !important;
    overflow: hidden !important;
  }
  .empty {
    text-align: center;
    color: #6b7280;
    padding: 3rem 1rem;
  }
</style>
