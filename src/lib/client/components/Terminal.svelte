<!--
  Placeholder xterm.js wrapper. v0.1 just uses a plain <pre> in the agent
  detail page; wiring @xterm/xterm in is deferred until we see the first real
  session output and can style it properly.
-->
<script lang="ts">
  let { text }: { text: string } = $props();
</script>

<pre class="terminal">{text}</pre>

<style>
  .terminal {
    background: #000;
    color: #e5e7eb;
    padding: 0.75rem;
    border-radius: 0.375rem;
    white-space: pre-wrap;
    min-height: 20rem;
    overflow: auto;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.85rem;
  }
</style>
