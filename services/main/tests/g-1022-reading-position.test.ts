import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ReadingBoundary } from '../src/modules/reading-position/boundary.ts';
import { ReadingPositionTraversal } from '../src/modules/reading-position/traversal.ts';
import { searchOccurrenceLabels } from '../src/modules/reading-position/label-index.ts';
import { WorkReadSession, WorkReadUnavailable, type ReadRow } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { ReadingOrderIndex } from '../src/modules/reading-position/immutable-order.ts';
import { backfillOccurrenceLabels } from '../src/modules/structure/label-index-backfill.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const binding = (value: string) => ({ type: 'literal', value });
test('G1022: wiki prefix resolves explicit and Mine boundaries with exact batches at 100, 1000 and 10000 chapters', async () => {
  for (const count of [100, 1000, 10000]) for (const selection of ['explicit', 'mine']) {
    const work = id(), structure = id(), revision = id(), occurrence = id(), revealed = id(), record = id();
    const rows = new Map<string, ReadRow>([[occurrence, {
      work: binding(work), structure: binding(structure), revision: binding(revision), occurrence: binding(occurrence),
      parent: binding(structure), segmentKey: binding('z'), orderKey: binding(String(count).padStart(5, '0')),
      role: binding('https://rezics.com/vocab/ChapterRole'),
    }], [revealed, {
      work: binding(work), structure: binding(structure), revision: binding(revision), occurrence: binding(revealed),
      parent: binding(structure), segmentKey: binding('a'), orderKey: binding('00001'),
      role: binding('https://rezics.com/vocab/ChapterRole'),
    }]]);
    const deps = { readingPositions: {
      generation: async () => '1', privateSnapshot: async () => 'stable', required: async () => new Set(),
      lookup: async () => new Map([[record, [{ record, recordKind: 'entity', occurrence: revealed, continuityWork: work, receipt: 'r' }]]]),
      completedPage: async () => ({ items: [occurrence], next: null }), finishedWorks: async () => new Set(),
    }, access: { canReadAsBaselineMember: async () => true } } as unknown as MainWorkDependencies;
    const session = new WorkReadSession(deps, new Request('http://main.local/fixture'), { actingSubject: id() }, { dataEpoch: 'epoch', sequence: '1' });
    session.principal = { issuer: 'https://qa.test', subject: 'reader', emailVerified: true };
    let calls = 0, returned = 0;
    session.query = async query => {
      calls++;
      expect(query).not.toContain('SELECT ?work ?structure ?revision ?placement');
      if (query.includes('# reading-position:works')) return [{ work: binding(work), structure: binding(structure), revision: binding(revision), generation: binding(id()) }];
      expect(query).toContain('# reading-position:records');
      const values = query.match(/VALUES \?occurrence \{([^}]+)}/)![1]!;
      const selected = [...rows.entries()].filter(([resource]) => values.includes(resource)).map(([, row]) => row);
      returned += selected.length; return selected;
    };
    const boundary = new ReadingBoundary(session, selection === 'mine' ? 'mine' : occurrence);
    const traversal = new ReadingPositionTraversal(session, work, async resources => new Set(resources));
    boundary.traversalFor = () => traversal;
    expect(await boundary.visible([record])).toEqual(new Set([record]));
    expect(calls).toBeLessThanOrEqual(3); expect(returned).toBe(2);
    expect(await boundary.visible([record])).toEqual(new Set([record]));
    expect(returned).toBe(2);
  }
});

test('G1022: index pages merge numeric rank, validate seek order and never turn missing coverage into exact empty', async () => {
  const work = id(), structure = id(), generation = id(), revision = id(), a = id(), b = id();
  const meta = { work, structure, generation, revision };
  let page: unknown = { items: [{ occurrence: a, segmentKey: 'a', orderKey: 'b', matches: true }], reads: 3 };
  const session = { query: async (query: string) => query.includes('numbered-placement')
    ? [{ segmentKey: binding('a'), orderKey: binding('a') }]
    : [{ page: binding(JSON.stringify(page)) }] } as unknown as WorkReadSession;
  const order = { hydrate: async (_meta: unknown, entries: Array<{ occurrence: string; parent: string; segmentKey: string; orderKey: string }>) =>
    entries.map(entry => ({ ...entry, work, structure, revision, role: 'chapter', target: null })) } as unknown as ReadingOrderIndex;
  const merged = await searchOccurrenceLabels(session, order, meta, structure, '1', undefined, 1, b);
  expect(merged.map(candidate => candidate.item.occurrence)).toEqual([b]); expect(merged[0]!.matches).toBe(true);
  for (const invalid of [null, { items: [], reads: 100_000 }, { items: [
    { occurrence: a, segmentKey: 'b', orderKey: 'a', matches: true },
    { occurrence: b, segmentKey: 'a', orderKey: 'a', matches: true },
  ], reads: 3 }]) {
    page = invalid;
    await expect(searchOccurrenceLabels(session, order, meta, structure, 'a', undefined, 2, null)).rejects.toBeInstanceOf(WorkReadUnavailable);
  }
  session.query = async () => [{}];
  await expect(searchOccurrenceLabels(session, order, meta, structure, 'a', undefined, 2, null)).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('G1022: backfill accepts derived placement URNs and resumes after a lost committed response', async () => {
  const generation = id(), placement = `urn:rezics:placement:${'a'.repeat(64)}`;
  let covered = false, commands = 0;
  const interruption = new AbortController();
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (query: string) => ({ results: { bindings: query.includes('rv:indexVersion') || covered ? []
      : [{ generation: binding(generation), placement: binding(placement) }] } }),
    commandWithReceipt: async (request: { update: string }) => {
      commands++; expect(request.update).toContain(`rv:occurrenceSearchPlacement <${placement}>`);
      covered = true; interruption.abort(new Error('lost response'));
      return { status: 'committed', position: { dataEpoch: 'epoch', sequence: '2' } };
    },
  } } as unknown as WorkActivationEnvironment;
  await expect(backfillOccurrenceLabels(env, { generation, signal: interruption.signal })).rejects.toThrow('lost response');
  expect(await backfillOccurrenceLabels(env, { generation })).toMatchObject({ indexed: 0, batches: 0 });
  expect(commands).toBe(1);
});
