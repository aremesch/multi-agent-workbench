// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub useT to echo the key (+ params) so tests assert on stable strings.
vi.mock('$lib/client/i18n.svelte', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    if (!params || Object.keys(params).length === 0) return key;
    const tail = Object.entries(params)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(',');
    return `${key} {${tail}}`;
  }
}));

const apiFetchMock = vi.fn();
vi.mock('$lib/client/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args)
}));

import ShowChangesModal from './ShowChangesModal.svelte';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  apiFetchMock.mockReset();
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

function makeChanges(overrides: Record<string, unknown> = {}) {
  return {
    committed: {
      kind: 'committed',
      totalAdded: 1,
      totalRemoved: 1,
      truncated: false,
      note: null,
      files: [
        {
          path: 'src/foo.ts',
          oldPath: null,
          status: 'M',
          added: 1,
          removed: 1,
          binary: false,
          truncated: false,
          hunks: [
            {
              header: '@@ -1,2 +1,2 @@',
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 2,
              lines: [
                { type: 'context', oldNo: 1, newNo: 1, text: 'keep' },
                { type: 'del', oldNo: 2, newNo: null, text: 'old' },
                { type: 'add', oldNo: null, newNo: 2, text: 'new' }
              ]
            }
          ]
        }
      ]
    },
    uncommitted: {
      kind: 'uncommitted',
      totalAdded: 0,
      totalRemoved: 0,
      truncated: false,
      note: null,
      files: []
    },
    baseSha: 'BASE',
    headSha: 'HEAD',
    aiEnabled: true,
    ...overrides
  };
}

describe('ShowChangesModal — diff rendering', () => {
  it('renders sections with cards collapsed by default (no hunk DOM)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeChanges()));
    const { container, findByText } = render(ShowChangesModal, {
      props: { open: true, agentId: 'agent-1', onClose: vi.fn() }
    });
    // Card header shows the path.
    expect(await findByText('src/foo.ts')).toBeInTheDocument();
    // Collapsed: no hunk lines mounted yet.
    expect(container.querySelector('.hunk')).toBeNull();
    expect(container.querySelector('.line')).toBeNull();
    expect(fetchMock.mock.calls[0]![0]).toContain('/api/agents/agent-1/changes');
  });

  it('reveals hunk lines when a card is expanded', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeChanges()));
    const { container, findByText } = render(ShowChangesModal, {
      props: { open: true, agentId: 'agent-1', onClose: vi.fn() }
    });
    const head = (await findByText('src/foo.ts')).closest('button')!;
    await fireEvent.click(head);
    await waitFor(() => expect(container.querySelector('.hunk')).toBeTruthy());
    const codes = Array.from(container.querySelectorAll('.line .code')).map((n) => n.textContent);
    expect(codes).toEqual(['keep', 'old', 'new']);
  });

  it('shows the empty message when nothing changed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        makeChanges({
          committed: { kind: 'committed', totalAdded: 0, totalRemoved: 0, truncated: false, note: null, files: [] }
        })
      )
    );
    const { container } = render(ShowChangesModal, {
      props: { open: true, agentId: 'agent-1', onClose: vi.fn() }
    });
    await waitFor(() => expect(container.querySelector('.empty')).toBeTruthy());
  });
});

describe('ShowChangesModal — AI panel', () => {
  it('disables the Q&A panel with a hint when aiEnabled is false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeChanges({ aiEnabled: false })));
    const { container, findByText } = render(ShowChangesModal, {
      props: { open: true, agentId: 'agent-1', onClose: vi.fn() }
    });
    expect(await findByText('changes.modal.aiDisabledHint')).toBeInTheDocument();
    expect(container.querySelector('.qa-input')).toBeNull();
  });

  it('sends a question and renders the returned HTML answer', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeChanges()));
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ html: '<p>because</p>', markdown: 'because' })
    );
    const { container, findByPlaceholderText, findByText } = render(ShowChangesModal, {
      props: { open: true, agentId: 'agent-1', onClose: vi.fn() }
    });
    const textarea = (await findByPlaceholderText('changes.modal.askPlaceholder')) as HTMLTextAreaElement;
    await fireEvent.input(textarea, { target: { value: 'why?' } });
    const send = await findByText('changes.modal.send');
    await fireEvent.click(send);

    await waitFor(() => expect(container.querySelector('.qa-a.markdown-body')).toBeTruthy());
    expect(container.querySelector('.qa-a.markdown-body')?.innerHTML).toContain('<p>because</p>');
    expect(container.querySelector('.qa-q')?.textContent).toBe('why?');
    // The diff-bearing section is forwarded to the QA endpoint.
    const [, init] = apiFetchMock.mock.calls[0]!;
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.question).toBe('why?');
    expect(payload.sections).toEqual(['committed']);
  });
});
