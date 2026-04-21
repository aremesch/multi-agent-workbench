// See https://kit.svelte.dev/docs/types#app

import type { AgentSupervisor } from '$lib/server/agents/AgentSupervisor';
import type { UserRow, SessionRow } from '$lib/server/db/types';
import type { Locale } from '$lib/i18n';

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      supervisor: AgentSupervisor;
      user: UserRow | null;
      session: SessionRow | null;
      locale: Locale;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  // Injected by Vite `define` at build time from scripts/gen-version.mjs.
  const __APP_VERSION__: string;
  const __APP_BUILD_NUMBER__: string;
  const __APP_BUILD_DATE__: string;
}

export {};
