import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CanonicalCollectionPrefix,
  CollectionSourceCall,
  PreparedCollectionSource,
  WorkAllowance,
  WorkReceipt,
} from '../services/kernel/src/library/collection-source.ts';
import type {
  CollectionSourceDriver,
  FactKind,
  NativePlan,
  NativeTrace,
  SourceFixture,
  SourcePersona,
} from './collection-source-driver.ts';

setDefaultTimeout(240_000);
let driver: CollectionSourceDriver;
let reservation = 0;
beforeEach(async () => {
  const location = process.env.COLLECTION_SOURCE_DRIVER;
  if (!location) throw new Error('Collection source outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('COLLECTION_SOURCE_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('COLLECTION_SOURCE_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createCollectionSourceDriver !== 'function')
    throw new Error('Expected createCollectionSourceDriver factory');
  driver = await binding.createCollectionSourceDriver();
  reservation = 0;
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});

// TEST-ONLY caller allocation. The source must not implement its own ledger/refill authority.
function allocate(candidateKeys: number): WorkAllowance {
  const remaining = { ...driver.admittedDimensions(), candidateKeys };
  for (const value of Object.values(remaining)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
  expect(candidateKeys).toBeLessThanOrEqual(256);
  return { reservationId: `source-call-${++reservation}`, remaining };
}
function account(work: WorkReceipt, allowance: WorkAllowance, trace: NativeTrace) {
  expect(work.reservationId).toBe(allowance.reservationId);
  for (const key of Object.keys(allowance.remaining) as (keyof WorkReceipt['used'])[]) {
    expect(Number.isSafeInteger(work.used[key]) && work.used[key] >= 0).toBe(true);
    expect(work.used[key]).toBeLessThanOrEqual(allowance.remaining[key]);
  }
  expect(work.used).toEqual({
    candidateKeys: trace.candidateKeys.length,
    identityMetadataRows: trace.identityMetadataRows,
    emptySeeks: trace.emptySeeks,
    nativePoints: trace.nativePoints,
    witnessKeys: trace.witnessKeys,
    statements: trace.statements,
    bytes: trace.bytes,
  });
  expect(trace.crossPartitionJoins).toBe(0);
  expect(trace.renderedSubjectReads).toBe(0);
  expect(trace.reservations[0]).toEqual({ allowance, beforeCandidateOffset: 0 });
}
async function prepare(fixture: SourceFixture, as: SourcePersona = 'owner') {
  const allowance = allocate(0);
  const { value, trace } = await driver.measure(() =>
    driver.read(as, (context) => driver.source.prepare({ ...context, collectionId: fixture.id, allowance })),
  );
  account(value.work, allowance, trace);
  expect(trace.candidateKeys).toEqual([]);
  expect(value.source.observation).toMatchObject({ collectionId: fixture.id, route: fixture.route });
  expect(value.source.observation.incarnation.length).toBeGreaterThan(0);
  expect(value.source.observation.basis.digest.length).toBeGreaterThan(0);
  return value.source;
}
async function call<T extends { work: WorkReceipt }>(
  source: PreparedCollectionSource,
  quota: number,
  operation: (input: CollectionSourceCall) => Promise<T>,
  as: SourcePersona = 'owner',
) {
  const allowance = allocate(quota);
  const measured = await driver.measure(() =>
    driver.read(as, (context) => operation({ ...context, source, allowance })),
  );
  account(measured.value.work, allowance, measured.trace);
  return measured;
}
const canonical = (
  source: PreparedCollectionSource,
  quota = 256,
  afterSubjectId: string | null = null,
  as: SourcePersona = 'owner',
) => call(source, quota, (input) => driver.source.prefix({ ...input, afterSubjectId }), as);
const raw = (source: PreparedCollectionSource, quota = 256, afterStoredSubjectId: string | null = null) =>
  call(source, quota, (input) => driver.source.readRawStoredPrefix({ ...input, afterStoredSubjectId }));
const contains = (source: PreparedCollectionSource, subjectId: string, quota = 256, as: SourcePersona = 'owner') =>
  call(source, quota, (input) => driver.source.containsSubject({ ...input, subjectId }), as);
async function failure(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error as { code: string };
  }
  throw new Error('Expected native failure, not a successful empty/false/ready result');
}
async function retryable(operation: () => Promise<unknown>) {
  expect(['dependency_unavailable', 'semantic_not_ready', 'partition_unavailable']).toContain(
    (await failure(operation)).code,
  );
}
const ids = (prefix: CanonicalCollectionPrefix) => prefix.candidates.map((candidate) => candidate.subjectId);
const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
function allPlans(plans: readonly NativePlan[]): NativePlan[] {
  return plans.flatMap((plan) => [plan, ...allPlans(plan.Plans ?? [])]);
}
async function union(
  sources: readonly SourceFixture[],
  options: { as?: SourcePersona; limit?: number; cursor?: string; filter?: unknown; scopes?: readonly string[] } = {},
) {
  return driver.union({
    sources,
    as: options.as ?? 'owner',
    limit: options.limit ?? 100,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
  });
}
async function page(response: Response): Promise<{ subjects: { id: string }[]; next: string | null }> {
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(Array.isArray(body.subjects)).toBe(true);
  expect(body.subjects.length).toBeLessThanOrEqual(100);
  return body;
}
async function traverse(source: SourceFixture, as: SourcePersona = 'owner', limit = 100) {
  const result: string[] = [];
  let cursor: string | undefined;
  for (let request = 0; request < 4098; request++) {
    const measured = await driver.measure(() =>
      union([source], { as, limit, ...(cursor === undefined ? {} : { cursor }) }),
    );
    expect(measured.trace.candidateKeys.length).toBeLessThanOrEqual(256);
    const body = await page(measured.value);
    result.push(...body.subjects.map((subject) => subject.id));
    if (body.next === null) return result;
    expect(body.next).not.toBe(cursor);
    cursor = body.next;
  }
  throw new Error('Finite native traversal failed to converge');
}

test('one Collection source owner preserves native authority covered canonical prefixes and aggregate charged work without rewriting stored identities', async () => {
  const x = await driver.subject(),
    y = await driver.subject();
  const collection = await driver.curated([
    { subjectId: x.id, note: 'first x' },
    { subjectId: y.id, note: 'middle y' },
    { subjectId: x.id, note: 'last x' },
  ]);
  await driver.addFact(x, 'session', driver.profiles[0]);
  const before = await driver.inspect();
  const source = await prepare(collection);
  expect(source.observation.authority.kind).toBe('curated');
  const stored = await raw(source);
  expect(stored.value.kind).toBe('raw_stored_subject_prefix');
  expect([...new Set(stored.value.storedSubjectIds)]).toEqual([x.id, y.id].sort());
  expect(ids((await canonical(source)).value)).toEqual([x.id, y.id].sort());
  expect((await contains(source, x.id)).value.result).toBe(true);
  expect((await contains(source, (await driver.subject()).id)).value.result).toBe(false);
  expect(await traverse(collection, 'owner', 1)).toEqual([x.id, y.id].sort());
  const after = await driver.inspect();
  expect(after.occurrences).toEqual(before.occurrences);
  expect(after.privateFacts).toEqual(before.privateFacts);
  expect(
    after.occurrences.filter((row) => row.collectionId === collection.id).map((row) => [row.subjectId, row.note]),
  ).toEqual([
    [x.id, 'first x'],
    [y.id, 'middle y'],
    [x.id, 'last x'],
  ]);
});

test('5000 duplicate occurrences use strict stored subject index seeks with quotas one and 256 and actual bounded EXPLAIN work', async () => {
  const x = await driver.subject();
  const collection = await driver.curated(
    Array.from({ length: 5000 }, (_, i) => ({ subjectId: x.id, note: `occurrence ${i}` })),
  );
  const source = await prepare(collection);
  const before = (await driver.inspect()).occurrences;
  for (const quota of [1, 256]) {
    const first = await raw(source, quota);
    expect(first.value.storedSubjectIds).toEqual([x.id]);
    expect(first.value.work.used.candidateKeys).toBeGreaterThanOrEqual(1);
    expect(first.value.work.used.candidateKeys).toBeLessThanOrEqual(quota);
    expect(first.value.storedCoveredThrough).toBe(x.id);
    const next = await raw(source, quota, x.id);
    expect(next.value.storedSubjectIds).toEqual([]);
    expect(next.value.storedExhausted).toBe(true);
    expect(next.trace.emptySeeks).toBeGreaterThan(0);
    for (const trace of [first.trace, next.trace]) {
      const seeks = allPlans(trace.plans).filter((plan) => plan['Index Name'] === 'collection_member_subject');
      expect(seeks.length).toBeGreaterThan(0);
      expect(trace.rowsExamined).toBeLessThanOrEqual(quota + 16);
      for (const seek of seeks) {
        expect(seek['Actual Rows'] * seek['Actual Loops']).toBeLessThanOrEqual(quota);
        expect(seek['Index Cond']).toContain('collection_id');
        expect(seek['Index Cond']).toContain('route');
      }
      const memberSQL = trace.sql.filter((sql) => /\bcollection_member\b/i.test(sql));
      expect(memberSQL.length).toBeGreaterThan(0);
      expect(memberSQL.join('\n')).not.toMatch(/\bDISTINCT\b|\bGROUP\s+BY\b|\bCOUNT\s*\(/i);
      const memberPlans = trace.plans.filter((plan) =>
        allPlans([plan]).some((node) => node['Relation Name'] === 'collection_member'),
      );
      expect(memberPlans.length).toBeGreaterThan(0);
      expect(allPlans(memberPlans).some((plan) => /Unique|Aggregate|Seq Scan|Sort/.test(plan['Node Type']))).toBe(
        false,
      );
    }
  }
  expect((await driver.inspect()).occurrences).toEqual(before);
});

test('stored a to z c z cannot masquerade as covered canonical order and exact stored misses cannot prove canonical absence', async () => {
  const subjects = [await driver.subject(), await driver.subject(), await driver.subject()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const [a, c, z] = subjects as [SourceFixture, SourceFixture, SourceFixture];
  const collection = await driver.curated([
    { subjectId: a.id, note: 'alias' },
    { subjectId: c.id, note: null },
    { subjectId: z.id, note: 'terminal' },
  ]);
  await driver.merge(a, z);
  await driver.repairIdentity();
  const source = await prepare(collection);
  expect((await raw(source)).value.storedSubjectIds).toEqual([a.id, c.id, z.id]);
  const prefix = (await canonical(source)).value;
  expect(prefix.kind).toBe('canonical_subject_prefix');
  expect(ids(prefix)).toEqual([c.id, z.id]);
  const aliasOnly = await driver.curated([{ subjectId: a.id, note: null }]);
  expect((await contains(await prepare(aliasOnly), z.id)).value.result).toBe(true);
  expect(await traverse(collection, 'owner', 1)).toEqual([c.id, z.id]);
});

test('257 aliases with only the last readable retain the boundary and recover the actual positive witness after accepted bounded native repair', async () => {
  const survivor = await driver.subject();
  const aliases: SourceFixture[] = [];
  await driver.holdIdentityRepair();
  for (let i = 0; i < 257; i++) aliases.push(await driver.subject());
  aliases.sort((a, b) => a.id.localeCompare(b.id));
  for (const [i, alias] of aliases.entries()) {
    await driver.grant(alias, 'subject:read', 'owner', i === 256);
    await driver.merge(alias, survivor);
  }
  const collection = await driver.curated(aliases.map((alias) => ({ subjectId: alias.id, note: null })));
  const before = await driver.inspect();
  const first = await driver.measure(async () => {
    try {
      return (await contains(await prepare(collection), survivor.id)).value;
    } catch (error) {
      return { error: (error as { code: string }).code };
    }
  });
  expect(first.trace.candidateKeys.length).toBeLessThanOrEqual(256);
  if ('error' in first.value) expect(['dependency_unavailable', 'semantic_not_ready']).toContain(first.value.error);
  else expect(first.value.result).toBe('not_proven');
  const pending = await union([collection]);
  expect(pending.status).toBe(503); // Held identity maintenance produced no resumable group progress.
  expect(await pending.json()).toMatchObject({ retryable: true });
  await driver.repairIdentity();
  const repaired = await prepare(collection);
  const positive = await contains(repaired, survivor.id);
  expect(positive.value.result).toBe(true);
  expect(positive.trace.anchors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'subject:read', id: aliases[256]!.id, route: aliases[256]!.route }),
      expect.objectContaining({ action: 'subject:read', id: survivor.id, route: survivor.route }),
    ]),
  );
  expect(await traverse(collection)).toEqual([survivor.id]);
  const after = await driver.inspect();
  expect(after.repairPages.length).toBeGreaterThan(0);
  for (const repair of after.repairPages) expect(repair.candidateKeys).toBeLessThanOrEqual(256);
  expect(after.occurrences).toEqual(before.occurrences);
  expect(after.privateFacts).toEqual(before.privateFacts);
  await driver.grant(aliases[256]!, 'subject:read', 'owner', false);
  expect((await contains(repaired, survivor.id)).value.result).toBe(false);
});

test('identity basis merge unmerge and repoint restart valid continuations while unrelated partition writes do not', async () => {
  const a = await driver.subject(),
    b = await driver.subject(),
    c = await driver.subject();
  const collection = await driver.curated([a, b, c].map((subject) => ({ subjectId: subject.id, note: null })));
  const source = await prepare(collection);
  const first = await page(await union([collection], { limit: 1 }));
  expect(first.next).not.toBeNull();
  await driver.unrelatedWrite(collection);
  const ordinary = await prepare(collection);
  expect(ordinary.observation.basis.digest).toBe(source.observation.basis.digest);
  expect((await union([collection], { limit: 1, cursor: first.next! })).status).toBe(200);
  await driver.merge(a, b);
  await driver.repairIdentity();
  expect((await prepare(collection)).observation.basis.identity).not.toBe(source.observation.basis.identity);
  expect((await union([collection], { limit: 1, cursor: first.next! })).status).toBe(409);
  expect((await failure(() => canonical(source))).code).toBe('stale_cursor');
  const merged = await prepare(collection);
  await driver.merge(b, c); // Existing merge_member repointing, not a caller hop cap.
  await driver.repairIdentity();
  expect((await prepare(collection)).observation.basis.identity).not.toBe(merged.observation.basis.identity);
  const repointed = await prepare(collection);
  await driver.unmerge(a);
  await driver.repairIdentity();
  expect((await prepare(collection)).observation.basis.identity).not.toBe(repointed.observation.basis.identity);
});

test('current owner other anonymous suspended grants and source sink anchors conceal denial before any candidate work', async () => {
  const subject = await driver.subject();
  const collection = await driver.curated([{ subjectId: subject.id, note: null }]);
  const owner = await prepare(collection);
  for (const as of ['other', 'anonymous', 'suspended'] as const) {
    const denied = await driver.measure(() => failure(() => prepare(collection, as)));
    expect(denied.value.code).toBe('not_found');
    expect(denied.trace.candidateKeys).toEqual([]);
  }
  for (const id of ['invalid', driver.unknownCollectionId]) {
    const denied = await driver.measure(() =>
      driver.read('owner', (context) =>
        failure(() => driver.source.prepare({ ...context, collectionId: id, allowance: allocate(0) })),
      ),
    );
    expect(denied.value.code).toBe('not_found');
    expect(denied.trace.candidateKeys).toEqual([]);
  }
  await driver.grant(collection, 'collection:read', 'other', true);
  const other = await prepare(collection, 'other');
  const checked = await contains(other, subject.id, 256, 'other');
  expect(checked.trace.anchors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'collection:read', id: collection.id, route: collection.route }),
      expect.objectContaining({ action: 'subject:read', id: subject.id, route: subject.route }),
    ]),
  );
  await driver.mount(collection);
  await driver.grant(collection, 'collection:read', 'other', false);
  expect((await failure(() => contains(other, subject.id, 256, 'other'))).code).toBe('not_found');
  expect((await failure(() => canonical(other, 1, null, 'other'))).code).toBe('not_found');
  for (const visibility of ['unlisted', 'public'] as const) {
    await driver.setCollectionVisibility(collection, visibility);
    for (const as of ['other', 'anonymous', 'suspended'] as const)
      expect((await prepare(collection, as)).observation.collectionId).toBe(collection.id);
  }
  await driver.softDeleteCollection(collection);
  expect((await failure(() => contains(owner, subject.id))).code).toBe('not_found');
  expect((await failure(() => raw(owner, 1))).code).toBe('not_found');
});

test('canonical coverage precedes subject rejection and truthful EOF lookahead rereads and empty seeks are all charged', async () => {
  const subjects = [await driver.subject(), await driver.subject(), await driver.subject()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const collection = await driver.curated(subjects.map((subject) => ({ subjectId: subject.id, note: null })));
  await driver.grant(subjects[0]!, 'subject:read', 'owner', false);
  const source = await prepare(collection);
  const first = await canonical(source, 1);
  expect(ids(first.value)).toEqual([subjects[0]!.id]);
  expect(first.value.coveredThrough).toBe(subjects[0]!.id);
  expect(first.value.exhausted).toBe(false);
  expect((await contains(source, subjects[0]!.id)).value.result).toBe(false);
  expect(first.value.work.used.candidateKeys).toBe(1);
  const reread = await canonical(source, 1);
  expect(reread.trace.candidateKeys).toEqual(first.trace.candidateKeys);
  const tail = await canonical(source, 2, first.value.coveredThrough);
  expect(ids(tail.value)).toEqual(subjects.slice(1).map((subject) => subject.id));
  expect(tail.value.coveredThrough).toBe(subjects[2]!.id);
  const eof = await canonical(source, 1, tail.value.coveredThrough);
  expect(ids(eof.value)).toEqual([]);
  expect(eof.value.exhausted).toBe(true);
  expect(eof.trace.emptySeeks).toBeGreaterThan(0);
  expect(await traverse(collection)).toEqual(subjects.slice(1).map((subject) => subject.id));
});

test('aggregate reservations across multiple calls never exceed 256 and zero or indivisible extra dimensions stop before work', async () => {
  const subjects: SourceFixture[] = [];
  for (let i = 0; i < 300; i++) subjects.push(await driver.subject());
  const collection = await driver.curated(subjects.map((subject) => ({ subjectId: subject.id, note: null })));
  const source = await prepare(collection);
  let remaining = 256,
    after: string | null = null,
    used = 0;
  for (const allocation of [64, 64, 128]) {
    expect(allocation).toBeLessThanOrEqual(remaining); // Reserve before dispatch.
    remaining -= allocation;
    const result = await canonical(source, allocation, after);
    used += result.value.work.used.candidateKeys;
    remaining += allocation - result.value.work.used.candidateKeys;
    after = result.value.coveredThrough;
    expect(used + remaining).toBe(256);
  }
  expect(used).toBeGreaterThan(0);
  expect(used).toBeLessThanOrEqual(256); // An admitted window need not fill its reservation.
  const zero = await driver.measure(() => retryable(() => canonical(source, 0, after)));
  expect(zero.trace.candidateKeys).toEqual([]);
  const noNativeWork = allocate(1);
  const allowance = {
    ...noNativeWork,
    remaining: { ...noNativeWork.remaining, statements: 0, nativePoints: 0, bytes: 0 },
  };
  const stopped = await driver.measure(() =>
    driver.read('owner', (context) =>
      retryable(() => driver.source.prefix({ ...context, source, allowance, afterSubjectId: after })),
    ),
  );
  expect(stopped.trace.candidateKeys).toEqual([]);
  expect(stopped.trace.statements).toBe(0);
  const overlap = await driver.curated(
    subjects.slice(0, 100).map((subject) => ({ subjectId: subject.id, note: null })),
  );
  const composed = await driver.measure(() => union([collection, overlap]));
  expect(composed.trace.candidateKeys.length).toBeLessThanOrEqual(256);
  await page(composed.value);
});

test('essential unknown retains its boundary independent true OR settles and ordinary rejection permits advancing empty pages', async () => {
  const ordered = [await driver.subject(), await driver.subject()].sort((a, b) => a.id.localeCompare(b.id));
  const [settledSubject, subject] = ordered as [SourceFixture, SourceFixture];
  const unknownSource = await driver.curated(ordered.map((value) => ({ subjectId: value.id, note: null })));
  const trueSource = await driver.curated([{ subjectId: subject.id, note: null }]);
  const filters = await driver.booleanFixture(subject, settledSubject);
  for (const filter of [filters.unknownFilter, filters.notUnknownFilter]) {
    const unknown = await union([trueSource], { filter });
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toMatchObject({ retryable: true });
  }
  expect((await union([], { scopes: [filters.unknownScopeId] })).status).toBe(503);
  const trueBody = await page(await union([trueSource], { scopes: [filters.unknownScopeId] }));
  expect(trueBody.subjects.map((value) => value.id)).toEqual([subject.id]);
  const settled = await page(await union([unknownSource], { filter: filters.settledThenUnknownFilter }));
  expect(settled.subjects.map((value) => value.id)).toEqual([settledSubject.id]);
  expect(settled.next).not.toBeNull();
  expect(
    (await union([unknownSource], { filter: filters.settledThenUnknownFilter, cursor: settled.next! })).status,
  ).toBe(503);
  expect(
    (await page(await union([trueSource], { filter: filters.trueFilter }))).subjects.map((value) => value.id),
  ).toEqual([subject.id]);
  expect((await page(await union([trueSource], { filter: filters.falseFilter }))).subjects).toEqual([]);
  const rejects: SourceFixture[] = [];
  for (let i = 0; i < 257; i++) rejects.push(await driver.subject());
  for (const rejected of rejects) await driver.grant(rejected, 'subject:read', 'owner', false);
  const rejectedCollection = await driver.curated(rejects.map((value) => ({ subjectId: value.id, note: null })));
  const empty = await page(await union([rejectedCollection]));
  expect(empty.subjects).toEqual([]);
  expect(empty.next).not.toBeNull();
  const next = await page(await union([rejectedCollection], { cursor: empty.next! }));
  expect(next.subjects).toEqual([]);
  expect(next.next).not.toBe(empty.next);
});

test('Everything uses all four native facts overlaps clearing soft deletion unprofiled labels and immutable old profile pins', async () => {
  const everything = await driver.builtin({ kind: 'everything' });
  const facts: FactKind[] = ['state', 'label', 'session', 'holding'];
  const subjects: SourceFixture[] = [];
  for (const kind of facts) {
    const subject = await driver.subject({ profile: driver.profiles[0] });
    subjects.push(subject);
    await driver.addFact(subject, kind, driver.profiles[0]);
  }
  const unprofiled = await driver.subject({ unprofiled: true });
  await driver.addFact(unprofiled, 'label');
  const overlap = subjects[0]!;
  for (const kind of facts.slice(1)) await driver.addFact(overlap, kind, driver.profiles[0]);
  const state = await driver.builtin({ kind: 'state', profile: driver.profiles[0] });
  const initial = await driver.inspect();
  expect(await traverse(everything)).toEqual([...subjects, unprofiled].map((value) => value.id).sort());
  expect(await traverse(state)).toEqual([overlap.id]);
  const multi = await canonical(await prepare(everything));
  expect(new Set(multi.trace.candidateKeys.map((key) => key.family))).toEqual(new Set(facts));
  expect(multi.trace.candidateKeys.length).toBeGreaterThan(ids(multi.value).length);
  await driver.clearFact(overlap, 'state');
  expect(await traverse(state)).toEqual([]);
  expect((await contains(await prepare(everything), overlap.id)).value.result).toBe(true);
  for (const kind of facts.slice(1)) await driver.clearFact(overlap, kind);
  expect((await contains(await prepare(everything), overlap.id)).value.result).toBe(false);
  await driver.softDeleteFact(subjects[1]!, 'label');
  expect((await contains(await prepare(everything), subjects[1]!.id)).value.result).toBe(false);
  const retainedState = await driver.subject({ profile: driver.profiles[0] });
  await driver.addFact(retainedState, 'state', driver.profiles[0]);
  const statePins = (await driver.inspect()).privateFacts.filter((fact) => fact.subjectId === retainedState.id);
  const retained = subjects[2]!;
  const oldFacts = initial.privateFacts.filter((fact) => fact.subjectId === retained.id);
  await driver.activateProfile(driver.profiles[0], 'labels_only');
  await driver.retireProfile(driver.profiles[0]);
  expect((await driver.inspect()).privateFacts.filter((fact) => fact.subjectId === retained.id)).toEqual(oldFacts);
  expect((await contains(await prepare(everything), retained.id)).value.result).toBe(true);
  expect((await driver.builtin({ kind: 'state', profile: driver.profiles[0] })).id).toBe(state.id);
  expect(await traverse(state)).toEqual([retainedState.id]);
  expect((await driver.inspect()).privateFacts.filter((fact) => fact.subjectId === retainedState.id)).toEqual(
    statePins,
  );
  const secondProfileSubject = await driver.subject({ profile: driver.profiles[1] });
  await driver.addFact(secondProfileSubject, 'state', driver.profiles[1]);
  expect(await traverse(await driver.builtin({ kind: 'state', profile: driver.profiles[1] }))).toEqual([
    secondProfileSubject.id,
  ]);
});

test('empty builtins are real identities and missing runtime canonical index profile and publication never report empty readiness', async () => {
  const everything = await driver.builtin({ kind: 'everything' });
  expect(await traverse(everything)).toEqual([]);
  expect((await driver.builtin({ kind: 'everything' })).id).toBe(everything.id);
  const subject = await driver.subject({ profile: driver.profiles[0] });
  await driver.addFact(subject, 'state', driver.profiles[0]);
  const state = await driver.builtin({ kind: 'state', profile: driver.profiles[0] });
  for (const dependency of ['runtime', 'canonical_index', 'profile'] as const) {
    const source = await prepare(state);
    const restore = await driver.unavailable(dependency);
    try {
      await retryable(() => canonical(source));
    } finally {
      await restore();
    }
  }
  await driver.setCollectionVisibility(everything, 'public');
  await driver.publishAndSettle();
  const publicSource = await prepare(everything, 'anonymous');
  const restore = await driver.unavailable('publication');
  try {
    await retryable(() => canonical(publicSource, 1, null, 'anonymous'));
  } finally {
    await restore();
  }
});

test('actual activated A private pending B terminal freeze and erasure preserve one public identity without private projection facts', async () => {
  const a = await driver.subject({ profile: driver.profiles[0] }),
    b = await driver.subject({ profile: driver.profiles[0] });
  const factA = await driver.addFact(a, 'state', driver.profiles[0]);
  const collection = await driver.builtin({ kind: 'everything' });
  await driver.setCollectionVisibility(collection, 'public');
  await driver.publishAndSettle();
  const active = await prepare(collection, 'anonymous');
  expect(active.observation.authority.kind).toBe('activated_output');
  expect(await traverse(collection, 'anonymous')).toEqual([a.id]);
  await driver.holdPublication();
  const factB = await driver.addFact(b, 'label', driver.profiles[0]);
  expect(await traverse(collection, 'anonymous')).toEqual([a.id]);
  const privateCollection = await driver.curated([{ subjectId: b.id, note: 'private note' }]);
  const unlisted = await driver.curated([{ subjectId: b.id, note: null }], 'unlisted');
  await driver.deleteOwnerAccount();
  const terminal = await driver.inspect();
  expect(terminal.pendingPrivatePurge).toBeGreaterThan(0);
  expect((await failure(() => prepare(privateCollection, 'other'))).code).toBe('not_found');
  expect((await failure(() => prepare(unlisted, 'anonymous'))).code).toBe('not_found');
  const frozen = await prepare(collection, 'anonymous');
  expect(frozen.observation.collectionId).toBe(active.observation.collectionId);
  expect(frozen.observation.authority.kind).toBe('frozen_output');
  if (active.observation.authority.kind !== 'activated_output' || frozen.observation.authority.kind !== 'frozen_output')
    throw new Error('Native generation authority missing');
  expect(frozen.observation.authority.generation).toBe(active.observation.authority.generation);
  await driver.settlePrivatePurge();
  await driver.replayOldPublicationEvents();
  expect(await traverse(collection, 'anonymous')).toEqual([a.id]);
  const inspection = await driver.inspect();
  expect(inspection.privateFacts).toEqual([]);
  const output = json([inspection.publicRows, inspection.publicDTOs]);
  expect(output).not.toContain(driver.accounts.owner.id);
  for (const secret of [
    factA.key,
    factA.privateValue,
    factB.key,
    factB.privateValue,
    driver.profiles[0].releaseDigest,
    'private note',
  ])
    expect(output).not.toContain(secret);
  for (const field of ['profilePins', 'predicate', 'work', 'candidateKeys', 'positiveEvidence'])
    expect(output).not.toContain(`"${field}"`);
  await driver.grant(a, 'subject:read', 'anonymous', false);
  expect(await traverse(collection, 'anonymous')).toEqual([]);
});

test('unactivated dynamic publication is withdrawn at terminal deletion and revoked generation cannot be resurrected by older events', async () => {
  const subject = await driver.subject({ profile: driver.profiles[0] });
  await driver.addFact(subject, 'label', driver.profiles[0]);
  const collection = await driver.builtin({ kind: 'everything' });
  await driver.holdPublication();
  await driver.setCollectionVisibility(collection, 'unlisted');
  await driver.deleteOwnerAccount();
  await driver.replayOldPublicationEvents();
  expect((await failure(() => prepare(collection, 'anonymous'))).code).toBe('not_found');
  await driver.settlePrivatePurge();
  expect((await driver.inspect()).privateFacts).toEqual([]);
});

test('activated unlisted output freezes through native public adoption while private builtins remain curator authorized', async () => {
  const subject = await driver.subject({ profile: driver.profiles[0] });
  await driver.addFact(subject, 'holding', driver.profiles[0]);
  const collection = await driver.builtin({ kind: 'everything' });
  expect((await prepare(collection)).observation.authority).toMatchObject({
    kind: 'private_builtin',
    curatorAccountId: driver.accounts.owner.id,
  });
  await driver.mount(collection);
  expect((await failure(() => prepare(collection, 'other'))).code).toBe('not_found');
  expect((await failure(() => prepare(collection, 'anonymous'))).code).toBe('not_found');
  await driver.setCollectionVisibility(collection, 'unlisted');
  await driver.publishAndSettle();
  const active = await prepare(collection, 'anonymous');
  expect(active.observation.authority.kind).toBe('activated_output');
  await driver.deleteOwnerAccount();
  const frozen = await prepare(collection, 'anonymous');
  expect(frozen.observation.collectionId).toBe(collection.id);
  expect(frozen.observation.authority.kind).toBe('frozen_output');
  expect(await traverse(collection, 'anonymous')).toEqual([subject.id]);
  await driver.settlePrivatePurge();
  expect((await driver.inspect()).privateFacts).toEqual([]);
});

test('active public curated Collection survives terminal deletion deidentified with its occurrences intact', async () => {
  const subject = await driver.subject();
  const collection = await driver.curated([{ subjectId: subject.id, note: 'retained occurrence' }], 'public');
  const before = (await driver.inspect()).occurrences;
  await driver.deleteOwnerAccount();
  expect(await traverse(collection, 'anonymous')).toEqual([subject.id]);
  const after = await driver.inspect();
  expect(after.occurrences).toEqual(before);
  expect(json([after.publicRows, after.publicDTOs])).not.toContain(driver.accounts.owner.id);
});

test('native direct membership and shared Boolean proofs do not turn unknown into false under NOT or render to probe', async () => {
  const subject = await driver.subject();
  const collection = await driver.curated([{ subjectId: subject.id, note: null }]);
  const source = await prepare(collection);
  const point = await contains(source, subject.id);
  expect(point.value.result).toBe(true);
  expect(point.trace.renderedSubjectReads).toBe(0);
  expect((await driver.directMembership('owner', [collection], subject.id)).status).toBe(200);
  const filters = await driver.booleanFixture(subject);
  for (const filter of [filters.unknownFilter, filters.notUnknownFilter])
    expect((await driver.directMembership('owner', [collection], subject.id, { filter })).status).toBe(503);
  expect(
    (await driver.directMembership('owner', [collection], subject.id, { filter: filters.falseFilter })).status,
  ).toBe(404);
  expect(
    (await driver.directMembership('owner', [collection], subject.id, { filter: filters.trueFilter })).status,
  ).toBe(200);
  expect((await driver.directMembership('owner', [], subject.id, { scopes: [filters.unknownScopeId] })).status).toBe(
    503,
  );
  expect(
    (await driver.directMembership('owner', [collection], subject.id, { scopes: [filters.unknownScopeId] })).status,
  ).toBe(200);
  await driver.grant(subject, 'subject:read', 'owner', false);
  expect((await driver.directMembership('owner', [collection], subject.id)).status).toBe(404);
  expect((await contains(source, subject.id)).value.result).toBe(false);
});

test('encrypted native continuations bind viewer request basis and route without exposing receipts pins rejected keys or aliases', async () => {
  const a = await driver.subject(),
    b = await driver.subject();
  const collection = await driver.curated(
    [
      { subjectId: a.id, note: 'private marker' },
      { subjectId: b.id, note: null },
    ],
    'public',
  );
  const first = await page(await union([collection], { as: 'anonymous', limit: 1 }));
  expect(first.next).not.toBeNull();
  const rawToken = Buffer.from(first.next!, 'base64url').toString();
  for (const secret of [a.id, b.id, 'private marker', 'candidateKeys', 'reservationId'])
    expect(rawToken).not.toContain(secret);
  expect(first.next!.length).toBeLessThanOrEqual(4096);
  const replay = await page(await union([collection], { as: 'anonymous', limit: 1 }));
  expect(replay.next).toBe(first.next);
  await driver.advanceClock(16 * 60_000);
  expect((await union([collection], { as: 'anonymous', limit: 1, cursor: first.next! })).status).toBe(200);
  expect((await union([collection], { as: 'other', limit: 1, cursor: first.next! })).status).toBe(400);
  expect((await union([collection], { as: 'anonymous', limit: 2, cursor: first.next! })).status).toBe(400);
  const another = await driver.curated([{ subjectId: a.id, note: null }], 'public');
  expect((await union([another], { as: 'anonymous', limit: 1, cursor: first.next! })).status).toBe(400);
  const bytes = Buffer.from(first.next!, 'base64url');
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  expect((await union([collection], { as: 'anonymous', limit: 1, cursor: bytes.toString('base64url') })).status).toBe(
    400,
  );
  const account = await page(await union([collection], { limit: 1 }));
  await driver.advanceClock(16 * 60_000);
  expect((await union([collection], { limit: 1, cursor: account.next! })).status).toBe(400);
  await driver.rotateCursorKey();
  expect((await union([collection], { as: 'anonymous', limit: 1, cursor: first.next! })).status).toBe(400);
});

test('native first and deep plans at three legal geometric scales bound actual rows buffers statements bytes aliases and duplicate history', async () => {
  const samples: { scale: number; position: 'first' | 'deep'; quota: number; trace: NativeTrace }[] = [];
  for (const scale of [256, 1024, 4096]) {
    const subjects: SourceFixture[] = [];
    for (let i = 0; i < scale; i++) subjects.push(await driver.subject({ profile: driver.profiles[0] }));
    subjects.sort((a, b) => a.id.localeCompare(b.id));
    const collection = await driver.curated(subjects.map((subject) => ({ subjectId: subject.id, note: null })));
    const source = await prepare(collection);
    for (const position of ['first', 'deep'] as const) {
      const result = await raw(source, 1, position === 'first' ? null : subjects[scale - 2]!.id);
      expect(result.trace.rowsExamined).toBeLessThan(256);
      expect(result.trace.buffers).toBeGreaterThan(0);
      expect(result.trace.statements).toBeGreaterThan(0);
      expect(result.trace.bytes).toBeGreaterThan(0);
      samples.push({ scale, position, quota: 1, trace: result.trace });
    }
    // Real large alias and retained-history fixtures; setup work is excluded from measured callbacks.
    const survivor = subjects[scale - 1]!;
    for (const alias of subjects.slice(0, -1)) await driver.merge(alias, survivor);
    await driver.repairIdentity();
    for (let i = 0; i < scale; i++) await driver.addFact(survivor, 'session', driver.profiles[0]);
    const everything = await prepare(await driver.builtin({ kind: 'everything' }));
    const point = await contains(everything, survivor.id, 256);
    expect(point.value.result).toBe(true);
    expect(point.trace.rowsExamined).toBeLessThan(512);
    samples.push({ scale, position: 'deep', quota: 256, trace: point.trace });
  }
  await driver.checkGrowth(samples);
});

import type { CollectionAliasProgress } from '../services/kernel/src/library/collection-source.ts';

/** Baseline writes precede denial/merging, so hidden originals cannot cause an illegal fixture setup. */
async function resumableAliasFixture(size: number) {
  const survivor = await driver.subject();
  const aliases: SourceFixture[] = [];
  for (let index = 0; index < size; index++) aliases.push(await driver.subject());
  aliases.sort((a, b) => a.id.localeCompare(b.id));
  const collection = await driver.curated(aliases.map((alias) => ({ subjectId: alias.id, note: 'original' })));
  const before = await driver.inspect();
  for (const alias of aliases) await driver.merge(alias, survivor);
  await driver.repairIdentity(); // Actual finite owner/Semantic maintenance, never a test readiness flag.
  for (const alias of aliases.slice(0, -1)) await driver.grant(alias, 'subject:read', 'owner', false);
  return { survivor, aliases, collection, before, source: await prepare(collection) };
}

async function membershipStep(
  source: PreparedCollectionSource,
  subjectId: string,
  progress?: CollectionAliasProgress,
  quota = 100,
) {
  const allowance = allocate(quota);
  const measured = await driver.measure(() =>
    driver.read('owner', (context) =>
      driver.source.containsSubject({
        ...context,
        source,
        subjectId,
        allowance,
        ...(progress === undefined ? {} : { progress }),
      }),
    ),
  );
  account(measured.value.work, allowance, measured.trace);
  expect(measured.trace.candidateKeys.length).toBeLessThanOrEqual(quota);
  expect(measured.trace.renderedSubjectReads).toBe(0);
  return measured;
}

function progressingGroup(
  value: Awaited<ReturnType<typeof membershipStep>>['value'],
  subjectId: string,
  basisDigest: string,
  previous?: CollectionAliasProgress,
): CollectionAliasProgress {
  expect(value.result).toBe('not_proven');
  if (value.result !== 'not_proven' || value.progress === null)
    throw new Error('An admitted incomplete alias window must return real resumable progress');
  expect(value.work.used.candidateKeys).toBeGreaterThan(0);
  const progress = value.progress;
  expect(Object.keys(progress).sort()).toEqual(['aliasAfter', 'basisDigest', 'sourceAfter', 'subjectId']);
  expect(progress.subjectId).toBe(subjectId);
  expect(progress.basisDigest).toBe(basisDigest);
  expect(progress.aliasAfter !== null || progress.sourceAfter !== null).toBe(true);
  if (previous) expect(progress).not.toEqual(previous);
  for (const key of [progress.aliasAfter, progress.sourceAfter])
    if (key !== null) expect(Buffer.byteLength(key, 'utf8')).toBeLessThanOrEqual(256);
  return progress;
}

test('257 and 4096 last-readable aliases recover through explicit bounded source group continuation after native repair', async () => {
  for (const size of [257, 4096]) {
    const fixture = await resumableAliasFixture(size);
    const first = await membershipStep(fixture.source, fixture.survivor.id);
    let progress = progressingGroup(first.value, fixture.survivor.id, fixture.source.observation.basis.digest);
    // Prefix discovery can represent this key; it cannot settle the union floor past this pending group.
    const prefix = (await canonical(fixture.source, 1)).value;
    expect(ids(prefix)).toEqual([fixture.survivor.id]);
    let positive = false;
    for (let step = 0; step < size * 4 + 4; step++) {
      // Reconstruct only compact data, as a trusted caller does after shared encrypted cursor decode.
      const restored: CollectionAliasProgress = JSON.parse(JSON.stringify(progress));
      const measured = await membershipStep(fixture.source, fixture.survivor.id, restored);
      expect(measured.value.result).not.toBe(false);
      if (measured.value.result === true) {
        expect(measured.trace.anchors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: 'collection:read',
              id: fixture.collection.id,
              route: fixture.collection.route,
            }),
            expect.objectContaining({
              action: 'subject:read',
              id: fixture.aliases[size - 1]!.id,
              route: fixture.aliases[size - 1]!.route,
            }),
            expect.objectContaining({ action: 'subject:read', id: fixture.survivor.id, route: fixture.survivor.route }),
          ]),
        );
        positive = true;
        break;
      }
      progress = progressingGroup(
        measured.value,
        fixture.survivor.id,
        fixture.source.observation.basis.digest,
        progress,
      );
    }
    expect(positive).toBe(true); // not_proven/readiness/empty is never a successful large-group proof.
    const after = await driver.inspect();
    expect(after.occurrences).toEqual(fixture.before.occurrences);
    expect(after.privateFacts).toEqual(fixture.before.privateFacts);
  }
});

test('pending alias groups reject other targets and stale source or identity bases before candidate work', async () => {
  const fixture = await resumableAliasFixture(257);
  const first = await membershipStep(fixture.source, fixture.survivor.id);
  const progress = progressingGroup(first.value, fixture.survivor.id, fixture.source.observation.basis.digest);
  const other = await driver.subject();
  const wrongTarget = await driver.measure(() => failure(() => membershipStep(fixture.source, other.id, progress)));
  expect(wrongTarget.value.code).toBe('invalid_cursor');
  expect(wrongTarget.trace.candidateKeys).toEqual([]);
  const another = await prepare(await driver.curated([{ subjectId: fixture.survivor.id, note: null }]));
  const wrongSource = await driver.measure(() => failure(() => membershipStep(another, fixture.survivor.id, progress)));
  expect(wrongSource.value.code).toBe('stale_cursor');
  expect(wrongSource.trace.candidateKeys).toEqual([]);
  await driver.unrelatedWrite(fixture.collection);
  expect((await prepare(fixture.collection)).observation.basis.digest).toBe(progress.basisDigest);
  await driver.unmerge(fixture.aliases[0]!);
  await driver.repairIdentity();
  const stale = await driver.measure(() =>
    failure(() => membershipStep(fixture.source, fixture.survivor.id, progress)),
  );
  expect(stale.value.code).toBe('stale_cursor');
  expect(stale.trace.candidateKeys).toEqual([]);
});

test('all-concealed alias groups terminate only after complete windows and late grants require a fresh traversal', async () => {
  const fixture = await resumableAliasFixture(257);
  await driver.grant(fixture.aliases[256]!, 'subject:read', 'owner', false);
  let progress: CollectionAliasProgress | undefined;
  let completed = false;
  for (let step = 0; step < 1032; step++) {
    const measured = await membershipStep(fixture.source, fixture.survivor.id, progress);
    expect(measured.value.result).not.toBe(true);
    if (measured.value.result === false) {
      expect(measured.value.negativeEvidence).toBeDefined();
      completed = true;
      break;
    }
    progress = progressingGroup(measured.value, fixture.survivor.id, fixture.source.observation.basis.digest, progress);
  }
  expect(completed).toBe(true);
  await driver.grant(fixture.aliases[0]!, 'subject:read', 'owner', true);
  // A new traversal rechecks a newly readable original behind the old keyset; old progress stores no denial.
  expect((await membershipStep(await prepare(fixture.collection), fixture.survivor.id)).value.result).toBe(true);
});

test('positive alias discovery rechecks current original terminal and Collection authority at final use', async () => {
  for (const revoke of ['original', 'terminal', 'collection'] as const) {
    const subject = await driver.subject(),
      original = await driver.subject();
    const collection = await driver.curated([{ subjectId: original.id, note: 'retained original' }]);
    await driver.merge(original, subject);
    await driver.repairIdentity();
    const source = await prepare(collection);
    let barrierReached = false;
    await driver.beforePositiveUse(async () => {
      barrierReached = true;
      const anchor = revoke === 'original' ? original : revoke === 'terminal' ? subject : collection;
      await driver.grant(anchor, revoke === 'collection' ? 'collection:read' : 'subject:read', 'owner', false);
    });
    if (revoke === 'collection') {
      expect((await failure(() => membershipStep(source, subject.id))).code).toBe('not_found');
    } else {
      const result = await membershipStep(source, subject.id);
      expect(result.value.result).not.toBe(true);
    }
    expect(barrierReached).toBe(true);
  }
});

test('optional positive evidence is only a current witness hint and rechecks original terminal and Collection authority', async () => {
  const terminal = await driver.subject();
  const original = await driver.subject();
  const collection = await driver.curated([{ subjectId: original.id, note: 'retained original' }]);
  await driver.merge(original, terminal);
  await driver.repairIdentity();
  const source = await prepare(collection);
  const discovered = await contains(source, terminal.id);
  expect(discovered.value.result).toBe(true);
  if (discovered.value.result !== true) throw new Error('Expected a current native positive witness');

  await driver.grant(terminal, 'subject:read', 'owner', false);
  const allowance = allocate(256);
  const rechecked = await driver.measure(() =>
    driver.read('owner', (context) =>
      driver.source.containsSubject({
        ...context,
        source,
        subjectId: terminal.id,
        allowance,
        positiveEvidence: discovered.value.positiveEvidence,
      }),
    ),
  );
  account(rechecked.value.work, allowance, rechecked.trace);
  expect(rechecked.value.result).not.toBe(true);
  expect(rechecked.trace.candidateKeys.length).toBeGreaterThan(0);
  expect(rechecked.trace.anchors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'collection:read', id: collection.id, route: collection.route }),
      expect.objectContaining({ action: 'subject:read', id: original.id, route: original.route }),
      expect.objectContaining({ action: 'subject:read', id: terminal.id, route: terminal.route }),
    ]),
  );
});

test('native resumable alias first and deep windows at 64 512 4096 measure fixed quota and actual last-alias success', async () => {
  const samples: { scale: number; position: 'first' | 'deep'; quota: number; trace: NativeTrace }[] = [];
  for (const scale of [64, 512, 4096]) {
    const fixture = await resumableAliasFixture(scale);
    const quota = 24;
    const first = await membershipStep(fixture.source, fixture.survivor.id, undefined, quota);
    samples.push({ scale, position: 'first', quota, trace: first.trace });
    let progress = progressingGroup(first.value, fixture.survivor.id, fixture.source.observation.basis.digest);
    let positive = false;
    for (let step = 0; step < scale * 4 + 4; step++) {
      const measured = await membershipStep(fixture.source, fixture.survivor.id, progress, quota);
      if (measured.value.result === true) {
        expect(measured.trace.bytes).toBeGreaterThan(0);
        expect(measured.trace.buffers).toBeGreaterThan(0);
        expect(measured.trace.statements).toBeGreaterThan(0);
        samples.push({ scale, position: 'deep', quota, trace: measured.trace });
        positive = true;
        break;
      }
      progress = progressingGroup(
        measured.value,
        fixture.survivor.id,
        fixture.source.observation.basis.digest,
        progress,
      );
    }
    expect(positive).toBe(true);
  }
  await driver.checkGrowth(samples); // Real native framework: warmups/repetitions, rows/blocks/statements/bytes.
});

test('actual advancing alias cursors retain the settled union boundary before the pending group until the last readable witness', async () => {
  const fixture = await resumableAliasFixture(4096);
  let cursor: string | undefined;
  let previousInner: readonly (string | number)[] | undefined;
  let pendingCalls = 0;
  const emitted: string[] = [];
  let exhausted = false;
  for (let request = 0; request < 16_388; request++) {
    const measured = await driver.measure(() =>
      union([fixture.collection], { limit: 1, ...(cursor === undefined ? {} : { cursor }) }),
    );
    expect(measured.trace.candidateKeys.length).toBeLessThanOrEqual(256);
    const body = await page(measured.value);
    emitted.push(...body.subjects.map((subject) => subject.id));
    if (body.subjects.length === 0 && body.next !== null) {
      const output = json(body);
      for (const field of [
        'aliasAfter',
        'sourceAfter',
        'basisDigest',
        'ownerBasisDigest',
        'progress',
        'candidateKeys',
        'work',
        'positiveEvidence',
        'profilePins',
        'predicate',
      ])
        expect(output).not.toContain(`"${field}"`);
      for (const candidate of measured.trace.candidateKeys) expect(output).not.toContain(candidate.key);
      const position = await driver.inspectUnionContinuation({
        as: 'owner',
        sources: [fixture.collection],
        limit: 1,
        cursor: body.next,
      });
      expect(position.after).toHaveLength(8);
      expect(position.after[1]).toBe(''); // No earlier canonical group has been settled.
      expect(position.after[2]).toBe(fixture.survivor.id);
      expect(position.after[3]).toBe(0);
      expect(position.after[6]).toBe(fixture.source.observation.basis.digest);
      expect(position.after[7]).toBe(1);
      const inner = position.after.slice(4, 6);
      expect(inner.some((key) => typeof key === 'string' && key.length > 0)).toBe(true);
      expect(inner).not.toEqual(previousInner);
      previousInner = inner;
      expect(measured.trace.candidateKeys.length).toBeGreaterThan(0);
      pendingCalls++;
    }
    if (body.next === null) {
      exhausted = true;
      break;
    }
    expect(body.next).not.toBe(cursor);
    cursor = body.next;
  }
  expect(pendingCalls).toBeGreaterThan(0);
  expect(exhausted).toBe(true);
  expect(emitted).toEqual([fixture.survivor.id]);
});

test('an independent current true native source settles a group while another owner has resumable unknown alias evidence', async () => {
  const fixture = await resumableAliasFixture(4096);
  const unknown = await membershipStep(fixture.source, fixture.survivor.id);
  progressingGroup(unknown.value, fixture.survivor.id, fixture.source.observation.basis.digest);
  const independent = await driver.curated([{ subjectId: fixture.survivor.id, note: null }]);
  await driver.repairIdentity();
  const measured = await driver.measure(() => union([fixture.collection, independent], { limit: 1 }));
  expect(measured.trace.candidateKeys.length).toBeLessThanOrEqual(256);
  const body = await page(measured.value);
  expect(body.subjects.map((subject) => subject.id)).toEqual([fixture.survivor.id]);
  expect(measured.trace.anchors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'collection:read', id: independent.id, route: independent.route }),
      expect.objectContaining({ action: 'subject:read', id: fixture.survivor.id, route: fixture.survivor.route }),
    ]),
  );
});

function identityAccounting(trace: NativeTrace) {
  expect(trace.identityMetadataRows).toBe(trace.identityBasisReads.reduce((sum, read) => sum + read.metadataRows, 0));
  expect(trace.nativePoints).toBeGreaterThanOrEqual(
    trace.identityBasisReads.reduce((sum, read) => sum + read.coreHomeObservations, 0),
  );
  let metadataOffset = 0;
  for (const read of trace.identityBasisReads) {
    const reserved = trace.metadataReservations.find((event) => event.allowance.reservationId === read.reservationId);
    expect(reserved).toBeDefined();
    if (!reserved) throw new Error('Native identity sweeps require a real before-dispatch caller reservation');
    expect(reserved.beforeMetadataOffset).toBeLessThanOrEqual(metadataOffset);
    expect(read.beforeMetadataOffset).toBe(metadataOffset);
    expect(reserved.allowance.remaining.identityMetadataRows).toBeGreaterThanOrEqual(8192);
    expect(Number.isSafeInteger(read.metadataRows) && read.metadataRows >= 0).toBe(true);
    expect(read.metadataRows).toBeLessThanOrEqual(8192);
    if (read.state === 'ready') {
      expect(read.metadataRows).toBe(8192); // TWO independently released complete 4096-home sweeps.
      expect(read.coreHomeObservations).toBeGreaterThanOrEqual(8192);
    }
    metadataOffset += read.metadataRows;
  }
}

test('prepare final use and resumed native calls reserve both identity sweeps separately and settle actual work on errors', async () => {
  const subject = await driver.subject();
  const collection = await driver.curated([{ subjectId: subject.id, note: null }]);
  const allowance = allocate(0);
  expect(allowance.remaining.identityMetadataRows).toBeGreaterThanOrEqual(8192);
  const prepared = await driver.measure(() =>
    driver.read('owner', (context) => driver.source.prepare({ ...context, collectionId: collection.id, allowance })),
  );
  account(prepared.value.work, allowance, prepared.trace);
  identityAccounting(prepared.trace);
  expect(prepared.trace.identityBasisReads.some((read) => read.state === 'ready')).toBe(true);
  expect(prepared.value.source.observation.basis.identity.digest).toMatch(/^[0-9a-f]{64}$/);
  const current = await contains(prepared.value.source, subject.id);
  expect(current.value.result).toBe(true);
  identityAccounting(current.trace);
  expect(current.trace.identityBasisReads.some((read) => read.state === 'ready')).toBe(true);

  for (const identityMetadataRows of [0, 4096, 8191]) {
    const reserved = allocate(100);
    const short = { ...reserved, remaining: { ...reserved.remaining, identityMetadataRows } };
    const stopped = await driver.measure(() =>
      driver.read('owner', (context) =>
        retryable(() =>
          driver.source.containsSubject({
            ...context,
            source: prepared.value.source,
            subjectId: subject.id,
            allowance: short,
          }),
        ),
      ),
    );
    expect(stopped.trace.candidateKeys).toEqual([]);
    expect(stopped.trace.identityMetadataRows).toBe(0); // Do not begin an indivisible observation without admission.
  }

  await driver.holdIdentityRepair();
  await driver.merge(subject, await driver.subject());
  const failed = await driver.measure(() => retryable(() => prepare(collection)));
  identityAccounting(failed.trace);
  expect(failed.trace.identityBasisReads.length).toBeGreaterThan(0);
  expect(failed.trace.settlements.length).toBeGreaterThan(0);
  expect(failed.trace.settlements.reduce((sum, receipt) => sum + receipt.used.identityMetadataRows, 0)).toBe(
    failed.trace.identityMetadataRows,
  );
  expect(failed.trace.settlements.reduce((sum, receipt) => sum + receipt.used.nativePoints, 0)).toBe(
    failed.trace.nativePoints,
  );
  for (const receipt of failed.trace.settlements) {
    const reserved = failed.trace.reservations.find((event) => event.allowance.reservationId === receipt.reservationId);
    expect(reserved).toBeDefined();
    if (!reserved) throw new Error('Thrown native calls must settle their actual caller reservation');
    for (const key of Object.keys(receipt.used) as (keyof WorkReceipt['used'])[]) {
      expect(receipt.used[key]).toBeGreaterThanOrEqual(0);
      expect(receipt.used[key]).toBeLessThanOrEqual(reserved.allowance.remaining[key]);
    }
  }
});

test('bounded alias fetch lookahead and unchecked suffixes are charged without adopting an unprocessed native frontier', async () => {
  const fixture = await resumableAliasFixture(257);
  let progress: CollectionAliasProgress | undefined;
  let positive = false;
  for (let request = 0; request < 1032; request++) {
    const measured = await membershipStep(fixture.source, fixture.survivor.id, progress, 24);
    identityAccounting(measured.trace);
    for (const window of measured.trace.aliasWindows) {
      expect(window.limit).toBeGreaterThanOrEqual(1);
      expect(window.limit).toBeLessThanOrEqual(100);
      expect(window.allowance.remaining.candidateKeys).toBeGreaterThanOrEqual(window.limit + 1);
      expect(window.examined).toBeLessThanOrEqual(window.limit + 1);
      expect(window.examined).toBeGreaterThanOrEqual(window.originals.length);
      expect(window.examined).toBeLessThanOrEqual(window.allowance.remaining.candidateKeys);
      expect(window.settledOriginals.every((id) => window.originals.includes(id))).toBe(true);
    }
    if (measured.value.result === true) {
      positive = true;
      break;
    }
    const next = progressingGroup(
      measured.value,
      fixture.survivor.id,
      fixture.source.observation.basis.digest,
      progress,
    );
    const settled = measured.trace.aliasWindows.flatMap((window) => window.settledOriginals);
    if (next.aliasAfter !== null && next.aliasAfter !== progress?.aliasAfter)
      expect(settled).toContain(next.aliasAfter);
    if (next.sourceAfter !== null)
      expect(next.sourceAfter).toMatch(
        /^1:[0-5]:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
      );
    progress = next;
  }
  expect(positive).toBe(true);
});

test('direct native eligibility resumes beyond 257 and 4096 aliases through shared private 202 cursors with both keysets advancing', async () => {
  for (const size of [257, 4096]) {
    const fixture = await resumableAliasFixture(size);
    let cursor: string | undefined;
    let aliasAfter = '',
      sourceAfter = '';
    let aliasAdvanced = false,
      sourceAdvanced = false,
      completed = false,
      pending = 0;
    for (let request = 0; request < size * 4 + 4; request++) {
      const measured = await driver.measure(() =>
        driver.directMembership(
          'owner',
          [fixture.collection],
          fixture.survivor.id,
          cursor === undefined ? undefined : { cursor },
        ),
      );
      expect(measured.trace.candidateKeys.length).toBeLessThanOrEqual(256);
      identityAccounting(measured.trace);
      if (measured.value.status === 200) {
        const body = await measured.value.json();
        expect(body).toHaveProperty('zone');
        expect(measured.trace.anchors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ action: 'subject:read', id: fixture.aliases.at(-1)!.id }),
            expect.objectContaining({ action: 'subject:read', id: fixture.survivor.id }),
            expect.objectContaining({ action: 'collection:read', id: fixture.collection.id }),
          ]),
        );
        completed = true;
        break;
      }
      expect(measured.value.status).toBe(202); // Ready, admitted group work must advance, never permanent 404/503.
      expect(measured.value.headers.get('Cache-Control')).toBe('private, no-store');
      const body = await measured.value.json();
      expect(Object.keys(body)).toEqual(['next']);
      expect(typeof body.next).toBe('string');
      expect(body.next).not.toBe(cursor);
      expect(body.next.length).toBeLessThanOrEqual(4096);
      const position = await driver.inspectDirectContinuation({
        as: 'owner',
        sources: [fixture.collection],
        subjectId: fixture.survivor.id,
        cursor: body.next,
      });
      expect(position.after).toHaveLength(8);
      expect(position.after[1]).toBe('');
      expect(position.after[2]).toBe(fixture.survivor.id);
      expect(position.after[3]).toBe(0);
      expect(position.after[6]).toBe(fixture.source.observation.basis.digest);
      expect(position.after[7]).toBe(1);
      const nextAlias = position.after[4],
        nextSource = position.after[5];
      expect(typeof nextAlias).toBe('string');
      expect(typeof nextSource).toBe('string');
      if (typeof nextAlias !== 'string' || typeof nextSource !== 'string')
        throw new Error('Native keysets must be compact strings');
      expect([nextAlias, nextSource]).not.toEqual([aliasAfter, sourceAfter]);
      aliasAdvanced ||= nextAlias !== '' && nextAlias !== aliasAfter;
      sourceAdvanced ||= nextSource !== '' && nextSource !== sourceAfter;
      aliasAfter = nextAlias;
      sourceAfter = nextSource;
      expect(measured.trace.candidateKeys.length).toBeGreaterThan(0);
      for (const key of measured.trace.candidateKeys)
        expect(Buffer.from(body.next, 'base64url').toString()).not.toContain(key.key);
      cursor = body.next;
      pending++;
    }
    expect(completed).toBe(true);
    expect(pending).toBeGreaterThan(0);
    expect(aliasAdvanced).toBe(true);
    expect(sourceAdvanced).toBe(true);
  }
});

test('direct zero-progress maintenance returns standard retryable 503 Retry-After with no continuation', async () => {
  const subject = await driver.subject();
  const collection = await driver.curated([{ subjectId: subject.id, note: null }]);
  const restore = await driver.unavailable('runtime');
  try {
    const response = await driver.directMembership('owner', [collection], subject.id);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).not.toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({ retryable: true });
    expect(body).not.toHaveProperty('next');
    expect(body).not.toHaveProperty('continuation');
    expect(body).not.toHaveProperty('zone');
  } finally {
    await restore();
  }
});
