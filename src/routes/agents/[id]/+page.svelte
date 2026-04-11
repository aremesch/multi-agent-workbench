<script lang="ts">
  import type { PageData } from './$types';
  import AgentTerminalPanel from '$lib/client/components/AgentTerminalPanel.svelte';

  let { data }: { data: PageData } = $props();
</script>

<AgentTerminalPanel agent={data.agent} />
