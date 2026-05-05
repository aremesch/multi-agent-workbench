// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const QUICK_KEY = { id: 'up', label: '↑', keys: '\x1b[A' };

const mocks = vi.hoisted(() => ({
  sendKeys: vi.fn(),
  sendResize: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  quickKey: { id: 'up', label: '↑', keys: '\x1b[A' }
}));

vi.mock('$lib/client/i18n.svelte', () => ({
  useT: () => (key: string) => key
}));

vi.mock('$lib/client/api', () => ({
  apiFetch: vi.fn()
}));

vi.mock('$lib/client/ws', () => ({
  getMawWsClient: () => ({
    sendKeys: mocks.sendKeys,
    sendResize: mocks.sendResize,
    subscribe: mocks.subscribe,
    unsubscribe: mocks.unsubscribe
  })
}));

vi.mock('$app/state', () => ({
  page: {
    data: {
      mobileQuickKeysMode: 'always',
      cliKinds: [{ kind: 'shell', mobileQuickKeys: [mocks.quickKey] }]
    }
  }
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import AgentTerminalPanel from './AgentTerminalPanel.svelte';

afterEach(() => {
  cleanup();
  mocks.sendKeys.mockClear();
  mocks.sendResize.mockClear();
  mocks.subscribe.mockClear();
  mocks.unsubscribe.mockClear();
});

const SHELL_AGENT = {
  id: 'agent-1',
  cli_kind: 'shell',
  status: 'running',
  tmux_session: 'maw-agent-1'
};

describe('AgentTerminalPanel — mobile quick-keys focus theft prevention', () => {
  it('renders the configured quick-key button when quickKeysMode is always', () => {
    const { getByLabelText } = render(AgentTerminalPanel, { props: { agent: SHELL_AGENT } });
    expect(getByLabelText(QUICK_KEY.label)).toBeInTheDocument();
  });

  it('cancels the default focus shift on mousedown so xterm keeps focus', () => {
    const { getByLabelText } = render(AgentTerminalPanel, { props: { agent: SHELL_AGENT } });
    const btn = getByLabelText(QUICK_KEY.label);
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('forwards the configured key bytes through sendKeys on click', async () => {
    const { getByLabelText } = render(AgentTerminalPanel, { props: { agent: SHELL_AGENT } });
    const btn = getByLabelText(QUICK_KEY.label);
    await fireEvent.click(btn);
    expect(mocks.sendKeys).toHaveBeenCalledTimes(1);
    expect(mocks.sendKeys).toHaveBeenCalledWith(SHELL_AGENT.id, QUICK_KEY.keys);
  });
});
