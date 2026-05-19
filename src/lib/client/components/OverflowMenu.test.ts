// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import OverflowMenu, { type OverflowMenuItem } from './OverflowMenu.svelte';

afterEach(() => {
  cleanup();
});

function items(overrides: Partial<OverflowMenuItem>[] = []): OverflowMenuItem[] {
  const base: OverflowMenuItem[] = [
    { id: 'a', label: 'First', onSelect: vi.fn() },
    { id: 'b', label: 'Second', onSelect: vi.fn() },
    { id: 'c', label: 'Danger', destructive: true, dividerBefore: true, onSelect: vi.fn() }
  ];
  return base.map((it, i) => ({ ...it, ...(overrides[i] ?? {}) }));
}

describe('OverflowMenu — open/close', () => {
  it('is collapsed by default and exposes the trigger label', () => {
    const { getByLabelText, queryByRole } = render(OverflowMenu, {
      props: { items: items(), label: 'Row actions' }
    });
    expect(getByLabelText('Row actions')).toBeInTheDocument();
    expect(queryByRole('menu')).toBeNull();
  });

  it('opens on trigger click and renders one menuitem per item', async () => {
    const { getByLabelText, getByRole, getAllByRole } = render(OverflowMenu, {
      props: { items: items(), label: 'Row actions' }
    });
    await fireEvent.click(getByLabelText('Row actions'));
    expect(getByRole('menu')).toBeInTheDocument();
    // Divider is an <hr aria-hidden>, NOT a menuitem.
    expect(getAllByRole('menuitem')).toHaveLength(3);
  });

  it('closes on Escape and on outside-click', async () => {
    const { getByLabelText, queryByRole } = render(OverflowMenu, {
      props: { items: items(), label: 'Row actions' }
    });
    await fireEvent.click(getByLabelText('Row actions'));
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(queryByRole('menu')).toBeNull();

    await fireEvent.click(getByLabelText('Row actions'));
    expect(queryByRole('menu')).not.toBeNull();
    await fireEvent.click(document.body);
    expect(queryByRole('menu')).toBeNull();
  });
});

describe('OverflowMenu — selection', () => {
  it('fires the item handler once and closes the menu', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const its: OverflowMenuItem[] = [
      { id: 'a', label: 'First', onSelect: first },
      { id: 'b', label: 'Second', onSelect: second }
    ];
    const { getByLabelText, getByText, queryByRole } = render(OverflowMenu, {
      props: { items: its, label: 'Row actions' }
    });
    await fireEvent.click(getByLabelText('Row actions'));
    await fireEvent.click(getByText('First'));
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(queryByRole('menu')).toBeNull();
  });

  it('does not fire a disabled item and marks it disabled + aria-disabled', async () => {
    const danger = vi.fn();
    const its: OverflowMenuItem[] = [
      { id: 'c', label: 'Danger', destructive: true, disabled: true, onSelect: danger }
    ];
    const { getByLabelText, getByText } = render(OverflowMenu, {
      props: { items: its, label: 'Row actions' }
    });
    await fireEvent.click(getByLabelText('Row actions'));
    const btn = getByText('Danger') as HTMLButtonElement;
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(btn);
    expect(danger).not.toHaveBeenCalled();
  });

  it('renders an anchor for href items', async () => {
    const { getByLabelText, getByText } = render(OverflowMenu, {
      props: {
        items: [{ id: 'l', label: 'Open agent', href: '/agents/x' }],
        label: 'Row actions'
      }
    });
    await fireEvent.click(getByLabelText('Row actions'));
    const link = getByText('Open agent');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/agents/x');
    expect(link).toHaveAttribute('role', 'menuitem');
  });
});
