import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { createLabelConsolidation } from '../../src/library/label-consolidation.ts';
import { createLabelConsolidationReview } from '../../src/library/label-consolidation-review.ts';
import { purgeLabelConsolidations } from '../../src/library/label-consolidation-retention.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';
import type { ConsolidationBinding, ConsolidationEvidence } from '../../src/library/label-consolidation-binding.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture,
  now = Date.now();
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock: () => new Date(now) });
}, 120000);
afterAll(async () => {
  await f?.close();
});
const scopes = ['subject:read', 'library_entry:read', 'library_entry:list', 'library_entry:update'];
async function setup(count = 2) {
  const identity = await f.identity(scopes),
    actor = identity.actor;
  const deps = { pool: f.pool, access: f.access, tokens: f.tokens, clock: () => new Date(now) };
  const native = createLabelAssignmentCommands(deps),
    labels = createPersonalLabelCommands(deps),
    flow = createLabelConsolidation(deps);
  const source = (await labels.createLabel(actor, { name: 'Source' }, entryKey())).value.label;
  const target = (await labels.createLabel(actor, { name: '😀'.repeat(100) }, entryKey())).value.label;
  const items = [];
  for (let n = 0; n < count; n++) {
    const subjectId = await f.createSubject('unprofiled');
    const a = (await native.assignLabel(actor, source.id, { subjectId }, entryKey())).value.assignment;
    items.push({ subjectId, assignmentId: a.id, revision: a.revision });
  }
  const evidence = async (): Promise<ConsolidationEvidence> => {
    const all: ConsolidationEvidence = {
      sourceLabel: { ...source, name: 'Source' },
      targetLabel: { ...target, name: '😀'.repeat(100) },
      items: [],
    };
    let cursor: string | undefined;
    do {
      const page = await createLabelConsolidationReview(deps)(actor, source.id, {
        targetLabelId: target.id,
        items,
        limit: 4,
        ...(cursor ? { cursor } : {}),
      });
      all.sourceLabel = page.sourceLabel;
      all.targetLabel = page.targetLabel;
      all.items.push(...page.items);
      cursor = page.next ?? undefined;
    } while (cursor);
    return all;
  };
  const select = async () => (await flow.select(actor, source.id, await evidence(), entryKey())).value;
  const confirmed = async () => {
    const b = await select();
    await flow.confirm(actor, b.id, b.digest, entryKey());
    return b;
  };
  const page = (labelId: string) => native.listAssignments(actor, { labelId, limit: 100 });
  return { identity, actor, native, labels, flow, source, target, items, evidence, select, confirmed, page };
}
test('explicit immutable confirmation moves only selected facts, reopens both native readers and retains original replay/undo', async () => {
  const s = await setup(6),
    unselected = s.items.pop()!;
  const existing = (await s.native.assignLabel(s.actor, s.target.id, { subjectId: s.items[0]!.subjectId }, entryKey()))
    .value.assignment;
  const b = await s.select();
  await expect(s.flow.apply(s.actor, b.id, 0)).rejects.toThrow();
  await expect(s.flow.confirm(s.actor, b.id, '0'.repeat(64), entryKey())).rejects.toThrow();
  await s.flow.confirm(s.actor, b.id, b.digest, entryKey());
  for (let n = 0; n < s.items.length; n++)
    expect((await s.flow.apply(s.actor, b.id, n)).items[n]!.status).toBe('moved');
  const result = await s.flow.result(s.actor, b.id);
  expect(result.state).toBe('complete');
  expect(result.items[0]!.target).toEqual(existing);
  expect((await s.page(s.source.id)).assignments.map((i) => i.subjectId)).toEqual([unselected.subjectId]);
  expect((await s.page(s.target.id)).assignments.map((i) => i.subjectId).sort()).toEqual(
    s.items.map((i) => i.subjectId).sort(),
  );
  const undo = result.items[0]!.sourceUndo!,
    first = s.items[0]!;
  const restored = await s.native.restoreAssignment(
    s.actor,
    s.source.id,
    { subjectId: first.subjectId, ...undo },
    entryKey(),
  );
  expect(restored.value.assignment.id).toBe(first.assignmentId);
  const before = await f.inspect(s.actor.accountId);
  expect((await s.flow.apply(s.actor, b.id, 0)).items[0]!.sourceUndo).toEqual(undo);
  expect(await f.inspect(s.actor.accountId)).toEqual(before);
  expect((await s.page(s.source.id)).assignments.some((i) => i.subjectId === first.subjectId)).toBe(true);
}, 120000);

test('native 32-slot admission refuses before source removal and reclaims only a deleted-label reservation on original retry', async () => {
  const s = await setup(1),
    b = await s.confirmed(),
    parents = [];
  for (let n = 0; n < 31; n++) {
    const label = (await s.labels.createLabel(s.actor, { name: 'Reserved ' + n }, entryKey())).value.label;
    parents.push(label);
    await s.native.assignLabel(s.actor, label.id, { subjectId: s.items[0]!.subjectId }, entryKey());
  }
  await expect(s.flow.apply(s.actor, b.id, 0)).rejects.toMatchObject({ code: 'library_label_capacity' });
  expect((await s.page(s.source.id)).assignments).toHaveLength(1);
  expect((await s.page(s.target.id)).assignments).toHaveLength(0);
  await s.labels.deleteLabel(s.actor, parents[0]!.id, parents[0]!.revision, entryKey());
  expect((await s.flow.apply(s.actor, b.id, 0)).items[0]!.status).toBe('moved');
  const subject = await s.native.listAssignments(s.actor, { subjectId: s.items[0]!.subjectId, limit: 100 });
  expect(subject.assignments).toHaveLength(31);
  expect(subject.assignments.some((i) => i.labelId === parents[1]!.id)).toBe(true);
}, 120000);

test('changed source revision/incarnation, source delete/recreate, target rename and current Subject exposure require new review', async () => {
  for (const change of ['revision', 'incarnation', 'source', 'target', 'subject', 'gate'] as const) {
    const s = await setup(1),
      b = await s.confirmed(),
      item = s.items[0]!;
    if (change === 'revision' || change === 'incarnation') {
      const removed = await s.native.unassignLabel(s.actor, s.source.id, item, entryKey());
      if (change === 'revision')
        await s.native.restoreAssignment(
          s.actor,
          s.source.id,
          { ...item, revision: removed.value.revision },
          entryKey(),
        );
      else await s.native.assignLabel(s.actor, s.source.id, { subjectId: item.subjectId }, entryKey());
    } else if (change === 'source') {
      await s.labels.deleteLabel(s.actor, s.source.id, s.source.revision, entryKey());
      const recreated = await s.labels.createLabel(s.actor, { name: 'Source' }, entryKey());
      expect(recreated.value.label.id).not.toBe(s.source.id);
    } else if (change === 'target')
      await s.labels.renameLabel(s.actor, s.target.id, { name: 'Renamed', revision: s.target.revision }, entryKey());
    else if (change === 'subject')
      expect(
        (await f.send('steward', 'POST', `/v1/subjects/${item.subjectId}:hide`, { reason: 'Changed exposure' })).status,
      ).toBe(200);
    else {
      await f.setLibraryOpen(false);
    }
    await expect(s.flow.apply(s.actor, b.id, 0)).rejects.toThrow();
    if (change === 'gate') await f.setLibraryOpen(true);
    expect((await s.page(s.target.id)).assignments).toHaveLength(0);
  }
}, 120000);

test('lost target acknowledgement resolves the exact original receipt; cancellation exposes accepted partial effects and stops new items', async () => {
  const s = await setup(),
    b = await s.confirmed();
  // Abort after durable start, before dispatch. Then exercise the actual original native assign as the lost caller.
  let abort = new AbortController();
  const stopped = createLabelConsolidation({
    pool: f.pool,
    access: f.access,
    tokens: f.tokens,
    clock: () => new Date(now),
    onCommand: () => abort.abort(),
  });
  await expect(stopped.apply(s.actor, b.id, 0, abort.signal)).rejects.toThrow();
  const row = (
    await f.pool.query<{ payload: ConsolidationBinding }>(
      'SELECT payload FROM library.label_consolidation WHERE route=$1 AND account_id=$2',
      [routeOf(s.actor.accountId), s.actor.accountId],
    )
  ).rows[0]!.payload;
  const item = row.items[0]!;
  const accepted = await s.native.assignLabel(
    s.actor,
    s.target.id,
    { subjectId: item.evidence.selected.subjectId },
    item.assignKey,
    undefined,
    { id: b.id, digest: b.digest, ordinal: 0, phase: 'assign', binding: row },
  );
  // No composition checkpoint records this acceptance; GET resolves rather than assigning again.
  const recovered = await s.flow.result(s.actor, b.id);
  expect(recovered.items[0]).toMatchObject({ status: 'target_accepted', target: accepted.value.assignment });
  const completed = await s.flow.apply(s.actor, b.id, 0);
  expect(completed.items[0]!.status).toBe('moved');
  const cancelled = await s.flow.cancel(s.actor, b.id, entryKey());
  expect(cancelled.state).toBe('cancelled');
  expect(cancelled.items.map((i) => i.status)).toEqual(['moved', 'pending']);
  expect((await s.flow.apply(s.actor, b.id, 1)).items[1]!.status).toBe('pending');
  expect((await s.page(s.target.id)).assignments).toHaveLength(1);
  expect((await s.page(s.source.id)).assignments.map((i) => i.subjectId)).toEqual([s.items[1]!.subjectId]);
}, 120000);

test('HTTP selection/confirm/result are owner-only; retained composition and native undo have independent finite original deadlines', async () => {
  const s = await setup(1),
    evidence = await s.evidence(),
    path = '/v1/libraryLabels/' + s.source.id + ':selectConsolidation';
  const response = await f.send(s.identity.bearer, 'POST', path, evidence);
  expect(response.status).toBe(200);
  const b = await response.json(),
    root = '/v1/libraryLabelConsolidations/' + b.id;
  expect((await f.send('other', 'GET', root)).status).toBe(404);
  expect((await f.send(s.identity.bearer, 'POST', root + ':confirm', { digest: b.digest })).status).toBe(200);
  const applied = await f.send(s.identity.bearer, 'POST', root + ':apply', { ordinal: 0 });
  expect(applied.status).toBe(200);
  expect(applied.headers.get('Cache-Control')).toBe('private, no-store');
  const undo = (await applied.json()).items[0].sourceUndo;
  const original = now;
  now += 16 * 60_000;
  expect((await f.send(s.identity.bearer, 'GET', root)).status).toBe(404);
  expect(
    (
      await purgeLabelConsolidations(
        { pool: f.pool, clock: () => new Date(now) },
        partitionOf(routeOf(s.actor.accountId)!),
      )
    ).removed,
  ).toBeGreaterThan(0);
  now = original + 31 * 86_400_000;
  await expect(
    s.native.restoreAssignment(s.actor, s.source.id, { subjectId: s.items[0]!.subjectId, ...undo }, entryKey()),
  ).rejects.toMatchObject({ code: 'library_label_restore_expired' });
  now = Date.now();
}, 120000);

test('terminal account admission denies original replays and shared owner graph erasure removes retained bindings', async () => {
  const s = await setup(1),
    b = await s.confirmed();
  await createLifecycleCommands({ pool: f.pool, access: f.access }).tombstone(
    { actor: s.actor, deadline: Date.now() + 30000 },
    { accountId: s.actor.accountId, key: entryKey() },
  );
  await expect(s.flow.apply(s.actor, b.id, 0)).rejects.toThrow();
  expect(
    (
      await purgeOwnedGraphPage(f.pool, {
        accountId: s.actor.accountId,
        kind: 'label_consolidation',
        parent: null,
        after: null,
        ordinal: 0,
        segment: 0,
      })
    ).removed,
  ).toBe(1);
  expect(
    (
      await f.pool.query('SELECT 1 FROM library.label_consolidation WHERE route=$1 AND account_id=$2', [
        routeOf(s.actor.accountId),
        s.actor.accountId,
      ])
    ).rowCount,
  ).toBe(0);
}, 120000);
