import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { createLibraryArchiveCollectionRecovery } from '../../src/library/library-archive-collection-recovery.ts';
import { type ArchiveRecord } from '../../src/library/library-archive.ts';
import { exportSections, libraryExportManifest } from '../../src/library/library-export-format.ts';
import { newId } from '../../src/route/route.ts';
import type { Actor } from '../../src/request/access.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

let db: GrowthDatabase;
let work: Awaited<ReturnType<typeof createWorkClient>>;
let service: ReturnType<typeof createLibraryArchiveCollectionRecovery>;
let actor: Actor;
let input: Parameters<typeof service.review>[2];
let archive: string;
let now = Date.now();
const owner = newId(0x2200);
const routeKey = new Uint8Array(32).fill(93);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) };

beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  const scopes = ['collection:create', 'collection:read', 'collection:update', 'subject:create', 'subject:read',
    'library_entry:list', 'library_entry:read', 'copy:list', 'progress_session:list', 'progress_session:read'];
  const fixture = await createRealAccess(db.admin, { owner }, scopes);
  await db.admin.query(`INSERT INTO access.exposure_opening("group",valid,transaction_id)
    SELECT g,'(,)'::tstzrange,$1 FROM unnest($2::text[]) g`,
  [owner, ['personal_library', 'reading_progress', 'collections']]);
  work = await createWorkClient(db.url, db.pool);
  const app = createKernel({ pool: db.pool, workClient: work, access: fixture.access,
    writeRate: fixture.writeRate, receiptKeys: testReceiptKeys(), routeKey, tokens });
  async function request(method: string, path: string, body?: unknown) {
    const response = await app.handle(new Request(`http://kernel.test${path}`, { method,
      headers: { authorization: `Bearer ${fixture.bearer('owner')}`,
        'idempotency-key': JSON.stringify(randomUUID()), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json();
  }
  const { subject } = await request('POST', '/v1/subjects', { type: 'schema:Book', labels: { en: 'Recovery source' } });
  const { collection } = await request('POST', '/v1/collections', { title: 'Recovery source', visibility: 'private' });
  const ids: string[] = [];
  for (const note of ['first duplicate', 'second duplicate']) {
    const { member } = await request('POST', `/v1/collections/${collection.id}/members`, { subjectId: subject.id, note });
    ids.push(member.id);
  }
  const capture = await request('POST', '/v1/libraryExports');
  const records: ArchiveRecord[] = [];
  let cursor = capture.first;
  while (cursor) {
    const page = await request('GET', `/v1/libraryExports/${capture.exportId}/pages?cursor=${encodeURIComponent(cursor)}`);
    records.push(...page.records.filter((record: ArchiveRecord) => exportSections.includes(record.section as typeof exportSections[number])));
    cursor = page.next;
  }
  // Project the installed producer's native rows into the recovery consumer's V1 envelope.
  const manifest = { ...libraryExportManifest({ export_id: capture.exportId,
    created_at: new Date(now).toISOString(), expires_at: new Date(now + 900_000).toISOString() }),
    fullExport: false, rows: records.length,
    recordBytes: records.reduce((n, record) => n + Buffer.byteLength(JSON.stringify(record)), 0) };
  archive = Buffer.from(JSON.stringify({ manifest, records })).toString('base64');
  const access = fixture.access({ actions: new Map(scopes.map(action => [action, { anonymous: false }])) });
  actor = await access.authenticate(fixture.bearer('owner'), { pool: db.pool, deadline: Date.now() + 10_000 });
  service = createLibraryArchiveCollectionRecovery({ pool: db.pool, access, routeKey, tokens, clock: () => new Date(now) });
  input = { collectionId: collection.id, selectedOccurrenceIds: ids,
    mappings: [{ sourceSubjectId: subject.id, targetSubjectId: subject.id }] };
}, 120_000);
afterAll(async () => { await work?.close(); await db?.close(); });

async function reviewed(partial = false) {
  // Advancing the evidence clock keeps the two-upload ceiling independent of previous cases.
  now += 86_400_001;
  const upload = await service.create(actor, archive, randomUUID());
  const original = partial ? { ...input, selectedOccurrenceIds: input.selectedOccurrenceIds.slice(0, 1) } : input;
  const key = randomUUID();
  const review = await service.review(actor, upload.uploadId, original, key);
  return { id: upload.uploadId, original, key, review };
}

async function persisted(id: string) {
  const root = await db.admin.query(`SELECT * FROM library.collection_archive_recovery WHERE account_id=$1 AND upload_id=$2`, [owner, id]);
  const records = await db.admin.query(`SELECT * FROM library.collection_archive_recovery_record
    WHERE account_id=$1 AND upload_id=$2 ORDER BY source_id`, [owner, id]);
  const effects = await db.admin.query(`SELECT collection_id,member_id,subject_id,note,ordinal_key
    FROM library.collection_member WHERE collection_id=(SELECT native_collection_id
      FROM library.collection_archive_recovery WHERE account_id=$1 AND upload_id=$2) ORDER BY member_id`, [owner, id]);
  const receipts = await db.admin.query(`SELECT command_kind,idempotency_key,response FROM core.receipt
    WHERE principal_id=$1 ORDER BY command_kind,idempotency_key`, [owner]);
  return { root: root.rows, records: records.rows, effects: effects.rows, receipts: receipts.rows };
}

async function delayed(id: string, replacement = { ...input, selectedOccurrenceIds: input.selectedOccurrenceIds.slice(1) }) {
  const ready = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const query = db.pool.query.bind(db.pool);
  const spy = spyOn(db.pool, 'query').mockImplementation(((...args: unknown[]) => {
    const result = Reflect.apply(query, db.pool, args);
    if (typeof args[0] === 'string' && args[0].includes('source_id=ANY($5::uuid[])')) {
      spy.mockRestore();
      return Promise.resolve(result).then(async value => { ready.resolve(); await resume.promise; return value; });
    }
    return result;
  }) as typeof db.pool.query);
  const outcome = service.review(actor, id, replacement, randomUUID()).then(
    value => ({ value, error: null }), error => ({ value: null, error }));
  await ready.promise;
  return { outcome, resume: () => resume.resolve() };
}

for (const partial of [false, true]) test(`delayed replacement preserves native ${partial ? 'partial' : 'complete'} effects`, async () => {
  const f = await reviewed(partial);
  const pending = await delayed(f.id);
  try {
    const applied = await service.apply(actor, f.id, f.review.confirmation!);
    expect(applied.state).toBe(partial ? 'partial' : 'complete');
    const accepted = await persisted(f.id);
    expect(accepted.effects).toHaveLength(partial ? 1 : 2);
    expect(accepted.records.filter(row => row.native_member_id)).toHaveLength(partial ? 1 : 2);
    pending.resume();
    expect((await pending.outcome).error).toMatchObject({ code: 'conflict' });
    expect(await persisted(f.id)).toEqual(accepted);
    expect(await service.review(actor, f.id, f.original, f.key)).toMatchObject({ state: applied.state, confirmation: f.review.confirmation });
    await expect(service.review(actor, f.id, { ...f.original, mappings: [] }, f.key)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await service.apply(actor, f.id, f.review.confirmation!)).toEqual(applied);
    expect(await persisted(f.id)).toEqual(accepted);
  } finally { pending.resume(); await pending.outcome; }
}, 120_000);

test('replacement, cancellation, expiry and removal win against a delayed review', async () => {
  for (const boundary of ['replacement', 'cancelled', 'expired', 'removed']) {
    const f = await reviewed();
    const pending = await delayed(f.id);
    try {
      if (boundary === 'replacement') {
        const replacement = await service.review(actor, f.id, input, randomUUID());
        expect(replacement.review!.epoch).toBe(f.review.review!.epoch + 1);
        await expect(service.apply(actor, f.id, f.review.confirmation!)).rejects.toMatchObject({ code: 'conflict' });
      } else if (boundary === 'cancelled') await service.cancel(actor, f.id);
      else if (boundary === 'expired') {
        now += 86_400_001;
        expect((await service.status(actor, f.id)).state).toBe('expired');
      } else await db.admin.query('DELETE FROM library.collection_archive_recovery WHERE account_id=$1 AND upload_id=$2', [owner, f.id]);
      const accepted = await persisted(f.id);
      pending.resume();
      expect((await pending.outcome).error).toMatchObject({ code: 'conflict' });
      expect(await persisted(f.id)).toEqual(accepted);
    } finally { pending.resume(); await pending.outcome; }
  }
}, 120_000);
