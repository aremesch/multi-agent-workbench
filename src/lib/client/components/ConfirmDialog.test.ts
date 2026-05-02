// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/client/i18n.svelte', () => ({
  useT: () => (key: string) => key
}));

import ConfirmDialog from './ConfirmDialog.svelte';

afterEach(() => {
  cleanup();
});

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    title: 'Confirm',
    body: 'Are you sure?',
    confirmLabel: 'Yes',
    cancelLabel: 'Cancel',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  };
}

describe('ConfirmDialog', () => {
  it('renders title, body and both buttons when open', () => {
    const { getByText, getByRole } = render(ConfirmDialog, { props: makeProps() });
    expect(getByText('Are you sure?')).toBeInTheDocument();
    expect(getByRole('button', { name: 'Yes' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('fires onConfirm when the confirm button is clicked', async () => {
    const props = makeProps();
    const { getByRole } = render(ConfirmDialog, { props });
    await fireEvent.click(getByRole('button', { name: 'Yes' }));
    expect(props.onConfirm).toHaveBeenCalledOnce();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('fires onCancel when the cancel button is clicked', async () => {
    const props = makeProps();
    const { getByRole } = render(ConfirmDialog, { props });
    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('paints the confirm button with destructive styling when tone="destructive"', () => {
    const props = makeProps({ tone: 'destructive' });
    const { getByRole } = render(ConfirmDialog, { props });
    const btn = getByRole('button', { name: 'Yes' });
    expect(btn.className).toContain('destructive');
  });

  it('does NOT paint destructive class with default tone', () => {
    const { getByRole } = render(ConfirmDialog, { props: makeProps() });
    const btn = getByRole('button', { name: 'Yes' });
    expect(btn.className).not.toContain('destructive');
  });
});
