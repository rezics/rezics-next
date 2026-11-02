import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadEditableCollectionPage } from '../src/library/collection-load';
import {
  captureCollectionExport,
  CollectionExportAttempt,
  finishCollectionExport,
  validateCollectionExportCapture,
} from '../src/library/collection-export-request';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.com' } }));
const { loadCollectionExport } = await import('../src/library/collection-export-read');
const context = { origin: 'https://rezics.com', locale: 'en' } as const;
const request = new Request('https://rezics.com/collections/list');
const members = ['one', 'two'].map((id) => ({
  id,
  note: `Note ${id}`,
  addedAt: '',
  subject: { id: 'same-subject', label: 'Book', type: 'schema:Book' },
}));
function native() {
  const calls: URL[] = [];
  const state = { denyAt: Infinity, next: null as string | null, revision: 1, members };
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      calls.push(url);
      expect(url.searchParams.get('view')).toBe('FULL');
      if (calls.length >= state.denyAt) return Response.json({ code: 'not_found' }, { status: 404 });
      return Response.json(
        url.pathname.endsWith('/members')
          ? { members: state.members, next: state.next }
          : {
              collection: {
                id: 'list',
                membershipKind: 'curated',
                title: 'List',
                description: null,
                visibility: 'public',
                curatorAccountId: 'curator',
                curator: null,
                revision: state.revision,
                memberCount: members.length,
                createdAt: '',
                updatedAt: '',
              },
            },
      );
    },
  });
  const page = () => loadEditableCollectionPage(client, request, {}, { id: 'list' }, 'anonymous');
  return { client, state, calls, page };
}

test('native completion revalidates FULL reads and retains occurrence notes, duplicates and order', async () => {
  const source = native();
  const capture = captureCollectionExport(await source.page())!;
  const result = await loadCollectionExport(source.client, request, {}, capture, context);
  expect(result.state).toBe('complete');
  if (result.state !== 'complete') throw new Error('Expected complete export');
  const file = JSON.parse(result.file.text);
  expect(
    file.itemListElement.map((item: { identifier: string; description: string }) => [
      item.identifier,
      item.description,
    ]),
  ).toEqual([
    ['one', 'Note one'],
    ['two', 'Note two'],
  ]);
  expect(file.itemListElement[0].url).toBe(file.itemListElement[1].url);
  expect(source.calls).toHaveLength(6); // displayed read, capture read, terminal read; each header + members
  expect(
    source.calls
      .filter((url) => url.pathname.endsWith('/members'))
      .every((url) => url.searchParams.get('limit') === '100'),
  ).toBe(true);
});

test('terminal native denial, changed population and revision never deliver a file; larger reads refuse', async () => {
  const source = native();
  const capture = captureCollectionExport(await source.page())!;
  source.state.denyAt = 5;
  expect(await loadCollectionExport(source.client, request, {}, capture, context)).toEqual({ state: 'unavailable' });
  source.state.denyAt = Infinity;
  source.state.members = [...members].reverse();
  expect(await loadCollectionExport(source.client, request, {}, capture, context)).toEqual({ state: 'changed' });
  source.state.members = members;
  source.state.revision++;
  expect(await loadCollectionExport(source.client, request, {}, capture, context)).toEqual({ state: 'changed' });
  source.state.next = 'later';
  expect(captureCollectionExport(await source.page())).toBeNull();
});

test('cancelled deliveries cannot finish and retry keeps its detached capture after source mutation', async () => {
  const source = native();
  const capture = captureCollectionExport(await source.page())!;
  const attempt = new CollectionExportAttempt(capture);
  let settle!: (value: Awaited<ReturnType<typeof finishCollectionExport>>) => void;
  const pending = attempt.run(
    async () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  attempt.cancel();
  settle({ state: 'complete', file: { filename: 'old', mediaType: 'application/ld+json', text: 'old' } });
  expect(await pending).toEqual({ state: 'cancelled' });
  capture.provenance.viewerId = 'replaced';
  const seen: unknown[] = [];
  expect(
    await attempt.run(async (retained) => {
      seen.push(retained);
      throw new Error('transport');
    }),
  ).toEqual({ state: 'unavailable' });
  await attempt.run(async (retained) => {
    seen.push(retained);
    return { state: 'unavailable' };
  });
  expect(seen[0]).toEqual(seen[1]);
  expect((seen[0] as typeof capture).provenance.viewerId).toBeNull();
});

test('curated filters and invalid captures refuse instead of falling back to an unfiltered population', async () => {
  const source = native();
  const page = await source.page();
  const capture = captureCollectionExport(page)!;
  expect(captureCollectionExport({ ...page, filter: { and: [] } })).toBeNull();
  expect(() => validateCollectionExportCapture({ ...capture, filter: { and: [] } })).toThrow();
  expect(() =>
    validateCollectionExportCapture({ ...capture, population: [capture.population[0], capture.population[0]] }),
  ).toThrow();
  expect(captureCollectionExport({ ...page, provenance: undefined })).toBeNull();
});
