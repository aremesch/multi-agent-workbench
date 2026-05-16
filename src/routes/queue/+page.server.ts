import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
  getQueueConcurrency,
  getSpawnDefaultsAll,
  listQueueEntriesForUser,
  listReposWithProjectForUser,
  listRoles
} from '$lib/server/db/queries';

/**
 * Server load for the global queue page.
 *
 * Returns every entry the user has so the client can group + filter without
 * a second round-trip. Also ships the data the spawn form needs (roles,
 * repos, cliKinds, spawn defaults) plus the current concurrency settings.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  const cliKinds = locals.supervisor.registry.list();
  const repos = listReposWithProjectForUser(locals.user.id).map((r) => ({
    id: r.id,
    path: r.path,
    projectName: r.project_name
  }));

  // Only "agentic coding CLI" adapters (claude-code, codex, gemini) belong
  // in the queue role picker — interactive tools (shell, browser*) can't be
  // automated and would just confuse the dropdown. Adapters opt in via the
  // `agenticCodingCli` flag in their JSONC; default false.
  const agenticKinds = new Set(
    cliKinds.filter((k) => k.agenticCodingCli).map((k) => k.kind)
  );
  const queueRoles = listRoles(locals.user.id).filter((r) =>
    agenticKinds.has(r.cli_kind)
  );

  return {
    entries: listQueueEntriesForUser(locals.user.id),
    concurrency: getQueueConcurrency(locals.user.id),
    roles: queueRoles,
    repos,
    // cliKinds stays unfiltered: SpawnAgentForm joins role.cli_kind → cliKind
    // for capability lookups (model picker, branch-vs-no-branch, etc.), and
    // a stale-after-filter listing would render those wrong.
    cliKinds,
    spawnDefaults: getSpawnDefaultsAll(
      locals.user.id,
      cliKinds.map((k) => k.kind)
    )
  };
};
