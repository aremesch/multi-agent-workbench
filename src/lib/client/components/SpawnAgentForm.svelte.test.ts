// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

// useT() → identity so button/label assertions match raw i18n keys.
vi.mock('$lib/client/i18n.svelte', () => ({
  useT: () => (key: string) => key
}));
vi.mock('$app/navigation', () => ({
  goto: vi.fn()
}));
// `use:enhance` is attached even in queue/edit mode (param just undefined);
// the real action's DEV guard rejects the non-POST <form>. Stub to a no-op
// action — consistent with how the suite stubs other $app/* modules.
vi.mock('$app/forms', () => ({
  enhance: () => ({ destroy() {} })
}));

import SpawnAgentForm, {
  type SpawnInitialValues
} from './SpawnAgentForm.svelte';

afterEach(() => cleanup());

const roles = [
  {
    id: 'role-1',
    name: 'Implementer',
    cli_kind: 'claude-code',
    default_model: 'sonnet',
    default_permission_mode: null
  }
];
const repos = [{ id: 'repo-1', path: '/srv/app', projectName: 'App' }];
const cliKinds = [
  {
    kind: 'claude-code',
    displayName: 'Claude Code',
    // false → no branch fetch / git fields, keeps the test offline.
    createWorktree: false,
    initialInputDelivery: 'cli-arg' as const,
    optionalArgs: [],
    capabilities: {
      model: {
        label: 'Model',
        values: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' }
        ],
        default: 'sonnet'
      },
      permissionMode: null
    }
  }
];

function initialValues(overrides: Partial<SpawnInitialValues> = {}): SpawnInitialValues {
  return {
    roleId: 'role-1',
    repoId: 'repo-1',
    taskTitle: 'Seeded title',
    taskBody: 'seeded body',
    targetUrl: '',
    branch: '',
    withWorktree: true,
    model: 'opus',
    permissionMode: null,
    optionalArgs: {},
    priority: 9,
    scheduledForLocal: '',
    exclusive: false,
    dependsOn: [],
    planMd: '',
    ...overrides
  };
}

function renderEdit(onEdit = vi.fn().mockResolvedValue({ ok: true })) {
  const utils = render(SpawnAgentForm, {
    props: {
      mode: 'queue' as const,
      roles,
      repos,
      cliKinds,
      initialValues: initialValues(),
      onEdit,
      onCancel: vi.fn()
    } as unknown as Parameters<typeof render>[1]['props']
  });
  return { ...utils, onEdit };
}

describe('SpawnAgentForm — edit mode', () => {
  it('pre-fills the form from initialValues', () => {
    const { getByDisplayValue } = renderEdit();
    expect(getByDisplayValue('Seeded title')).toBeInTheDocument(); // task_title
    expect(getByDisplayValue('9')).toBeInTheDocument(); // priority
  });

  it('keeps the seeded model on mount (caps-reset guard) instead of role default', () => {
    const { getByRole } = renderEdit();
    // Without the per-effect guard the model effect would reset this to the
    // role default ('sonnet') on mount. The guard keeps the seeded 'opus'.
    const modelSelect = getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect(modelSelect.value).toBe('opus');
  });

  it('renders a single "Save changes" action (no Save/Run pair)', () => {
    const { getByRole, queryByRole } = renderEdit();
    expect(
      getByRole('button', { name: 'queue.action.saveEdit' })
    ).toBeInTheDocument();
    expect(queryByRole('button', { name: 'queue.action.save' })).toBeNull();
    expect(queryByRole('button', { name: 'queue.action.run' })).toBeNull();
  });

  it('calls onEdit with the edited title when "Save changes" is clicked', async () => {
    const { getByDisplayValue, getByRole, onEdit } = renderEdit();

    const titleInput = getByDisplayValue('Seeded title');
    await fireEvent.input(titleInput, { target: { value: 'Edited title' } });
    await fireEvent.click(getByRole('button', { name: 'queue.action.saveEdit' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    const payload = onEdit.mock.calls[0]![0] as { task_title: string; priority: number };
    expect(payload.task_title).toBe('Edited title');
    expect(payload.priority).toBe(9);
  });
});
