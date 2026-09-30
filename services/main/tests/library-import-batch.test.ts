import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { reviewCommand } from '../src/modules/review/contract.ts';
import { importReviewedBatch, type ReviewedImportBatch }
  from '../src/modules/library-import/batch.ts';
import type { ReaderLibraryImportStore, ImportPlacement }
  from '../src/modules/library-import/reader-import.ts';

const iri = (suffix: string) => `https://rezics.com/id/0194f314-9280-767f-89a6-${suffix}`;
const agent = iri('000000000099'), work = iri('000000000001');
const request = new Request('http://main.local/v1/me/library-import/batches', {
  method: 'POST', headers: { authorization: 'Bearer reader' } });
const batch = (choice?: 'keep' | 'replace'): ReviewedImportBatch => ({ actingSubject: agent,
  context: null, language: 'en', existingShelves: [], rows: [{ work, status: 'read',
    startedOn: null, finishedOn: '2026-01-04', rating: null, hasRating: false,
    review: null, reviewVisibility: 'private', shelves: ['classics'],
    ...(choice ? { conflictChoice: choice } : {}) }] });

function store(initialDate: string | null) {
  let finishedOn = initialDate, version = 2, statusWrites = 0, shelfWrites = 0;
  const outcomes = new Map<string, Map<number, unknown>>();
  const steps = new Map<string, { plan: Record<string, unknown>; completed: boolean }>();
  let placement: ImportPlacement | null = null;
  const fake = {
    beginBatch: async (_agent: string, key: string) => { if (!outcomes.has(key)) outcomes.set(key, new Map()); },
    outcomes: async (_agent: string, key: string) => new Map(outcomes.get(key)),
    recordOutcome: async (_agent: string, key: string, row: number, outcome: unknown) => {
      outcomes.get(key)!.set(row, outcome);
    },
    withBatch: async (_agent: string, _key: string, action: () => Promise<unknown>) => action(),
    planStep: async (_agent: string, key: string, row: number, name: string, plan: Record<string, unknown>) => {
      const id = `${key}:${row}:${name}`;
      if (!steps.has(id)) steps.set(id, { plan, completed: false });
      return steps.get(id)!;
    },
    completeStep: async (_agent: string, key: string, row: number, name: string) => {
      steps.get(`${key}:${row}:${name}`)!.completed = true;
    },
    planPlacement: async (_agent: string, _shelf: string, _work: string,
      structure: string, expectedHead: string) => {
      placement ??= { structure, expectedHead, attempt: 0, completed: false };
      return placement;
    },
    completePlacement: async () => { placement!.completed = true; },
    call: async (called: Request) => {
      const url = new URL(called.url);
      if (url.pathname.endsWith('/reader-state')) return Response.json({
        status: { status: 'read', startedOn: null, finishedOn, version },
        rating: { global: null }, customShelves: [] });
      if (url.pathname.endsWith('/reader-status')) {
        const body = await called.json() as { finishedOn: string };
        statusWrites++; finishedOn = body.finishedOn; version++;
        return Response.json({ version });
      }
      if (url.pathname === '/v1/collections' && called.method === 'POST') {
        return Response.json({ collection: iri('000000000010') }, { status: 201 });
      }
      if (/\/v1\/collections\/[^/]+$/.test(url.pathname) && called.method === 'GET') {
        return Response.json({ revision: iri('000000000020'), structure: iri('000000000021') });
      }
      if (url.pathname.endsWith('/changes')) { shelfWrites++; return Response.json({ revision: iri('000000000022') }); }
      throw new Error(`unexpected Main call: ${called.method} ${url.pathname}`);
    },
  } as unknown as ReaderLibraryImportStore;
  return { fake, counts: () => ({ statusWrites, shelfWrites, finishedOn }) };
}

test('G428: Main fills missing dates once and retains shelf placement across lost projection and file retry', async () => {
  const { fake, counts } = store(null);
  const first = await importReviewedBatch(fake, request, batch(), 'same-file');
  expect(first).toMatchObject({ pending: false, items: [{ result: { issues: [] } }] });
  expect(counts()).toEqual({ statusWrites: 1, shelfWrites: 1, finishedOn: '2026-01-04' });
  expect(await importReviewedBatch(fake, request, batch(), 'same-file')).toEqual(first);
  expect(await importReviewedBatch(fake, request, batch('keep'), 'reviewed-again'))
    .toMatchObject({ pending: false, items: [{ result: { issues: [] } }] });
  expect(counts()).toEqual({ statusWrites: 1, shelfWrites: 1, finishedOn: '2026-01-04' });
});

test('G428: a newer reader date remains until the reader chooses Keep mine or Use imported', async () => {
  const { fake, counts } = store('2026-01-05');
  expect((await importReviewedBatch(fake, request, batch(), 'plain')).items[0]?.result.issues)
    .toEqual(['status-changed']);
  expect(counts().statusWrites).toBe(0);
  expect((await importReviewedBatch(fake, request, batch('keep'), 'keep')).items[0]?.result.issues)
    .toEqual([]);
  expect(counts().statusWrites).toBe(0);
  expect((await importReviewedBatch(fake, request, batch('replace'), 'replace')).items[0]?.result.issues)
    .toEqual([]);
  expect(counts()).toEqual({ statusWrites: 1, shelfWrites: 1, finishedOn: '2026-01-04' });
});

test('G-650: public library review import uses the resource read and target command, including retry', async () => {
  const { fake } = store('2026-01-04');
  const originalCall = fake.call.bind(fake);
  let reads = 0, writes = 0;
  fake.call = async called => {
    const url = new URL(called.url);
    if (url.pathname === `/v1/resources/${work.slice(-36)}/reviews` && called.method === 'GET') {
      reads++;
      return Response.json({ items: [] });
    }
    if (url.pathname === '/v1/reviews' && called.method === 'POST') {
      const body = await called.json();
      expect(Value.Check(reviewCommand, body)).toBe(true);
      expect(body).toMatchObject({ target: work, text: 'A public imported review' });
      writes++;
      return Response.json({ revision: iri('000000000030') }, { status: 201 });
    }
    if (url.pathname.endsWith('/reader-state')) return Response.json({
      status: { status: 'read', startedOn: null, finishedOn: '2026-01-04', version: 2 },
      rating: { global: { value: 4 } }, customShelves: [] });
    return originalCall(called);
  };
  const input = batch();
  input.context = iri('000000000031');
  input.rows[0] = { ...input.rows[0]!, review: 'A public imported review', reviewVisibility: 'public', shelves: [] };
  const result = await importReviewedBatch(fake, request, input, 'public-review');
  expect(result).toMatchObject({ pending: false, items: [{ result: { issues: [], applied: ['public-review'] } }] });
  expect(await importReviewedBatch(fake, request, input, 'public-review')).toEqual(result);
  expect({ reads, writes }).toEqual({ reads: 1, writes: 1 });
});
