import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseAniList } from '../../src/library/list-import-anilist-parser.ts';
import { aniListLabelEvidence, ANILIST_LABEL_LIMITS } from '../../src/library/list-import-anilist-label-evidence.ts';
import { aniListDigest } from '../../src/library/list-import-anilist-label-guard.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { routeOf } from '../../src/route/route.ts';
let f: NativeProfileFixture;
beforeAll(async () => { f = await createProfileEntryFixture(); }, 120000);
afterAll(async () => { await f?.close(); });
const base = '/v1/libraryImports/anilist';
const evidence = (row: object, group?: object) => aniListLabelEvidence(parseAniList(JSON.stringify(
  group ? { lists: [{ ...group, entries: [row] }] } : [row],
)).rows[0]!);

test('retained membership distinguishes absent, null, empty, invalid, unsupported, default and custom evidence', () => {
  for (const [value, state] of [[undefined, 'missing'], [null, 'unknown'], [{}, 'empty'], [[], 'unsupported'], [1, 'invalid'], [{ a: 'yes' }, 'invalid']] as const)
    expect(evidence(value === undefined ? {} : { customLists: value }).membership).toBe(state);
  expect(evidence({ tags: ['a'], status: 'CURRENT' }, { name: 'Watching', isCustomList: false })).toMatchObject({ grouping: 'default', tags: 'unsupported', selectable: [] });
  expect(evidence({}, { name: 'Unspecified grouping' })).toMatchObject({ grouping: 'unknown', selectable: [] });
  const supported = evidence({ customLists: { First: true, Second: false } }, { name: 'First', isCustomList: true });
  expect(supported.values.map(v => [v.value, v.member, v.origin])).toEqual([
    ['First', true, 'customLists'], ['Second', false, 'customLists'], ['First', true, 'customContainer'],
  ]);
  expect(supported.selectable.map(v => v.key)).toEqual(['customLists:First', 'group:name']);
  expect(evidence({ customLists: Object.fromEntries(Array.from({ length: 33 }, (_, n) => [String(n), true])) })).toMatchObject({ membership: 'oversized', selectable: [] });
  expect(aniListDigest({ b: 1, a: [2, 1] })).toBe(aniListDigest({ a: [2, 1], b: 1 }));
  expect(aniListDigest([1, 2])).not.toBe(aniListDigest([2, 1]));
});
async function json(path: string, method = 'GET', body?: unknown, status = 200, who = 'owner') {
  const response = await f.send(who, method, path, body);
  expect(response.status).toBe(status);
  return response.json();
}
async function upload(rows: object[], group?: object) {
  const value = await json(base + ':preview', 'POST', { upload: JSON.stringify(group ? { lists: [{ ...group, entries: rows }] } : rows) });
  return base + '/' + value.id;
}
async function createLabel(name: string) { return (await json('/v1/libraryLabels', 'POST', { name }, 201)).label; }
async function review(path: string, ordinal: number, subjectId: string | undefined, selections: unknown[]) {
  return { ordinal, reviewId: (await json(path + ':reviewLabels', 'POST', { ordinal, ...(subjectId ? { subjectId } : {}), selections })).review.id };
}
const existing = (key: string, labelId: string) => ({ key, target: { labelId } });
const proposed = (key: string, name: string) => ({ key, target: { name } });
async function apply(path: string, confirmations: unknown[]) { return json(path + ':applyLabels', 'POST', { confirmations }); }

test('reopen an admitted state row, adopt existing and normalized new labels, and replay original native identities', async () => {
  const subjectId = await f.createSubject('game'), label = await createLabel('AniList existing');
  const path = await upload([{ status: 'PLANNING', customLists: { Existing: true, New: true }, notes: 'evidence only', progress: 8 }], { name: 'Existing', isCustomList: true });
  const stateReview = await json(path + ':review', 'POST', { ordinal: 0, subjectId, fields: ['status'] });
  await json(path + ':apply', 'POST', { confirmations: [{ ordinal: 0, reviewId: stateReview.review.id }] });
  const before = await json('/v1/libraryEntries/' + subjectId);
  const selection = [existing('customLists:Existing', label.id), proposed('customLists:New', ' E\u0301  Private '), existing('group:name', label.id)];
  const confirmation = await review(path, 0, undefined, selection);
  const response = await f.send('owner', 'GET', path);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(Buffer.byteLength(JSON.stringify(await response.json()))).toBeLessThanOrEqual(ANILIST_LABEL_LIMITS.pageBytes);
  const result = await apply(path, [confirmation]);
  expect(result.complete).toBe(true);
  const items = result.outcomes[0].items;
  expect(items.map((v: { status: string }) => v.status)).toEqual(['applied', 'applied', 'unchanged']);
  expect(items[0].assignment).toEqual(items[2].assignment);
  expect((await json('/v1/libraryLabels?q=' + encodeURIComponent('É Private'))).labels[0]).toMatchObject({ id: items[1].label.id, name: 'É Private' });
  const assignments = (await json('/v1/libraryLabelAssignments?subjectId=' + subjectId)).assignments;
  expect(assignments.map((v: { id: string }) => v.id).sort()).toEqual([items[0].assignment.id, items[1].assignment.id].sort());
  expect(await json('/v1/libraryEntries/' + subjectId)).toEqual(before);
  expect(await apply(path, [confirmation])).toEqual(result);
  // Lose the producer's acknowledgement after real native commands committed. The native receipts, not new effects, recover identities.
  const importId = path.slice(base.length + 1);
  await f.pool.query("UPDATE library.list_import_anilist SET payload=payload-'labelWork' WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=0", [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, importId]);
  expect(await apply(path, [confirmation])).toEqual(result);
  const refreshed = await review(path, 0, subjectId, [existing('customLists:Existing', label.id)]);
  expect((await apply(path, [confirmation])).outcomes[0].items[0].status).toBe('stale');
  expect((await apply(path, [refreshed])).outcomes[0].items[0].status).toBe('unchanged');
  expect((await f.send('other', 'GET', path)).status).toBe(404);
  expect((await f.send('other', 'POST', path + ':applyLabels', { confirmations: [refreshed] })).status).toBe(404);
  expect((await f.send('other', 'POST', path + ':reviewLabels', { ordinal: 0, subjectId, selections: selection })).status).toBe(404);
  await json(path + ':cancel', 'POST', { remove: true });
  expect((await f.send('owner', 'POST', path + ':applyLabels', { confirmations: [refreshed] })).status).toBe(404);
  expect((await json('/v1/libraryLabelAssignments?subjectId=' + subjectId)).assignments).toHaveLength(2);
}, 120000);

test('unsupported/default groups cannot be adopted; exact label incarnation and refreshed review guard new effects', async () => {
  const subjectId = await f.createSubject('unprofiled'), label = await createLabel('AniList incarnation');
  const path = await upload([{ customLists: { Private: true }, tags: ['unsupported'] }, {}], { name: 'Completed', isCustomList: false });
  for (const key of ['group:name', 'tags:unsupported'])
    expect((await f.send('owner', 'POST', path + ':reviewLabels', { ordinal: 0, subjectId, selections: [existing(key, label.id)] })).status).toBe(400);
  const choice = await review(path, 0, subjectId, [existing('customLists:Private', label.id)]);
  await json('/v1/libraryLabels/' + label.id + '?revision=' + label.revision, 'DELETE');
  const replacement = await createLabel('AniList incarnation');
  expect(replacement.id).not.toBe(label.id);
  expect((await apply(path, [choice])).outcomes[0].items[0].status).toBe('stale');
  expect((await json('/v1/libraryLabelAssignments?subjectId=' + subjectId)).assignments).toHaveLength(0);
  const refreshed = await review(path, 0, subjectId, [existing('customLists:Private', replacement.id)]);
  expect((await apply(path, [choice])).outcomes[0].items[0].status).toBe('stale');
  expect((await apply(path, [refreshed])).outcomes[0].items[0].status).toBe('applied');
  await json(path + ':cancel', 'POST', { remove: true });
}, 120000);

test('32-slot refusal is a per-item outcome; cancellation/removal preserve accepted assignments', async () => {
  const full = await f.createSubject('unprofiled'), free = await f.createSubject('unprofiled');
  for (let n = 0; n < 32; n++) {
    const label = await createLabel('AniList full ' + n);
    await json('/v1/libraryLabels/' + label.id + ':assign', 'POST', { subjectId: full });
  }
  const path = await upload([{ customLists: { One: true, Two: true } }, { customLists: { One: true } }]);
  const target = await createLabel('AniList partial');
  const capacity = await review(path, 0, full, [existing('customLists:One', target.id)]);
  expect((await apply(path, [capacity])).outcomes[0].items[0].status).toBe('capacity');
  const accepted = await review(path, 0, free, [existing('customLists:One', target.id)]);
  const pending = await review(path, 1, full, [existing('customLists:One', target.id)]);
  expect((await apply(path, [accepted])).outcomes[0].items[0].status).toBe('applied');
  await json(path + ':cancel', 'POST', {});
  expect(await apply(path, [pending])).toEqual({ outcomes: [], complete: false });
  expect((await json('/v1/libraryLabelAssignments?subjectId=' + free)).assignments).toHaveLength(1);
  expect((await json('/v1/libraryLabelAssignments?subjectId=' + full)).assignments).toHaveLength(32);
  await json(path + ':cancel', 'POST', { remove: true });
}, 120000);
