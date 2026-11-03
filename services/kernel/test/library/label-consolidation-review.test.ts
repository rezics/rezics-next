import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands.ts';
import { createLabelConsolidationReview, LABEL_CONSOLIDATION_REVIEW_LIMITS } from '../../src/library/label-consolidation-review.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => { f = await createProfileEntryFixture(); }, 120000);
afterAll(async () => { await f?.close(); });
const catalogue = () => createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
const assignments = () => createLabelAssignmentCommands({ pool: f.pool, tokens: f.tokens, access: f.access });
const label = async (name: string) => (await catalogue().createLabel(f.owner.actor, { name }, entryKey())).value.label;
const select = async (labelId: string, subjectId: string) => {
  const a = (await assignments().assignLabel(f.owner.actor, labelId, { subjectId }, entryKey())).value.assignment;
  return { subjectId, assignmentId: a.id, revision: a.revision };
};
test('supplied-ID review returns exact identities, bounded final pages and stale selection conflicts without changing native facts', async () => {
  const source = await label('Review source'), target = await label('😀'.repeat(100));
  const items = [];
  for (let n = 0; n < 6; n++) items.push(await select(source.id, await f.createSubject('unprofiled')));
  const both = await select(target.id, items[0]!.subjectId);
  const old = items[1]!;
  await assignments().unassignLabel(f.owner.actor, source.id, old, entryKey());
  const replacement = await select(source.id, old.subjectId);
  const missing = { subjectId: await f.createSubject('unprofiled'), assignmentId: randomUUID(), revision: 1 };
  const selection = { targetLabelId: target.id, items: [...items, missing], limit: 4 };
  const path = '/v1/libraryLabels/' + source.id + ':reviewConsolidation';
  const before = await f.inspect();
  const first = await f.send('owner', 'POST', path, selection);
  expect(first.status).toBe(200);
  expect(first.headers.get('Cache-Control')).toBe('private, no-store');
  const page = await first.json();
  expect(page.sourceLabel).toEqual({ ...source, name: 'Review source' });
  expect(page.targetLabel).toEqual({ ...target, name: '😀'.repeat(100) });
  expect(page.items.map((i: { outcome: string }) => i.outcome)).toEqual(['already_on_target', 'changed', 'movable', 'movable']);
  expect(page.items[0].target).toEqual({ id: both.assignmentId, revision: both.revision, effective: true });
  expect(page.items[1].selected).toEqual(old);
  expect(page.items[1].source).toEqual({ id: replacement.assignmentId, revision: replacement.revision, effective: true });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(LABEL_CONSOLIDATION_REVIEW_LIMITS.responseBytes);
  const lastResponse = await f.send('owner', 'POST', path, { ...selection, cursor: page.next });
  expect(lastResponse.status).toBe(200);
  const last = await lastResponse.json();
  expect(last.selection).toBe(page.selection);
  expect(last.items.map((i: { outcome: string }) => i.outcome)).toEqual(['movable', 'movable', 'missing']);
  expect(last.items[2]).toMatchObject({ selected: missing, source: null, target: null });
  expect(last.next).toBeNull();
  expect(await f.inspect()).toEqual(before);
  const changed = await f.send('owner', 'POST', path, { ...selection, items: [...items].reverse(), cursor: page.next });
  expect(changed.status).toBe(400);
  await catalogue().renameLabel(f.owner.actor, target.id, { name: 'Renamed review target', revision: target.revision }, entryKey());
  expect((await f.send('owner', 'POST', path, { ...selection, cursor: page.next })).status).toBe(409);
  const refreshed = await f.send('owner', 'POST', path, selection);
  expect(refreshed.status).toBe(200);
  expect((await refreshed.json()).targetLabel).toMatchObject({ id: target.id, revision: 2, name: 'Renamed review target' });
}, 120000);
test('native32capacity refusal and deleted-label reclaim eligibility are advisory and never remove the selected source', async () => {
  const source = await label('Capacity source'), target = await label('Capacity target');
  const subjectId = await f.createSubject('unprofiled'), item = await select(source.id, subjectId);
  const labels = [];
  for (let n = 0; n < 31; n++) {
    const parent = await label('Capacity reservation ' + n);
    labels.push(parent);
    await select(parent.id, subjectId);
  }
  const review = createLabelConsolidationReview({ pool: f.pool, tokens: f.tokens, access: f.access });
  const input = { targetLabelId: target.id, items: [item] };
  const full = await f.inspect();
  expect((await review(f.owner.actor, source.id, input)).items[0]!.outcome).toBe('capacity_limited');
  expect(await f.inspect()).toEqual(full);
  await catalogue().deleteLabel(f.owner.actor, labels[0]!.id, labels[0]!.revision, entryKey());
  const hidden = await f.inspect();
  expect((await review(f.owner.actor, source.id, input)).items[0]!.outcome).toBe('movable');
  expect(await f.inspect()).toEqual(hidden);
  // The ordinary native command remains the only payer for one deleted-parent reservation.
  await select(target.id, subjectId);
  expect((await review(f.owner.actor, source.id, input)).items[0]!.outcome).toBe('already_on_target');
  expect((await assignments().listAssignments(f.owner.actor, { labelId: source.id })).assignments).toContainEqual({
    id: item.assignmentId, revision: item.revision, labelId: source.id, subjectId,
  });
}, 120000);
test('selection validation, inaccessible supplied IDs and foreign/deleted/recreated labels preserve native owner boundaries', async () => {
  const source = await label('Identity source'), target = await label('Identity target');
  const item = await select(source.id, await f.createSubject('unprofiled'));
  const path = '/v1/libraryLabels/' + source.id + ':reviewConsolidation';
  const input = { targetLabelId: target.id, items: [item] };
  const review = createLabelConsolidationReview({ pool: f.pool, tokens: f.tokens, access: f.access });
  await expect(review({ ...f.owner.actor, scopes: ['library_entry:read'] }, source.id, input)).rejects.toThrow();
  await expect(review({ ...f.owner.actor, scopes: ['library_entry:update'] }, source.id, input)).rejects.toThrow();
  for (const body of [
    { ...input, targetLabelId: source.id }, { ...input, items: [] }, { ...input, limit: 5 },
    { ...input, items: [item, item] }, { ...input, q: 'all' }, { ...input, items: Array(17).fill(item) },
    { ...input, items: [{ ...item, revision: '1' }] }, { ...input, items: [{ ...item, labelName: 'Identity source' }] },
  ]) expect((await f.send('owner', 'POST', path, body)).status).toBe(400);
  expect((await f.send('other', 'POST', path, input)).status).toBe(404);
  expect([401, 403]).toContain((await f.send('anonymous', 'POST', path, input)).status);
  const inaccessible = await f.send('owner', 'POST', path, { ...input, items: [{ ...item, subjectId: target.id }] });
  expect(inaccessible.status).toBe(200);
  expect((await inaccessible.json()).items[0]).toMatchObject({ outcome: 'inaccessible', source: null, target: null });
  await catalogue().deleteLabel(f.owner.actor, source.id, source.revision, entryKey());
  await label('Identity source');
  expect((await f.send('owner', 'POST', path, input)).status).toBe(404);
}, 120000);
