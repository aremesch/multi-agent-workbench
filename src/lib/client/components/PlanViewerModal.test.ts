// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub useT to render `key {dir=foo, error=bar}` so tests can assert on
// substituted params without needing the real i18n dictionary.
vi.mock('$lib/client/i18n.svelte', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    if (!params || Object.keys(params).length === 0) return key;
    const tail = Object.entries(params)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(',');
    return `${key} {${tail}}`;
  }
}));

import PlanViewerModal from './PlanViewerModal.svelte';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

describe('PlanViewerModal — empty state', () => {
  it('renders the empty message when the API returns no files', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ dir: 'docs/plans', files: [] }));
    const { findByText, container } = render(PlanViewerModal, {
      props: { open: true, agentId: 'agent-1', onClose: vi.fn() }
    });
    // Mock translator emits "<key> {dir=docs/plans}" — assert the dir flowed through.
    expect(await findByText(/dir=docs\/plans/)).toBeInTheDocument();
    expect(container.querySelector('.empty')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain('/api/agents/agent-1/plan');
  });
});

describe('PlanViewerModal — single file auto-load', () => {
  it('auto-loads the most recently modified plan and renders its HTML', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          dir: 'docs/plans',
          files: [{ name: 'v0.2.md', modifiedMs: 1000, sizeBytes: 10 }]
        })
      )
      .mockResolvedValueOnce(jsonResponse({ name: 'v0.2.md', html: '<h1>Hello</h1>' }));

    const { container, findByText } = render(PlanViewerModal, {
      props: { open: true, agentId: 'agent-1', onClose: vi.fn() }
    });
    expect(await findByText('Hello')).toBeInTheDocument();
    expect(container.querySelector('.markdown-body')?.innerHTML).toContain('<h1>Hello</h1>');

    // Two fetches: list, then ?file=
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toContain('file=v0.2.md');
  });
});

describe('PlanViewerModal — multi-file switcher', () => {
  it('shows a select switcher when multiple plans exist', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          dir: 'docs/plans',
          files: [
            { name: 'v0.2.md', modifiedMs: 2000, sizeBytes: 10 },
            { name: 'v0.1.md', modifiedMs: 1000, sizeBytes: 10 }
          ]
        })
      )
      .mockResolvedValueOnce(jsonResponse({ name: 'v0.2.md', html: '<p>x</p>' }));

    const { container } = render(PlanViewerModal, {
      props: { open: true, agentId: 'agent-1', onClose: vi.fn() }
    });
    await waitFor(() => {
      expect(container.querySelector('.switcher select')).toBeTruthy();
    });
    const select = container.querySelector('.switcher select') as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    expect(select.value).toBe('v0.2.md');
  });
});

describe('PlanViewerModal — error state', () => {
  it('renders the error body and a retry button when the list fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'boom' }, { status: 500 }));
    const { findByText, findByRole, container } = render(PlanViewerModal, {
      props: { open: true, agentId: 'agent-1', onClose: vi.fn() }
    });
    // Mock translator emits "<key> {error=HTTP 500}" — assert the error message flowed through.
    expect(await findByText(/error=HTTP 500/)).toBeInTheDocument();
    expect(container.querySelector('.error')).toBeTruthy();
    expect(await findByRole('button', { name: 'plan.modal.retry' })).toBeInTheDocument();
  });
});
