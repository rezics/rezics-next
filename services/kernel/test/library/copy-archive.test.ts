import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { parseCopyArchive, COPY_ARCHIVE_LIMITS } from '../../src/library/copy-archive-format.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture, owner: Awaited<ReturnType<NativeProfileFixture['identity']>>, other: typeof owner;
let artifact: { manifest: Record<string, any>; records: Record<string, any>[] };
let now = Date.now();
const scopes = ['subject:read','copy:create','copy:read','copy:list','account:delete',
  'library_entry:list','library_entry:read','progress_session:list','progress_session:read','collection:read'];
const path = '/v1/libraryCopyArchives';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function json(response: Response, status = 200) {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  expect(response.headers.get('cache-control')).toContain('no-store');
  return response.json();
}
const send = (method: string, suffix = '', body?: unknown, key?: string) => f.send(owner.bearer,method,path + suffix,body,key);
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock: () => new Date(now) });
  owner = await f.identity(scopes);
  other = await f.identity(scopes);
  const release = (statuses: string[]) => compileCatalogue(fixture({ id: 'fixture.archive', copies: {
    kinds: [{ id: 'physical', statuses: statuses.map((id) => ({ id })) }, { id: 'digital', statuses: [{ id: 'licensed' }] }],
  } }));
  await f.activate(await f.publish(await release(['owned','lent'])));
  for (const group of ['personal_library','reading_progress','collections'])
    expect((await f.send('steward','POST',`/v1/platform/exposure/${group}:open`)).status).toBe(200);
  const subjectId = await f.createSubject('game');
  // Distinct native commands create legitimate identical-text siblings; no row-list fixture format.
  for (let i = 0; i < 12; i++)
    expect((await f.send(owner.bearer,'POST','/v1/copies',{ subjectId, kind: 'physical', status: 'owned',
      note: '📚'.repeat(1000), source: 'gift', acquiredOn: i === 0 ? '2020-02-29' : null, disposedOn: null })).status).toBe(201);
  await f.activate(await f.publish(await release(['lent']))); // Old vocabulary is still readable evidence.
  const status = await json(await f.send(owner.bearer,'POST','/v1/libraryExports'));
  const records: Record<string, any>[] = [];
  let cursor = status.first, manifest: Record<string, any> | null = null;
  for (let n = 0; cursor && n < 100; n++) {
    const page = await json(await f.send(owner.bearer,'GET',
      `/v1/libraryExports/${status.exportId}/pages?cursor=${encodeURIComponent(cursor)}`));
    records.push(...page.records);
    cursor = page.next;
    manifest = page.manifest;
  }
  expect(cursor).toBeNull();
  expect(manifest).not.toBeNull();
  artifact = { manifest: manifest!, records };
},120000);
afterAll(async () => { await f?.close(); });

test('actual installed export retains independent holdings, all pins and exact dates without implying restoration', async () => {
  const parsed = parseCopyArchive(bytes(artifact));
  expect(parsed.holdings).toHaveLength(12);
  expect(new Set(parsed.holdings.map((r) => r.evidence.copy_id)).size).toBe(12);
  expect(new Set(parsed.holdings.map((r) => r.evidence.subject_id)).size).toBe(1);
  expect(parsed.holdings.every((r) => r.evidence.status === 'owned' && r.evidence.note === '📚'.repeat(1000))).toBe(true);
  expect(parsed.holdings.every((r) => r.evidence.kind_profile_pin && r.evidence.status_profile_pin && r.evidence.library_profile_pin)).toBe(true);
  expect(parsed.holdings.some((r) => r.evidence.acquired_on === '2020-02-29')).toBe(true);
  expect(parsed.holdings.some((r) => r.evidence.acquired_on === null)).toBe(true);
  expect(parsed.coverage.find((c) => c.section === 'entries')).toEqual({ section: 'entries', records: 0, support: 'unsupported' });
});

test('installed final manifest, counts, envelopes and admission bounds are mandatory', () => {
  const reject = (change: (a: typeof artifact) => void, recount = false) => {
    const a = structuredClone(artifact);
    change(a);
    if (recount) { a.manifest.rows = a.records.length; a.manifest.recordBytes = a.records.reduce((n,r) => n + bytes(r).length,0); }
    expect(() => parseCopyArchive(bytes(a))).toThrow('invalid_request');
  };
  reject((a) => { a.manifest.version = 2; });
  reject((a) => { a.manifest = null as any; });
  reject((a) => { a.manifest.rows++; });
  reject((a) => { a.manifest.recordBytes++; });
  reject((a) => { a.manifest.sections = a.manifest.sections.filter((s: string) => s !== 'holdings'); });
  reject((a) => { a.records[0]!.acquired_on = '2020-02'; },true);
  reject((a) => { a.records[0]!.acquired_on = '2021-02-29'; },true);
  reject((a) => { delete a.records[0]!.disposed_on; },true);
  reject((a) => { a.records[0]!.note = 'x'.repeat(1001); },true);
  reject((a) => { a.records.push(a.records[0]!); },true);
  expect(() => parseCopyArchive(new Uint8Array(COPY_ARCHIVE_LIMITS.bytes + 1))).toThrow('content_too_large');
  expect(() => parseCopyArchive(new TextEncoder().encode('{"manifest":1,"manifest":2,"records":[]}'))).toThrow('invalid_request');
  expect(() => parseCopyArchive(new TextEncoder().encode('['.repeat(17) + ']'.repeat(17)))).toThrow('invalid_request');
});

test('private paged inspection, original upload replay, cancellation, expiry and removal', async () => {
  expect((await f.send('anonymous','POST',path,artifact)).status).toBe(401);
  const key = entryKey(), uploaded = await json(await send('POST','',artifact,key));
  expect(await json(await send('POST','',artifact,key))).toEqual(uploaded);
  expect((await send('POST','',artifact)).status).toBe(409);
  const suffix = `/${uploaded.uploadId}`;
  const denied = await f.send(other.bearer,'GET',path + suffix);
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain('gift');
  const first = await json(await send('GET',suffix));
  expect(first).toMatchObject({ holdings: 12, fullRestoration: false, effectsSupported: false, state: 'inspecting' });
  expect(first.rows).toHaveLength(10);
  expect(first.rows.every((r: any) => r.resolution === 'unresolved')).toBe(true);
  const last = await json(await send('GET',`${suffix}?after=${first.next}`));
  expect(last.rows).toHaveLength(2);
  expect(last.next).toBeNull();
  expect(await json(await send('POST',suffix + ':cancel'))).toMatchObject({ cancelled: true });
  expect(await json(await send('GET',suffix))).toMatchObject({ state: 'cancelled', holdings: 12 });
  now += 7 * 86_400_000;
  expect((await send('GET',suffix)).status).toBe(404);
  expect(await json(await send('DELETE',suffix))).toMatchObject({ removed: 12, complete: true });
  expect((await send('POST','',artifact,key)).status).toBe(404); // Receipt never resurrects removed evidence.
  now = Date.now();
},120000);

test('terminal account fencing denies inspection and bounded owner erasure removes evidence', async () => {
  const uploaded = await json(await send('POST','',artifact));
  await createLifecycleCommands({ pool: f.pool, access: f.access }).tombstone(
    { actor: owner.actor, pool: f.pool, deadline: Date.now() + 30000 },
    { accountId: owner.actor.accountId, key: entryKey() });
  expect([401,403]).toContain((await send('GET',`/${uploaded.uploadId}`)).status);
  expect((await purgeOwnedGraphPage(f.pool,{ accountId: owner.actor.accountId, kind: 'copy_archive',
    parent: null, after: null, ordinal: 0, segment: 0 })).removed).toBe(12);
  const count = await f.pool.query('SELECT 1 FROM library.copy_archive_row WHERE route=$1 AND account_id=$2',
    [routeOf(owner.actor.accountId),owner.actor.accountId]);
  expect(count.rowCount).toBe(0);
},120000);
