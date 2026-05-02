// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/client/i18n.svelte', () => ({
  useT: () => (key: string) => key
}));

import AgentMenu from './AgentMenu.svelte';

afterEach(() => {
  cleanup();
});

function makeProps(overrides: Partial<Parameters<typeof render>[1]['props']> = {}) {
  return {
    agent: {
      id: 'agent-1',
      cli_kind: 'claude-code',
      status: 'running' as const
    },
    onShowPlan: vi.fn(),
    onShowLog: vi.fn(),
    onExit: vi.fn(),
    ...overrides
  };
}

describe('AgentMenu — open/close', () => {
  it('renders the kebab button collapsed by default', () => {
    const { getByLabelText, queryByRole } = render(AgentMenu, { props: makeProps() });
    expect(getByLabelText('agentMenu.button')).toBeInTheDocument();
    // Menu is not in the DOM until opened.
    expect(queryByRole('menu')).toBeNull();
  });

  it('opens the menu on button click and shows three items', async () => {
    const { getByLabelText, getByRole, getAllByRole } = render(AgentMenu, {
      props: makeProps()
    });
    await fireEvent.click(getByLabelText('agentMenu.button'));
    expect(getByRole('menu')).toBeInTheDocument();
    expect(getAllByRole('menuitem')).toHaveLength(3);
  });

  it('closes the menu when Escape is pressed', async () => {
    const { getByLabelText, queryByRole } = render(AgentMenu, { props: makeProps() });
    await fireEvent.click(getByLabelText('agentMenu.button'));
    expect(queryByRole('menu')).not.toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(queryByRole('menu')).toBeNull();
  });

  it('closes the menu on outside-click', async () => {
    const { getByLabelText, queryByRole } = render(AgentMenu, { props: makeProps() });
    await fireEvent.click(getByLabelText('agentMenu.button'));
    expect(queryByRole('menu')).not.toBeNull();
    await fireEvent.click(document.body);
    expect(queryByRole('menu')).toBeNull();
  });
});

describe('AgentMenu — item callbacks', () => {
  it('fires onShowPlan exactly once when Show Plan is clicked', async () => {
    const props = makeProps();
    const { getByLabelText, getByText } = render(AgentMenu, { props });
    await fireEvent.click(getByLabelText('agentMenu.button'));
    await fireEvent.click(getByText('agentMenu.showPlan'));
    expect(props.onShowPlan).toHaveBeenCalledOnce();
    expect(props.onShowLog).not.toHaveBeenCalled();
    expect(props.onExit).not.toHaveBeenCalled();
  });

  it('fires onShowLog exactly once when Show Log is clicked', async () => {
    const props = makeProps();
    const { getByLabelText, getByText } = render(AgentMenu, { props });
    await fireEvent.click(getByLabelText('agentMenu.button'));
    await fireEvent.click(getByText('agentMenu.showLog'));
    expect(props.onShowLog).toHaveBeenCalledOnce();
  });

  it('fires onExit exactly once when Exit Agent is clicked (running agent)', async () => {
    const props = makeProps();
    const { getByLabelText, getByText } = render(AgentMenu, { props });
    await fireEvent.click(getByLabelText('agentMenu.button'));
    await fireEvent.click(getByText('agentMenu.exitAgent'));
    expect(props.onExit).toHaveBeenCalledOnce();
  });

  it('closes the menu after a successful pick', async () => {
    const { getByLabelText, getByText, queryByRole } = render(AgentMenu, {
      props: makeProps()
    });
    await fireEvent.click(getByLabelText('agentMenu.button'));
    await fireEvent.click(getByText('agentMenu.showPlan'));
    expect(queryByRole('menu')).toBeNull();
  });
});

describe('AgentMenu — Exit gating by status', () => {
  it('disables Exit Agent when the agent has already exited', async () => {
    const props = makeProps({ agent: { id: 'a', cli_kind: 'codex', status: 'exited' } });
    const { getByLabelText, getByText } = render(AgentMenu, { props });
    await fireEvent.click(getByLabelText('agentMenu.button'));
    const btn = getByText('agentMenu.exitAgent') as HTMLButtonElement;
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(btn);
    expect(props.onExit).not.toHaveBeenCalled();
  });

  it('disables Exit Agent when the agent has crashed', async () => {
    const props = makeProps({ agent: { id: 'a', cli_kind: 'gemini', status: 'crashed' } });
    const { getByLabelText, getByText } = render(AgentMenu, { props });
    await fireEvent.click(getByLabelText('agentMenu.button'));
    const btn = getByText('agentMenu.exitAgent') as HTMLButtonElement;
    expect(btn.hasAttribute('disabled')).toBe(true);
    await fireEvent.click(btn);
    expect(props.onExit).not.toHaveBeenCalled();
  });

  it('still allows Show Plan + Show Log when the agent has exited', async () => {
    const props = makeProps({ agent: { id: 'a', cli_kind: 'claude-code', status: 'exited' } });
    const { getByLabelText, getByText } = render(AgentMenu, { props });
    await fireEvent.click(getByLabelText('agentMenu.button'));
    await fireEvent.click(getByText('agentMenu.showPlan'));
    expect(props.onShowPlan).toHaveBeenCalledOnce();
  });
});
