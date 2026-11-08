import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import type { HistoryEntry } from '../src/moderation/workbench-history/read';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { readWorkbenchHistory, historySource } = await import('../src/moderation/workbench-history/read');
const { WorkbenchHistory } = await import('../src/moderation/workbench-history/view');
const { workbenchSearch } = await import('../src/moderation/workbench-queue/scope');

const entry: HistoryEntry = {
  id: 'decision-one',
  targetId: 'post-one',
  targetKind: 'post',
  action: 'takedown',
  statement: 'Retained reason',
  decidedAt: '2026-11-04T00:00:00.000Z',
  history: { reasonState: 'retained', decider: 'withheld', receipt: 'permitted', target: 'unavailable' },
};
const page = { entries: [entry], nextCursor: 'history:next/opaque', viewer: { kind: 'board-moderator' } };
const search = workbenchSearch({
  board: 'board-one',
  cursor: 'queue:original',
  history: true,
  historyCursor: 'history:original',
  historyTargetKind: 'post',
  historyDecision: entry.id,
});

test('native history transports independent operands and reads one exact receipt without queue scans', async () => {
  const requests: Request[] = [];
  const controller = new AbortController();
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(init?.cache).toBe('no-store');
      expect(init?.signal).toBe(controller.signal);
      const data =
        requests.length === 1
          ? page
          : {
              ...entry,
              appeal: null,
              appealDeadline: null,
              viewer: {
                affectedAuthor: false,
                observedAt: entry.decidedAt,
                appeal: { state: 'unavailable', reason: 'not_affected_author' },
              },
              targetContext: { state: 'concealed' },
            };
      return Response.json(data, { headers: { [SESSION_HEADER]: 'native-source' } });
    }) as typeof fetch,
  });
  const result = await readWorkbenchHistory(
    historySource(client, 'Bearer original', controller.signal),
    search,
    controller.signal,
  );
  expect(result.state).toBe('ready');
  expect(result.selected?.state).toBe('ready');
  expect(requests).toHaveLength(2);
  const url = new URL(requests[0]!.url);
  expect(url.pathname).toBe('/v1/boards/board-one/moderation-history');
  expect(url.searchParams.get('cursor')).toBe('history:original');
  expect(url.searchParams.get('targetKind')).toBe('post');
  expect(url.searchParams.get('limit')).toBe('20');
  expect(requests[1]!.url).toEndWith('/v1/moderation-decisions/decision-one');
  expect(requests.every((request) => request.headers.get('authorization') === 'Bearer original')).toBe(true);
});

test('sparse continuation, stale restart and dependency retry preserve the original selection', async () => {
  const sparse = await readWorkbenchHistory(
    {
      page: async () => ({ status: 200, data: { ...page, entries: [] }, source: 'source' }),
      exact: async () => {
        throw new Error('unexpected exact');
      },
    },
    search,
  );
  expect(sparse).toMatchObject({ state: 'ready', entries: [], next: page.nextCursor });
  for (const [status, code, state] of [
    [400, 'invalid_cursor', 'stale'],
    [503, 'dependency_unavailable', 'unavailable'],
    [404, 'not_found', 'denied'],
  ] as const) {
    const result = await readWorkbenchHistory(
      {
        page: async () => ({ status, error: { value: { code } } }),
        exact: async () => {
          throw new Error('unexpected exact');
        },
      },
      search,
    );
    expect(result).toMatchObject({ state, entries: [], next: null });
    expect(search.historyCursor).toBe('history:original');
  }
});

test('missing native advice, missing source and a replaced exact identity admit no receipt', async () => {
  let exactReads = 0;
  const exact = async () => {
    exactReads++;
    return { status: 200, source: 'source', data: { ...entry, targetId: 'replacement' } };
  };
  const unavailable = { ...entry, history: { ...entry.history, receipt: 'unavailable' as const } };
  const result = await readWorkbenchHistory(
    { page: async () => ({ status: 200, source: 'source', data: { ...page, entries: [unavailable] } }), exact },
    search,
  );
  expect(result.selected?.state).toBe('unavailable');
  expect(exactReads).toBe(0);
  expect((await readWorkbenchHistory({ page: async () => ({ status: 200, data: page }), exact }, search)).state).toBe(
    'unavailable',
  );
  const replaced = await readWorkbenchHistory(
    { page: async () => ({ status: 200, source: 'source', data: page }), exact },
    search,
  );
  expect(replaced.selected?.state).toBe('unavailable');
  expect(exactReads).toBe(1);
});

test('moderator history separates retained empty reasons, retired reasons and unavailable target advice', () => {
  const entries = [
    { ...entry, statement: '' },
    {
      ...entry,
      id: 'retired',
      statement: '',
      history: {
        ...entry.history,
        reasonState: 'retired' as const,
        decider: 'retired' as const,
        receipt: 'unavailable' as const,
      },
    },
  ];
  const markup = renderToStaticMarkup(
    createElement(WorkbenchHistory, {
      page: { state: 'ready', entries, next: 'opaque' },
      search,
      onSearch: () => {},
      onReturn: () => {},
    }),
  );
  expect(markup).toMatch(/datetime="2026-11-04T00:00:00.000Z"/i);
  expect(markup).toContain('post-one');
  expect(markup).not.toContain('<form');
  expect(markup).not.toContain('href="/posts/');
  expect(markup).not.toContain('queue:original');
});

test('a native continuation outside the browser address bound cannot silently become First', async () => {
  const result = await readWorkbenchHistory(
    {
      page: async () => ({ status: 200, source: 'source', data: { ...page, nextCursor: 'x'.repeat(4097) } }),
      exact: async () => {
        throw new Error('unexpected exact');
      },
    },
    search,
  );
  expect(result).toMatchObject({ state: 'unavailable', entries: [], next: null });
});

test('abort after native page or exact dispatch discards late results without reading a successor receipt', async () => {
  for (const phase of ['page', 'exact'] as const) {
    const controller = new AbortController();
    let reads = 0;
    const client = createKernelClient('https://kernel.invalid', {
      fetch: (async (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        reads++;
        if (phase === 'page' || reads === 2) controller.abort();
        return Response.json(
          reads === 1
            ? page
            : {
                ...entry,
                viewer: { affectedAuthor: false, observedAt: entry.decidedAt, appeal: {} },
                targetContext: { state: 'concealed' },
              },
          { headers: { [SESSION_HEADER]: 'late-source' } },
        );
      }) as typeof fetch,
    });
    await expect(
      readWorkbenchHistory(historySource(client, 'Bearer original', controller.signal), search, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(phase === 'page' ? 1 : 2);
  }
});
