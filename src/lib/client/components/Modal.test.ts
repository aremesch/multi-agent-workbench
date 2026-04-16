// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

// i18n wants a getContext('maw-locale'); mock useT with a pass-through
// translator so the component renders without a context wrapper.
vi.mock('$lib/client/i18n.svelte', () => ({
  useT: () => (key: string) => key
}));

import Modal from './Modal.svelte';

afterEach(() => {
  cleanup();
});

function renderChild() {
  // Svelte 5 Snippets are not plain functions — `createRawSnippet`
  // hand-builds a minimal snippet whose render() returns a string of HTML.
  return createRawSnippet(() => ({
    render: () => '<span data-testid="modal-body">body content</span>'
  }));
}

describe('Modal — structure', () => {
  it('renders a <dialog> with the supplied title and close affordance', () => {
    const { container, getByRole } = render(Modal, {
      props: {
        open: true,
        onClose: vi.fn(),
        title: 'My Modal',
        children: renderChild()
      }
    });
    // Heading rendered.
    expect(getByRole('heading', { level: 2 }).textContent).toBe('My Modal');
    // Close button has the i18n'd aria-label (mock returns the key).
    expect(getByRole('button', { name: 'common.close' })).toBeInTheDocument();
    // Body content rendered into the modal body region.
    expect(container.querySelector('.maw-modal-body')?.textContent).toContain('body content');
  });

  it('falls back to an empty heading when title is omitted', () => {
    const { getByRole } = render(Modal, {
      props: {
        open: true,
        onClose: vi.fn(),
        children: renderChild()
      }
    });
    expect(getByRole('heading', { level: 2 }).textContent).toBe('');
  });
});

describe('Modal — dialog open/close driven by the `open` prop', () => {
  it('calls showModal() on mount when open=true (dialog has the open attribute)', () => {
    const { container } = render(Modal, {
      props: {
        open: true,
        onClose: vi.fn(),
        children: renderChild()
      }
    });
    const dlg = container.querySelector('dialog');
    expect(dlg?.hasAttribute('open')).toBe(true);
  });

  it('does NOT open the dialog when open=false', () => {
    const { container } = render(Modal, {
      props: {
        open: false,
        onClose: vi.fn(),
        children: renderChild()
      }
    });
    const dlg = container.querySelector('dialog');
    expect(dlg?.hasAttribute('open')).toBe(false);
  });

  it('re-opens the dialog when `open` toggles false → true', async () => {
    const { container, rerender } = render(Modal, {
      props: {
        open: false,
        onClose: vi.fn(),
        children: renderChild()
      }
    });
    const dlg = container.querySelector('dialog');
    expect(dlg?.hasAttribute('open')).toBe(false);
    await rerender({ open: true, onClose: vi.fn(), children: renderChild() });
    expect(dlg?.hasAttribute('open')).toBe(true);
  });
});

describe('Modal — onClose triggers', () => {
  it('calls onClose when the header close button is clicked', async () => {
    const onClose = vi.fn();
    const { getByRole } = render(Modal, {
      props: {
        open: true,
        onClose,
        children: renderChild()
      }
    });
    await fireEvent.click(getByRole('button', { name: 'common.close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the user clicks the dialog backdrop', async () => {
    const onClose = vi.fn();
    const { container } = render(Modal, {
      props: {
        open: true,
        onClose,
        children: renderChild()
      }
    });
    const dlg = container.querySelector('dialog') as HTMLDialogElement;
    // Backdrop click: the dialog itself is the event target.
    await fireEvent.click(dlg, { target: dlg });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does NOT call onClose when the user clicks inside the modal body', async () => {
    const onClose = vi.fn();
    const { container } = render(Modal, {
      props: {
        open: true,
        onClose,
        children: renderChild()
      }
    });
    const body = container.querySelector('.maw-modal-body') as HTMLElement;
    await fireEvent.click(body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fires onClose when the native dialog close event fires while open is still true', () => {
    const onClose = vi.fn();
    const { container } = render(Modal, {
      props: {
        open: true,
        onClose,
        children: renderChild()
      }
    });
    const dlg = container.querySelector('dialog') as HTMLDialogElement;
    dlg.dispatchEvent(new Event('close'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
