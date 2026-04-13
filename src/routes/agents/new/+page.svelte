<script lang="ts">
  import type { PageData } from './$types';
  import SpawnAgentForm from '$lib/client/components/SpawnAgentForm.svelte';
  let { data }: { data: PageData } = $props();
</script>

<h1>Spawn agent</h1>
<SpawnAgentForm roles={data.roles} repos={data.repos} projects={data.projects} cliKinds={data.cliKinds} spawnDefaults={data.spawnDefaults} />

<style>
  h1 {
    color: #e5e7eb;
    font-size: 1.25rem;
    margin: 0 0 1rem 0;
  }
</style>
