import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands.ts';
import { routeOf } from '../../src/route/route.ts';

let f: NativeProfileFixture;
beforeAll(async () => { f = await createProfileEntryFixture(); }, 120000);
afterAll(async () => { await f?.close(); });
const base = '/v1/libraryImports/vndb';
const catalogue = () => createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
const assignments = () => createLabelAssignmentCommands({ pool: f.pool, tokens: f.tokens, access: f.access });
const label = async () => (await catalogue().createLabel(f.owner.actor, { name: entryKey() }, entryKey())).value.label;
async function json(method: string, path: string, body?: unknown, status = 200, persona = 'owner', key = entryKey()) {
  const response = await f.send(persona, method, path, body, key), data = await response.json();
  expect({ status: response.status, data }).toMatchObject({ status });
  if (response.ok && path.startsWith(base)) expect(response.headers.get('cache-control')).toBe('private, no-store');
  return data;
}
async function retained(names: string[], target = '') {
  const subjectId = target || await f.createSubject('game');
  const made = await json('POST', `${base}:preview`, {
    xml: `<vndb-export version="1.0"><vns><vn id="v9999999999999999">${names.map(n => `<label label="${n}" private="1"/>`).join('')}</vn></vns></vndb-export>`,
  });
  const decision = await json('POST', `${base}/${made.uploadId}:review`, { ordinal: 0, action: 'retain', targetId: subjectId });
  return { id: made.uploadId as string, rows: [{ ordinal: 0, reviewId: decision.reviewId }], subjectId };
}
const map = (source: string, l: { id: string; revision: number }) => ({ source, target: { labelId: l.id, revision: l.revision } });
const consent = (r: Awaited<ReturnType<typeof retained>>, mappings: unknown[], key = entryKey()) =>
  json('POST', `${base}/${r.id}/labels:review`, { rows: r.rows, mappings }, 200, 'owner', key);
const page = (id: string, after = -1) => json('GET', `${base}/${id}/labels?after=${after}`);
const apply = (id: string, previewId: string, items = [0]) => json('POST', `${base}/${id}/labels:apply`, { previewId, items });
const remove = (id: string) => json('DELETE', `${base}/${id}`);
const countLabels = async () => Number((await f.pool.query(
  'SELECT count(*) FROM library.personal_label WHERE route=$1 AND account_id=$2', [routeOf(f.owner.actor.accountId), f.owner.actor.accountId])).rows[0].count);

test('two retained private names require separate consent, existing assignment is preserved, new creation and acknowledgement replay are additive', async () => {
  const existing = await label(), target = await f.createSubject('game');
  const already = await assignments().assignLabel(f.owner.actor, existing.id, { subjectId: target }, entryKey());
  const before = await f.inspect(), count = await countLabels();
  const r = await retained(['Playing', 'Together', 'Favourite'], target);
  expect(await countLabels()).toBe(count); // Ordinary producer upload/review/apply never creates a label.
  await json('POST', `${base}/${r.id}:apply`, { rows: r.rows });
  expect(await countLabels()).toBe(count);
  const newName = `Chosen ${entryKey()}`, key = entryKey();
  const c = await consent(r, [map('Together', existing), { source: 'Favourite', target: { name: newName } }], key);
  expect(await countLabels()).toBe(count);
  const reviewed = await page(r.id);
  expect(reviewed.items.map((i: any) => i.subjectId)).toEqual([target, target]);
  expect(reviewed.items[0].result.assignment).toEqual(already.value.assignment);
  expect(reviewed.mappings[1]).toMatchObject({ label: null, target: { name: newName }, admission: 'ready' });
  expect((await consent(r, [map('Together', existing), { source: 'Favourite', target: { name: newName } }], key)).previewId).toBe(c.previewId);
  const result = await apply(r.id, c.previewId, [0, 1]);
  expect(result.outcomes.map((i: any) => i.status)).toEqual(['already_present', 'applied']);
  expect(result.outcomes[0].result.assignment).toEqual(already.value.assignment);
  expect(await apply(r.id, c.previewId, [0, 1])).toEqual(result);
  expect(await countLabels()).toBe(count + 1);
  // Lose only the composition acknowledgements: original native creation/assignment receipts remain installed.
  await f.pool.query(`UPDATE library.vndb_label_adoption SET mappings=jsonb_set(mappings,'{1,label}','null') WHERE account_id=$1 AND upload_id=$2`, [f.owner.actor.accountId, r.id]);
  await f.pool.query(`UPDATE library.vndb_label_adoption_item SET status='ready',result=NULL WHERE account_id=$1 AND upload_id=$2 AND item_no=1`, [f.owner.actor.accountId, r.id]);
  const replay = await apply(r.id, c.previewId, [1]);
  expect(replay.outcomes[0].result).toEqual(result.outcomes[1].result);
  expect(await countLabels()).toBe(count + 1);
  const after = await f.inspect();
  for (const field of ['entries', 'sessions', 'copies', 'entitlements'] as const) expect(after[field]).toEqual(before[field]);
  await remove(r.id);
  expect(await countLabels()).toBe(count + 1);
  expect((await json('GET', `/v1/libraryLabelAssignments?subjectId=${target}`)).assignments).toHaveLength(2);
}, 120000);

test('revision/incarnation changes and refreshed source review refuse stale work, other owners have no authority', async () => {
  const l = await label(), r = await retained(['One']);
  const c = await consent(r, [map('One', l)]);
  await json('GET', `${base}/${r.id}/labels`, undefined, 404, 'other');
  await json('POST', `${base}/${r.id}/labels:apply`, { previewId: c.previewId, items: [0] }, 404, 'other');
  const deleted = await catalogue().deleteLabel(f.owner.actor, l.id, l.revision, entryKey());
  await catalogue().restoreLabel(f.owner.actor, l.id, deleted.value.revision, entryKey());
  expect((await apply(r.id, c.previewId)).outcomes[0].status).toBe('stale');
  expect((await json('GET', `/v1/libraryLabelAssignments?subjectId=${r.subjectId}`)).assignments).toEqual([]);
  await remove(r.id);
  const next = await retained(['One']), c2 = await consent(next, [map('One', await label())]);
  await json('POST', `${base}/${next.id}:review`, { ordinal: 0, action: 'retain', targetId: next.subjectId });
  expect((await apply(next.id, c2.previewId)).outcomes[0].status).toBe('stale');
  await remove(next.id);
}, 120000);

test('partial cancellation preserves acknowledged labels, source deletion cascades previews/results, retired review cannot reinstall consent', async () => {
  const r = await retained(['One', 'Two']), mappings = ['One', 'Two'].map(source => ({ source, target: { name: `Cancel ${entryKey()}` } }));
  const oldKey = entryKey(), old = await consent(r, mappings, oldKey), c = await consent(r, mappings);
  await json('POST', `${base}/${r.id}/labels:review`, { rows: r.rows, mappings }, 409, 'owner', oldKey);
  const first = await apply(r.id, c.previewId, [0]);
  expect(first.outcomes[0].status).toBe('applied');
  await json('POST', `${base}/${r.id}/labels:cancel`, { previewId: c.previewId });
  expect(await apply(r.id, c.previewId, [1])).toMatchObject({ outcomes: [], stopped: 'cancelled' });
  expect((await page(r.id)).items[1].status).toBe('ready');
  await remove(r.id);
  await pageMissing(r.id);
  for (const table of ['vndb_label_adoption', 'vndb_label_adoption_item'])
    expect((await f.pool.query(`SELECT 1 FROM library.${table} WHERE account_id=$1 AND upload_id=$2`, [f.owner.actor.accountId, r.id])).rows).toEqual([]);
  expect((await json('GET', `/v1/libraryLabelAssignments?subjectId=${r.subjectId}`)).assignments).toHaveLength(1);
  expect(old.previewId).not.toBe(c.previewId);
}, 120000);
const pageMissing = (id: string) => json('GET', `${base}/${id}/labels`, undefined, 404);

test('native slot exhaustion is visible during review and retained as a per-item refusal without changing membership', async () => {
  const target = await f.createSubject('game');
  for (let i = 0; i < 32; i++) await assignments().assignLabel(f.owner.actor, (await label()).id, { subjectId: target }, entryKey());
  const r = await retained(['Full', 'Playing'], target), l = await label();
  const c = await consent(r, [map('Full', l), map('Playing', l)]);
  expect((await page(r.id)).items.map((i: any) => [i.status, i.result.reason])).toEqual([
    ['ready', 'assignment-capacity'], ['unsupported', 'state-label'],
  ]);
  const result = await apply(r.id, c.previewId, [0, 1]);
  expect(result.outcomes.map((i: any) => i.status)).toEqual(['refused', 'unsupported']);
  expect(result.outcomes[0].result).toMatchObject({ reason: 'assignment-capacity', retryable: false });
  expect((await json('GET', `/v1/libraryLabelAssignments?subjectId=${target}&limit=100`)).assignments).toHaveLength(32);
  await remove(r.id);
}, 180000);
