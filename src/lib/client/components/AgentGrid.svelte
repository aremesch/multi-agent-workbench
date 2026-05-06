<script lang="ts">
  import { getAllContexts, mount, onDestroy, onMount, unmount } from 'svelte';
  import type { GridStack } from 'gridstack';
  import { loadGridStack } from '$lib/client/gridstack-loader';
  import AgentCard from '$lib/client/components/AgentCard.svelte';
  import type { AgentCardRow, LayoutEntry } from '$lib/shared/types';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  // Svelte 5's `mount()` creates a fresh component tree with no parent
  // context — so an imperatively-mounted AgentCard can't see the
  // `maw-locale` context (useT → getContext) and throws during setup.
  // Capture our own parent context here at AgentGrid setup time and
  // forward it to every mount() below.
  const parentContext = getAllContexts();

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

  /**
   * Default "small computer screen" size for fresh cards. Because the
   * grid is configured with `cellHeight: 'auto'` (square cells equal in
   * pixel height to cellWidth), a 3 × 2 box is always 3:2 landscape —
   * close enough to a 16:10 monitor and tiles 4 cards per row on the
   * 12-column grid. Users can resize individual cards after the fact
   * and their new size is persisted via scheduleChange.
   */
  const DEFAULT_GS_W = 3;
  const DEFAULT_GS_H = 2;

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
      // Uniform "small computer screen" default (~16:10 landscape).
      el.setAttribute('gs-w', String(DEFAULT_GS_W));
      el.setAttribute('gs-h', String(DEFAULT_GS_H));
      // Flow new cards left-to-right, then wrap down. Without this the
      // missing gs-x/gs-y default to (0,0) and — because float:true lets
      // items overlap — every fresh spawn stacks on the top-left corner.
      el.setAttribute('gs-auto-position', 'true');
    }
    const content = document.createElement('div');
    content.className = 'grid-stack-item-content';
    el.appendChild(content);

    grid.makeWidget(el);

    const dispose = mount(AgentCard, {
      target: content,
      props: { agent, onOpen },
      context: parentContext
    });

    // Svelte 5 delegates onclick to document, but gridstack's drag/resize
    // handling can prevent the event from reaching the delegation root.
    // Attach a direct DOM listener so card-body clicks always fire.
    content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('.agent-card-grip')) return; // let drag handle pass
      onOpen(agent);
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
    // On coarse-pointer devices (phones, tablets) we run the grid in
    // `staticGrid: true` so gridstack's `_removeDD(el)` nukes all drag
    // listeners AND every `.ui-resizable-handle` element. The handles
    // are 10 px-wide invisible strips along every tile edge with
    // `touch-action: none` baked into the gridstack stylesheet — even
    // with the drag handle anchored to a small grip in the header,
    // touching one of those edge strips would start a *resize* (which
    // looks identical to drag at c:1) and eat the page-scroll
    // gesture. Drag-to-rearrange becomes desktop-only as a result;
    // `alwaysShowResizeHandle: 'mobile'` is intentionally dropped
    // because the handles aren't rendered when staticGrid is on.
    const isCoarse =
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: coarse)').matches;
    grid = GridStackCtor.init(
      {
        column: 12,
        // 'auto' keeps cellHeight == cellWidth, so each grid cell is
        // square. Combined with DEFAULT_GS_W=3 / DEFAULT_GS_H=2 that
        // gives every fresh card a uniform 3:2 landscape aspect
        // (~16:10) regardless of container width.
        cellHeight: 'auto',
        float: true,
        margin: 8,
        // `.agent-card-grip` is a small icon in each card's header — see
        // AgentCard.svelte. Anchoring drag to the grip (instead of the
        // full-width header) is desktop polish; on touch the whole
        // grid is static (see staticGrid below) so the grip is purely
        // decorative and CSS hides it under @media (pointer: coarse).
        draggable: { handle: '.agent-card-grip' },
        // Phones: collapse to a single column so cards aren't 1/12-th
        // of a 400 px viewport (≈33 px wide).
        columnOpts: { breakpoints: [{ w: 600, c: 1 }] },
        staticGrid: isCoarse
      },
      container
    );
    grid.on('change', scheduleChange);

    for (const agent of agents) addWidget(agent);
  });

  // Reactively sync widgets with the agents prop.
  //
  // IMPORTANT: read `agents` *before* the grid guard. Svelte 5 $effect tracks
  // dependencies by what is actually read during the run, so if we early-
  // returned on the very first pass (before onMount set `grid`) without
  // touching `agents`, Svelte would never register the prop as a dep — and
  // subsequent changes (e.g. a newly-spawned agent landing in data.liveAgents
  // after invalidateAll) would silently fail to update the grid.
  $effect(() => {
    const ids = agents.map((a) => a.id);
    if (!grid) return;
    const present = new Set(ids);
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
  <p class="empty">{t('agent.noLiveAgents')}</p>
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
