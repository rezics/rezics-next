import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from '../semantic/real-access.ts';
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
const scopes = ['library_entry:list', 'library_entry:read', 'copy:list', 'progress_session:list', 'progress_session:read', 'collection:read', 'subject:read', ...LIFECYCLE_ACTIONS.keys()];
const routeKey = new Uint8Array(32).fill(93);
const sparse = newId(route),
  position = newId(route);
const subjectIds: string[] = [];
let now = Date.now();
const key = randomUUID();
function request(method: string, path: string, persona: 'owner' | 'other' | 'anonymous' = 'owner', requestKey = key, signal?: AbortSignal) {
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
beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  fixture = await createRealAccess(db.admin, { owner, other }, scopes);
  workClient = await createWorkClient(process.env.DATABASE_URL!);
app = createKernel({ workClient, pool: db.pool, routeKey, clock: () => new Date(now), tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) }, access: fixture.access, writeRate: fixture.writeRate, ratePeer: () => '127.0.0.1', });
await db.admin.query( `INSERT INTO access.exposure_opening("group",valid,transaction_id) SELECT g,tstzrange('2020-01-01',NULL,'[)'),$1 FROM unnest($2::text[]) g`, [owner, ['personal_library', 'reading_progress', 'collections']], );
  const access = fixture.access({
    actions: new Map(scopes.map((a) => [a, { anonymous: false }])),
  });
const actor = await access.authenticate(fixture.bearer('owner'), { pool: db.pool, deadline: Date.now() + 10000, });
  for (let i = 0; i < 18; i++) {
    const k = randomUUID();
const result = await createSubject(db.pool, { actor, target: subjectTarget(routeKey, owner, k), idempotencyKey: k, digest: createHash('sha256').update(k).digest(), item: { type: 'schema:Book', labels: { en: `Book ${i}` } }, release: { digest: bundledDigest, release: bundledRelease }, authorize: async () => true, });
    subjectIds.push(result.subject.id);
await db.admin.query( `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,1,now(),now(),$2)`, [route, owner, result.subject.id, i === 0 ? 'old-unknown-state' : 'planned'], );
  }
await db.admin.query( `INSERT INTO library.personal_label(route,account_id,label_id,normalized_name,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,'weekend',1,now(),now(),$2)`, [route, owner, label], );
await db.admin.query( `INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,1,now(),now(),$2)`, [route, owner, subjectIds[1], label], );
await db.admin.query( `INSERT INTO library.copy(route,account_id,copy_id,subject_id,status,note,source,acquired_on,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,'owned','signed copy','gift','2020-02-29',1,now(),now(),$2)`, [route, owner, copy, subjectIds[2]], );
await db.admin.query( `INSERT INTO library.progress_session(route,account_id,session_id,subject_id,version_subject_id,mode,unit,total,amount, completed_unit_count,state,revision,started_at,transaction_id) VALUES($1,$2,$3,$4,$5,'scalar_amount','page',300,12.50,0,'active',1, '2020-01-02 03:04:05.123456+00',$2)`, [route, owner, session, subjectIds[3], version], );
await db.admin.query( `INSERT INTO library.progress_change(route,session_id,change_no,intent,recorded_at,transaction_id) VALUES($1,$2,1,'{"kind":"amount","amount":"12.50"}','2020-01-02 03:04:05.123456+00',$3)`, [route, session, owner], );
await db.admin.query( `INSERT INTO library.progress_session(route,account_id,session_id,subject_id,mode,unit, completed_unit_count,state,revision,started_at,transaction_id) VALUES($1,$2,$3,$4,'completed_units','chapter',2,'active',1,now(),$2)`, [route, owner, sparse, subjectIds[5]], );
await db.admin.query( `INSERT INTO library.progress_unit(route,session_id,unit_id,added_at) SELECT $1,$2,u,now() FROM unnest(ARRAY['chapter-1','chapter-9']) u`, [route, sparse], );
await db.admin.query( `INSERT INTO library.progress_session(route,account_id,session_id,subject_id,mode,unit,locator,position, completed_unit_count,state,revision,started_at,transaction_id) VALUES($1,$2,$3,$4,'cursor_position','page','part-2',3.25,0,'active',1,now(),$2)`, [route, owner, position, subjectIds[6]], );
await db.admin.query( `INSERT INTO library.collection(route,collection_id,curator_account_id,title,description,visibility,state,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,'Weekend','Private notes','private','active',1,now(),now(),$3)`, [route, collection, owner], );
  for (const note of ['first occurrence', 'second occurrence'])
await db.admin.query( `INSERT INTO library.collection_member(route,collection_id,member_id,subject_id,note,ordinal_key,added_at,transaction_id) VALUES($1,$2,$3,$4,$5,$6,now(),$7)`, [route, collection, newId(route), subjectIds[4], note, note.startsWith('first') ? 'a0' : 'a1', owner], );
await db.admin.query( `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,'secret-other-state',1,now(),now(),$2)`, [route, other, subjectIds[0]], );
});
afterAll(async () => {
  await workClient?.close();
  await db?.close();
});
test('native owner export streams independent persisted facts, preserves dates, and retries original identity', async () => {
  expect((await request('POST', '/v1/libraryExports', 'anonymous')).status).toBe(401);
  const capture = await json(await request('POST', '/v1/libraryExports'));
  const id = capture.exportId;
  expect((await json(await request('POST', '/v1/libraryExports'))).exportId).toBe(id);
  expect((await request('GET', `/v1/libraryExports/${id}`, 'other')).status).toBe(404);
  const records: Record<string, any>[] = [];
  let cursor = capture.first,
    final: any,
    pages = 0;
  const firstPath = `/v1/libraryExports/${id}/pages?cursor=${encodeURIComponent(cursor)}`;
  const first = await json(await request('GET', firstPath));
  expect(await json(await request('GET', firstPath))).toEqual(first);
  while (cursor) {
    const page = await json(await request('GET', `/v1/libraryExports/${id}/pages?cursor=${encodeURIComponent(cursor)}`));
    expect(page.records.length).toBeLessThanOrEqual(16);
    records.push(...page.records);
    cursor = page.next;
    final = page;
    pages++;
    if (cursor) expect(page.manifest).toBeNull();
    expect(pages).toBeLessThan(100);
  }
  expect(pages).toBeGreaterThan(2);
expect(final).toMatchObject({ state: 'ready', next: null, manifest: { version: 1, fullExport: false }, });
  expect(final.manifest.rows).toBe(records.length);
  expect(records.filter((r) => r.section === 'entries')).toHaveLength(18);
expect(records.find((r) => r.state === 'old-unknown-state')).toMatchObject({ library_profile_pin: null, subject_id_reference: { id: subjectIds[0], href: `https://rezics.com/subjects/${subjectIds[0]}`, }, });
expect(records.find((r) => r.section === 'holdings')).toMatchObject({ copy_id: copy, note: 'signed copy', acquired_on: '2020-02-29', });
expect(records.find((r) => r.section === 'sessions')).toMatchObject({ session_id: session, amount: '12.50', total: '300', position: null, completed_unit_count: 0, version_subject_id: version, started_at: '2020-01-02 03:04:05.123456+00', });
expect(records.find((r) => r.section === 'history')).toMatchObject({ intent: { kind: 'amount', amount: '12.50' }, });
expect( records .filter((r) => r.section === 'occurrences') .map((r) => r.note) .sort(), ).toEqual(['first occurrence', 'second occurrence']);
expect(records.find((r) => r.section === 'assignments')).toMatchObject({ label_id: label, subject_id: subjectIds[1], });
  expect(records.filter((r) => r.section === 'units').map((r) => r.unit_id)).toEqual(['chapter-1', 'chapter-9']);
  expect(records.find((r) => r.session_id === position && r.section === 'sessions')).toMatchObject({ amount: null, position: '3.25', locator: 'part-2' });
  expect(JSON.stringify(records)).not.toContain('secret-other-state');
  expect(JSON.stringify(records)).not.toContain('transaction_id');
  expect((await json(await request('GET', `/v1/libraryExports/${id}`))).state).toBe('ready');
  await db.admin.query(`UPDATE library.collection_member SET note='edited' WHERE route=$1 AND collection_id=$2`, [route, collection]);
expect(await json(await request('GET', firstPath))).toMatchObject({ state: 'stale', records: [], manifest: null, });
});
test('cancellation, changed revisions, expiry and terminal deletion never yield success artifacts', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const cancelledRequest = await request('POST', '/v1/libraryExports', 'owner', randomUUID(), aborted.signal).catch(() => null);
  expect(cancelledRequest === null || cancelledRequest.status >= 400).toBe(true);
  const capture = await json(await request('POST', '/v1/libraryExports', 'owner', randomUUID()));
  const path = `/v1/libraryExports/${capture.exportId}`;
  expect((await request('GET', `${path}/pages?cursor=forged`)).status).toBe(400);
  await json(await request('DELETE', path));
expect(await json(await request('GET', `${path}/pages?cursor=${encodeURIComponent(capture.first)}`))).toMatchObject({ state: 'cancelled', records: [], next: null, manifest: null, });
  const newer = await json(await request('POST', '/v1/libraryExports', 'owner', randomUUID()));
  expect((await request('POST', '/v1/libraryExports', 'owner', randomUUID())).status).toBe(409);
  const newerPath = `/v1/libraryExports/${newer.exportId}`;
  expect((await request('GET', `${newerPath}/pages?cursor=${encodeURIComponent(capture.first)}`)).status).toBe(400);
  await db.admin.query(`UPDATE library.entry SET revision=revision+1 WHERE route=$1 AND account_id=$2 AND subject_id=$3`, [route, owner, subjectIds[0]]);
  expect((await json(await request('GET', newerPath))).state).toBe('stale');
  const expiring = await json(await request('POST', '/v1/libraryExports', 'owner', randomUUID()));
  now += 15 * 60_000;
  expect((await json(await request('GET', `/v1/libraryExports/${expiring.exportId}`))).state).toBe('expired');
  now = Date.now();
  await db.admin.query(`UPDATE library.library_export SET state='expired' WHERE route=$1 AND account_id=$2`, [route, owner]);
  const terminal = await json(await request('POST', '/v1/libraryExports', 'owner', randomUUID()));
  const access = fixture.access({ actions: LIFECYCLE_ACTIONS });
const actor = await access.authenticate(fixture.bearer('owner'), { pool: db.pool, deadline: Date.now() + 10000, });
  await fixture.grant({ route, id: owner }, 'owner', 'account:delete');
  await createLifecycleCommands({ pool: db.pool, access }).tombstone({ actor, deadline: Date.now() + 10000 }, { accountId: owner, key: randomUUID() });
  const response = await request('GET', `/v1/libraryExports/${terminal.exportId}/pages?cursor=${encodeURIComponent(terminal.first)}`);
  expect([401, 403]).toContain(response.status);
  await purgeOwnedGraphPage(db.pool, {
    accountId: owner,
    kind: 'library_export',
    parent: null,
    after: null,
    ordinal: 0,
    segment: 0,
  });
  expect((await db.admin.query(`SELECT 1 FROM library.library_export WHERE route=$1 AND account_id=$2`, [route, owner])).rowCount).toBe(0);
});
