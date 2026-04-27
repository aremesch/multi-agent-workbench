// See https://kit.svelte.dev/docs/types#app

import type { AgentSupervisor } from '$lib/server/agents/AgentSupervisor';
import type { Locale } from '$lib/i18n';

/** Minimal user shape exposed to routes. Sourced from better-auth, with
 *  `must_change_password` stitched in from the legacy `users` table. */
export interface AppUser {
  id: string;
  username: string;
  must_change_password: number;
}

export interface AppSession {
  id: string;
  userId: string;
}

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      supervisor: AgentSupervisor;
      user: AppUser | null;
      session: AppSession | null;
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
