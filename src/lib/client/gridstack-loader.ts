/**
 * SSR-safe lazy loader for gridstack. Mirrors the dynamic-import pattern
 * Terminal.svelte uses for xterm — gridstack touches `window` at import
 * time, so it can only be loaded from an `onMount` hook.
 */

import type { GridStack } from 'gridstack';

export async function loadGridStack(): Promise<typeof GridStack> {
  await import('gridstack/dist/gridstack.min.css');
  const mod = await import('gridstack');
  return mod.GridStack;
}
