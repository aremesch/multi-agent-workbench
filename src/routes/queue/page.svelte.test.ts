// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntryRow } from '$lib/server/db/types';

// useT() → identity so assertions can match on the raw i18n keys.
vi.mock('$lib/client/i18n.svelte', () => ({
  useT: () => (key: string) => key
}));

// The page imports these from $app/navigation at module load; the row
// expand/collapse path under test never calls them.
vi.mock('$app/navigation', () => ({
  invalidate: vi.fn(),
  invalidateAll: vi.fn()
}));

// Opening the edit modal mounts SpawnAgentForm, whose <form> carries
// `use:enhance`. The real action's DEV guard rejects a non-POST form; stub
// it to a no-op action (same approach as the $app/navigation stub above).
vi.mock('$app/forms', () => ({
  enhance: () => ({ destroy() {} })
}));

import Page from './+page.svelte';

afterEach(() => {
  cleanup();
});

const BODY = 'Investigate the flaky login integration test';

function makeEntry(overrides: Partial<QueueEntryRow> = {}): QueueEntryRow {
  return {
    id: 'q1',
    user_id: 'u1',
    role_id: 'role-1',
    repo_id: 'repo-1',
    title: 'Fix login flake',
    body: BODY,
    target_url: null,
    model: 'claude-opus',
    permission_mode: null,
    source_branch: 'main',
    with_worktree: 1,
    optional_args_json: '{}',
    priority: 0,
    depends_on_json: '[]',
    scheduled_for: null,
    exclusive: 0,
    queued: 1,
    plan_md: null,
    plan_source_path: null,
    status: 'ready',
    agent_id: null,
    external_source_json: null,
    attachments_json: '[]',
    last_error: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    started_at: null,
    completed_at: null,
    ...overrides
  };
}

function makeData(entries: QueueEntryRow[]) {
  return {
    entries,
    agentsById: {},
    roles: [{ id: 'role-1', name: 'Implementer' }],
    repos: [{ id: 'repo-1', path: '/srv/app' }],
    cliKinds: [],
    spawnDefaults: {}
  } as unknown as Parameters<typeof render>[1]['props']['data'];
}

describe('Tasks page — inline expand', () => {
  it('hides the task body until the row is expanded', async () => {
    const { getByRole, queryByText, getByText } = render(Page, {
      props: { data: makeData([makeEntry()]) }
    });

    // Collapsed: title visible, body not in the DOM.
    expect(getByText('Fix login flake')).toBeInTheDocument();
    expect(queryByText(BODY)).toBeNull();

    await fireEvent.click(
      getByRole('button', { name: 'queue.action.expand' })
    );

    // Expanded: body + a metadata label are now rendered.
    expect(getByText(BODY)).toBeInTheDocument();
    expect(getByText('queue.column.role')).toBeInTheDocument();
    expect(getByText('Implementer')).toBeInTheDocument();
  });

  it('collapses again on a second activation', async () => {
    const { getByRole } = render(Page, {
      props: { data: makeData([makeEntry()]) }
    });

    const head = getByRole('button', { name: 'queue.action.expand' });
    expect(head).toHaveAttribute('aria-expanded', 'false');

    await fireEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'true');

    // Accessible name flips to the collapse label once open.
    await fireEvent.click(
      getByRole('button', { name: 'queue.action.collapse' })
    );
    expect(head).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles via keyboard (Enter) for touch/a11y parity', async () => {
    const { getByRole, queryByText } = render(Page, {
      props: { data: makeData([makeEntry()]) }
    });

    const head = getByRole('button', { name: 'queue.action.expand' });
    await fireEvent.keyDown(head, { key: 'Enter' });
    expect(queryByText(BODY)).not.toBeNull();
  });

  it('shows an empty-state line when a task has no body', async () => {
    const { getByRole, getByText } = render(Page, {
      props: { data: makeData([makeEntry({ body: null })]) }
    });

    await fireEvent.click(
      getByRole('button', { name: 'queue.action.expand' })
    );
    expect(getByText('queue.detail.noContent')).toBeInTheDocument();
  });
});

describe('Tasks page — edit task', () => {
  // Per-row actions now live in an M3 overflow (kebab) menu; the Edit
  // action is a menuitem revealed after the kebab is opened.
  // status/queued combos → bucket. Editable: backlog, ready, blocked.
  const editable: Array<[string, Partial<QueueEntryRow>]> = [
    ['ready', { status: 'ready', queued: 1 }],
    ['blocked', { status: 'blocked', queued: 1 }],
    ['backlog (pending, not queued)', { status: 'pending', queued: 0 }]
  ];
  it.each(editable)('exposes an Edit menuitem for %s tasks', async (_label, overrides) => {
    const { getByRole, queryByRole } = render(Page, {
      props: { data: makeData([makeEntry(overrides)]) }
    });
    // Closed menu → no Edit item yet.
    expect(queryByRole('menuitem', { name: 'queue.action.edit' })).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'queue.action.rowMenu' }));
    expect(
      getByRole('menuitem', { name: 'queue.action.edit' })
    ).toBeInTheDocument();
  });

  it('offers no Edit item for a running task (open agent + cancel only)', async () => {
    const { getByRole, queryByRole } = render(Page, {
      props: {
        data: makeData([makeEntry({ status: 'running', queued: 1, agent_id: 'a1' })])
      }
    });
    await fireEvent.click(getByRole('button', { name: 'queue.action.rowMenu' }));
    expect(queryByRole('menuitem', { name: 'queue.action.edit' })).toBeNull();
    expect(
      getByRole('menuitem', { name: 'queue.action.cancel' })
    ).toBeInTheDocument();
  });

  const noMenu: Array<[string, Partial<QueueEntryRow>]> = [
    ['done', { status: 'done', queued: 1, agent_id: null }],
    ['cancelled', { status: 'cancelled', queued: 0, agent_id: null }]
  ];
  it.each(noMenu)(
    'renders no row menu for %s tasks without an agent',
    (_label, overrides) => {
      const { queryByRole } = render(Page, {
        props: { data: makeData([makeEntry(overrides)]) }
      });
      expect(queryByRole('button', { name: 'queue.action.rowMenu' })).toBeNull();
    }
  );

  it('opens the edit modal pre-filled with the task title', async () => {
    const { getByRole, getByText, queryByText, getByDisplayValue } = render(Page, {
      props: { data: makeData([makeEntry({ title: 'Fix login flake' })]) }
    });

    // Modal absent until the Edit menuitem (inside the kebab) is clicked.
    expect(queryByText('queue.action.editTask')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'queue.action.rowMenu' }));
    await fireEvent.click(getByRole('menuitem', { name: 'queue.action.edit' }));

    // Modal title rendered + the form's task-title input seeded from the row.
    expect(getByText('queue.action.editTask')).toBeInTheDocument();
    expect(getByDisplayValue('Fix login flake')).toBeInTheDocument();
  });
});
