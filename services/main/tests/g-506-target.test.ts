import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import type { MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { readResourceSummaries, summaryBases, type ResourceType } from '../src/modules/media/summary.ts';
import { resourceSummary } from '../src/modules/media/summary-contract.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaUnavailable } from '../src/modules/media/store.ts';
import { capabilityBases, capabilityPath, resolvedTarget, targetRef, type Base }
  from '../src/modules/target/contract.ts';
import { resolveTargets, TargetNotBound, TargetUnavailable, TARGET_RESOLVE_COST }
  from '../src/modules/target/resolve.ts';
import { WorkReadSession, WorkReadMoved, WorkReadUnavailable, WorkReadInvalid, WorkReadLimit }
  from '../src/modules/work/read-session.ts';

const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
const literal = (value: string) => ({ type: 'literal' as const, value });
const uri = (value: string) => ({ type: 'uri' as const, value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];

function fixture(records: Array<{ resource: string; type: ResourceType; work?: string;
  public?: boolean; erased?: boolean }>, options: { hidden?: string[]; summarySequence?: string;
    revisionSequence?: string; revisionRows?: Row[] } = {}) {
  const queries: string[] = [];
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async (query: string) => {
    queries.push(query);
    if (query.includes('SELECT ?epoch ?sequence ?hold')) return { results: { bindings: records.map(record => ({
      epoch: literal('epoch'), sequence: literal(options.summarySequence ?? '1'), r: uri(record.resource),
      type: literal(record.type), ...(record.work ? { work: uri(record.work) } : {}), head: uri(id(100)),
      public: literal(String(record.public ?? true)), erased: literal(String(record.erased ?? false)),
      label: { type: 'literal', value: 'Sword Art Online', 'xml:lang': 'en' },
    })) } };
    if (query.includes('SELECT ?epoch ?sequence ?r ?revision ?type')) return { results: { bindings:
      options.revisionRows ?? records.map((record, index) => ({ epoch: literal('epoch'),
        sequence: literal(options.revisionSequence ?? '1'), r: uri(record.resource),
        revision: uri(id(1000 + index)), type: uri('https://schema.org/CreativeWork') })) } };
    throw new Error(`Unexpected graph probe: ${query}`);
  };
  let accessBatches = 0;
  const allowed = async (resources: readonly string[]) => {
    accessBatches++;
    return new Set(resources.filter(resource => !options.hidden?.includes(resource)));
  };
  const deps: MainWorkDependencies = { environment: { fuseki: graph, objectDirectory: '.temp/g-506-unit',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } }, access: {} as never, account: {} as never,
  mediaAccess: { canReadWorks: (_principal, _actor, resources) => allowed(resources),
    canReadSemantics: (_principal, _actor, resources) => allowed(resources),
    canReadPrivateContexts: (_principal, _actor, resources) => allowed(resources) } };
  const session = new WorkReadSession(deps, new Request('http://main.test/v1/resources'),
    { actingSubject: id(999) }, { dataEpoch: 'epoch', sequence: '1' });
  session.principal = { issuer: 'https://account.test', subject: 'reader' };
  return { session, queries, allowed, accessBatches: () => accessBatches };
}

test('G-506: shared schemas preserve exact grains and every capability has an explicit binding', () => {
  const bases = { work: true, realization: true, release: true, occurrence: true, resource: true } satisfies Record<Base, boolean>;
  expect(Object.keys(bases).sort()).toEqual(['occurrence', 'realization', 'release', 'resource', 'work']);
  expect(capabilityBases).toEqual({ review: ['work', 'release'], rating: ['work', 'release'],
    discussion: ['work', 'realization', 'release', 'occurrence', 'resource'],
    'collection-member': ['work', 'realization', 'release', 'occurrence', 'resource'],
    'library-status': ['work'], progress: ['occurrence'], continuity: ['work', 'realization', 'occurrence'],
    'spoiler-boundary': ['occurrence'] });
  expect(capabilityPath(id(1), 'discussion')).toBe('/v1/resources/00000000-0000-4000-8000-000000000001/discussion');
  expect(Value.Check(targetRef, id(1))).toBe(true);
  expect(Value.Check(targetRef, { target: id(1), base: 'work' })).toBe(false);
  expect(Value.Check(resolvedTarget, { resource: id(1), base: 'work', types: ['https://schema.org/Book'],
    work: id(1), revision: id(2), disclosure: 'public' })).toBe(true);
  expect(Value.Check(resolvedTarget, { resource: id(1), base: 'main-version', types: [],
    work: id(1), revision: id(2), disclosure: 'public' })).toBe(false);
  expect(summaryBases['main-version']).toBeNull();
});

test('G-506: 64 exact targets use one summary probe, one revision probe and one Work Access batch', async () => {
  const records = Array.from({ length: 64 }, (_, index) => ({ resource: id(index + 1),
    type: (index % 2 ? 'occurrence' : 'release') as ResourceType, work: id(500), public: false }));
  const f = fixture(records);
  const resolved = await resolveTargets(f.session, records.map(record => record.resource), 'discussion');
  expect(resolved).toHaveLength(64);
  expect(resolved.map(target => target.resource)).toEqual(records.map(record => record.resource));
  expect(resolved.every(target => target.work === id(500) && target.disclosure === 'restricted')).toBe(true);
  expect(f.queries).toHaveLength(2);
  expect(f.accessBatches()).toBe(1);
  expect(f.queries[1]).toContain(`LIMIT ${TARGET_RESOLVE_COST.revisionRows + 1}`);
  expect(f.queries[1]).toContain('rv:structureHead ?revision');
  expect(f.queries[1]).toContain('rv:releaseHead ?revision');
  const duplicated = await resolveTargets(f.session, [id(1), id(1)], 'review');
  expect(duplicated[0]).toEqual(duplicated[1]);
  await expect(resolveTargets(f.session, Array.from({ length: 65 }, () => id(1)), 'review'))
    .rejects.toBeInstanceOf(WorkReadInvalid);
});

test('G-506: no summary-unavailable target can escape through a capability resolver', async () => {
  for (const type of ['work', 'release', 'occurrence', 'realization', 'character', 'resource'] as const) {
    const f = fixture([{ resource: id(1), work: type === 'character' || type === 'resource' ? undefined : id(2),
      type, public: false }], { hidden: [id(1), id(2)] });
    const summaries = await readResourceSummaries(f.session.deps.environment, undefined,
      { canReadWorks: f.allowed, canReadSemantics: f.allowed },
      { resources: [id(1)], context: DEFAULT_MEDIA_CONTEXT, language: null });
    expect(summaries.summaries).toEqual([{ reference: id(1), status: 'unavailable' }]);
    expect(Value.Check(resourceSummary, { ...summaries.summaries[0], base: 'work', work: id(2) })).toBe(false);
    await expect(resolveTargets(f.session, [id(1)], 'discussion')).rejects.toBeInstanceOf(TargetUnavailable);
    expect(f.queries.every(query => !query.includes('SELECT ?epoch ?sequence ?r ?revision'))).toBe(true);
  }
  const erased = fixture([{ resource: id(1), type: 'work', work: id(1), erased: true }]);
  await expect(resolveTargets(erased.session, [id(1)], 'discussion')).rejects.toBeInstanceOf(TargetUnavailable);
  const attached = fixture([{ resource: id(1), type: 'work', work: id(1), erased: true },
    { resource: id(1), type: 'resource' }]);
  await expect(resolveTargets(attached.session, [id(1)], 'discussion')).rejects.toBeInstanceOf(TargetUnavailable);
  const mixed = fixture([{ resource: id(1), type: 'work', work: id(1) },
    { resource: id(2), type: 'release', work: id(3), public: false }], { hidden: [id(3)] });
  await expect(resolveTargets(mixed.session, [id(1), id(2)], 'discussion')).rejects.toBeInstanceOf(TargetUnavailable);
  expect(mixed.queries).toHaveLength(1);
});

test('G-506: Main Version and grain mismatch are 422 only after target admission', async () => {
  const main = fixture([{ resource: id(1), type: 'main-version', work: id(2) }]);
  const error = await resolveTargets(main.session, [id(1)], 'discussion').catch(error => error);
  expect(error).toBeInstanceOf(TargetNotBound);
  expect(error).toMatchObject({ status: 422, code: 'target_not_bound' });
  expect(main.queries).toHaveLength(1);
  const occurrence = fixture([{ resource: id(1), type: 'occurrence', work: id(2) }]);
  await expect(resolveTargets(occurrence.session, [id(1)], 'rating')).rejects.toBeInstanceOf(TargetNotBound);
  const hiddenMismatch = fixture([{ resource: id(1), type: 'occurrence', work: id(2), public: false }],
    { hidden: [id(2)] });
  const unavailable = await resolveTargets(hiddenMismatch.session, [id(1)], 'rating').catch(error => error);
  expect(unavailable).toMatchObject({ status: 404, code: 'resource_unavailable' });
});

test('G-506: graph movement, ambiguous heads and excess revision rows never produce an exact pin', async () => {
  const records = [{ resource: id(1), type: 'work' as const, work: id(1) }];
  for (const options of [{ summarySequence: '2' }, { revisionSequence: '2' }]) {
    const f = fixture(records, options);
    await expect(resolveTargets(f.session, [id(1)], 'discussion')).rejects.toBeInstanceOf(WorkReadMoved);
  }
  const restored = fixture(records);
  restored.session.deps.environment.lineage.dataEpoch = 'restored-epoch';
  await expect(resolveTargets(restored.session, [id(1)], 'discussion')).rejects.toBeInstanceOf(MediaUnavailable);
  const row = { epoch: literal('epoch'), sequence: literal('1'), r: uri(id(1)), revision: uri(id(10)) };
  const ambiguous = fixture(records, { revisionRows: [row, { ...row, revision: uri(id(11)) }] });
  await expect(resolveTargets(ambiguous.session, [id(1)], 'discussion')).rejects.toBeInstanceOf(WorkReadUnavailable);
  const excessive = fixture(records, { revisionRows: Array.from({ length: TARGET_RESOLVE_COST.revisionRows + 1 }, () => row) });
  await expect(resolveTargets(excessive.session, [id(1)], 'discussion')).rejects.toBeInstanceOf(WorkReadLimit);
});

test('G-506: optional redirects re-admit the canonical target and reject cycles or excess depth', async () => {
  const f = fixture([{ resource: id(2), type: 'work', work: id(2) }]);
  const result = await resolveTargets(f.session, [id(1), id(2)], 'discussion', resource => resource === id(1) ? id(2) : null);
  expect(result.map(target => target.resource)).toEqual([id(2), id(2)]);
  await expect(resolveTargets(f.session, [id(1)], 'discussion', () => id(1)))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  await expect(resolveTargets(f.session, [id(1)], 'discussion', resource => id(Number(resource.slice(-12)) + 1)))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});
