import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { reviewCommand } from '../src/modules/review/contract.ts';
import { importReviewedBatch, portableShelfId, type ReviewedImportBatch }
  from '../src/modules/library-import/batch.ts';
import { ReaderLibraryImportStore, ReaderImportUnavailable, type ImportPlacement }
  from '../src/modules/library-import/reader-import.ts';
import type { Pool } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { applyLibraryFile } from '../src/modules/library-import/apply.ts';
import type { LibraryFileStore, StoredSourceRow } from '../src/modules/library-import/file-store.ts';
import type { CanonicalRow } from '../src/modules/library-import/formats/contract.ts';

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

// Exercise the file adapter too: shelf rows and membership rows must make the
// same ownership decision even when a new upload supplies fresh command keys.
type PortableShelf = { curator: string; name: string; disclosure: 'private' | 'public'; members: Set<string> };
function portableLibrary() {
  const shelves = new Map<string, PortableShelf>();
  const ownershipReads: string[] = [];
  const graph = { query: async (query: string) => {
    ownershipReads.push(query);
    const id = /VALUES \?id \{ <([^>]+)> \}/.exec(query)![1]!;
    const curator = /rv:curator <([^>]+)>/.exec(query)![1]!;
    return { results: { bindings: shelves.get(id)?.curator === curator
      ? [{ id: { type: 'uri', value: id } }] : [] } };
  } } as Pick<FusekiClient, 'query'>;
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const memory = store(null).fake;
  const owner = Object.assign(new ReaderLibraryImportStore(pool, undefined, undefined, graph), memory);
  const placements = new Map<string, ImportPlacement>();
  owner.planPlacement = async (person, shelf, target, structure, expectedHead) => {
    const id = `${person}:${shelf}:${target}`;
    if (!placements.has(id)) placements.set(id, { structure, expectedHead, attempt: 0, completed: false });
    return placements.get(id)!;
  };
  owner.completePlacement = async (person, shelf, target) => {
    placements.get(`${person}:${shelf}:${target}`)!.completed = true;
  };
  let creates = 0, inserts = 0, loseCreateResponse = false;
  const receipts = new Map<string, object>();
  owner.call = async called => {
    const url = new URL(called.url);
    expect(called.headers.get('authorization')).toBe('Bearer reader');
    if (url.pathname.endsWith('/reader-state')) return Response.json({
      status: { status: null, startedOn: null, finishedOn: null, version: 0 },
      rating: { global: null }, customShelves: [...shelves].filter(([, shelf]) =>
        shelf.curator === url.searchParams.get('actingSubject') && shelf.members.has(work))
        .map(([id]) => ({ id })) });
    if (url.pathname === '/v1/collections' && called.method === 'POST') {
      const body = await called.json() as { collection: string; name: string; disclosure: 'private' | 'public'; actingSubject: string };
      const key = called.headers.get('idempotency-key')!;
      if (receipts.has(key)) return Response.json(receipts.get(key));
      if (shelves.has(body.collection)) return Response.json({ code: 'already_exists' }, { status: 409 });
      shelves.set(body.collection, { curator: body.actingSubject, name: body.name,
        disclosure: body.disclosure, members: new Set() });
      creates++;
      const result = { collection: body.collection };
      receipts.set(key, result);
      if (loseCreateResponse) { loseCreateResponse = false; throw new ReaderImportUnavailable('lost owner response'); }
      return Response.json(result, { status: 201 });
    }
    const id = `https://rezics.com/id/${url.pathname.split('/')[3]}`;
    const shelf = shelves.get(id);
    if (!shelf) return Response.json({ code: 'missing' }, { status: 404 });
    if (called.method === 'GET') return Response.json({ revision: iri('000000000020'), structure: iri('000000000021') });
    const body = await called.json() as { actingSubject: string; operations: { target: string }[] };
    if (shelf.curator !== body.actingSubject) return Response.json({ code: 'denied' }, { status: 403 });
    for (const operation of body.operations) { shelf.members.add(operation.target); inserts++; }
    return Response.json({ revision: iri('000000000022') });
  };
  async function apply(person: string, rows: CanonicalRow[], fileKey: string) {
    const completed = new Map<number, NonNullable<StoredSourceRow['outcome']>>();
    const files = {
      pool, seal: async () => {}, file: async () => ({ import_key: fileKey, format: 'rezics' }),
      pending: async () => rows.map((source, index) => ({ index, source, resolution: null, match: null })),
      complete: async (_person: string, _file: string, index: number, outcome: NonNullable<StoredSourceRow['outcome']>) => { completed.set(index, outcome); },
      progress: async () => ({ completed: completed.size }),
    } as unknown as LibraryFileStore;
    await applyLibraryFile(files, owner, request, person, fileKey, { context: null, language: 'en' });
    expect([...completed.values()].map(outcome => outcome.issues)).toEqual(rows.map(() => []));
  }
  return { owner, shelves, ownershipReads, apply, counts: () => ({ creates, inserts }),
    loseNextCreateResponse: () => { loseCreateResponse = true; } };
}
function portableRow(kind: 'shelf' | 'entry', shelf: string, name = 'Private shelf'): CanonicalRow {
  return { kind, sourceId: kind === 'shelf' ? shelf : `member:${shelf}`, title: name, creators: [],
    work: kind === 'entry' ? work : null, target: null, identifiers: [], status: null,
    startedOn: null, finishedOn: null, score: null, review: null, shelves: [name], readCount: null,
    progress: null, session: null, raw: { shelfId: shelf, disclosure: 'private' } };
}

const emptyShelf = iri('000000000040'), populatedShelf = iri('000000000041');
const portableRows = () => [portableRow('shelf', emptyShelf), portableRow('shelf', populatedShelf),
  portableRow('entry', populatedShelf)];

test('portable same-Person reimport preserves empty shelves, independent names and memberships with fresh keys', async () => {
  const library = portableLibrary();
  library.shelves.set(emptyShelf, { curator: agent, name: 'Private shelf', disclosure: 'private', members: new Set() });
  library.shelves.set(populatedShelf, { curator: agent, name: 'Private shelf', disclosure: 'private', members: new Set([work]) });
  const before = structuredClone(library.shelves);
  await library.apply(agent, portableRows(), 'same-person-first');
  await library.apply(agent, portableRows(), 'same-person-fresh-keys');
  expect(library.shelves).toEqual(before);
  expect(library.counts()).toEqual({ creates: 0, inserts: 0 });
  expect(library.ownershipReads.every(query => query.includes('LIMIT 2')
    && query.includes(`rv:curator <${agent}>`))).toBe(true);
});

test.each(['private', 'public'] as const)('portable independent-Person restoration never adopts another curator\'s %s shelves', async disclosure => {
  const library = portableLibrary(), other = iri('000000000098');
  library.shelves.set(emptyShelf, { curator: other, name: 'Private shelf', disclosure, members: new Set() });
  library.shelves.set(populatedShelf, { curator: other, name: 'Private shelf', disclosure, members: new Set([work]) });
  const originals = structuredClone(library.shelves);
  await library.apply(agent, portableRows(), 'independent-person');
  const restored = structuredClone(library.shelves);
  await library.apply(agent, portableRows(), 'independent-person-fresh-key');
  expect(library.shelves).toEqual(restored);
  for (const [id, shelf] of originals) expect(library.shelves.get(id)).toEqual(shelf);
  expect(library.shelves.get(portableShelfId(agent, emptyShelf))).toEqual({
    curator: agent, name: 'Private shelf', disclosure: 'private', members: new Set() });
  expect(library.shelves.get(portableShelfId(agent, populatedShelf))).toEqual({
    curator: agent, name: 'Private shelf', disclosure: 'private', members: new Set([work]) });
  expect(library.shelves.size).toBe(4);
  expect(library.counts()).toEqual({ creates: 2, inserts: 1 });
});

test('portable shelf restoration resumes after a committed create loses its response', async () => {
  const library = portableLibrary(), rows = [portableRow('shelf', emptyShelf)];
  library.loseNextCreateResponse();
  await expect(library.apply(agent, rows, 'lost-create')).rejects.toBeInstanceOf(ReaderImportUnavailable);
  await library.apply(agent, rows, 'lost-create');
  await library.apply(agent, rows, 'fresh-create-key');
  expect(library.counts()).toEqual({ creates: 1, inserts: 0 });
  expect(library.shelves.size).toBe(1);
});

test('a portable membership page restores its own shelf before the shelf metadata page arrives', async () => {
  const library = portableLibrary();
  await library.apply(agent, [portableRow('entry', populatedShelf)], 'membership-page');
  await library.apply(agent, [portableRow('shelf', populatedShelf)], 'shelf-page');
  expect(library.shelves.get(portableShelfId(agent, populatedShelf))).toEqual({
    curator: agent, name: 'Private shelf', disclosure: 'private', members: new Set([work]) });
  expect(library.counts()).toEqual({ creates: 1, inserts: 1 });
});

test.each(['shelf', 'entry'] as const)('a conflicting curator at the derived identity refuses the %s rather than adopting it', async kind => {
  const library = portableLibrary(), id = portableShelfId(agent, emptyShelf);
  library.shelves.set(id, { curator: iri('000000000098'), name: 'Private shelf', disclosure: 'public', members: new Set() });
  const before = structuredClone(library.shelves);
  const files = { pool: library.owner.pool, seal: async () => {},
    file: async () => ({ import_key: 'conflict', format: 'rezics' }),
    pending: async () => [{ index: 0, source: portableRow(kind, emptyShelf), resolution: null, match: null }],
    complete: async (_person: string, _file: string, _index: number, outcome: unknown) => {
      expect(outcome).toEqual({ applied: ['private-source'], issues: ['shelf-failed'] });
    }, progress: async () => ({ completed: 1 }),
  } as unknown as LibraryFileStore;
  await applyLibraryFile(files, library.owner, request, agent, 'conflict', { context: null, language: 'en' });
  expect(library.shelves).toEqual(before);
  expect(library.counts()).toEqual({ creates: 0, inserts: 0 });
});
