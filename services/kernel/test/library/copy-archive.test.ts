import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture, libraryProfile, unitData } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { parseCopyArchive, COPY_ARCHIVE_LIMITS } from '../../src/library/copy-archive-format.ts';
import { createCopyArchive } from '../../src/library/copy-archive.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { testRouteKey } from '../support/test-kernel.ts';

let f: NativeProfileFixture, owner: Awaited<ReturnType<NativeProfileFixture['identity']>>, other: typeof owner;
let artifact: { manifest: Record<string, any>; records: Record<string, any>[] };
let subjectId: string;
let sourceSessions: { id: string; unit: string }[] = [];
let currentDigest: string;
let now = Date.now();
const scopes = [
  'subject:read',
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
function archiveRelease(statuses: string[], legacyUnit = false, changedProfile = false) {
  const profile = libraryProfile('fixture.archive', changedProfile ? 'volume' : 'chapter');
  if (!changedProfile) profile.progress.allowed[0]!.units.push(unitData('volume'));
  if (legacyUnit) profile.progress.allowed[0]!.units.push(unitData('old.chapter.v1'));
  profile.copies.kinds = [
    { id: 'physical', statuses: statuses.map((id) => ({ id })) },
    { id: 'digital', statuses: [{ id: 'licensed' }] },
  ];
  return compileCatalogue(fixture(profile));
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
          ...(unit === 'old.chapter.v1' ? {} : { additionalMeasures: [{ unit: 'volume', total: '5.000001' }] }),
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
    if (unit !== 'old.chapter.v1')
      await json(
        await f.send(owner.bearer, 'POST', `/v1/progressSessions/${session.id}:record`, {
          revision: 2,
          measureId: 'volume',
          amount: '4.125000',
        }),
      );
    await json(
      await f.send(owner.bearer, 'POST', `/v1/progressSessions/${session.id}:complete`, {
        revision: unit === 'old.chapter.v1' ? 2 : 3,
      }),
    );
    return { id: session.id, unit };
  };
  sourceSessions = [await createSession('chapter'), await createSession('chapter'), await createSession('old.chapter.v1')];
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
  expect(parsed.progress).toHaveLength(3);
  expect(parsed.progress.filter((r) => r.evidence.section === 'sessions')).toHaveLength(3);
  expect(parsed.progress.every((r) => r.evidence.section !== 'sessions' || r.evidence.subject_id === subjectId)).toBe(true);
  expect(parsed.progress.find((r) => r.evidence.section === 'sessions' && r.sourceSessionId === sourceSessions[0]!.id))
    .toMatchObject({ evidence: { amount: '0', total: '999999999999.999999', additional_measures: [{ unit: 'volume', amount: '4.125000', total: '5.000001' }] } });
  expect(parsed.progress.find((r) => r.evidence.section === 'sessions' && r.sourceSessionId === sourceSessions[2]!.id))
    .toMatchObject({ evidence: { unit: 'old.chapter.v1' } });
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
  expect(await json(await send('DELETE', suffix))).toMatchObject({ removed: 15, complete: true });
  expect((await send('POST', '', artifact, key)).status).toBe(404); // Receipt never resurrects removed evidence.
  now = Date.now();
}, 120000);

test('recovery selects one equal-measure occurrence, reviews current meanings and reopens exact native facts', async () => {
  const uploaded = await json(await send('POST', '', artifact, entryKey()));
  expect(uploaded.progressRecords).toBe(3);
  const suffix = `/${uploaded.uploadId}`;
  const page = await json(await send('GET', `${suffix}/progress`));
  expect(page.occurrences).toHaveLength(3);
  expect(new Set(page.occurrences.map((row: any) => row.evidence.subject_id)).size).toBe(1);
  expect(page.occurrences.filter((row: any) => row.evidence.amount === '0')).toHaveLength(2);
  const source = sourceSessions[0]!;
  now += 60_000;
  const reviewBody = {
    sessionId: source.id,
    subjectId,
    mode: 'scalar_amount',
    unit: 'chapter',
    additionalMeasures: [{ sourceUnit: 'volume', unit: 'volume' }],
    unitIds: [],
  };
  const review = await json(
    await send('POST', `${suffix}/progressReviews`, reviewBody, entryKey()),
  );
  expect(review).toMatchObject({ applicable: true, recovery: 'complete', historical: { sourceRevision: 4 } });
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
  expect(applied).toMatchObject({ state: 'applied', acceptedSteps: 4, totalSteps: 4 });
  expect(await json(await send('POST', `${suffix}/progressReviews/${review.reviewId}:apply`, undefined, applyKey)))
    .toEqual(applied);
  const result = await json(await send('GET', `${suffix}/progressReviews/${review.reviewId}`));
  expect(result.application).toMatchObject({ state: 'applied', sessionId: applied.sessionId, acceptedSteps: 4 });
  expect(result.progressSession).toMatchObject({
    id: applied.sessionId,
    subjectId,
    state: 'completed',
    amount: '0',
    total: '999999999999.999999',
    measures: [{ unit: 'chapter', amount: '0' }, { unit: 'volume', amount: '4.125000', total: '5.000001' }],
  });
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
  expect((await send('POST', `${suffix}/progressReviews/${changed.reviewId}:apply`, undefined, applyKey)).status)
    .toBe(422);

  const staleReview = await json(
    await send('POST', `${suffix}/progressReviews`, reviewBody, entryKey()),
  );
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
  const service = createCopyArchive({
      pool: f.pool,
      access: f.access,
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
