import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GrantDeniedError } from '../../src/access/contract/errors.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { LibraryConflictError } from '../../src/library/entries.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import {
  capture,
  checkGrowth,
  catalogStatementBound,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Capture,
} from '../support/growth.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let db: GrowthDatabase, f: NativeProfileFixture;
let labels: ReturnType<typeof createPersonalLabelCommands>, commands: ReturnType<typeof createLabelAssignmentCommands>;
const scopes = ['subject:read', 'library_entry:read', 'library_entry:list', 'library_entry:update'];
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createProfileEntryFixture({ pool: db.pool });
  labels = createPersonalLabelCommands({ pool: db.pool, tokens: f.tokens });
  commands = createLabelAssignmentCommands({ pool: db.pool, access: f.access, tokens: f.tokens });
}, 120000);
afterAll(async () => {
  await f?.close();
  await db?.close();
});

test('native assignment identity CAS privacy hidden-source replay and parent hiding preserve independent outcomes', async () => {
  const actor = (await f.identity(scopes)).actor,
    subjectId = await f.createSubject('unprofiled');
  const labelId = (await labels.createLabel(actor, { name: 'Native private assignment' }, entryKey())).value.label.id;
  const key = entryKey(),
    first = await commands.assignLabel(actor, labelId, { subjectId }, key),
    a = first.value.assignment;
  for (const value of [{ subjectId, extra: true }, { subjectId: 7 }, { subjectId: 'bad' }])
    await expect(
      commands.assignLabel(actor, labelId, value as { subjectId: string }, entryKey()),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(commands.assignLabel(actor, labelId, { subjectId: f.unknownSubject() }, key)).rejects.toMatchObject({
    name: 'IdempotencyConflictError',
  });
  await expect(commands.assignLabel(f.other.actor, labelId, { subjectId }, entryKey())).rejects.toBeInstanceOf(
    LibraryNotFoundError,
  );
  await expect(commands.assignLabel({ kind: 'anonymous' }, labelId, { subjectId }, key)).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  await expect(
    commands.unassignLabel(
      actor,
      labelId,
      { subjectId, assignmentId: newId(routeOf(actor.accountId)!), revision: 1 },
      entryKey(),
    ),
  ).rejects.toBeInstanceOf(LibraryConflictError);
  const otherPage = await commands.listAssignments(actor, { subjectId, limit: 1 });
  expect(otherPage.assignments).toEqual([{ ...a, labelId, subjectId }]);
  await expect(
    commands.listAssignments(f.other.actor, { subjectId, limit: 1, cursor: otherPage.next! }),
  ).rejects.toMatchObject({ code: 'invalid_cursor' });
  await labels.renameLabel(actor, labelId, { name: 'Renamed assignment', revision: 1 }, entryKey());
  await expect(commands.listAssignments(actor, { subjectId, limit: 1, cursor: otherPage.next! })).rejects.toMatchObject(
    { code: 'stale_cursor' },
  );
  expect(
    (await f.send('steward', 'POST', `/v1/subjects/${subjectId}:hide`, { reason: 'Native label source concealment' }))
      .status,
  ).toBe(200);
  const before = await f.inspect(actor.accountId);
  await expect(commands.assignLabel(actor, labelId, { subjectId }, entryKey())).rejects.toBeInstanceOf(
    LibraryNotFoundError,
  );
  await expect(commands.listAssignments(actor, { subjectId })).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect(await f.inspect(actor.accountId)).toEqual(before);
  expect(await commands.assignLabel(actor, labelId, { subjectId }, key)).toMatchObject({
    replayed: true,
    value: first.value,
  });
  // Clearing an owner's hidden fact needs no renewed source capability.
  const removed = await commands.unassignLabel(
    actor,
    labelId,
    { subjectId, assignmentId: a.id, revision: a.revision },
    entryKey(),
  );
  expect(removed.value.revision).toBe(2);
  await expect(
    commands.restoreAssignment(actor, labelId, { subjectId, assignmentId: a.id, revision: 2 }, entryKey()),
  ).rejects.toBeInstanceOf(LibraryNotFoundError);
  const revoked = await f.inspect(actor.accountId);
  await f.suspend(actor.accountId);
  await expect(commands.assignLabel(actor, labelId, { subjectId }, key)).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(commands.listAssignments(actor, { labelId, cursor: 'broken' })).rejects.toBeInstanceOf(GrantDeniedError);
  expect((await f.inspect(actor.accountId)).receipts).toEqual(revoked.receipts);
}, 120000);

test('native 32nd and 33rd concurrent admissions share capacity and parent restore never revives reclaimed children', async () => {
  const actor = f.owner.actor,
    subjectId = await f.createSubject('unprofiled'),
    ids: string[] = [];
  for (let n = 0; n < 33; n++)
    ids.push((await labels.createLabel(actor, { name: 'Concurrent label ' + n }, entryKey())).value.label.id);
  for (const id of ids.slice(0, 31)) await commands.assignLabel(actor, id, { subjectId }, entryKey());
  const race = await Promise.allSettled(
    ids.slice(31).map((id) => commands.assignLabel(actor, id, { subjectId }, entryKey())),
  );
  expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(race.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'library_label_capacity' } });
  const loser = ids[31 + race.findIndex((r) => r.status === 'rejected')]!;
  const a = (await commands.listAssignments(actor, { labelId: ids[0]! })).assignments[0]!;
  await labels.deleteLabel(actor, ids[0]!, 1, entryKey());
  await expect(commands.listAssignments(actor, { labelId: ids[0]! })).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect((await commands.listAssignments(actor, { subjectId, limit: 100 })).assignments).toHaveLength(31);
  await commands.assignLabel(actor, loser, { subjectId }, entryKey());
  await labels.restoreLabel(actor, ids[0]!, 2, entryKey());
  expect((await commands.listAssignments(actor, { labelId: ids[0]! })).assignments).toEqual([]);
  await expect(
    commands.restoreAssignment(actor, ids[0]!, { subjectId, assignmentId: a.id, revision: a.revision + 1 }, entryKey()),
  ).rejects.toMatchObject({ code: 'library_label_restore_capacity' });
}, 120000);

function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  return [...('Node Type' in value ? [value as Record<string, unknown>] : []), ...Object.values(value).flatMap(nodes)];
}
function plans(raw: Capture) {
  const catalogue = catalogStatementBound(raw);
  expect(catalogue.catalogStatements).toBeLessThanOrEqual(catalogue.allowedStatements);
  const all = raw.plans.flatMap(nodes);
  for (const node of all.filter(
    (n) => n.Schema === 'library' && ['personal_label', 'label_assignment'].includes(String(n['Relation Name'])),
  )) {
    if (['Seq Scan', 'Bitmap Heap Scan'].includes(String(node['Node Type']))) {
      const plan = raw.plans.find((candidate) => nodes(candidate).includes(node)) as
        | { 'Query Text'?: string }
        | undefined;
      throw new Error(
        `Unexpected ${String(node['Node Type'])} on library.${String(node['Relation Name'])}: ${JSON.stringify({
          query: plan?.['Query Text'],
          node,
        })}`,
      );
    }
    const rows =
      (Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0)) * Number(node['Actual Loops']);
    expect(rows).toBeLessThanOrEqual(node['Relation Name'] === 'personal_label' ? 33 : 32);
  }
  expect(all.some((n) => n['Index Name'] === 'label_assignment_reserved_source')).toBe(true);
  expect(all.some((n) => n['Index Name'] === 'label_assignment_owner_label')).toBe(true);
}

test('native assignment commands and both raw seek pages charge all pools at 64 512 4096 inactive histories and unrelated owners', async () => {
  const actor = (await f.identity(scopes)).actor,
    route = routeOf(actor.accountId)!;
  const other = (await f.identity(scopes, partitionOf(route))).actor;
  const subjectId = await f.createSubject('unprofiled');
  const id = (await labels.createLabel(actor, { name: 'Assignment growth target' }, entryKey())).value.label.id;
  let a = (await commands.assignLabel(actor, id, { subjectId }, entryKey())).value.assignment;
  const hidden = (await labels.createLabel(actor, { name: 'Assignment history template' }, entryKey())).value.label.id;
  const old = (await commands.assignLabel(actor, hidden, { subjectId }, entryKey())).value.assignment;
  await commands.unassignLabel(actor, hidden, { subjectId, assignmentId: old.id, revision: old.revision }, entryKey());
  const neighbour = (await labels.createLabel(other, { name: 'Assignment neighbour template' }, entryKey())).value.label
    .id;
  const otherA = (await commands.assignLabel(other, neighbour, { subjectId }, entryKey())).value.assignment;
  const template = async (accountId: string, labelId: string) => ({
    label: (
      await db.admin.query('SELECT * FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3', [
        routeOf(accountId),
        accountId,
        labelId,
      ])
    ).rows[0]!,
    assignment: (
      await db.admin.query(
        'SELECT * FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND label_id=$3 AND subject_id=$4',
        [routeOf(accountId), accountId, labelId, subjectId],
      )
    ).rows[0]!,
  });
  const history = await template(actor.accountId, hidden),
    unrelated = await template(other.accountId, neighbour);
  // Fill the positive source through real commands. This makes even a one-row page pay all 32 reserved keys.
  for (let n = 1; n < 32; n++) {
    const l = (await labels.createLabel(actor, { name: 'Growth reserved ' + n }, entryKey())).value.label.id;
    await commands.assignLabel(actor, l, { subjectId }, entryKey());
  }
  const extra = (await labels.createLabel(actor, { name: 'Growth rejected capacity' }, entryKey())).value.label.id;
  const reader = db.openPool({ options: '-c default_transaction_read_only=on' });
  const readOnly = createLabelAssignmentCommands({ pool: reader, access: f.access, tokens: f.tokens });
  async function operation() {
    expect((await commands.assignLabel(actor, id, { subjectId }, entryKey())).value.assignment).toEqual(a);
    await expect(commands.assignLabel(actor, extra, { subjectId }, entryKey())).rejects.toMatchObject({
      code: 'library_label_capacity',
    });
    const removed = await commands.unassignLabel(
      actor,
      id,
      { subjectId, assignmentId: a.id, revision: a.revision },
      entryKey(),
    );
    a = (
      await commands.restoreAssignment(
        actor,
        id,
        { subjectId, assignmentId: a.id, revision: removed.value.revision },
        entryKey(),
      )
    ).value.assignment;
    const first = await commands.listAssignments(actor, { subjectId, limit: 1 });
    expect(first.assignments).toHaveLength(1);
    expect(first.next).toBeTruthy();
    const next = await commands.listAssignments(actor, { subjectId, limit: 1, cursor: first.next! });
    expect(next.assignments).toHaveLength(1);
    expect(next.assignments[0]!.labelId).not.toBe(first.assignments[0]!.labelId);
    const labelFirst = await readOnly.listAssignments(actor, { labelId: id, limit: 1 });
    expect(labelFirst.assignments).toEqual([{ ...a, labelId: id, subjectId }]);
    expect(labelFirst.next).toBeTruthy();
    const sparse = await readOnly.listAssignments(actor, { labelId: id, limit: 1, cursor: labelFirst.next! });
    expect(sparse.assignments).toEqual([]);
    expect(sparse.next).toBeTruthy();
  }
  const evidence: unknown[] = [];
  const report = await checkGrowth(db, {
    name: 'native assignment full command and bounded pages',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await seed(
        database,
        {
          name: 'assignment native inactive history',
          hotPartition: partitionOf(route),
          hotShare: 1,
          rows(p) {
            const l = newId(route),
              s = newId(routeOf(subjectId)!);
            return {
              'library.personal_label': [
                { ...history.label, label_id: l, normalized_name: `History ${p.ordinal}` },
                { ...unrelated.label, label_id: l, normalized_name: `Other ${p.ordinal}` },
              ],
              'library.label_assignment': [
                { ...history.assignment, assignment_id: newId(route), label_id: l },
                { ...history.assignment, assignment_id: newId(route), label_id: id, subject_id: s },
                { ...unrelated.assignment, assignment_id: newId(route), label_id: l, subject_id: s },
              ],
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    async warmup(_database, scale) {
      const result = await capture(db, operation);
      plans(result.capture);
      evidence.push({ scale, capture: result.capture });
    },
    operation,
  });
  console.info(JSON.stringify({ report, evidence, otherAssignment: otherA.id }));
}, 1800000);
