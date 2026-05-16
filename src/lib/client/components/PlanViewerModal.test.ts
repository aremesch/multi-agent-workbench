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
  it('renders the empty message with both dirs when the API returns no files', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ dir: 'docs/plans', globalDir: '~/.claude/plans', files: [] })
    );
    const { findByText, container } = render(PlanViewerModal, {
      props: { open: true, source: { kind: 'agent', agentId: 'agent-1' }, onClose: vi.fn() }
    });
    // Mock translator emits "<key> {dir=docs/plans,globalDir=~/.claude/plans}".
    expect(await findByText(/dir=docs\/plans/)).toBeInTheDocument();
    expect(await findByText(/globalDir=~\/.claude\/plans/)).toBeInTheDocument();
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
          globalDir: '~/.claude/plans',
          files: [{ name: 'v0.2.md', modifiedMs: 1000, sizeBytes: 10, source: 'local' }]
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ name: 'v0.2.md', html: '<h1>Hello</h1>', markdown: '# Hello' })
      );

    const { container, findByText } = render(PlanViewerModal, {
      props: { open: true, source: { kind: 'agent', agentId: 'agent-1' }, onClose: vi.fn() }
    });
    expect(await findByText('Hello')).toBeInTheDocument();
    expect(container.querySelector('.markdown-body')?.innerHTML).toContain('<h1>Hello</h1>');

    // Two fetches: list, then ?file=&source=
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const renderUrl = fetchMock.mock.calls[1]![0] as string;
    expect(renderUrl).toContain('file=v0.2.md');
    expect(renderUrl).toContain('source=local');
  });

  it('passes source=global through to the render fetch when a global plan auto-loads', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          dir: 'docs/plans',
          globalDir: '~/.claude/plans',
          files: [{ name: 'g.md', modifiedMs: 9000, sizeBytes: 10, source: 'global' }]
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ name: 'g.md', html: '<p>g</p>', markdown: 'g raw' })
      );

    render(PlanViewerModal, {
      props: { open: true, source: { kind: 'agent', agentId: 'agent-1' }, onClose: vi.fn() }
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const renderUrl = fetchMock.mock.calls[1]![0] as string;
    expect(renderUrl).toContain('file=g.md');
    expect(renderUrl).toContain('source=global');
  });
});

describe('PlanViewerModal — multi-file switcher', () => {
  it('shows a switcher with source-tagged option values when multiple plans exist', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          dir: 'docs/plans',
          globalDir: '~/.claude/plans',
          files: [
            { name: 'v0.2.md', modifiedMs: 2000, sizeBytes: 10, source: 'local' },
            { name: 'v0.1.md', modifiedMs: 1000, sizeBytes: 10, source: 'global' }
          ]
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ name: 'v0.2.md', html: '<p>x</p>', markdown: 'x raw' })
      );

    const { container } = render(PlanViewerModal, {
      props: { open: true, source: { kind: 'agent', agentId: 'agent-1' }, onClose: vi.fn() }
    });
    await waitFor(() => {
      expect(container.querySelector('.switcher select')).toBeTruthy();
    });
    const select = container.querySelector('.switcher select') as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    // Option values encode `${source}/${name}` so duplicate basenames stay distinct.
    expect(select.value).toBe('local/v0.2.md');
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'local/v0.2.md',
      'global/v0.1.md'
    ]);
  });
});

describe('PlanViewerModal — error state', () => {
  it('renders the error body and a retry button when the list fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'boom' }, { status: 500 }));
    const { findByText, findByRole, container } = render(PlanViewerModal, {
      props: { open: true, source: { kind: 'agent', agentId: 'agent-1' }, onClose: vi.fn() }
    });
    // Mock translator emits "<key> {error=HTTP 500}" — assert the error message flowed through.
    expect(await findByText(/error=HTTP 500/)).toBeInTheDocument();
    expect(container.querySelector('.error')).toBeTruthy();
    expect(await findByRole('button', { name: 'plan.modal.retry' })).toBeInTheDocument();
  });
});
