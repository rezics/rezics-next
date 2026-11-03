import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { purgeOwnedGraphPage as purge } from '../../src/library/erasure-owned-graph.ts';
import { newId } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { parseBangumiUpload } from '../../src/library/list-import-bangumi-model.ts';
import { parseMal } from '../../src/library/list-import-mal-parser.ts';
import { decodeLibraryArchive } from '../../src/library/library-archive.ts';
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
  'copy:list',
  'progress_session:list',
  'progress_session:read',
  'collection:read',
  'subject:read',
  ...LIFECYCLE_ACTIONS.keys(),
];
const routeKey = new Uint8Array(32).fill(93);
const sparse = newId(route);
const subjectIds: string[] = [];
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
    await sql`INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id) VALUES(${route},${subject},'schema:Book',${owner})`;
    subjectIds.push(subject);
    await sql`INSERT INTO library.entry(route,account_id,subject_id,state,library_profile_pin,revision,created_at,updated_at,transaction_id) VALUES(${route},${owner},${subject},${i === 0 ? 'old-unknown-state' : 'planned'},${legacyPin},1,now(),now(),${owner})`;
  }
  await sql`INSERT INTO library.personal_label(route,account_id,label_id,normalized_name,revision,created_at,updated_at,transaction_id) VALUES(${route},${owner},${label},'weekend',1,now(),now(),${owner})`;
  await sql`INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,revision,created_at,updated_at,transaction_id) VALUES(${route},${owner},${subjectIds[1]},${label},1,now(),now(),${owner})`;
  await sql`INSERT INTO library.copy(route,account_id,copy_id,subject_id,kind,status,library_profile_pin,note,source,acquired_on,revision,created_at,updated_at,transaction_id) VALUES(${route},${owner},${copy},${subjectIds[2]},'physical','owned',${legacyPin},'signed copy','gift','2020-02-29',1,now(),now(),${owner})`;
  await sql`INSERT INTO library.progress_session(route,account_id,session_id,subject_id,version_subject_id,mode,unit,total,amount, completed_unit_count,state,library_profile_pin,revision,started_at,transaction_id) VALUES(${route},${owner},${session},${subjectIds[3]},${version},'scalar_amount','page',300,12.50,0,'active',${legacyPin},1, '2020-01-02 03:04:05.123456+00',${owner})`;
  await sql`INSERT INTO library.progress_change(route,session_id,change_no,intent,recorded_at,transaction_id) VALUES(${route},${session},1,'{"kind":"amount","amount":"12.50"}','2020-01-02 03:04:05.123456+00',${owner})`;
  await sql`INSERT INTO library.progress_session(route,account_id,session_id,subject_id,mode,unit, completed_unit_count,state,library_profile_pin,revision,started_at,transaction_id) VALUES(${route},${owner},${sparse},${subjectIds[5]},'completed_units','chapter',2,'active',${legacyPin},1,now(),${owner})`;
  await sql`INSERT INTO library.progress_unit(route,session_id,unit_id,added_at) SELECT ${route},${sparse},u,now() FROM unnest(ARRAY['chapter-1','chapter-9']) u`;
  await sql`INSERT INTO library.collection(route,collection_id,curator_account_id,title,description,visibility,state,revision,created_at,updated_at,transaction_id) VALUES(${route},${collection},${owner},'Weekend','Private notes','private','active',1,now(),now(),${owner})`;
  for (const note of ['first occurrence', 'second occurrence'])
    await sql`INSERT INTO library.collection_member(route,collection_id,member_id,subject_id,note,ordinal_key,added_at,transaction_id) VALUES(${route},${collection},${newId(route)},${subjectIds[4]},${note},${note.startsWith('first') ? 'a0' : 'a1'},now(),${owner})`;
  await sql`INSERT INTO library.entry(route,account_id,subject_id,state,library_profile_pin,revision,created_at,updated_at,transaction_id) VALUES(${route},${other},${subjectIds[0]},'secret-other-state',${legacyPin},1,now(),now(),${other})`;
  await sql`INSERT INTO library.bangumi_upload(route,account_id,upload_id) VALUES(${route},${owner},${copy}),(${route},${other},${copy})`;
  await sql`INSERT INTO library.bangumi_upload_row(route,account_id,upload_id,ordinal,evidence,review) VALUES(${route},${owner},${copy},0,${parseBangumiUpload('{"format":"rezics.bangumi-collection.v1","collections":[{"subject_id":42,"notes":"source note","type":99}]}')[0]},'{"token":"never-export-review"}')`;
  await sql`INSERT INTO library.list_import_mal(route,account_id,id,document,expires_at) VALUES(${route},${owner},${copy},${{ rows: parseMal('<myanimelist><anime><series_animedb_id>17</series_animedb_id><series_title>Original title</series_title><my_start_date>2020-00-00</my_start_date><my_password>never-export-secret</my_password></anime></myanimelist>'), canceled: false, xml: 'never-export-raw-xml' }},now()+interval '1 day')`;
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
  const records: Record<string, any>[] = [];
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
  expect(final).toMatchObject({ state: 'ready', next: null, manifest: { version: 1, fullExport: false } });
  expect(final.manifest.rows).toBe(records.length);
  expect(sections.entries).toHaveLength(18);
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
  expect(sections.bangumiEvidence?.[0]?.evidence.source).toMatchObject({ subject_id: 42, type: 99 });
  expect(sections.malEvidence?.[0]?.evidence.identifier.value).toBe('17');
  expect(sections.malEvidence?.[0]?.evidence.dates.started.precision).toBe('year');
  const decoded = decodeLibraryArchive(Buffer.from(JSON.stringify({ manifest: final.manifest, records })));
  expect<unknown>(decoded.records).toEqual(records);
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
  expect((await get(`/v1/libraryExports/${id}`)).state).toBe('ready');
  await sql`UPDATE library.collection_member SET note='edited' WHERE route=${route} AND collection_id=${collection}`;
  expect(await get(firstPath)).toMatchObject({ state: 'stale', records: [], manifest: null });
});
test('cancellation, changed revisions, expiry and terminal deletion never yield success artifacts', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const cancelledRequest = await request('POST', '/v1/libraryExports', 'owner', randomUUID(), aborted.signal).catch(
    () => null,
  );
  expect(cancelledRequest === null || cancelledRequest.status >= 400 || (await cancelledRequest.text()) === '').toBe(
    true,
  );
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
});
