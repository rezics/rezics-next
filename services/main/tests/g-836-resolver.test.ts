import { expect, test } from 'bun:test';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { readMergedIdentity, redirectOf } from '../src/modules/identity-merge/resolution.ts';
import { MergeUnavailable } from '../src/modules/identity-merge/contract.ts';
import { resolveTargets, TargetUnavailable, TARGET_RESOLVE_COST } from '../src/modules/target/resolve.ts';
import { WorkReadInvalid, WorkReadSession, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaUnavailable } from '../src/modules/media/store.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });
interface Record { resource: string; next?: string; public?: boolean }
function fixture(records: Record[]) {
  const calls: string[] = [], graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    calls.push(query);
    const requested = records.filter(record => query.includes(`<${record.resource}>`));
    let rows: NonNullable<SparqlResult['results']>['bindings'];
    if (query.includes('SELECT ?epoch ?sequence ?hold')) rows = requested.length ? requested.map(record => ({
      epoch: literal('epoch'), sequence: literal('1'), r: uri(record.resource), type: literal('work'),
      work: uri(record.resource), head: uri(id(1000)), public: literal(String(record.public ?? true)),
      erased: literal('false'), label: { type: 'literal', value: 'Sword Art Online 1', 'xml:lang': 'en' },
      ...(record.next ? { mergedInto: uri(record.next) } : {}),
    })) : [{ epoch: literal('epoch'), sequence: literal('1') }];
    else if (query.includes('SELECT ?epoch ?sequence ?r ?revision ?type')) rows = requested.map(record => ({
      epoch: literal('epoch'), sequence: literal('1'), r: uri(record.resource), revision: uri(id(1000)),
      type: uri('https://schema.org/Book'), ...(record.next ? { mergedInto: uri(record.next) } : {}),
    }));
    else if (query.includes('SELECT ?sequence ?mergedInto')) rows = [{ sequence: literal('1'),
      ...(requested[0]?.next ? { mergedInto: uri(requested[0].next) } : {}) }];
    else if (query.includes('SELECT ?sequence WHERE')) rows = [{ sequence: literal('1') }];
    else throw new Error(`Unexpected graph probe: ${query}`);
    return { results: { bindings: rows } };
  };
  const environment = { fuseki: graph, objectDirectory: '.temp/g-836-resolver', lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  const deps: MainWorkDependencies = { environment, access: {} as never, account: {} as never };
  const session = new WorkReadSession(deps, new Request('http://main.test'), {}, { dataEpoch: 'epoch', sequence: '1' });
  return { calls, session, environment };
}

test('G836: every default capability target follows native mergedInto in bounded batches and preserves duplicates', async () => {
  const records = [...Array.from({ length: 64 }, (_, n) => ({ resource: id(n + 1), next: id(100) })), { resource: id(100) }];
  const f = fixture(records), targets = await resolveTargets(f.session, records.slice(0, 64).map(record => record.resource), 'discussion');
  expect(targets).toHaveLength(64);
  expect(targets.every(target => target.resource === id(100) && target.work === id(100))).toBe(true);
  expect(f.calls).toHaveLength(4);
  expect(TARGET_RESOLVE_COST.redirectHops).toBe(32);
  const duplicate = fixture([{ resource: id(1), next: id(2) }, { resource: id(2) }]);
  expect((await resolveTargets(duplicate.session, [id(1), id(2), id(1)], 'review')).map(target => target.resource))
    .toEqual([id(2), id(2), id(2)]);
  expect(duplicate.calls).toHaveLength(4);
  await expect(resolveTargets(duplicate.session, Array.from({ length: 65 }, () => id(1)), 'review')).rejects.toBeInstanceOf(WorkReadInvalid);
});

test('G836: summary identity chains share disclosure, preserve source metadata and batch converging aliases', async () => {
  const sources = Array.from({ length: 64 }, (_, n) => ({ resource: id(n + 1), next: id(100) }));
  const f = fixture([...sources, { resource: id(100) }]);
  const input = { resources: sources.map(record => record.resource), context: DEFAULT_MEDIA_CONTEXT, language: null };
  const result = await readResourceSummaries(f.environment, undefined, {}, input);
  expect(result.cost.graphQueries).toBe(3);
  expect(result.summaries).toHaveLength(64);
  expect(result.summaries[0]).toMatchObject({ reference: id(1), status: 'available',
    resolution: { state: 'merged', source: id(1), survivor: id(100), hops: 1 } });
  for (const hidden of [1, 2]) {
    const f = fixture([{ resource: id(1), next: id(2), public: hidden !== 1 }, { resource: id(2), public: hidden !== 2 }]);
    expect((await readResourceSummaries(f.environment, undefined, {}, { ...input, resources: [id(1)] })).summaries)
      .toEqual([{ reference: id(1), status: 'unavailable' }]);
  }
  const chain = Array.from({ length: 33 }, (_, n) => ({ resource: id(n + 1), ...(n < 32 ? { next: id(n + 2) } : {}) }));
  const deep = fixture(chain);
  expect((await readResourceSummaries(deep.environment, undefined, {}, { ...input, resources: [id(1)] })).summaries[0])
    .toMatchObject({ resolution: { hops: 32, survivor: id(33) } });
  expect(deep.calls).toHaveLength(34);
  for (const records of [[{ resource: id(1), next: id(2) }, { resource: id(2), next: id(1) }],
    [...chain.slice(0, 32), { resource: id(33), next: id(34) }, { resource: id(34) }]]) {
    const f = fixture(records);
    await expect(readResourceSummaries(f.environment, undefined, {}, { ...input, resources: [id(1)] }))
      .rejects.toBeInstanceOf(MediaUnavailable);
  }
});

test('G836: exactly 32 identity hops resolve; cycles, excess depth and undisclosed source or survivor fail closed', async () => {
  const chain = Array.from({ length: 33 }, (_, n) => ({ resource: id(n + 1), ...(n < 32 ? { next: id(n + 2) } : {}) }));
  const allowed = fixture(chain);
  expect((await resolveTargets(allowed.session, [id(1)], 'rating'))[0]!.resource).toBe(id(33));
  expect(allowed.calls).toHaveLength(66);
  const excessive = fixture([...chain.slice(0, 32), { resource: id(33), next: id(34) }, { resource: id(34) }]);
  await expect(resolveTargets(excessive.session, [id(1)], 'rating')).rejects.toBeInstanceOf(WorkReadUnavailable);
  const cycle = fixture([{ resource: id(1), next: id(2) }, { resource: id(2), next: id(1) }]);
  await expect(resolveTargets(cycle.session, [id(1)], 'discussion')).rejects.toBeInstanceOf(WorkReadUnavailable);
  for (const hidden of [1, 2]) {
    const f = fixture([{ resource: id(1), next: id(2), public: hidden !== 1 }, { resource: id(2), public: hidden !== 2 }]);
    await expect(resolveTargets(f.session, [id(1)], 'discussion')).rejects.toBeInstanceOf(TargetUnavailable);
  }
});

test('G836: direct hook and old-read envelope retain source identity while fencing the complete chain and disclosure', async () => {
  const f = fixture([{ resource: id(1), next: id(2) }, { resource: id(2) }]);
  expect(await redirectOf(f.environment)(id(1))).toBe(id(2));
  const seen: string[] = [];
  expect(await readMergedIdentity(f.environment, id(1), resource => { seen.push(resource); return Promise.resolve(true); }))
    .toEqual({ state: 'merged', source: id(1), survivor: id(2), hops: 1 });
  expect(seen).toEqual([id(1), id(2)]);
  await expect(readMergedIdentity(f.environment, id(1), resource => Promise.resolve(resource !== id(2))))
    .rejects.toBeInstanceOf(MergeUnavailable);
  const query = f.environment.fuseki.query.bind(f.environment.fuseki);
  f.environment.fuseki.query = async (body, bytes) => body.includes('FILTER(STR(?sequence)')
    ? { results: { bindings: [] } } : query(body, bytes);
  await expect(readMergedIdentity(f.environment, id(1), () => Promise.resolve(true))).rejects.toBeInstanceOf(MergeUnavailable);
});
