// See https://kit.svelte.dev/docs/types#app

import type { AgentSupervisor } from '$lib/server/agents/AgentSupervisor';
import type { UserRow, SessionRow } from '$lib/server/db/types';

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      supervisor: AgentSupervisor;
      user: UserRow | null;
      session: SessionRow | null;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
