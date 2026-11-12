import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  admitKnowledgeNavigationPage,
  parseKnowledgeNavigationRequest,
  readKnowledgeNavigation,
} from '../src/knowledge/navigation-read';
import { KnowledgeNavigationReading } from '../src/knowledge/navigation-model';
import { KnowledgeNavigationReturn } from '../src/knowledge/navigation-return';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const accountId = id(99),
  notebookId = id(10),
  placementId = id(20),
  structureRevisionId = id(30);
const root = { kind: 'outline', notebookId, parentPlacementId: null } as const;
const dto = (overrides = {}) => ({
  notebookId,
  structureRevisionId,
  parentPlacementId: null,
  placements: [{ placementId, documentId: id(21), parentPlacementId: null, position: '7', title: 'Supplied title' }],
  next: null,
  ...overrides,
});

test('generated wire sends one GET with exact owner, parent, limit and opaque cursor; sparse stays sparse', async () => {
  const calls: Request[] = [];
  const responses = [
    {
      notebooks: [
        { notebookId, subjectId: id(40), title: 'Owned title', structureRevisionId, createdAt: '2026-11-10T10:00:00Z' },
      ],
      next: 'opaque_inventory',
    },
    dto(),
    dto({ parentPlacementId: placementId, placements: [], next: 'opaque_child_frontier' }),
  ];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      expect(request.cache).toBe('no-store');
      expect(request.redirect).toBe('manual');
      expect(request.headers.get('authorization')).toBe('Bearer owner');
      return Response.json(responses.shift());
    }) as typeof fetch,
  });
  const read = (request: Parameters<typeof readKnowledgeNavigation>[1]['request']) =>
    readKnowledgeNavigation(client, { accountId, authorization: 'Bearer owner', request });
  expect((await read({ kind: 'owned' })).state).toBe('ready');
  expect((await read(root)).state).toBe('ready');
  expect(await read({ ...root, parentPlacementId: placementId, cursor: 'opaque+/=frontier' })).toMatchObject({
    state: 'ready',
    page: { placements: [], next: 'opaque_child_frontier' },
  });
  expect(calls).toHaveLength(3);
  expect(calls.map((r) => new URL(r.url).pathname)).toEqual([
    `/v1/accounts/${accountId}/knowledge/notebooks`,
    `/v1/accounts/${accountId}/knowledge/notebooks/${notebookId}/outline`,
    `/v1/accounts/${accountId}/knowledge/notebooks/${notebookId}/outline`,
  ]);
  expect(calls.map((r) => Object.fromEntries(new URL(r.url).searchParams))).toEqual([
    { limit: '20' },
    { limit: '20' },
    { limit: '20', cursor: 'opaque+/=frontier', parentPlacementId: placementId },
  ]);
});

test('HTTP boundary rejects malformed addresses, oversized pages and misaddressed DTOs', () => {
  expect(parseKnowledgeNavigationRequest({ ...root, accountId: id(2) })).toEqual(root);
  for (const bad of [
    { kind: 'outline', notebookId, parentPlacementId: 'document-title' },
    { ...root, cursor: '' },
    { kind: 'owned', cursor: 'x'.repeat(4097) },
  ])
    expect(parseKnowledgeNavigationRequest(bad)).toBeNull();
  for (const bad of [
    dto({ notebookId: id(2) }),
    dto({ parentPlacementId: placementId }),
    dto({ placements: Array(21).fill(dto().placements[0]) }),
    dto({ next: '' }),
    dto({ placements: [{ ...dto().placements[0], documentId: 'latest' }] }),
  ])
    expect(admitKnowledgeNavigationPage(200, bad, root)).toEqual({ state: 'unavailable' });
  expect(admitKnowledgeNavigationPage(409, { code: 'stale_cursor' }, root)).toEqual({ state: 'changed' });
  expect(admitKnowledgeNavigationPage(403, {}, root)).toEqual({ state: 'denied' });
});

test('reading preserves native order, retries its attempted cursor, and explicitly restarts changed parents', async () => {
  const calls: unknown[] = [];
  let attempt = 0;
  const reader = new KnowledgeNavigationReading(
    async (request) => {
      calls.push(structuredClone(request));
      if (attempt++ === 0)
        return admitKnowledgeNavigationPage(
          200,
          dto({
            placements: [
              { ...dto().placements[0], placementId: id(22), position: '90', title: 'First native row' },
              dto().placements[0],
            ],
            next: 'frontier-a',
          }),
          request,
        );
      if (attempt === 2) return { state: 'unavailable' };
      if (attempt === 3) return { state: 'changed' };
      return admitKnowledgeNavigationPage(200, dto({ structureRevisionId: id(31) }), request);
    },
    { request: root, breadcrumbs: [] },
  );
  await reader.open();
  const first = reader.getSnapshot();
  expect(first.page?.kind === 'outline' && first.page.placements.map((r) => r.title)).toEqual([
    'First native row',
    'Supplied title',
  ]);
  reader.actions(first).more();
  await Promise.resolve();
  expect(reader.getSnapshot().page).toBeUndefined();
  expect(reader.getSnapshot().state).toBe('unavailable');
  reader.actions(reader.getSnapshot()).retry();
  await Promise.resolve();
  expect(calls[1]).toEqual(calls[2]);
  expect(reader.getSnapshot().state).toBe('changed');
  reader.actions(first).more();
  expect(calls).toHaveLength(3);
  reader.actions(reader.getSnapshot()).restart();
  await Promise.resolve();
  expect(calls[3]).toEqual(root);
  expect(reader.getSnapshot().state).toBe('ready');
});

test('structure replacement and retirement discard late rows and old callbacks', async () => {
  let complete!: (value: ReturnType<typeof admitKnowledgeNavigationPage>) => void;
  let calls = 0;
  const reader = new KnowledgeNavigationReading(
    () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    { request: root, breadcrumbs: [], structureRevisionId },
  );
  const pending = reader.open();
  complete(admitKnowledgeNavigationPage(200, dto({ structureRevisionId: id(31) }), root));
  await pending;
  expect(reader.getSnapshot().state).toBe('changed');
  const stale = reader.actions(reader.getSnapshot());
  const late = reader.open();
  reader.retire();
  complete(admitKnowledgeNavigationPage(200, dto(), root));
  await late;
  stale.restart();
  expect(calls).toBe(2);
  expect(reader.getSnapshot().page).toBeUndefined();
  expect(reader.getSnapshot().frontier.breadcrumbs).toEqual([]);
});

test('editor returns consume a bounded frontier once; expiry and identity replacement require restart', () => {
  let now = 0;
  const returning = new KnowledgeNavigationReturn(() => now);
  const address = { notebookId, documentId: id(21) };
  const frontier = {
    request: { ...root, parentPlacementId: placementId, cursor: 'same-frontier' },
    breadcrumbs: [{ placementId, title: 'Visited' }],
    structureRevisionId,
  };
  returning.save('viewer-session-locale', address, frontier);
  expect(returning.take('viewer-session-locale', notebookId)).toBeUndefined(); // Exact address openings reload root.
  returning.save('viewer-session-locale', address, frontier);
  returning.returnTo('viewer-session-locale', address);
  expect(returning.take('viewer-session-locale', notebookId)).toEqual({ frontier, expired: false });
  returning.save('viewer-session-locale', address, frontier);
  returning.returnTo('viewer-session-locale', address);
  now += 15 * 60_000;
  expect(returning.take('viewer-session-locale', notebookId)).toEqual({ expired: true });
  returning.save('old', address, frontier);
  returning.retireUnless('new');
  returning.returnTo('new', address);
  expect(returning.take('new', notebookId)).toEqual({ expired: true });
});
