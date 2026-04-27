<script lang="ts">
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import AgentTerminalPanel from '$lib/client/components/AgentTerminalPanel.svelte';

  let { data }: { data: PageData } = $props();

  // When the agent transitions to a terminal status (browser-agent stop,
  // CLI-agent exit/crash mid-session), there's nothing useful left on this
  // page — bounce the user back to the dashboard so the row appears in the
  // archive. The dashboard modal has its own auto-close path; this is the
  // standalone-route equivalent.
  function onStatusChange(status: string): void {
    if (status === 'exited' || status === 'crashed') {
      void goto('/');
    }
  }
</script>

<AgentTerminalPanel agent={data.agent} {onStatusChange} />
