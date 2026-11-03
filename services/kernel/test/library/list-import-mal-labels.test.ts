import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { MAL_LABEL_LIMITS, malTagEvidence } from '../../src/library/list-import-mal-tags.ts';
import { parseMal } from '../../src/library/list-import-mal-parser.ts';
import { createMalImport } from '../../src/library/list-import-mal.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { accountToken } from '../support/admitted-access.ts';

let f: NativeProfileFixture;
beforeAll(async () => { f = await createProfileEntryFixture(); }, 120000);
afterAll(async () => { await f?.close(); });
const base = '/v1/libraryImports/mal';
const xml = (tags?: string, id = '1') => `<myanimelist><anime><series_animedb_id>${id}</series_animedb_id><series_title>Display only</series_title><my_status>Completed</my_status>${tags === undefined ? '' : `<my_tags>${tags}</my_tags>`}<my_comments>private comment</my_comments><my_times_watched>9</my_times_watched></anime></myanimelist>`;
async function json(method: string, path: string, body?: unknown, status = 200, key = randomUUID(), persona = 'owner') {
  const response = await f.send(persona, method, path, body, key);
  const data = await response.json();
  expect({ status: response.status, data }).toMatchObject({ status });
  if (path.startsWith(base) && response.ok) expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  return data;
}
const upload = async (tags?: string) => (await json('POST', `${base}:preview`, { xml: xml(tags) })).id as string;
const label = async (name: string) => (await json('POST', '/v1/libraryLabels', { name }, 201)).label as { id: string; revision: number };
const assignments = async (subject: string) => (await json('GET', `/v1/libraryLabelAssignments?subjectId=${subject}&limit=100`)).assignments as { id: string; labelId: string; subjectId: string; revision: number }[];
const selected = (value: number, l: { id: string; revision: number }) => ({ value, target: { labelId: l.id, revision: l.revision } });
async function review(id: string, target: string | null, labels: unknown[], row = 0) {
  const version = randomUUID();
  await json('POST', `${base}/${id}/review`, { row, target, labels, replace: false, skip: false }, 200, version);
  return version;
}
const apply = (id: string, version: string, row = 0, status = 200) =>
  json('POST', `${base}/${id}/apply`, { confirm: true, rows: [{ row, version, fields: ['tags'] }] }, status);

test('retained XML tag grammar preserves exact evidence and distinguishes absence, emptiness and unsupported input', () => {
  const evidence = (raw?: string) => malTagEvidence(parseMal(xml(raw))[0]!);
  expect(evidence().kind).toBe('missing');
  expect(evidence('').kind).toBe('empty');
  expect(evidence('  ').kind).toBe('unknown');
  expect(evidence('one,,two').kind).toBe('invalid');
  expect(evidence('one, &quot;two,three&quot;').kind).toBe('unsupported');
  expect(evidence('one\\,two').kind).toBe('unsupported');
  expect(evidence('one&#10;two').kind).toBe('invalid');
  expect(evidence('x'.repeat(MAL_LABEL_LIMITS.sourceBytes + 1)).reason).toBe('source-byte-limit');
  expect(evidence(Array.from({ length: 33 }, (_, i) => `v${i}`).join(',')).reason).toBe('source-value-limit');
  expect(evidence(' A &amp; B,second,A &amp; B').values).toEqual([
    { index: 0, raw: ' A & B', value: 'A & B', duplicateOf: null },
    { index: 1, raw: 'second', value: 'second', duplicateOf: null },
    { index: 2, raw: 'A & B', value: 'A & B', duplicateOf: 0 },
  ]);
  expect(evidence('unknown').values[0]?.value).toBe('unknown');
});

test('actual MAL upload adopts existing and new labels on its admitted Subject; retries preserve original native identities', async () => {
  const producer = await accountToken({ accountId: f.steward.actor.accountId, clientId: f.steward.actor.clientId,
    scopes: [...f.steward.actor.scopes, 'subject:batch_write'] });
  const created = await json('POST', '/v1/subjects:batchWrite', { commands: [{ op: 'create', key: randomUUID(),
    source: { source: 'mal_anime', external_id: '1', record_revision: '1', digest: 'a'.repeat(64), converter_revision: 'fixture', field_group: 'facts' },
    subject: { type: 'ex:Child', labels: { en: 'Claim chooses identity' } },
  }] }, 200, randomUUID(), producer);
  const subject = created.results[0].value.id, existing = await label('Owned MAL target');
  const id = await upload('old,new,old,invalid,collision');
  const selection = [selected(0, existing), { value: 1, target: { name: '  MAL   Cafe\u0301  ' } }, selected(2, existing),
    { value: 3, target: { name: ' '.repeat(2) } }, { value: 4, target: { name: ' Owned MAL target ' } }];
  const version = await review(id, null, selection);
  const page = await json('GET', `${base}/${id}`);
  expect(page.rows[0].review).toMatchObject({ target: subject, labels: { selections: [
    { status: 'ready' }, { status: 'ready', target: { name: 'MAL Café' } }, { status: 'duplicate' },
    { status: 'invalid' }, { status: 'collision' },
  ] } });
  expect(page.rows[0].notes.value).toBe('private comment');
  expect(page.rows[0].repeats.value).toBe(9);
  const result = await apply(id, version), adopted = result.outcomes[0].labels;
  expect(adopted.map((o: { status: string }) => o.status)).toEqual(['accepted', 'accepted', 'unchanged', 'unsupported', 'unsupported']);
  const native = await assignments(subject);
  expect(native.map((a) => a.labelId).sort()).toEqual([existing.id, adopted[1].labelId].sort());
  expect(native.find((a) => a.labelId === adopted[1].labelId)?.id).toBe(adopted[1].assignment.id);
  await json('GET', `/v1/libraryEntries/${subject}`, undefined, 404);
  expect((await json('GET', `/v1/libraryLabels/${adopted[1].labelId}`)).label.name).toBe('MAL Café');
  // Both native commands committed; acknowledgement of their operands/outcome was lost.
  await f.pool.query(`UPDATE library.list_import_mal SET document=document
    #- '{labelIntents,0,items,1,label}' #- '{labelIntents,0,items,1,outcome}' WHERE account_id=$1 AND id=$2`, [f.owner.actor.accountId, id]);
  expect((await apply(id, version)).outcomes[0].labels).toEqual(adopted);
  expect(await assignments(subject)).toEqual(native);
  await json('GET', `${base}/${id}`, undefined, 404, randomUUID(), 'other');
  await json('POST', `${base}/${id}/apply`, { confirm: true, rows: [{ row: 0, version, fields: ['tags'] }] }, 404, randomUUID(), 'other');
  await json('DELETE', `/v1/libraryLabels/${existing.id}?revision=1`);
  const replacement = await label('Owned MAL target');
  expect(replacement.id).not.toBe(existing.id);
  expect((await apply(id, version)).outcomes[0].labels[0].status).toBe('stale');
  expect((await assignments(subject)).some((a) => a.labelId === replacement.id)).toBe(false);
  await review(id, subject, [{ value: 0, target: { name: 'Reviewed replacement' } }]);
  await apply(id, version, 0, 409);
  await json('POST', `${base}/${id}/review`, { row: 0, target: null, labels: selection, replace: false, skip: false }, 409, version);
  await json('DELETE', `${base}/${id}`);
  expect((await assignments(subject)).some((a) => a.labelId === adopted[1].labelId)).toBe(true);
}, 120000);

test('32 native reservations refuse extra assignment and deleted parents can be reclaimed by the original command', async () => {
  const subject = await f.createSubject('unprofiled'), targets = [];
  for (let n = 0; n < 32; n++) {
    const l = await label(`MAL capacity ${n}`); targets.push(l);
    await json('POST', `/v1/libraryLabels/${l.id}:assign`, { subjectId: subject });
  }
  const id = await upload(Array.from({ length: 32 }, (_, i) => `value ${i}`).join(','));
  const version = await review(id, subject, [{ value: 31, target: { name: 'MAL capacity overflow' } }, selected(0, targets[0]!)]);
  const refused = (await apply(id, version)).outcomes[0].labels;
  expect(refused[0]).toMatchObject({ status: 'failed', reason: 'library-label-capacity' });
  expect(refused[1].status).toBe('unchanged');
  expect(await assignments(subject)).toHaveLength(32);
  await json('DELETE', `/v1/libraryLabels/${targets[1]!.id}?revision=1`);
  const retry = (await apply(id, version)).outcomes[0].labels;
  expect(retry[0]).toMatchObject({ status: 'accepted', labelId: refused[0].labelId });
  expect(await assignments(subject)).toHaveLength(32);
  await json('DELETE', `${base}/${id}`);
}, 120000);

test('partial request cancellation preserves accepted assignments; expiry and removal only retire evidence', async () => {
  const subject = await f.createSubject('unprofiled'), a = await label('MAL partial A'), b = await label('MAL partial B');
  const id = await upload('first,second'), version = await review(id, subject, [selected(0, a), selected(1, b)]);
  const service = createMalImport({ pool: f.pool, access: f.access, tokens: f.tokens, routeKey: testRouteKey() });
  const cancel = new AbortController();
  const result = await service.apply(f.owner.actor, id, { confirm: true, rows: [{ row: 0, version, fields: ['tags'] }] },
    Date.now() + 30000, cancel.signal, () => cancel.abort());
  expect(result).toMatchObject({ stopped: true, remaining: [0], outcomes: [{ labels: [{ status: 'accepted', labelId: a.id }], remainingLabels: [1] }] });
  expect((await assignments(subject)).map((v) => v.labelId)).toEqual([a.id]);
  await json('POST', `${base}/${id}/cancel`, {});
  await apply(id, version, 0, 409);
  await f.pool.query('UPDATE library.list_import_mal SET expires_at=clock_timestamp()-interval \'1 second\' WHERE account_id=$1 AND id=$2', [f.owner.actor.accountId, id]);
  await json('GET', `${base}/${id}`, undefined, 404);
  const fresh = await upload('third');
  expect((await f.pool.query('SELECT 1 FROM library.list_import_mal WHERE account_id=$1 AND id=$2', [f.owner.actor.accountId, id])).rows).toEqual([]);
  expect((await assignments(subject)).map((v) => v.labelId)).toEqual([a.id]);
  await json('DELETE', `${base}/${fresh}`);
}, 120000);
