import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { consolidationClient } from '../../../../apps/web/src/library/label-consolidation/client';
import { ConsolidationReview } from '../../../../apps/web/src/library/label-consolidation/review';
import { ConsolidationVisit } from '../../../../apps/web/src/library/label-consolidation/visit';

import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture';
import { createPersonalLabelCommands } from '../../src/library/label-commands';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands';
import { routeOf } from '../../src/route/route';

let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

async function journey() {
  const labels = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
  const assignments = createLabelAssignmentCommands({ pool: f.pool, tokens: f.tokens, access: f.access });
  const label = async () =>
    (await labels.createLabel(f.owner.actor, { name: crypto.randomUUID() }, entryKey())).value.label;
  const source = await label(),
    target = await label();
  const select = async (labelId: string, subjectId: string) => {
    const row = (await assignments.assignLabel(f.owner.actor, labelId, { subjectId }, entryKey())).value.assignment;
    return { subjectId, assignmentId: row.id, revision: row.revision };
  };
  const items = [];
  for (let i = 0; i < 6; i++) items.push(await select(source.id, await f.createSubject('unprofiled')));
  const existing = await select(target.id, items[1]!.subjectId);
  const requests: Request[] = [];
  let lose = '';
  const client = createKernelClient('http://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      const url = new URL(request.url);
      const response = await f.sendWithHeaders(
        'anonymous',
        request.method,
        url.pathname + url.search,
        request.method === 'POST' ? await request.json() : undefined,
        request.headers,
      );
      if (lose && url.pathname.endsWith(lose)) {
        lose = '';
        expect(response.ok).toBe(true);
        throw new Error('acknowledgement lost');
      }
      return response;
    }) as typeof fetch,
  });
  let authorization = `Bearer ${f.owner.bearer}`;
  let retired = false;
  const refreshes: string[][] = [];
  const visit = new ConsolidationVisit(
    new ConsolidationReview(source.id, target.id, items.slice(0, 5)),
    {
      capture: () => ({ headers: { authorization }, isCurrent: () => !retired }),
      subscribeRetirement: () => () => {},
    },
    (headers) => consolidationClient(client, source.id, headers),
    (...ids) => refreshes.push(ids),
  );
  const read = async (labelId: string) => {
    const response = await f.send('owner', 'GET', `/v1/libraryLabelAssignments?labelId=${labelId}`);
    expect(response.status).toBe(200);
    return (await response.json()).assignments as Array<{ id: string; subjectId: string; revision: number }>;
  };
  return {
    source,
    target,
    items,
    existing,
    visit,
    read,
    requests,
    assignments,
    refreshes,
    lose: (operation: string) => {
      lose = operation;
    },
    rotate: () => {
      authorization = `Bearer ${f.other.bearer}`;
    },
    owner: () => {
      authorization = `Bearer ${f.owner.bearer}`;
    },
    retire: () => {
      retired = true;
    },
  };
}

async function reviewed(j: Awaited<ReturnType<typeof journey>>) {
  expect(await j.visit.nextPage()).toBe('accepted');
  expect(j.visit.review.reviewed).toBe(4);
  expect(await j.visit.confirm()).toBe('unavailable');
  expect(await j.visit.nextPage()).toBe('accepted');
  expect(j.visit.review.complete).toBe(true);
  expect(j.visit.review.evidence[0]!.items[0]!.target).toBeNull();
}

test('native paged review, original confirmation/apply replay and both movement branches reopen current shelves', async () => {
  const j = await journey();
  await reviewed(j);
  j.lose(':confirmConsolidation');
  expect(await j.visit.confirm()).toBe('unknown');
  const original = j.requests.at(-1)!;
  j.rotate(); // A substituted sender would fail native authorization or receipt ownership.
  expect(await j.visit.recover()).toBe('accepted');
  const replay = j.requests.at(-1)!;
  expect(replay.headers.get('authorization')).toBe(original.headers.get('authorization'));
  expect(replay.headers.get('idempotency-key')).toBe(original.headers.get('idempotency-key'));
  expect(await replay.json()).toEqual(await original.json());
  j.owner();
  j.lose(':applyConsolidation');
  expect(await j.visit.apply()).toBe('unknown');
  const apply = j.requests.at(-1)!;
  j.rotate();
  expect(await j.visit.readResult()).toBe('rejected'); // Different viewer cannot acknowledge the command.
  expect(j.visit.acknowledgementUnknown).toBe(true);
  expect(await j.visit.recover()).toBe('accepted');
  expect(j.requests.at(-1)!.headers.get('idempotency-key')).toBe(apply.headers.get('idempotency-key'));
  j.owner();
  for (let item = 1; item < 5; item++) expect(await j.visit.apply()).toBe('accepted');
  expect(j.visit.result!.status).toBe('completed');
  expect(j.visit.result!.items[1]).toMatchObject({
    status: 'moved',
    targetUnchanged: true,
    targetAssignment: { id: j.existing.assignmentId, revision: j.existing.revision },
  });
  expect((await j.read(j.source.id)).map((row) => row.subjectId)).toEqual([j.items[5]!.subjectId]);
  expect((await j.read(j.target.id)).map((row) => row.subjectId).sort()).toEqual(
    j.items
      .slice(0, 5)
      .map((row) => row.subjectId)
      .sort(),
  );
  j.retire();
  expect(await j.visit.apply()).toBe('unavailable');
}, 120_000);

test('native mixed moves, uncertain target cancellation and original finite source Undo retain partial effects and controls', async () => {
  const j = await journey();
  await reviewed(j);
  expect(await j.visit.confirm()).toBe('accepted');
  expect(await j.visit.apply()).toBe('accepted');
  expect(await j.visit.apply()).toBe('accepted');
  expect(j.visit.result!.items[1]).toMatchObject({
    status: 'moved',
    targetUnchanged: true,
    targetAssignment: { id: j.existing.assignmentId, revision: j.existing.revision },
  });
  const confirmationId = j.visit.confirmation!.confirmationId;
  const route = routeOf(f.owner.actor.accountId)!;
  const key = (
    await f.pool.query(
      `SELECT target_request_key FROM library.label_consolidation_item
    WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND item_no=2`,
      [route, f.owner.actor.accountId, confirmationId],
    )
  ).rows[0]!.target_request_key;
  await f.pool.query(
    `UPDATE library.label_consolidation_item SET status='applying',stage='target_started'
    WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND item_no=2`,
    [route, f.owner.actor.accountId, confirmationId],
  );
  const selected = j.items[2]!;
  const accepted = await j.assignments.assignLabelForConsolidation(
    f.owner.actor,
    j.target.id,
    { subjectId: selected.subjectId },
    j.target.revision,
    {
      labelId: j.source.id,
      assignmentId: selected.assignmentId,
      revision: selected.revision,
      labelRevision: j.source.revision,
    },
    null,
    key,
  );
  expect(await j.visit.cancel()).toBe('accepted');
  expect(await j.visit.retry(2)).toBe('accepted');
  expect(j.visit.result!.items[2]).toMatchObject({
    status: 'target_applied_source_retained',
    targetAssignment: { id: accepted.value.assignment.id },
  });
  expect(j.visit.result!.items[3]!.status).toBe('pending');
  const sourceRows = await j.read(j.source.id),
    targetRows = await j.read(j.target.id);
  expect(sourceRows.map((row) => row.subjectId)).toEqual(
    expect.arrayContaining(j.items.slice(2).map((row) => row.subjectId)),
  );
  expect(targetRows.map((row) => row.subjectId)).toEqual(
    expect.arrayContaining(j.items.slice(0, 3).map((row) => row.subjectId)),
  );
  expect(targetRows.map((row) => row.subjectId)).not.toContain(j.items[5]!.subjectId);
  const moved = j.visit.result!.items[0]!;
  const before = (
    await f.pool.query(
      `SELECT purge_after::text AS deadline FROM library.label_assignment
    WHERE route=$1 AND account_id=$2 AND assignment_id=$3`,
      [route, f.owner.actor.accountId, j.items[0]!.assignmentId],
    )
  ).rows[0]!.deadline;
  expect(before).toBeTruthy();
  expect(await j.visit.readResult()).toBe('accepted');
  const restored = await f.send('owner', 'POST', `/v1/libraryLabels/${j.source.id}:restoreAssignment`, {
    ...j.items[0],
    revision: moved.sourceUnassignRevision,
  });
  expect(restored.status).toBe(200);
  expect((await restored.json()).assignment.id).toBe(j.items[0]!.assignmentId);
  expect((await j.read(j.source.id)).map((row) => row.subjectId)).toContain(j.items[0]!.subjectId);
  expect((await j.read(j.target.id)).map((row) => row.subjectId)).toContain(j.items[0]!.subjectId);
  expect(j.refreshes.length).toBeGreaterThan(0);
}, 120_000);
