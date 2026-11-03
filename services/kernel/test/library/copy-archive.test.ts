import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import {
  fixture,
  libraryLabels,
  libraryProfile,
  unitData,
} from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { parseCopyArchive, COPY_ARCHIVE_LIMITS } from '../../src/library/copy-archive-format.ts';
import { createCopyArchive } from '../../src/library/copy-archive.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { testRouteKey } from '../support/test-kernel.ts';

let f: NativeProfileFixture, owner: Awaited<ReturnType<NativeProfileFixture['identity']>>, other: typeof owner;
let artifact: { manifest: Record<string, any>; records: Record<string, any>[] };
let subjectId: string;
let sourceSessions: { id: string; unit: string }[] = [];
let currentDigest: string;
let workClient: Awaited<ReturnType<typeof createWorkClient>> | undefined;
let now = Date.now();
const scopes = [
  'subject:read',
  'subject:create',
  'statement:propose',
  'copy:create',
  'copy:read',
  'copy:list',
  'account:delete',
  'library_entry:list',
  'library_entry:read',
  'progress_session:list',
  'progress_session:read',
  'progress_session:create',
  'progress_session:update',
  'collection:read',
];
const path = '/v1/libraryCopyArchives';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const additionalUnits = ['volume', 'page', 'minute', 'episode', 'percent', 'plot-key.v2', 'edition.v1'];
let archivedUnits: { sessionId: string; memberId: string; detachedId: string };
const statement = (property: string, content: string) => ({
  property: { id: property },
  value: { type: 'value', content },
});
function archiveRelease(statuses: string[], legacyUnit = false, changedProfile = false) {
  const profile = libraryProfile('fixture.archive', changedProfile ? 'volume' : 'chapter');
  profile.progress.allowed[0]!.units.push(
    ...additionalUnits
      .filter((unit) => unit !== profile.progress.allowed[0]!.units[0]!.id)
      .map((unit) => unitData(unit)),
  );
  profile.progress.allowed.push({ mode: 'completed_units', units: [unitData('episode', 'completed_units')] });
  if (legacyUnit) profile.progress.allowed[0]!.units.push(unitData('old.chapter.v1'));
  profile.copies.kinds = [
    { id: 'physical', statuses: statuses.map((id) => ({ id })) },
    { id: 'digital', statuses: [{ id: 'licensed' }] },
  ];
  const sources = fixture(profile);
  const schema = JSON.parse(sources.schemas['fixture.yaml']!);
  schema.prefixes.schema = 'http://schema.org/';
  schema.classes.Child.slots = ['isPartOf'];
  schema.classes.Episode = { class_uri: 'schema:Episode', slots: ['isPartOf'] };
  schema.slots = {
    isPartOf: {
      slot_uri: 'schema:isPartOf',
      range: 'Child',
      annotations: { datatype: 'wikibase-item', relation_group: 'membership' },
    },
  };
  sources.schemas['fixture.yaml'] = JSON.stringify(schema);
  for (const [key, source] of Object.entries(sources.presentation)) {
    const labels = JSON.parse(source);
    const locale = key.slice('fixture/'.length) as Parameters<typeof libraryLabels>[1];
    labels.types['schema:Episode'] = 'episode';
    labels.properties = { ...(labels.properties ?? {}), 'schema:isPartOf': 'part of' };
    labels.libraryProfiles[profile.id] = libraryLabels(profile, locale);
    sources.presentation[key] = JSON.stringify(labels);
  }
  return compileCatalogue(sources);
}
async function json(response: Response, status = 200) {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  expect(response.headers.get('cache-control')).toContain('no-store');
  return response.json();
}
const send = (method: string, suffix = '', body?: unknown, key?: string) =>
  f.send(owner.bearer, method, path + suffix, body, key);
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock: () => new Date(now) });
  owner = await f.identity(scopes);
  other = await f.identity(scopes);
  await f.activate(await f.publish(await archiveRelease(['owned', 'lent'], true)));
  for (const group of ['personal_library', 'reading_progress', 'collections'])
    expect((await f.send('steward', 'POST', `/v1/platform/exposure/${group}:open`)).status).toBe(200);
  subjectId = await f.createSubject('game');
  // Distinct native commands create legitimate identical-text siblings; no row-list fixture format.
  for (let i = 0; i < 12; i++)
    expect(
      (
        await f.send(owner.bearer, 'POST', '/v1/copies', {
          subjectId,
          kind: 'physical',
          status: 'owned',
          note: '📚'.repeat(1000),
          source: 'gift',
          acquiredOn: i === 0 ? '2020-02-29' : null,
          disposedOn: null,
        })
      ).status,
    ).toBe(201);
  const createSession = async (unit: string) => {
    const additionalMeasures =
      unit === 'old.chapter.v1' ? [] : additionalUnits.map((measureUnit) => ({ unit: measureUnit, total: '5.000001' }));
    const started = await json(
      await f.send(
        owner.bearer,
        'POST',
        '/v1/progressSessions',
        {
          subjectId,
          mode: 'scalar_amount',
          unit,
          total: '999999999999.999999',
          ...(additionalMeasures.length ? { additionalMeasures } : {}),
        },
        entryKey(),
      ),
      201,
    );
    const session = started.progressSession;
    await json(
      await f.send(owner.bearer, 'POST', `/v1/progressSessions/${session.id}:record`, {
        revision: 1,
        amount: '0',
      }),
    );
    let revision = 2;
    for (const measure of additionalMeasures) {
      await json(
        await f.send(owner.bearer, 'POST', `/v1/progressSessions/${session.id}:record`, {
          revision,
          measureId: measure.unit,
          amount: '4.125000',
        }),
      );
      revision++;
    }
    await json(
      await f.send(owner.bearer, 'POST', `/v1/progressSessions/${session.id}:complete`, {
        revision,
      }),
    );
    return { id: session.id, unit };
  };
  sourceSessions = [
    await createSession('chapter'),
    await createSession('chapter'),
    await createSession('old.chapter.v1'),
  ];
  const createEpisode = async (label: string) => {
    const response = await f.send(owner.bearer, 'POST', '/v1/subjects', {
      type: 'schema:Episode',
      labels: { en: label },
      statements: { 'schema:isPartOf': [statement('schema:isPartOf', subjectId)] },
    });
    if (response.status !== 201) throw new Error(`${response.status}: ${await response.text()}`);
    return (await response.json()).subject as { id: string; statements: Record<string, { id: string }[]> };
  };
  const member = await createEpisode('Archive member'),
    detached = await createEpisode('Archive detached member');
  const unitStart = await json(
    await f.send(owner.bearer, 'POST', '/v1/progressSessions', {
      subjectId,
      mode: 'completed_units',
      unit: 'episode',
    }),
    201,
  );
  const unitSession = unitStart.progressSession;
  await json(
    await f.send(owner.bearer, 'POST', `/v1/progressSessions/${unitSession.id}:recordEpisodes`, {
      revision: 1,
      add: [member.id, detached.id],
    }),
  );
  await json(await f.send(owner.bearer, 'POST', `/v1/progressSessions/${unitSession.id}:complete`, { revision: 2 }));
  const relation = detached.statements['schema:isPartOf']![0]!.id;
  const hidden = await f.send('steward', 'POST', `/v1/subjects/${detached.id}/candidates/${relation}:hide`, {
    reason: 'Archive fixture removes current membership',
  });
  expect(hidden.status).toBe(200);
  archivedUnits = { sessionId: unitSession.id, memberId: member.id, detachedId: detached.id };
  currentDigest = await f.publish(await archiveRelease(['lent']));
  await f.activate(currentDigest); // Current profile drops the old progress vocabulary.
  const status = await json(await f.send(owner.bearer, 'POST', '/v1/libraryExports'));
  const records: Record<string, any>[] = [];
  let cursor = status.first,
    manifest: Record<string, any> | null = null;
  for (let n = 0; cursor && n < 100; n++) {
    const page = await json(
      await f.send(
        owner.bearer,
        'GET',
        `/v1/libraryExports/${status.exportId}/pages?cursor=${encodeURIComponent(cursor)}`,
      ),
    );
    records.push(...page.records);
    cursor = page.next;
    manifest = page.manifest;
  }
  expect(cursor).toBeNull();
  expect(manifest).not.toBeNull();
  artifact = { manifest: manifest!, records };
}, 120000);
afterAll(async () => {
  await workClient?.close();
  await f?.close();
});

test('actual installed export retains independent holdings, all pins and exact dates without implying restoration', async () => {
  const parsed = parseCopyArchive(bytes(artifact));
  expect(parsed.holdings).toHaveLength(12);
  expect(new Set(parsed.holdings.map((r) => r.evidence.copy_id)).size).toBe(12);
  expect(new Set(parsed.holdings.map((r) => r.evidence.subject_id)).size).toBe(1);
  expect(parsed.holdings.every((r) => r.evidence.status === 'owned' && r.evidence.note === '📚'.repeat(1000))).toBe(
    true,
  );
  expect(
    parsed.holdings.every(
      (r) => r.evidence.kind_profile_pin && r.evidence.status_profile_pin && r.evidence.library_profile_pin,
    ),
  ).toBe(true);
  expect(parsed.holdings.some((r) => r.evidence.acquired_on === '2020-02-29')).toBe(true);
  expect(parsed.holdings.some((r) => r.evidence.acquired_on === null)).toBe(true);
  expect(parsed.progress).toHaveLength(6);
  expect(parsed.progress.filter((r) => r.evidence.section === 'sessions')).toHaveLength(4);
  expect(parsed.progress.every((r) => r.evidence.section !== 'sessions' || r.evidence.subject_id === subjectId)).toBe(
    true,
  );
  const primary = parsed.progress.find(
    (row) => row.evidence.section === 'sessions' && row.sourceSessionId === sourceSessions[0]!.id,
  );
  expect(primary).toMatchObject({ evidence: { amount: '0', total: '999999999999.999999' } });
  if (!primary || primary.evidence.section !== 'sessions') throw new Error('Missing exported primary measure');
  expect(primary.evidence.additional_measures).toHaveLength(7);
  expect(new Set(primary.evidence.additional_measures?.map((measure) => measure.unit))).toEqual(
    new Set(additionalUnits),
  );
  expect(primary.evidence.additional_measures?.every((measure) => measure.amount === '4.125000')).toBe(true);
  const units = parsed.progress.filter((row) => row.evidence.section === 'units');
  expect(units.map((row) => row.evidence.section === 'units' && row.evidence.unit_id).sort()).toEqual(
    [archivedUnits.detachedId, archivedUnits.memberId].sort(),
  );
  expect(
    parsed.progress.find((r) => r.evidence.section === 'sessions' && r.sourceSessionId === sourceSessions[2]!.id),
  ).toMatchObject({ evidence: { unit: 'old.chapter.v1' } });
  expect(parsed.coverage.find((c) => c.section === 'entries')).toEqual({
    section: 'entries',
    records: 0,
    support: 'unsupported',
  });
});

test('installed final manifest, counts, envelopes and admission bounds are mandatory', () => {
  const reject = (change: (a: typeof artifact) => void, recount = false) => {
    const a = structuredClone(artifact);
    change(a);
    if (recount) {
      a.manifest.rows = a.records.length;
      a.manifest.recordBytes = a.records.reduce((n, r) => n + bytes(r).length, 0);
    }
    expect(() => parseCopyArchive(bytes(a))).toThrow('invalid_request');
  };
  reject((a) => {
    a.manifest.version = 2;
  });
  reject((a) => {
    a.manifest = null as any;
  });
  reject((a) => {
    a.manifest.rows++;
  });
  reject((a) => {
    a.manifest.recordBytes++;
  });
  reject((a) => {
    a.manifest.sections = a.manifest.sections.filter((s: string) => s !== 'holdings');
  });
  reject((a) => {
    a.records[0]!.acquired_on = '2020-02';
  }, true);
  reject((a) => {
    a.records[0]!.acquired_on = '2021-02-29';
  }, true);
  reject((a) => {
    delete a.records[0]!.disposed_on;
  }, true);
  reject((a) => {
    a.records[0]!.note = 'x'.repeat(1001);
  }, true);
  reject((a) => {
    const session = a.records.find((record) => record.section === 'sessions');
    if (!session) throw new Error('Missing exported progress session');
    session.amount = '1.0000000';
  }, true);
  reject((a) => {
    a.records.push(a.records[0]!);
  }, true);
  expect(() => parseCopyArchive(new Uint8Array(COPY_ARCHIVE_LIMITS.bytes + 1))).toThrow('content_too_large');
  expect(() => parseCopyArchive(new TextEncoder().encode('{"manifest":1,"manifest":2,"records":[]}'))).toThrow(
    'invalid_request',
  );
  expect(() => parseCopyArchive(new TextEncoder().encode('['.repeat(17) + ']'.repeat(17)))).toThrow('invalid_request');
});

test('private paged inspection, original upload replay, cancellation, expiry and removal', async () => {
  expect((await f.send('anonymous', 'POST', path, artifact)).status).toBe(401);
  const key = entryKey(),
    uploaded = await json(await send('POST', '', artifact, key));
  expect(await json(await send('POST', '', artifact, key))).toEqual(uploaded);
  expect((await send('POST', '', artifact)).status).toBe(409);
  const suffix = `/${uploaded.uploadId}`;
  const denied = await f.send(other.bearer, 'GET', path + suffix);
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain('gift');
  const first = await json(await send('GET', suffix));
  expect(first).toMatchObject({ holdings: 12, fullRestoration: false, effectsSupported: false, state: 'inspecting' });
  expect(first.rows).toHaveLength(10);
  expect(first.rows.every((r: any) => r.resolution === 'unresolved')).toBe(true);
  const last = await json(await send('GET', `${suffix}?after=${first.next}`));
  expect(last.rows).toHaveLength(2);
  expect(last.next).toBeNull();
  expect(await json(await send('POST', suffix + ':cancel'))).toMatchObject({ cancelled: true });
  expect(await json(await send('GET', suffix))).toMatchObject({ state: 'cancelled', holdings: 12 });
  now += 7 * 86_400_000;
  expect((await send('GET', suffix)).status).toBe(404);
  expect(await json(await send('DELETE', suffix))).toMatchObject({ removed: 18, complete: true });
  expect((await send('POST', '', artifact, key)).status).toBe(404); // Receipt never resurrects removed evidence.
  now = Date.now();
}, 120000);

test('recovery selects one equal-measure occurrence, reviews current meanings and reopens exact native facts', async () => {
  const uploaded = await json(await send('POST', '', artifact, entryKey()));
  expect(uploaded.progressRecords).toBe(6);
  const suffix = `/${uploaded.uploadId}`;
  const page = await json(await send('GET', `${suffix}/progress`));
  expect(page.occurrences).toHaveLength(6);
  expect(new Set(page.occurrences.map((row: any) => row.evidence.subject_id)).size).toBe(1);
  expect(page.occurrences.filter((row: any) => row.evidence.amount === '0')).toHaveLength(2);
  const source = sourceSessions[0]!;
  now += 60_000;
  const reviewBody = {
    sessionId: source.id,
    subjectId,
    mode: 'scalar_amount',
    unit: 'chapter',
    additionalMeasures: additionalUnits.map((unit) => ({ sourceUnit: unit, unit })),
    unitIds: [],
  };
  const review = await json(await send('POST', `${suffix}/progressReviews`, reviewBody, entryKey()));
  expect(review).toMatchObject({ applicable: true, recovery: 'complete', historical: { sourceRevision: 10 } });
  expect(review.unsupportedHistoricalDates).toEqual(['started_at', 'completed_at', 'last_changed_at']);
  const oldVocabularyReview = await json(
    await send(
      'POST',
      `${suffix}/progressReviews`,
      { ...reviewBody, sessionId: sourceSessions[2]!.id, additionalMeasures: [] },
      entryKey(),
    ),
  );
  expect(oldVocabularyReview).toMatchObject({
    applicable: true,
    historical: { unit: 'old.chapter.v1' },
    current: { unit: 'chapter' },
  });
  const applyKey = entryKey();
  const applied = await json(
    await send('POST', `${suffix}/progressReviews/${review.reviewId}:apply`, undefined, applyKey),
  );
  expect(applied).toMatchObject({ state: 'applied', acceptedSteps: 10, totalSteps: 10 });
  expect(
    await json(await send('POST', `${suffix}/progressReviews/${review.reviewId}:apply`, undefined, applyKey)),
  ).toEqual(applied);
  const result = await json(await send('GET', `${suffix}/progressReviews/${review.reviewId}`));
  expect(result.application).toMatchObject({ state: 'applied', sessionId: applied.sessionId, acceptedSteps: 10 });
  expect(result.progressSession).toMatchObject({
    id: applied.sessionId,
    subjectId,
    state: 'completed',
    amount: '0',
    total: '999999999999.999999',
  });
  expect(result.progressSession.measures).toHaveLength(8);
  expect(result.progressSession.measures.find((measure: any) => measure.unit === 'chapter')).toMatchObject({
    amount: '0',
    total: '999999999999.999999',
  });
  expect(new Set(result.progressSession.measures.map((measure: any) => measure.unit))).toEqual(
    new Set(['chapter', ...additionalUnits]),
  );
  expect(
    result.progressSession.measures
      .filter((measure: any) => additionalUnits.includes(measure.unit))
      .every((measure: any) => measure.amount === '4.125000' && measure.total === '5.000001'),
  ).toBe(true);
  expect(applied.sessionId).not.toBe(source.id);
  expect(new Date(result.progressSession.startedAt).getTime()).toBeGreaterThanOrEqual(now);
  const changed = await json(
    await send(
      'POST',
      `${suffix}/progressReviews`,
      { ...reviewBody, unit: 'volume', additionalMeasures: [{ sourceUnit: 'volume', unit: 'chapter' }] },
      entryKey(),
    ),
  );
  expect(changed.reviewId).not.toBe(review.reviewId);
  expect((await send('POST', `${suffix}/progressReviews/${changed.reviewId}:apply`, undefined, applyKey)).status).toBe(
    422,
  );

  expect(
    (
      await f.send(
        other.bearer,
        'POST',
        `${path}/${uploaded.uploadId}/progressReviews/${review.reviewId}:apply`,
        undefined,
        entryKey(),
      )
    ).status,
  ).toBe(404);

  const unitReview = await json(
    await send(
      'POST',
      `${suffix}/progressReviews`,
      {
        sessionId: archivedUnits.sessionId,
        subjectId,
        mode: 'completed_units',
        unit: 'episode',
        additionalMeasures: [],
        unitIds: [archivedUnits.memberId, archivedUnits.detachedId],
      },
      entryKey(),
    ),
  );
  expect(unitReview).toMatchObject({
    applicable: true,
    recovery: 'partial',
    completedUnits: [
      { unitId: archivedUnits.memberId, admission: 'member' },
      { unitId: archivedUnits.detachedId, admission: 'detached' },
    ],
  });
  const unitApply = await json(
    await send('POST', `${suffix}/progressReviews/${unitReview.reviewId}:apply`, undefined, entryKey()),
  );
  const unitResult = await json(await send('GET', `${suffix}/progressReviews/${unitReview.reviewId}`));
  expect(unitResult.progressSession).toMatchObject({
    id: unitApply.sessionId,
    state: 'completed',
    completedUnitCount: 1,
  });
  const reopenedUnits = await json(
    await f.send(
      owner.bearer,
      'GET',
      `/v1/progressSessions/${unitApply.sessionId}/episodes?ids=${archivedUnits.memberId},${archivedUnits.detachedId}`,
    ),
  );
  expect(reopenedUnits.episodes).toMatchObject([
    { episodeSubjectId: archivedUnits.memberId, completed: true, membership: 'member' },
    { episodeSubjectId: archivedUnits.detachedId, completed: false, membership: 'detached' },
  ]);

  const staleReview = await json(await send('POST', `${suffix}/progressReviews`, reviewBody, entryKey()));
  await f.activate(await f.publish(await archiveRelease(['lent'], false, true)));
  const stale = await json(
    await send('POST', `${suffix}/progressReviews/${staleReview.reviewId}:apply`, undefined, entryKey()),
  );
  expect(stale).toMatchObject({ state: 'stale', acceptedSteps: 0, sessionId: null });
  await f.activate(currentDigest);

  const partialReview = await json(
    await send(
      'POST',
      `${suffix}/progressReviews`,
      { ...reviewBody, sessionId: sourceSessions[2]!.id, additionalMeasures: [] },
      entryKey(),
    ),
  );
  workClient ??= await createWorkClient(f.pool.options.connectionString!, f.pool);
  const service = createCopyArchive({
      pool: f.pool,
      access: f.access,
      workClient,
      tokens: f.tokens,
      routeKey: testRouteKey(),
      clock: () => new Date(now),
    }),
    partialKey = entryKey(),
    abort = new AbortController();
  await expect(
    service.applyProgress(owner.actor, uploaded.uploadId, partialReview.reviewId, partialKey, abort.signal, () =>
      abort.abort(),
    ),
  ).rejects.toThrow();
  await service.cancel(owner.actor, uploaded.uploadId);
  const partial = await service.applyProgress(owner.actor, uploaded.uploadId, partialReview.reviewId, partialKey);
  expect(partial).toMatchObject({ state: 'partial', acceptedSteps: 1, totalSteps: 3 });
  expect(partial.sessionId).not.toBeNull();
  const partialResult = await json(await send('GET', `${suffix}/progressReviews/${partialReview.reviewId}`));
  expect(partialResult.progressSession).toMatchObject({ id: partial.sessionId, state: 'active' });
  const disclosureAbort = new AbortController();
  const throwIfNotAborted = disclosureAbort.signal.throwIfAborted.bind(disclosureAbort.signal);
  let disclosureGates = 0;
  disclosureAbort.signal.throwIfAborted = () => {
    if (++disclosureGates === 4) disclosureAbort.abort();
    throwIfNotAborted();
  };
  await expect(
    service.progressResult(owner.actor, uploaded.uploadId, unitReview.reviewId, disclosureAbort.signal),
  ).rejects.toThrow();
  expect(await json(await send('DELETE', suffix))).toMatchObject({ complete: true });
}, 120000);

test('terminal account fencing denies inspection and bounded owner erasure removes evidence', async () => {
  const uploaded = await json(await send('POST', '', artifact));
  await createLifecycleCommands({ pool: f.pool, access: f.access }).tombstone(
    { actor: owner.actor, deadline: Date.now() + 30000 },
    { accountId: owner.actor.accountId, key: entryKey() },
  );
  expect([401, 403]).toContain((await send('GET', `/${uploaded.uploadId}`)).status);
  expect(
    (
      await purgeOwnedGraphPage(f.pool, {
        accountId: owner.actor.accountId,
        kind: 'copy_archive',
        parent: null,
        after: null,
        ordinal: 0,
        segment: 0,
      })
    ).removed,
  ).toBe(15);
  const count = await f.pool.query('SELECT 1 FROM library.copy_archive_row WHERE route=$1 AND account_id=$2', [
    routeOf(owner.actor.accountId),
    owner.actor.accountId,
  ]);
  expect(count.rowCount).toBe(0);
}, 120000);
