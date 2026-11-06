import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createKernelClient } from '../../../../packages/client/src/index.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { purgeOwnedGraphPage as purge } from '../../src/library/erasure-owned-graph.ts';
import { newId } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { parseBangumiUpload } from '../../src/library/list-import-bangumi-model.ts';
import { parseVndb } from '../../src/library/list-import-vndb-parser.ts';
import { parseAniList } from '../../src/library/list-import-anilist-parser.ts';
import { readExportSourcePage, initialExportSeek } from '../../src/library/library-export-source.ts';
import { exportSectionsV4 } from '../../src/library/library-export-format.ts';
import { parseMal } from '../../src/library/list-import-mal-parser.ts';
import { exportSections, exportSectionsV2, libraryExportManifest } from '../../src/library/library-export-format.ts';
import { decodeLibraryArchive, type ArchiveRecord } from '../../src/library/library-archive.ts';
import { createLibraryArchiveCollectionRecovery } from '../../src/library/library-archive-collection-recovery.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
let workClient: WorkClient;
let db: GrowthDatabase, app: ReturnType<typeof createKernel>;
let fixture: Awaited<ReturnType<typeof createRealAccess<{ owner: string; other: string }>>>;
const route = 0x2200,
  owner = newId(route),
  other = newId(route),
  label = newId(route);
const collection = newId(route),
  session = newId(route),
  copy = newId(route),
  version = newId(route);
const scopes = [
  'library_entry:list',
  'library_entry:read',
  'library_entry:update',
  'copy:list',
  'progress_session:list',
  'progress_session:read',
  'progress_session:update',
  'collection:read',
  'collection:create',
  'collection:update',
  'subject:create',
  'subject:read',
  ...LIFECYCLE_ACTIONS.keys(),
];
const routeKey = new Uint8Array(32).fill(93);
const sparse = newId(route);
const subjectIds: string[] = [];
const sourceMemberIds = [newId(route), newId(route)].sort();
let recoveryUploadId: string | undefined;
const legacyPin = {
  provenance: 'legacy',
  releaseDigest: bundledDigest,
  acceptingType: null,
  profileId: 'legacy-fixed-v1',
};
let now = Date.now();
const key = randomUUID();
function request(
  method: string,
  path: string,
  persona: 'owner' | 'other' | 'anonymous' = 'owner',
  requestKey = key,
  signal?: AbortSignal,
) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(persona === 'anonymous' ? {} : { authorization: `Bearer ${fixture.bearer(persona)}` }),
        'idempotency-key': JSON.stringify(requestKey),
      },
      ...(signal ? { signal } : {}),
    }),
  );
}
function command(method: string, path: string, body: unknown, requestKey = randomUUID()) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${fixture.bearer('owner')}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(requestKey),
      },
      body: JSON.stringify(body),
    }),
  );
}
async function json(response: Response, code = 200) {
  if (response.status !== code) throw new Error(`${response.status}: ${await response.text()}`);
  expect(response.headers.get('cache-control')).toContain('no-store');
  return response.json();
}
function sql(parts: TemplateStringsArray, ...values: unknown[]) {
  return db.admin.query(
    parts.reduce((text, part, i) => text + (i ? `$${i}` : '') + part, ''),
    values,
  );
}
const get = (path: string) => request('GET', path).then(json);
const capture = (requestKey = randomUUID()) => request('POST', '/v1/libraryExports', 'owner', requestKey).then(json);
beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  fixture = await createRealAccess(db.admin, { owner, other }, scopes);
  await fixture.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'subject:create');
  workClient = await createWorkClient(process.env.DATABASE_URL!);
  app = createKernel({
    receiptKeys: testReceiptKeys(),
    workClient,
    pool: db.pool,
    routeKey,
    clock: () => new Date(now),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) },
    access: fixture.access,
    writeRate: fixture.writeRate,
    ratePeer: () => '127.0.0.1',
  });
  await sql`INSERT INTO access.exposure_opening("group",valid,transaction_id) SELECT g,tstzrange('2020-01-01',NULL,'[)'),${owner} FROM unnest(${['personal_library', 'reading_progress', 'collections']}::text[]) g`;
  for (let i = 0; i < 18; i++) {
    const subject = newId(route);
    if (i === 4) {
      const key = randomUUID();
      const response = await app.handle(
        new Request('http://kernel.test/v1/subjects', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${fixture.bearer('owner')}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(key),
          },
          body: JSON.stringify({ type: 'schema:Book', labels: { en: 'Recovered occurrence subject' } }),
        }),
      );
      if (response.status !== 201)
        throw new Error(`Native Subject creation failed: ${response.status} ${await response.text()}`);
      subjectIds.push(((await response.json()) as { subject: { id: string } }).subject.id);
    } else {
      await sql`INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id) VALUES(${route},${subject},'schema:Book',${owner})`;
      subjectIds.push(subject);
    }
    await sql`INSERT INTO library.entry(route,account_id,subject_id,state,library_profile_pin,revision,created_at,updated_at,transaction_id) VALUES(${route},${owner},${subject},${i === 0 ? 'old-unknown-state' : 'planned'},${legacyPin},1,now(),now(),${owner})`;
  }
  await sql`INSERT INTO library.personal_label(route,account_id,label_id,normalized_name,revision,created_at,updated_at,transaction_id) VALUES(${route},${owner},${label},'weekend',1,now(),now(),${owner})`;
  await sql`INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,revision,created_at,updated_at,transaction_id) VALUES(${route},${owner},${subjectIds[1]},${label},1,now(),now(),${owner})`;
  await sql`INSERT INTO library.copy(route,account_id,copy_id,subject_id,kind,status,library_profile_pin,note,source,acquired_on,revision,created_at,updated_at,transaction_id) VALUES(${route},${owner},${copy},${subjectIds[2]},'physical','owned',${legacyPin},'signed copy','gift','2020-02-29',1,now(),now(),${owner})`;
  await sql`INSERT INTO library.progress_session(route,account_id,session_id,subject_id,version_subject_id,mode,unit,total,amount, completed_unit_count,state,library_profile_pin,revision,started_at,transaction_id) VALUES(${route},${owner},${session},${subjectIds[3]},${version},'scalar_amount','page',300,12.50,0,'active',${legacyPin},1, '2020-01-02 03:04:05.123456+00',${owner})`;
  await sql`INSERT INTO library.progress_change(route,session_id,change_no,intent,recorded_at,transaction_id) VALUES(${route},${session},1,'{"kind":"amount","amount":"12.50"}','2020-01-02 03:04:05.123456+00',${owner})`;
  await sql`INSERT INTO library.progress_session(route,account_id,session_id,subject_id,mode,unit, completed_unit_count,state,library_profile_pin,revision,started_at,transaction_id) VALUES(${route},${owner},${sparse},${subjectIds[5]},'completed_units','chapter',2,'active',${legacyPin},1,now(),${owner})`;
  await sql`INSERT INTO library.progress_unit(route,session_id,unit_id,added_at) SELECT ${route},${sparse},u,now() FROM unnest(ARRAY['chapter-1','chapter-9']) u`;
  await sql`INSERT INTO library.collection(route,collection_id,curator_account_id,title,description,visibility,state,revision,created_at,updated_at,transaction_id) VALUES(${route},${collection},${owner},'Weekend','Private notes','public','active',1,now(),now(),${owner})`;
  await sql`INSERT INTO library.collection_member(route,collection_id,member_id,subject_id,note,ordinal_key,added_at,transaction_id) VALUES
    (${route},${collection},${sourceMemberIds[0]},${subjectIds[4]},'first occurrence','a1',now(),${owner}),
    (${route},${collection},${sourceMemberIds[1]},${subjectIds[4]},'second occurrence','a0',now(),${owner})`;
  await sql`INSERT INTO library.entry(route,account_id,subject_id,state,library_profile_pin,revision,created_at,updated_at,transaction_id) VALUES(${route},${other},${subjectIds[0]},'secret-other-state',${legacyPin},1,now(),now(),${other})`;
  await sql`INSERT INTO library.bangumi_upload(route,account_id,upload_id) VALUES(${route},${owner},${copy}),(${route},${other},${copy})`;
  await sql`INSERT INTO library.bangumi_upload_row(route,account_id,upload_id,ordinal,evidence,review) VALUES(${route},${owner},${copy},0,${parseBangumiUpload('{"format":"rezics.bangumi-collection.v1","collections":[{"subject_id":42,"subject_type":2,"type":99,"rate":8,"ep_status":4,"tags":["private tag"],"comment":"source note","private":true,"custom_field":"future"}]}')[0]},'{"token":"never-export-review"}')`;
  await sql`INSERT INTO library.list_import_mal(route,account_id,id,document,expires_at) VALUES(${route},${owner},${copy},${{ rows: parseMal('<myanimelist><anime><series_animedb_id>17</series_animedb_id><series_title>Original title</series_title><my_start_date>2020-00-00</my_start_date><my_password>never-export-secret</my_password></anime></myanimelist>'), canceled: false, xml: 'never-export-raw-xml' }},now()+interval '1 day')`;
  const vndbRows = parseVndb(
    '<vndb-export version="1.0"><vns>' +
      Array.from(
        { length: 35 },
        (_, i) =>
          `<vn id="v${i + 1}"><vote>${i === 0 ? '7.5' : '0'}</vote><started>2004-02-00</started><progress>0</progress><label>Unfamiliar</label><secret>never-export-xml-secret</secret></vn>`,
      ).join('') +
      '</vns></vndb-export>',
  );
  const anilist = parseAniList(
    JSON.stringify(
      Array.from({ length: 35 }, (_, i) => ({
        mediaId: i + 1,
        score: 0,
        status: 'FUTURE_STATUS',
        startedAt: { year: 2004, month: null, day: 0 },
        notes: null,
        unfamiliar: { nested: [{ password: 'never-export-password', value: 'original unknown' }] },
      })),
    ),
    'POINT_10_DECIMAL',
  );
  await sql`INSERT INTO library.vndb_import(route,account_id,upload_id,expires_at,xml,rows) VALUES(${route},${owner},${copy},now()+interval '1 day','never-export-raw-vndb',${JSON.stringify(vndbRows)})`;
  await sql`INSERT INTO library.list_import_anilist(route,account_id,import_id,ordinal,payload) VALUES(${route},${owner},${copy},-1,${{ rawUpload: 'never-export-raw-anilist', document: { secret: 'never-export-wrapper' }, scoreFormat: anilist.scoreFormat, cancelled: true, count: anilist.rows.length }})`;
  for (const [ordinal, source] of anilist.rows.entries())
    await sql`INSERT INTO library.list_import_anilist(route,account_id,import_id,ordinal,payload) VALUES(${route},${owner},${copy},${ordinal},${{ source, review: { id: 'never-export-review-id' }, outcome: { receipt: 'never-export-receipt' } }})`;
});
afterAll(async () => {
  await workClient?.close();
  await db?.close();
});
test('native owner export streams independent persisted facts, preserves dates, and retries original identity', async () => {
  expect((await request('POST', '/v1/libraryExports', 'anonymous')).status).toBe(401);
  const original = await capture(key);
  const id = original.exportId;
  expect((await capture(key)).exportId).toBe(id);
  expect((await request('GET', `/v1/libraryExports/${id}`, 'other')).status).toBe(404);
  const records: ArchiveRecord[] = [];
  let cursor = original.first,
    final: any,
    pages = 0;
  const firstPath = `/v1/libraryExports/${id}/pages?cursor=${encodeURIComponent(cursor)}`;
  const first = await get(firstPath);
  expect(await get(firstPath)).toEqual(first);
  while (cursor) {
    const page = await get(`/v1/libraryExports/${id}/pages?cursor=${encodeURIComponent(cursor)}`);
    expect(page.records.length).toBeLessThanOrEqual(16);
    records.push(...page.records);
    cursor = page.next;
    final = page;
    pages++;
    if (cursor) expect(page.manifest).toBeNull();
    expect(pages).toBeLessThan(100);
  }
  const sections = Object.groupBy(records, (r) => r.section);
  expect(pages).toBeGreaterThan(2);
  expect(final).toMatchObject({ state: 'ready', next: null, manifest: { version: 4, fullExport: false } });
  expect(final.manifest.rows).toBe(records.length);
  expect(final.manifest.recordBytes).toBe(
    records.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record), 'utf8'), 0),
  );
  expect(sections.entries).toHaveLength(18);
  const providerRows = records as Record<string, any>[];
  expect(providerRows.filter((r) => r.section === 'vndbEvidence').map((r) => r.ordinal)).toEqual(
    Array.from({ length: 36 }, (_, i) => i),
  );
  expect(providerRows.find((r) => r.section === 'vndbEvidence')).toMatchObject({
    evidence: {
      identifier: { provider: 'vndb', value: 'v1' },
      fields: {
        score: { kind: 'value', raw: '7.5', value: 7.5, scale: { min: 1, max: 10, step: 0.1 } },
        finished: { kind: 'missing', raw: null },
        started: { value: '2004-02', precision: 'month' },
        progress: { raw: '0' },
      },
    },
  });
  expect(providerRows.filter((r) => r.section === 'anilistEvidence').map((r) => r.ordinal)).toEqual(
    Array.from({ length: 35 }, (_, i) => i),
  );
  expect(providerRows.find((r) => r.section === 'anilistUploads')).toMatchObject({
    score_format: 'POINT_10_DECIMAL',
    cancelled: true,
    row_count: 35,
  });
  expect(providerRows.find((r) => r.section === 'anilistEvidence')).toMatchObject({
    evidence: {
      identifiers: [{ source: 'anilist', externalId: '1' }],
      evidence: {
        score: 0,
        status: 'FUTURE_STATUS',
        notes: null,
        startedAt: { year: 2004, month: null, day: 0 },
        unfamiliar: { nested: [{ value: 'original unknown' }] },
      },
    },
  });
  for (const section of ['vndbUploads', 'vndbEvidence', 'anilistUploads', 'anilistEvidence'])
    expect(final.manifest.sectionTotals[section].rows).toBe(providerRows.filter((r) => r.section === section).length);

  expect(records.find((r) => r.state === 'old-unknown-state')).toMatchObject({
    library_profile_pin: legacyPin,
    subject_id_reference: { id: subjectIds[0], href: `https://rezics.com/subjects/${subjectIds[0]}` },
  });
  expect(sections.holdings?.[0]).toMatchObject({ copy_id: copy, note: 'signed copy', acquired_on: '2020-02-29' });
  expect(sections.sessions?.find((r) => r.session_id === session)).toMatchObject({
    session_id: session,
    amount: '12.50',
    total: '300',
    position: null,
    completed_unit_count: 0,
    version_subject_id: version,
    started_at: '2020-01-02 03:04:05.123456+00',
  });
  expect(sections.history?.[0]).toMatchObject({ intent: { kind: 'amount', amount: '12.50' } });
  expect(sections.occurrences?.map((r) => r.note).sort()).toEqual(['first occurrence', 'second occurrence']);
  expect(sections.assignments?.[0]).toMatchObject({ label_id: label, subject_id: subjectIds[1] });
  expect(sections.units?.map((r) => r.unit_id)).toEqual(['chapter-1', 'chapter-9']);
  expect(JSON.stringify(records)).not.toContain('secret-other-state');
  expect(JSON.stringify(records)).not.toMatch(/transaction_id|never-export-/);
  expect(sections.bangumiEvidence?.[0]).toMatchObject({
    evidence: {
      source: {
        subject_id: 42,
        subject_type: 2,
        type: 99,
        rate: 8,
        ep_status: 4,
        tags: ['private tag'],
        comment: 'source note',
        private: true,
        custom_field: 'future',
      },
    },
  });
  expect(sections.malEvidence?.[0]).toMatchObject({ evidence: { identifier: { value: '17' } } });
  expect(sections.malEvidence?.[0]).toMatchObject({ evidence: { dates: { started: { precision: 'year' } } } });
  expect(
    decodeLibraryArchive(Buffer.from(JSON.stringify({ manifest: final.manifest, records }))).manifest.version,
  ).toBe(4);
  const archiveRecords = records.filter((record) =>
    exportSections.includes(record.section as (typeof exportSections)[number]),
  );
  const archiveManifest = {
    ...libraryExportManifest({
      export_id: id,
      created_at: final.manifest.capturedAt,
      expires_at: final.manifest.expiresAt,
      format_version: 1,
    }),
    fullExport: false as const,
    rows: archiveRecords.length,
    recordBytes: archiveRecords.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record), 'utf8'), 0),
  };
  const v2Records = records.filter((record) =>
    exportSectionsV2.includes(record.section as (typeof exportSectionsV2)[number]),
  );
  const v2Manifest = {
    ...libraryExportManifest({
      export_id: id,
      created_at: final.manifest.capturedAt,
      expires_at: final.manifest.expiresAt,
      format_version: 2,
    }),
    fullExport: false,
    rows: v2Records.length,
    recordBytes: v2Records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0),
    sectionTotals: Object.fromEntries(
      exportSectionsV2.map((section) => {
        const rows = v2Records.filter((r) => r.section === section);
        return [
          section,
          { rows: rows.length, recordBytes: rows.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0) },
        ];
      }),
    ),
  };
  expect(
    decodeLibraryArchive(Buffer.from(JSON.stringify({ manifest: v2Manifest, records: v2Records }))).manifest.version,
  ).toBe(2);
  const decoded = decodeLibraryArchive(
    Buffer.from(JSON.stringify({ manifest: archiveManifest, records: archiveRecords })),
  );
  expect<unknown>(decoded.records).toEqual(archiveRecords);
  expect(decoded.coverage.find((s) => s.section === 'entries')).toMatchObject({
    rows: 18,
    capture: 'present',
    treatment: 'requires-explicit-mapping',
  });
  expect(decoded.coverage.find((s) => s.section === 'sessions')).toMatchObject({
    rows: 2,
    capture: 'present',
    treatment: 'retained-unsupported',
  });
  expect(decoded.fullRestoration).toBe(false);

  await fixture.grant({ route, id: subjectIds[4]! }, 'owner', 'subject:read');
  const archiveBase64 = Buffer.from(JSON.stringify({ manifest: archiveManifest, records: archiveRecords })).toString(
    'base64',
  );
  const client = createKernelClient('http://kernel.test', {
    headers: { authorization: `Bearer ${fixture.bearer('owner')}` },
    fetch: (async (input, init) => app.handle(new Request(input, init))) as typeof fetch,
  });
  const uploaded = await client.libraryArchiveCollectionRecoveries.post(
    { archiveBase64 },
    { headers: { 'idempotency-key': JSON.stringify(randomUUID()) } },
  );
  if (uploaded.error) throw uploaded.error;
  if (!uploaded.data) throw new Error('Archive recovery upload returned no status');
  recoveryUploadId = uploaded.data.uploadId;
  expect(uploaded.data.state).toBe('preview');
  const listed = await client.libraryArchiveCollectionRecoveries({ id: recoveryUploadId }).collections.get({
    query: { limit: 50 },
  });
  if (listed.error) throw listed.error;
  if (!listed.data) throw new Error('Archive recovery list returned no page');
  const source = listed.data.collections.find((candidate) => candidate.id === collection);
  expect(source).toMatchObject({
    eligible: true,
    membershipComplete: true,
    orderComplete: true,
    visibilityDisposition: 'will_be_private',
  });
  const occurrencePage = await client
    .libraryArchiveCollectionRecoveries({ id: recoveryUploadId })
    .collections({ collectionId: collection })
    .occurrences.get({ query: { limit: 50 } });
  if (occurrencePage.error) throw occurrencePage.error;
  if (!occurrencePage.data) throw new Error('Archive recovery occurrence page returned no data');
  expect(occurrencePage.data.occurrences.map((item) => item.note)).toEqual(['second occurrence', 'first occurrence']);
  expect(occurrencePage.data.occurrences.map((item) => item.sourceOccurrenceId)).toEqual([
    sourceMemberIds[1]!,
    sourceMemberIds[0]!,
  ]);
  const reviewed = await client.libraryArchiveCollectionRecoveries({ id: recoveryUploadId }).review.post(
    {
      collectionId: collection,
      selectedOccurrenceIds: occurrencePage.data.occurrences.map((item) => item.sourceOccurrenceId),
      mappings: [{ sourceSubjectId: subjectIds[4]!, targetSubjectId: subjectIds[4]! }],
    },
    { headers: { 'idempotency-key': JSON.stringify(randomUUID()) } },
  );
  if (reviewed.error) throw reviewed.error;
  if (!reviewed.data?.confirmation) throw new Error('Archive recovery review returned no confirmation');
  expect(reviewed.data.review).toMatchObject({ completeMembership: true, completeOrder: true });
  const applied = await client.libraryArchiveCollectionRecoveries({ id: recoveryUploadId }).apply.post({
    reviewId: reviewed.data.confirmation.reviewId,
    digest: reviewed.data.confirmation.digest,
  });
  if (applied.error) throw applied.error;
  const outcomes = await client.libraryArchiveCollectionRecoveries({ id: recoveryUploadId }).outcomes.get({
    query: { limit: 50 },
  });
  if (outcomes.error) throw outcomes.error;
  if (!outcomes.data) throw new Error('Archive recovery outcomes returned no page');
  if (applied.data?.state !== 'complete')
    throw new Error(`Recovery state ${applied.data?.state}: ${JSON.stringify(outcomes.data.outcomes)}`);
  expect(outcomes.data.outcomes.map((item) => item.outcome)).toEqual(['applied', 'applied']);
  expect(outcomes.data.outcomes.map((item) => item.note)).toEqual(['second occurrence', 'first occurrence']);
  const recoveredId = applied.data?.collectionId;
  expect(recoveredId).toBeString();
  expect(recoveredId).not.toBe(collection);
  const recovered = await get(`/v1/collections/${recoveredId}?view=FULL`);
  expect(recovered.collection).toMatchObject({ id: recoveredId, title: 'Weekend', visibility: 'private' });
  const recoveredMembers = await get(`/v1/collections/${recoveredId}/members?limit=20`);
  expect(
    recoveredMembers.members.map((member: { subjectId: string; note: string | null }) => [
      member.subjectId,
      member.note,
    ]),
  ).toEqual([
    [subjectIds[4], 'second occurrence'],
    [subjectIds[4], 'first occurrence'],
  ]);
  expect((await request('GET', `/v1/libraryArchiveCollectionRecoveries/${recoveryUploadId}`, 'other')).status).toBe(
    404,
  );

  const recoveryAccess = fixture.access({
    actions: new Map([...scopes.map((action) => [action, { anonymous: false }] as const), ...LIFECYCLE_ACTIONS]),
  });
  const ownerActor = await recoveryAccess.authenticate(fixture.bearer('owner'), {
    pool: db.pool,
    deadline: Date.now() + 10_000,
  });
  const failedEffects = new Set(['create', 'member', 'order']);
  const replayService = createLibraryArchiveCollectionRecovery({
    pool: db.pool,
    access: recoveryAccess,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) },
    routeKey,
    clock: () => new Date(now),
    afterNativeEffect: async (kind) => {
      if (failedEffects.delete(kind)) throw new Error(`lost acknowledgement after ${kind}`);
    },
  });
  const directUpload = await replayService.create(ownerActor, archiveBase64, randomUUID());
  const directCollections = await replayService.listCollections(ownerActor, directUpload.uploadId, { limit: 50 });
  const directPreview = await replayService.previewCollection(ownerActor, directUpload.uploadId, collection, {
    limit: 50,
  });
  const selectedOccurrences = directPreview.occurrences.map((item) => item.sourceOccurrenceId);
  const sourceMapping = [{ sourceSubjectId: subjectIds[4]!, targetSubjectId: subjectIds[4]! }];
  const oldReview = await replayService.review(
    ownerActor,
    directUpload.uploadId,
    { collectionId: collection, selectedOccurrenceIds: selectedOccurrences, mappings: sourceMapping },
    randomUUID(),
  );
  const changedReview = await replayService.review(
    ownerActor,
    directUpload.uploadId,
    {
      collectionId: collection,
      selectedOccurrenceIds: selectedOccurrences,
      mappings: [{ sourceSubjectId: subjectIds[4]!, targetSubjectId: null }],
    },
    randomUUID(),
  );
  expect(changedReview.mappings[0]?.state).toBe('unresolved');
  await expect(replayService.apply(ownerActor, directUpload.uploadId, oldReview.confirmation!)).rejects.toThrow();
  const finalReview = await replayService.review(
    ownerActor,
    directUpload.uploadId,
    { collectionId: collection, selectedOccurrenceIds: selectedOccurrences, mappings: sourceMapping },
    randomUUID(),
  );
  const confirmation = finalReview.confirmation!;
  const beforeCollectionIds = new Set(
    (
      await sql`SELECT collection_id::text FROM library.collection
    WHERE route=${route} AND curator_account_id=${owner} AND title='Weekend'`
    ).rows.map((row) => row.collection_id),
  );
  let replayedCollectionId: string | null = null;
  let acknowledgedMemberId: string | null = null;
  for (const kind of ['create', 'member', 'order']) {
    await expect(replayService.apply(ownerActor, directUpload.uploadId, confirmation)).rejects.toThrow(
      `lost acknowledgement after ${kind}`,
    );
    if (kind === 'create') {
      const afterCreate = (
        await sql`SELECT collection_id::text FROM library.collection
        WHERE route=${route} AND curator_account_id=${owner} AND title='Weekend'`
      ).rows;
      const created = afterCreate.map((row) => row.collection_id).filter((id) => !beforeCollectionIds.has(id));
      expect(created).toHaveLength(1);
      replayedCollectionId = created[0]!;
    } else if (kind === 'member') {
      const accepted = await sql`SELECT member_id::text FROM library.collection_member
        WHERE route=${route} AND collection_id=${replayedCollectionId} AND deletion_id IS NULL`;
      expect(accepted.rows).toHaveLength(1);
      acknowledgedMemberId = accepted.rows[0]!.member_id;
    }
  }
  const replayed = await replayService.apply(ownerActor, directUpload.uploadId, confirmation);
  expect(replayed.state).toBe('complete');
  expect(replayed.collectionId).toBe(replayedCollectionId);
  const replayOutcomes = await replayService.outcomes(ownerActor, directUpload.uploadId, { limit: 50 });
  expect(replayOutcomes.outcomes.map((item) => item.nativeMemberId)).toContain(acknowledgedMemberId);
  const replayMembers = await sql`SELECT member_id::text AS id,subject_id::text AS subject_id,note
    FROM library.collection_member WHERE route=${route} AND collection_id=${replayedCollectionId} AND deletion_id IS NULL
    ORDER BY ordinal_key COLLATE "C",member_id`;
  expect(replayMembers.rows).toHaveLength(2);
  expect(replayMembers.rows.map((member) => [member.subject_id, member.note])).toEqual([
    [subjectIds[4], 'second occurrence'],
    [subjectIds[4], 'first occurrence'],
  ]);
  expect(directCollections.collections.find((item) => item.id === collection)?.eligible).toBe(true);

  await fixture.grant({ route, id: subjectIds[4]! }, 'other', 'subject:read');
  const otherActor = await recoveryAccess.authenticate(fixture.bearer('other'), {
    pool: db.pool,
    deadline: Date.now() + 10_000,
  });
  let otherNow = now;
  const otherService = createLibraryArchiveCollectionRecovery({
    pool: db.pool,
    access: recoveryAccess,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) },
    routeKey,
    clock: () => new Date(otherNow),
  });
  const noteRecords = archiveRecords.map((record) => {
    if (record.section !== 'occurrences') return record;
    if (record.member_id === sourceMemberIds[0]) {
      const { note: _note, ...missing } = record;
      return missing;
    }
    return record.member_id === sourceMemberIds[1] ? { ...record, note: null } : record;
  });
  const archiveForOther = (archiveRecords: ArchiveRecord[]) => {
    const manifest = {
      ...archiveManifest,
      rows: archiveRecords.length,
      recordBytes: archiveRecords.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record)), 0),
    };
    return Buffer.from(JSON.stringify({ manifest, records: archiveRecords })).toString('base64');
  };
  const noteUpload = await otherService.create(otherActor, archiveForOther(noteRecords), randomUUID());
  const notePreview = await otherService.previewCollection(otherActor, noteUpload.uploadId, collection, { limit: 50 });
  expect(notePreview.occurrences.map((item) => item.noteState)).toEqual(['cleared', 'missing']);
  const noteReview = await otherService.review(
    otherActor,
    noteUpload.uploadId,
    {
      collectionId: collection,
      selectedOccurrenceIds: notePreview.occurrences.map((item) => item.sourceOccurrenceId),
      mappings: sourceMapping,
    },
    randomUUID(),
  );
  const noteApplied = await otherService.apply(otherActor, noteUpload.uploadId, noteReview.confirmation!);
  expect(noteApplied.state).toBe('partial');
  const noteOutcomes = await otherService.outcomes(otherActor, noteUpload.uploadId, { limit: 50 });
  expect(noteOutcomes.outcomes.map((item) => [item.sourceNoteState, item.noteState])).toEqual([
    ['cleared', 'applied'],
    ['missing', 'unsupported'],
  ]);
  const noteMembers = await request(
    'GET',
    `/v1/collections/${noteApplied.collectionId}/members?limit=20`,
    'other',
  ).then(json);
  expect(noteMembers.members.map((member: { note: string | null }) => member.note)).toEqual([null, null]);

  let boundaryNow = otherNow;
  let boundaryUploadId = '';
  let boundaryExpiry = '';
  let boundaryConfirmation = { reviewId: '', digest: '' };
  let loseBoundaryAcknowledgement = false;
  let boundaryService: ReturnType<typeof createLibraryArchiveCollectionRecovery>;
  boundaryService = createLibraryArchiveCollectionRecovery({
    pool: db.pool,
    access: recoveryAccess,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) },
    routeKey,
    clock: () => new Date(boundaryNow),
    afterNativeEffect: async (kind) => {
      if (kind !== 'member' || !loseBoundaryAcknowledgement) return;
      loseBoundaryAcknowledgement = false;
      boundaryNow = Date.parse(boundaryExpiry) + 1;
      expect((await boundaryService.status(otherActor, boundaryUploadId)).state).toBe('expired');
      const lease = await sql`SELECT lease_until::text AS lease,expires_at::text AS expiry
        FROM library.collection_archive_recovery WHERE route=${route} AND account_id=${other}
          AND upload_id=${boundaryUploadId}`;
      expect(Date.parse(lease.rows[0]!.lease)).toBeLessThanOrEqual(Date.parse(lease.rows[0]!.expiry));
      expect((await boundaryService.apply(otherActor, boundaryUploadId, boundaryConfirmation)).state).toBe('expired');
      throw new Error('lost acknowledgement at Collection expiry boundary');
    },
  });
  const boundaryUpload = await boundaryService.create(otherActor, archiveForOther(archiveRecords), randomUUID());
  boundaryUploadId = boundaryUpload.uploadId;
  boundaryExpiry = boundaryUpload.expiresAt;
  const boundaryPreview = await boundaryService.previewCollection(otherActor, boundaryUploadId, collection, {
    limit: 50,
  });
  const boundaryReview = await boundaryService.review(
    otherActor,
    boundaryUploadId,
    {
      collectionId: collection,
      selectedOccurrenceIds: boundaryPreview.occurrences.map((item) => item.sourceOccurrenceId),
      mappings: sourceMapping,
    },
    randomUUID(),
  );
  boundaryConfirmation = boundaryReview.confirmation!;
  const beforeBoundaryCollections = new Set(
    (
      await sql`SELECT collection_id::text FROM library.collection
        WHERE route=${route} AND curator_account_id=${other} AND title='Weekend'`
    ).rows.map((row) => row.collection_id),
  );
  boundaryNow = Date.parse(boundaryExpiry) - 60_000;
  loseBoundaryAcknowledgement = true;
  await expect(boundaryService.apply(otherActor, boundaryUploadId, boundaryConfirmation)).rejects.toThrow(
    'lost acknowledgement at Collection expiry boundary',
  );
  const afterBoundaryCollections = await sql`SELECT collection_id::text AS id FROM library.collection
    WHERE route=${route} AND curator_account_id=${other} AND title='Weekend'`;
  const boundaryCollectionId = afterBoundaryCollections.rows
    .map((row) => row.id)
    .find((id) => !beforeBoundaryCollections.has(id));
  expect(boundaryCollectionId).toBeString();
  const boundaryMembers = await sql`SELECT member_id::text AS id,note FROM library.collection_member
    WHERE route=${route} AND collection_id=${boundaryCollectionId} AND deletion_id IS NULL`;
  expect(boundaryMembers.rows).toHaveLength(1);
  expect(boundaryMembers.rows[0]!.note).toBeNull();
  expect(
    (
      await sql`SELECT 1 FROM library.collection_archive_recovery_record
        WHERE route=${route} AND account_id=${other} AND upload_id=${boundaryUploadId}`
    ).rowCount,
  ).toBe(0);
  await boundaryService.create(otherActor, archiveForOther(archiveRecords), randomUUID());
  expect(
    (
      await sql`SELECT 1 FROM library.collection_archive_recovery
        WHERE route=${route} AND account_id=${other} AND upload_id=${boundaryUploadId}`
    ).rowCount,
  ).toBe(0);

  otherNow = Date.parse(noteUpload.expiresAt) + 1;
  expect((await otherService.status(otherActor, noteUpload.uploadId)).state).toBe('expired');
  expect(
    (
      await sql`SELECT 1 FROM library.collection_archive_recovery_record
    WHERE route=${route} AND account_id=${other} AND upload_id=${noteUpload.uploadId}`
    ).rowCount,
  ).toBe(0);

  const sourceCollectionRecord = archiveRecords.find(
    (record) => record.section === 'collections' && record.collection_id === collection,
  )!;
  const dynamicCollectionId = newId(route);
  const builtinCollectionId = newId(route);
  const extraCollections = [
    { ...sourceCollectionRecord, collection_id: dynamicCollectionId, title: 'Saved rule', membership_kind: 'dynamic' },
    {
      ...sourceCollectionRecord,
      collection_id: builtinCollectionId,
      title: 'Built in',
      membership_kind: 'curated',
      builtin_kind: 'seeded',
    },
  ];
  const cancellationRecords = archiveRecords.flatMap((record) =>
    record === sourceCollectionRecord ? [record, ...extraCollections] : [record],
  );
  let cancellationUploadId = '';
  let cancellationSent = false;
  let cancelService: ReturnType<typeof createLibraryArchiveCollectionRecovery>;
  cancelService = createLibraryArchiveCollectionRecovery({
    pool: db.pool,
    access: recoveryAccess,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) },
    routeKey,
    clock: () => new Date(otherNow),
    afterNativeEffect: async (kind) => {
      if (kind === 'member' && !cancellationSent) {
        cancellationSent = true;
        await cancelService.cancel(otherActor, cancellationUploadId);
      }
    },
  });
  const cancellationUpload = await cancelService.create(otherActor, archiveForOther(cancellationRecords), randomUUID());
  cancellationUploadId = cancellationUpload.uploadId;
  const cancellationList = await cancelService.listCollections(otherActor, cancellationUploadId, { limit: 50 });
  expect(cancellationList.collections.find((item) => item.id === dynamicCollectionId)?.unsupported).toBe(
    'dynamic_membership_not_restored',
  );
  expect(cancellationList.collections.find((item) => item.id === builtinCollectionId)?.unsupported).toBe(
    'built_in_not_restored',
  );
  const cancellationPreview = await cancelService.previewCollection(otherActor, cancellationUploadId, collection, {
    limit: 50,
  });
  const cancellationReview = await cancelService.review(
    otherActor,
    cancellationUploadId,
    {
      collectionId: collection,
      selectedOccurrenceIds: cancellationPreview.occurrences.map((item) => item.sourceOccurrenceId),
      mappings: sourceMapping,
    },
    randomUUID(),
  );
  const cancelled = await cancelService.apply(otherActor, cancellationUploadId, cancellationReview.confirmation!);
  expect(cancelled).toMatchObject({ state: 'cancelled', cancelRequested: true });
  if (!cancelled.collectionId) throw new Error('Cancelled recovery did not retain its Collection ID');
  expect(cancelled.collectionId).toBeString();
  const cancelledOutcomes = await cancelService.outcomes(otherActor, cancellationUploadId, { limit: 50 });
  expect(cancelledOutcomes.outcomes.filter((item) => item.addState === 'applied')).toHaveLength(1);
  expect(cancelledOutcomes.outcomes.filter((item) => item.addState === 'pending')).toHaveLength(1);
  const cancelledMembers = await request(
    'GET',
    `/v1/collections/${cancelled.collectionId}/members?limit=20`,
    'other',
  ).then(json);
  expect(cancelledMembers.members).toHaveLength(1);

  // The accepted recovered Collection advances native owner source and invalidates this older export.
  expect((await get(`/v1/libraryExports/${id}`)).state).toBe('stale');
  await sql`UPDATE library.collection_member SET note='edited' WHERE route=${route} AND collection_id=${collection}`;
  expect(await get(firstPath)).toMatchObject({ state: 'stale', records: [], manifest: null });
});
test('provider changes, expiry and completed-request replay cannot deliver a different population', async () => {
  for (const mutation of [
    () => sql`UPDATE library.vndb_import SET state='cancelled' WHERE route=${route} AND account_id=${owner}`,
    () =>
      sql`UPDATE library.vndb_import_row SET evidence=evidence||'{"extra":0}' WHERE route=${route} AND account_id=${owner} AND ordinal=0`,
    () =>
      sql`UPDATE library.list_import_anilist SET payload=jsonb_set(payload,'{cancelled}','false') WHERE route=${route} AND account_id=${owner} AND ordinal=-1`,
    () => sql`DELETE FROM library.list_import_anilist WHERE route=${route} AND account_id=${owner} AND ordinal=34`,
  ]) {
    await sql`UPDATE library.library_export SET state='stale' WHERE route=${route} AND account_id=${owner}`;
    const key = randomUUID(),
      original = await capture(key);
    const path = `/v1/libraryExports/${original.exportId}/pages?cursor=${encodeURIComponent(original.first)}`;
    expect((await get(path)).next).toBeString();
    await mutation();
    expect(await capture(key)).toMatchObject({ exportId: original.exportId, state: 'stale', first: null });
    expect(await get(path)).toMatchObject({ state: 'stale', records: [], manifest: null, next: null });
  }
  await sql`UPDATE library.vndb_import SET expires_at=${new Date(now + 1000).toISOString()} WHERE route=${route} AND account_id=${owner}`;
  const key = randomUUID(),
    original = await capture(key);
  let cursor = original.first;
  while (cursor) {
    const page = await get(`/v1/libraryExports/${original.exportId}/pages?cursor=${encodeURIComponent(cursor)}`);
    cursor = page.next;
  }
  now += 2000;
  expect(await capture(key)).toMatchObject({ exportId: original.exportId, state: 'stale', first: null });
  expect(
    await get(`/v1/libraryExports/${original.exportId}/pages?cursor=${encodeURIComponent(original.first)}`),
  ).toMatchObject({ state: 'stale', records: [], manifest: null });
  now -= 2000;
  await sql`DELETE FROM library.vndb_import WHERE route=${route} AND account_id=${owner}`;
  expect((await sql`SELECT 1 FROM library.vndb_import_row WHERE route=${route} AND account_id=${owner}`).rowCount).toBe(
    0,
  );
  // A fresh capture declares exhausted, empty VNDB sections explicitly.
  const empty = await capture();
  let page: any,
    next = empty.first;
  do {
    page = await get(`/v1/libraryExports/${empty.exportId}/pages?cursor=${encodeURIComponent(next)}`);
    next = page.next;
  } while (next);
  expect(page.manifest.sectionTotals.vndbEvidence).toEqual({ rows: 0, recordBytes: 0 });
  await json(await request('DELETE', `/v1/libraryExports/${empty.exportId}`));
});

test('provider encoded-row limits include nested evidence and escaped UTF-8', async () => {
  const section = exportSectionsV4.indexOf('anilistEvidence');
  const seek = { ...initialExportSeek(4), section, parent: copy };
  const client = {
    query: async () => ({
      rows: [
        { value: { key: '0', upload_id: copy, ordinal: 0, evidence: { evidence: { notes: '\u0001'.repeat(11000) } } } },
      ],
    }),
  };
  const page = await readExportSourcePage(client as any, route, owner, seek, new Date(now).toISOString(), 4);
  expect(page).toMatchObject({ records: [], oversized: true });
});

test('version 4 streams annotations, accepted provenance and addressed live journals as independent facts', async () => {
  const annotationSubject = subjectIds[16]!;
  const provenanceSubject = subjectIds[15]!;
  const annotationWrite = await command('PUT', `/v1/libraryEntries/${annotationSubject}/annotations`, {
    revision: 0,
    note: { op: 'set', value: 'Keep this private note.' },
    priority: { op: 'set', value: 42 },
  });
  expect((await json(annotationWrite)).personalEntry).toMatchObject({
    annotationRevision: 1,
    note: 'Keep this private note.',
    priority: 42,
  });
  const provenanceWrite = await command('POST', `/v1/libraryEntries/${provenanceSubject}/sourceObservations`, {
    provider: 'reader-list',
    recordId: 'row-17',
    confirmReviewed: true,
    privacy: { status: 'known', meaning: 'source_visible' },
    sourceCreated: { status: 'known', value: '2004-02' },
    sourceUpdated: { status: 'unknown', sourceValue: 'not-a-date' },
  });
  const admittedObservation = (await json(provenanceWrite, 201)).sourceObservation;
  expect(admittedObservation).toMatchObject({
    provider: 'reader-list',
    recordId: 'row-17',
    revision: 1,
    privacy: { status: 'known', meaning: 'source_visible' },
    sourceCreated: { status: 'known', value: '2004-02', precision: 'month', zone: 'unknown' },
    sourceUpdated: { status: 'unknown', sourceValue: 'not-a-date' },
  });
  const journalWrite = await command('PATCH', `/v1/progressSessions/${session}/journal`, {
    revision: 0,
    startDate: { year: 2004, month: 2 },
    finishDate: { year: 2023, month: 7, day: 11 },
    reflection: 'Revisited before summer.',
    assessment: { units: 0 },
  });
  expect((await json(journalWrite)).journal).toMatchObject({ sessionId: session, revision: 1, changed: true });

  const requestKey = randomUUID();
  const captureStatus = await capture(requestKey);
  expect(captureStatus).toMatchObject({ version: 4, fullExport: false });
  expect(captureStatus.sections.slice(14, 17)).toEqual(['annotations', 'provenance', 'journals']);
  const firstPath = `/v1/libraryExports/${captureStatus.exportId}/pages?cursor=${encodeURIComponent(captureStatus.first)}`;
  const first = await get(firstPath);
  expect(await get(firstPath)).toEqual(first);
  const records: Record<string, any>[] = [...first.records];
  let final = first;
  let cursor = first.next;
  while (cursor) {
    final = await get(`/v1/libraryExports/${captureStatus.exportId}/pages?cursor=${encodeURIComponent(cursor)}`);
    records.push(...final.records);
    if (final.next) expect(final.manifest).toBeNull();
    cursor = final.next;
  }
  expect(final).toMatchObject({ state: 'ready', next: null, manifest: { version: 4, fullExport: false } });
  expect(final.manifest.rows).toBe(records.length);
  expect(final.manifest.recordBytes).toBe(
    records.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record), 'utf8'), 0),
  );
  for (const section of final.manifest.sections) {
    const sectionRecords = records.filter((record) => record.section === section);
    expect(final.manifest.sectionTotals[section]).toEqual({
      rows: sectionRecords.length,
      recordBytes: sectionRecords.reduce(
        (bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record), 'utf8'),
        0,
      ),
    });
  }
  const annotation = records.find(
    (record) => record.section === 'annotations' && record.subjectId === annotationSubject,
  );
  const entry = await sql`SELECT incarnation_id::text AS id,library_profile_pin FROM library.entry
    WHERE route=${route} AND account_id=${owner} AND subject_id=${annotationSubject}`;
  expect(annotation).toMatchObject({
    accountId: owner,
    annotationRevision: 1,
    note: 'Keep this private note.',
    priority: 42,
    entryIncarnationId: entry.rows[0]!.id,
    libraryProfilePin: legacyPin,
  });
  expect(records.some((record) => record.section === 'provenance' && record.subjectId === annotationSubject)).toBe(
    false,
  );
  const provenance = records.find(
    (record) => record.section === 'provenance' && record.subjectId === provenanceSubject,
  );
  expect(provenance).toMatchObject({
    accountId: owner,
    observation: {
      provider: 'reader-list',
      recordId: 'row-17',
      revision: 1,
      privacy: { status: 'known', meaning: 'source_visible' },
      sourceCreated: { status: 'known', value: '2004-02', precision: 'month', zone: 'unknown' },
      sourceUpdated: { status: 'unknown', sourceValue: 'not-a-date' },
      recordedAt: expect.any(String),
    },
  });
  expect(provenance!.observation.recordedAt).not.toBe(provenance!.observation.sourceCreated.value);
  expect(provenance!.observation.recordedAt).toBe(admittedObservation.recordedAt);
  const journal = records.find((record) => record.section === 'journals' && record.sessionId === session);
  expect(journal).toMatchObject({
    accountId: owner,
    progressRevision: 1,
    libraryProfilePin: legacyPin,
    journal: {
      sessionId: session,
      revision: 1,
      startDate: { year: 2004, month: 2 },
      finishDate: { year: 2023, month: 7, day: 11 },
      reflection: 'Revisited before summer.',
      assessment: { meaningRevision: 1, units: 0 },
    },
  });
  expect(records.some((record) => record.section === 'annotations' && record.subjectId === journal!.subjectId)).toBe(
    false,
  );

  const captureReplay = await capture(requestKey);
  expect(captureReplay).toMatchObject({ exportId: captureStatus.exportId, expiresAt: captureStatus.expiresAt });
  expect(captureReplay.first).toBe(captureStatus.first);
  const annotationClear = await command('PUT', `/v1/libraryEntries/${annotationSubject}/annotations`, {
    revision: 1,
    note: { op: 'clear' },
    priority: { op: 'unchanged' },
  });
  expect((await json(annotationClear)).personalEntry.annotationRevision).toBe(2);
  const journalClear = await command('PATCH', `/v1/progressSessions/${session}/journal`, {
    revision: 1,
    startDate: null,
    finishDate: null,
    reflection: null,
  });
  expect((await json(journalClear)).journal).toMatchObject({ revision: 2, changed: true });
  expect((await get(`/v1/libraryExports/${captureStatus.exportId}`)).state).toBe('stale');
  expect(await capture(requestKey)).toMatchObject({
    exportId: captureStatus.exportId,
    expiresAt: captureStatus.expiresAt,
    state: 'stale',
  });
  expect(await get(firstPath)).toMatchObject({ state: 'stale', records: [], next: null, manifest: null });
});

test('stored V3 keeps its assessment sections and provider oversize refuses the final artifact', async () => {
  const old = await capture();
  await sql`UPDATE library.library_export SET format_version=3 WHERE route=${route} AND account_id=${owner}`;
  const status = await get(`/v1/libraryExports/${old.exportId}`);
  expect(status).toMatchObject({ version: 3, sections: expect.arrayContaining(['journals']) });
  expect(status.sections).toHaveLength(17);
  let cursor = status.first,
    last: any;
  while (cursor) {
    last = await get(`/v1/libraryExports/${old.exportId}/pages?cursor=${encodeURIComponent(cursor)}`);
    cursor = last.next;
  }
  expect(last.manifest).toMatchObject({ version: 3, rows: expect.any(Number) });
  expect(Object.keys(last.manifest.sectionTotals)).toHaveLength(17);
  await json(await request('DELETE', `/v1/libraryExports/${old.exportId}`));
  const evidence = { notes: '\u0001'.repeat(11000) };
  for (const provider of ['vndb', 'anilist']) {
    if (provider === 'vndb')
      await sql`INSERT INTO library.vndb_import(route,account_id,upload_id,expires_at,xml,rows)
        VALUES(${route},${owner},${copy},now()+interval '1 day','inert',${JSON.stringify([evidence])})`;
    else
      await sql`UPDATE library.list_import_anilist SET payload=jsonb_set(payload,'{source}',${evidence}::jsonb)
        WHERE route=${route} AND account_id=${owner} AND ordinal=0`;
    const start = await capture();
    let next = start.first,
      page: any;
    do {
      page = await get(`/v1/libraryExports/${start.exportId}/pages?cursor=${encodeURIComponent(next)}`);
      next = page.next;
    } while (next);
    expect(page).toMatchObject({ state: 'limit', records: [], manifest: null });
    expect(await capture()).toMatchObject({ state: 'collecting' });
    await sql`UPDATE library.library_export SET state='cancelled' WHERE route=${route} AND account_id=${owner}`;
    if (provider === 'vndb')
      await sql`UPDATE library.vndb_import SET rows='[]' WHERE route=${route} AND account_id=${owner}`;
    else
      await sql`UPDATE library.list_import_anilist SET payload='{"source":{}}' WHERE route=${route} AND account_id=${owner} AND ordinal=0`;
  }
});

test('cancellation, changed revisions, expiry and terminal deletion never yield success artifacts', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const abortKey = randomUUID();
  const beforeExport =
    await sql`SELECT export_id::text AS id,state FROM library.library_export WHERE route=${route} AND account_id=${owner}`;
  const beforeReceipts = await sql`SELECT count(*)::int AS count FROM core.receipt
    WHERE principal_id=${owner} AND command_kind='library.export.capture'`;
  const beforeEvents = await sql`SELECT count(*)::int AS count FROM core.outbox
    WHERE type='com.rezics.library.export.requested.v1' AND subject=${owner}`;
  const cancelledRequest = await request('POST', '/v1/libraryExports', 'owner', abortKey, aborted.signal).catch(
    () => null,
  );
  expect(cancelledRequest === null || cancelledRequest.status >= 400 || (await cancelledRequest.text()) === '').toBe(
    true,
  );
  expect(
    (
      await sql`SELECT export_id::text AS id,state FROM library.library_export WHERE route=${route} AND account_id=${owner}`
    ).rows,
  ).toEqual(beforeExport.rows);
  expect(
    (
      await sql`SELECT count(*)::int AS count FROM core.receipt
    WHERE principal_id=${owner} AND command_kind='library.export.capture'`
    ).rows,
  ).toEqual(beforeReceipts.rows);
  expect(
    (
      await sql`SELECT count(*)::int AS count FROM core.outbox
    WHERE type='com.rezics.library.export.requested.v1' AND subject=${owner}`
    ).rows,
  ).toEqual(beforeEvents.rows);
  const cancelled = await capture();
  const path = `/v1/libraryExports/${cancelled.exportId}`;
  expect((await request('GET', `${path}/pages?cursor=forged`)).status).toBe(400);
  await json(await request('DELETE', path));
  const cancelledPage = await get(`${path}/pages?cursor=${encodeURIComponent(cancelled.first)}`);
  expect(cancelledPage).toMatchObject({ state: 'cancelled', records: [], next: null, manifest: null });
  const newer = await capture();
  expect((await request('POST', '/v1/libraryExports', 'owner', randomUUID())).status).toBe(409);
  const newerPath = `/v1/libraryExports/${newer.exportId}`;
  expect((await request('GET', `${newerPath}/pages?cursor=${encodeURIComponent(cancelled.first)}`)).status).toBe(400);
  await sql`UPDATE library.entry SET revision=revision+1 WHERE route=${route} AND account_id=${owner} AND subject_id=${subjectIds[0]}`;
  expect((await get(newerPath)).state).toBe('stale');
  const expiring = await capture();
  now += 15 * 60_000;
  expect((await get(`/v1/libraryExports/${expiring.exportId}`)).state).toBe('expired');
  now = Date.now();
  await sql`UPDATE library.library_export SET state='expired' WHERE route=${route} AND account_id=${owner}`;
  await sql`UPDATE library.vndb_import SET rows='[{"identifier":{"value":"v1"}}]'
    WHERE route=${route} AND account_id=${owner}`;
  const terminal = await capture();
  const access = fixture.access({ actions: LIFECYCLE_ACTIONS });
  const actor = await access.authenticate(fixture.bearer('owner'), { pool: db.pool, deadline: Date.now() + 10000 });
  await fixture.grant({ route, id: owner }, 'owner', 'account:delete');
  await createLifecycleCommands({ pool: db.pool, access }).tombstone(
    { actor, deadline: Date.now() + 10000 },
    { accountId: owner, key: randomUUID() },
  );
  const response = await request(
    'GET',
    `/v1/libraryExports/${terminal.exportId}/pages?cursor=${encodeURIComponent(terminal.first)}`,
  );
  expect([401, 403]).toContain(response.status);
  await purge(db.pool, { accountId: owner, kind: 'library_export', parent: null, after: null, ordinal: 0, segment: 0 });
  expect((await sql`SELECT 1 FROM library.library_export WHERE route=${route} AND account_id=${owner}`).rowCount).toBe(
    0,
  );
  await purge(db.pool, { accountId: owner, kind: 'vndb_import', parent: null, after: null, ordinal: 0, segment: 0 });
  await purge(db.pool, {
    accountId: owner,
    kind: 'list_import_anilist',
    parent: null,
    after: null,
    ordinal: 0,
    segment: 0,
  });
  expect((await sql`SELECT 1 FROM library.vndb_import_row WHERE route=${route} AND account_id=${owner}`).rowCount).toBe(
    0,
  );
  expect(
    (await sql`SELECT 1 FROM library.list_import_anilist WHERE route=${route} AND account_id=${owner}`).rowCount,
  ).toBe(0);
  await purge(db.pool, {
    accountId: owner,
    kind: 'collection_archive_recovery',
    parent: null,
    after: null,
    ordinal: 0,
    segment: 0,
  });
  expect(
    (
      await sql`SELECT 1 FROM library.collection_archive_recovery
    WHERE route=${route} AND account_id=${owner}`
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await sql`SELECT 1 FROM library.collection_archive_recovery_record
    WHERE route=${route} AND account_id=${owner}`
    ).rowCount,
  ).toBe(0);
});
