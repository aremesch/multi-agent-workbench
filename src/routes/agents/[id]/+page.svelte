<script lang="ts">
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import AgentWindowModal from '$lib/client/components/AgentWindowModal.svelte';

  let { data }: { data: PageData } = $props();

  // This standalone route is a deep-link target (push notification, direct
  // URL). It shows the same captioned window as the dashboard/repo pages.
  // Closing it — or the agent reaching a terminal status (browser-agent
  // stop, CLI exit/crash) — has nothing useful left here, so bounce back
  // to the dashboard where the row reappears in the archive.
  function leave(): void {
    void goto('/');
  }
</script>

<AgentWindowModal agent={data.agent} open={true} onClose={leave} onArchived={leave} />
