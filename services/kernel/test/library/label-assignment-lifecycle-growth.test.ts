import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import {
  readStoredLabelAssignment as read,
  restoreStoredLabelAssignment as restore,
  unassignStoredLabelAssignment as unassign,
} from '../../src/library/label-assignment-lifecycle-store.ts';
import { setLabelAssignment as set, type SetLabelAssignmentResult } from '../../src/library/label-assignment-store.ts';
import { deletePersonalLabel, insertPersonalLabel, restorePersonalLabel } from '../../src/library/label-store.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  type Capture,
  type GrowthDatabase,
} from '../support/growth.ts';

const route = 0x6c76;
const id = (n: number) => `00000000-0000-7000-8000-6c76${n.toString(16).padStart(8, '0')}`;
const at = '2026-10-28T00:00:00.000Z';
const later = '2026-10-29T00:00:00.000Z';
const context = { transactionId: id(90), time: at };
const undoContext = { transactionId: id(91), time: later };
const tuple = (subject: number, label: number) => ({
  route,
  accountId: id(1),
  subjectId: id(subject),
  labelId: id(label),
});
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

function applied(result: SetLabelAssignmentResult) {
  if (result.kind !== 'applied') throw new Error(`Expected applied, got ${result.kind}`);
  return result.assignment;
}
async function labels(c: PoolClient, start: number, count: number) {
  for (let n = start; n < start + count; n++)
    await insertPersonalLabel(c, route, { accountId: id(1), id: id(n), name: `Lifecycle ${n}` }, context);
}
async function rollback<T>(body: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    return await body(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
async function archived(c: PoolClient, subject: number, label: number) {
  const t = tuple(subject, label);
  const a = applied(await set(c, t, context));
  expect((await unassign(c, { ...t, assignmentId: a.id, revision: a.revision }, context)).kind).toBe('applied');
  return { ...t, assignmentId: a.id, revision: a.revision + 1 };
}

test('private tuple reads and CAS reject foreign owners, stale episodes and legacy identity without parent work', async () => {
  await rollback(async (c) => {
    await labels(c, 100, 4);
    const t = tuple(2, 100);
    const a = applied(await set(c, t, context));
    const key = { ...t, assignmentId: a.id, revision: a.revision };
    for (const foreign of [{ accountId: id(3) }, { subjectId: id(3) }, { route: route + 1 }, { labelId: id(999) }]) {
      expect(await read(c, { ...t, ...foreign })).toBeNull();
      expect((await unassign(c, { ...key, ...foreign }, context)).kind).toBe('not_found');
      expect((await restore(c, { ...key, ...foreign }, context)).kind).toBe('not_found');
    }
    expect((await unassign(c, { ...key, assignmentId: id(999) }, context)).kind).toBe('stale');
    expect((await unassign(c, { ...key, revision: 2 }, context)).kind).toBe('stale');
    expect((await restore(c, key, context)).kind).toBe('stale');
    const parent = await deletePersonalLabel(c, route, id(1), id(100), 1, context);
    const removed = await unassign(c, { ...key, assignmentId: a.id.toUpperCase() }, undoContext);
    expect(removed.kind).toBe('applied');
    const tomb = (await read(c, t))!;
    expect(tomb).toEqual({
      ...t,
      id: a.id,
      revision: 2,
      slotNo: null,
      createdAt: a.createdAt,
      updatedAt: later,
      deletedAt: later,
      purgeAfter: '2026-11-28T00:00:00.000Z',
      transactionId: id(91),
    });
    expect((await unassign(c, { ...key, revision: 2 }, undoContext)).kind).toBe('stale');
    const undo = { ...key, revision: 2 };
    expect((await restore(c, undo, undoContext)).kind).toBe('not_found');
    expect(await read(c, t)).toEqual(tomb);
    await restorePersonalLabel(c, route, id(1), id(100), parent!.revision, undoContext);
    expect(await read(c, t)).toEqual(tomb);
    expect((await restore(c, undo, context)).kind).toBe('stale');
    expect((await restore(c, undo, { ...context, time: tomb.purgeAfter! })).kind).toBe('expired');
    expect((await restore(c, undo, undoContext)).kind).toBe('applied');
    expect((await restore(c, undo, undoContext)).kind).toBe('stale');
    expect((await unassign(c, key, undoContext)).kind).toBe('stale');
    expect((await unassign(c, { ...key, revision: 3 }, undoContext)).kind).toBe('applied');
    expect((await restore(c, undo, undoContext)).kind).toBe('stale');
    await c.query(
      `INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,assignment_id,revision,
      created_at,updated_at,transaction_id,deleted_at,purge_after)
      VALUES($1,$2,$3,$4,NULL,1,$6,$6,$7,NULL,NULL),
            ($1,$2,$3,$5,NULL,2,$6,$6,$7,$6,$6::timestamptz+interval '720 hours')`,
      [route, id(1), id(2), id(101), id(102), at, id(90)],
    );
    for (const [label, revision] of [
      [101, 1],
      [102, 2],
    ]) {
      const legacy = { ...tuple(2, label!), assignmentId: id(999), revision: revision! };
      const before = await read(c, legacy);
      expect(before!.id).toBeNull();
      expect((await unassign(c, legacy, context)).kind).toBe('migration_required');
      expect((await restore(c, legacy, context)).kind).toBe('migration_required');
      expect(await read(c, legacy)).toEqual(before);
    }
  });
});

test('native microsecond window boundaries and revision exhaustion fail closed before admission maintenance', async () => {
  await rollback(async (c) => {
    await labels(c, 200, 34);
    const key = await archived(c, 4, 200);
    await c.query(
      `UPDATE library.label_assignment SET deleted_at=$1,purge_after=$1::timestamptz+interval '720 hours',
      updated_at=$1 WHERE route=$2 AND account_id=$3 AND subject_id=$4 AND label_id=$5`,
      ['2026-10-28T00:00:00.000123Z', route, id(1), id(4), id(200)],
    );
    const before = (await read(c, key))!;
    expect(before.deletedAt).toBe('2026-10-28T00:00:00.000123Z');
    expect(before.purgeAfter).toBe('2026-11-27T00:00:00.000123Z');
    expect((await restore(c, key, { ...context, time: '2026-10-28T00:00:00.000122Z' })).kind).toBe('stale');
    expect((await restore(c, key, { ...context, time: before.purgeAfter! })).kind).toBe('expired');
    expect(await read(c, key)).toEqual(before);
    expect((await restore(c, key, { ...context, time: '2026-11-27T00:00:00.000122Z' })).kind).toBe('applied');
    await c.query(
      'UPDATE library.label_assignment SET revision=2147483647 WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
      [route, id(1), id(4), id(200)],
    );
    const live = await read(c, key);
    await expect(unassign(c, { ...key, revision: 2147483647 }, context)).rejects.toBeInstanceOf(RangeError);
    expect(await read(c, key)).toEqual(live);
    // A maximum-revision archive must not reclaim a deleted parent's slot before rejecting the increment.
    const max = await archived(c, 5, 200);
    for (let n = 201; n <= 232; n++) applied(await set(c, tuple(5, n), context));
    await deletePersonalLabel(c, route, id(1), id(201), 1, context);
    const victim = await read(c, tuple(5, 201));
    await c.query(
      'UPDATE library.label_assignment SET revision=2147483647 WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
      [route, id(1), id(5), id(200)],
    );
    const archive = await read(c, max);
    await expect(restore(c, { ...max, revision: 2147483647 }, context)).rejects.toBeInstanceOf(RangeError);
    expect(await read(c, max)).toEqual(archive);
    expect(await read(c, tuple(5, 201))).toEqual(victim);
  });
});

// The controller retries only complete native transactions, including failures at COMMIT.
async function command<T>(body: (c: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await body(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      if (attempt >= 7 || !['40001', '23505'].includes((error as { code: string }).code)) throw error;
    } finally {
      c.release();
    }
  }
}

test('native concurrent undo unassign reassign and erased-identity races preserve exact CAS and 32 slots', async () => {
  const c = await db.admin.connect();
  let key: Awaited<ReturnType<typeof archived>>;
  let old: Awaited<ReturnType<typeof archived>>;
  let liveKey: Awaited<ReturnType<typeof archived>>;
  try {
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await labels(c, 300, 34);
    key = await archived(c, 60, 300);
    old = await archived(c, 61, 300);
    const live = applied(await set(c, tuple(62, 300), context));
    liveKey = { ...tuple(62, 300), assignmentId: live.id, revision: live.revision };
    for (let n = 301; n <= 331; n++) applied(await set(c, tuple(60, n), context));
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  const measured = await capture(
    db,
    async () => {
      const race = await Promise.all([
        command((c) => restore(c, key, undoContext)),
        command((c) => restore(c, key, undoContext)),
        command((c) => unassign(c, key, undoContext)),
        command((c) => set(c, key, undoContext)),
        command((c) => set(c, tuple(60, 332), undoContext)),
      ]);
      expect(race[2]!.kind).toBe('stale');
      expect(race.slice(0, 2).filter((r) => r.kind === 'applied').length).toBeLessThanOrEqual(1);
      expect(race.every((r) => ['applied', 'stale', 'existing', 'capacity'].includes(r.kind))).toBe(true);
      const removals = await Promise.all([
        command((c) => unassign(c, liveKey, undoContext)),
        command((c) => unassign(c, liveKey, undoContext)),
        command((c) => set(c, liveKey, undoContext)),
        command((c) => restore(c, { ...liveKey, revision: 2 }, undoContext)),
      ]);
      expect(removals.slice(0, 2).filter((r) => r.kind === 'applied')).toHaveLength(1);
      const retained = await db.pool.query(
        'SELECT assignment_id FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
        [route, id(1), id(62), id(300)],
      );
      expect(retained.rows[0]!.assignment_id).toBe(liveKey.assignmentId);
      // Erasure permits revision 1 with a new identity; concurrent old commands cannot address it.
      await command((c) =>
        c.query(
          'DELETE FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
          [route, id(1), id(61), id(300)],
        ),
      );
      const stale = { ...old, revision: 1 };
      const newEpisode = await Promise.all([
        command((c) => set(c, old, undoContext)),
        command((c) => unassign(c, stale, undoContext)),
        command((c) => restore(c, stale, undoContext)),
      ]);
      expect(applied(newEpisode[0]!).id).not.toBe(old.assignmentId);
      for (const result of newEpisode.slice(1)) expect(['not_found', 'stale']).toContain(result.kind);
    },
    { includeBackends: true },
  );
  expect(new Set(measured.capture.statementBackends).size).toBeGreaterThan(1);
  const rows = (
    await db.admin.query(
      'SELECT slot_no,assignment_id FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND slot_no IS NOT NULL',
      [route, id(1), id(60)],
    )
  ).rows;
  expect(rows).toHaveLength(32);
  expect(new Set(rows.map((r) => r.slot_no)).size).toBe(32);
  expect(new Set(rows.map((r) => r.assignment_id)).size).toBe(32);
  console.info(
    JSON.stringify({
      name: 'native lifecycle races all-pool including retries',
      cost: costOf(measured.capture),
      ...measured.capture,
    }),
  );
});

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value === null || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  return [...(typeof row['Node Type'] === 'string' ? [row] : []), ...Object.values(row).flatMap(nodes)];
}
function assertPlans(raw: Capture, admission: boolean) {
  const plans = raw.plans.flatMap(nodes);
  const source = plans.filter((n) => n['Index Name'] === 'label_assignment_reserved_source');
  expect(source.length > 0).toBe(admission);
  for (const n of plans.filter((n) => n.Schema === 'library' && n['Relation Name'])) {
    expect(['Seq Scan', 'Bitmap Heap Scan']).not.toContain(n['Node Type']);
    const touched =
      (Number(n['Actual Rows'] ?? 0) +
        Number(n['Rows Removed by Filter'] ?? 0) +
        Number(n['Rows Removed by Index Recheck'] ?? 0)) *
      Number(n['Actual Loops']);
    if (n['Index Name'] === 'label_assignment_reserved_source') expect(touched).toBeLessThanOrEqual(32);
    else if (n['Relation Name'] === 'personal_label') expect(touched).toBeLessThanOrEqual(33);
    else if (String(n['Node Type']).includes('Scan')) expect(touched).toBeLessThanOrEqual(1);
    if (n['Index Name'] === 'label_assignment_identity') expect(String(n['Index Cond'])).toContain('assignment_id');
  }
  const guards = raw.statements.filter((s) => s.includes('pg_advisory_xact_lock'));
  expect(guards.length).toBeGreaterThan(0);
  if (!admission) {
    expect(raw.statements.some((s) => s.includes('personal_label'))).toBe(false);
    expect(guards).toHaveLength(1);
  } else expect(guards.length).toBeGreaterThanOrEqual(2);
}

let undo: Awaited<ReturnType<typeof archived>>;
let full: Awaited<ReturnType<typeof archived>>;
let reclaim: Awaited<ReturnType<typeof archived>>;
async function setupGrowth() {
  const c = await db.admin.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await labels(c, 500, 36);
    undo = await archived(c, 30, 500);
    full = await archived(c, 31, 500);
    reclaim = await archived(c, 32, 500);
    for (const subject of [31, 32]) for (let n = 501; n <= 532; n++) applied(await set(c, tuple(subject, n), context));
    await deletePersonalLabel(c, route, id(1), id(501), 1, context);
    // Only one subject has a reclaimable parent; restore it for the full-capacity subject's reservation.
    const replacement = applied(await set(c, tuple(31, 533), context));
    expect(replacement.slotNo).toBeGreaterThanOrEqual(0);
    await restorePersonalLabel(c, route, id(1), id(501), 2, context);
    await deletePersonalLabel(c, route, id(1), id(532), 1, context);
    // Swap the full-capacity subject away from the second hidden parent as well.
    applied(await set(c, tuple(31, 534), context));
    await c.query(
      `INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,assignment_id,revision,
      created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,NULL,1,$5,$5,$6)`,
      [route, id(1), id(30), id(535), at, id(90)],
    );
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}
async function unassignOperation() {
  await rollback(async (c) => {
    const t = tuple(32, 502);
    const live = (await read(c, t))!;
    const key = { ...t, assignmentId: live.id!, revision: live.revision };
    expect((await unassign(c, key, undoContext)).kind).toBe('applied');
  });
}
async function restoreOperation() {
  await rollback(async (c) => {
    expect((await restore(c, { ...undo, labelId: id(999) }, undoContext)).kind).toBe('not_found');
    expect((await restore(c, { ...undo, assignmentId: id(999) }, undoContext)).kind).toBe('stale');
    expect((await restore(c, { ...undo, labelId: id(535), revision: 1 }, undoContext)).kind).toBe('migration_required');
    expect((await restore(c, undo, { ...context, time: '2026-11-27T00:00:00.000Z' })).kind).toBe('expired');
    expect((await restore(c, undo, { ...context, time: '2026-10-27T00:00:00.000Z' })).kind).toBe('stale');
    const before = await read(c, full);
    expect((await restore(c, full, undoContext)).kind).toBe('capacity');
    expect(await read(c, full)).toEqual(before);
    expect((await restore(c, undo, undoContext)).kind).toBe('applied');
    expect((await restore(c, reclaim, undoContext)).kind).toBe('applied');
    const victim = (await read(c, tuple(32, 532)))!;
    expect(victim.deletedAt).toBe(at);
    expect(victim.purgeAfter).toBe('2026-11-27T00:00:00.000Z');
    expect(victim.slotNo).toBeNull();
    expect(
      (await restore(c, { ...tuple(32, 532), assignmentId: victim.id!, revision: victim.revision }, undoContext)).kind,
    ).toBe('not_found');
    expect(await read(c, tuple(32, 532))).toEqual(victim);
    await restorePersonalLabel(c, route, id(1), id(532), 2, undoContext);
    expect(await read(c, tuple(32, 532))).toEqual(victim);
  });
}
async function growHistory(scale: number, previous: number) {
  const uuid = (s: string) => `('00000000-0000-7000-8000-6c76'||lpad(to_hex(${s}),8,'0'))::uuid`;
  await db.admin.query(
    `INSERT INTO library.personal_label(route,account_id,label_id,normalized_name,revision,created_at,updated_at,transaction_id)
    SELECT $1,$2,${uuid('10000+n')},'History '||n,1,$3,$3,$4 FROM generate_series($5::int+1,$6::int) n`,
    [route, id(1), at, id(90), previous, scale],
  );
  await db.admin.query(
    `INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,revision,created_at,updated_at,transaction_id,deleted_at,purge_after)
    SELECT $1,$2,s,${uuid('10000+n')},2,$3,$3,$4,$3,$3::timestamptz+interval '720 hours'
    FROM generate_series($5::int+1,$6::int) n CROSS JOIN unnest($7::uuid[]) s`,
    [route, id(1), at, id(90), previous, scale, [id(30), id(31), id(32)]],
  );
}
async function growOwners(scale: number, previous: number) {
  const uuid = (s: string) => `('00000000-0000-7000-8000-6c76'||lpad(to_hex(${s}),8,'0'))::uuid`;
  await db.admin.query(
    `INSERT INTO library.personal_label(route,account_id,label_id,normalized_name,revision,created_at,updated_at,transaction_id)
    SELECT $1,${uuid('100000+n')},${uuid('200000+k')},'Noise '||k,1,$2,$2,$3
    FROM generate_series($4::int+1,$5::int) n CROSS JOIN generate_series(0,31) k`,
    [route, at, id(90), previous, scale],
  );
  await db.admin.query(
    `INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,revision,slot_no,created_at,updated_at,transaction_id)
    SELECT $1,${uuid('100000+n')},$2,${uuid('200000+k')},1,k,$3,$3,$4
    FROM generate_series($5::int+1,$6::int) n CROSS JOIN generate_series(0,31) k`,
    [route, id(30), at, id(90), previous, scale],
  );
}

test('native lifecycle all-pool plans rows loops removals blocks and statements stay bounded at 64 512 4096 histories and unrelated owners', async () => {
  await setupGrowth();
  // Hold the other dimension at a real scale while each series grows independently.
  await growHistory(64, 0);
  for (const [dimension, grow] of [
    ['unrelated parents and owners', growOwners],
    ['inactive history', growHistory],
  ] as const) {
    const report = await checkGrowth(db, {
      name: `private assignment unassign and restore by ${dimension}`,
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: (_db, scale, previous) => grow(scale, dimension === 'inactive history' ? Math.max(64, previous) : previous),
      async warmup(_db, scale) {
        for (const [name, operation, admission] of [
          ['unassign', unassignOperation, false],
          ['restore', restoreOperation, true],
        ] as const) {
          const measured = await capture(db, operation);
          console.info(JSON.stringify({ dimension, name, scale, cost: costOf(measured.capture), ...measured.capture }));
          assertPlans(measured.capture, admission);
        }
      },
      async operation() {
        await unassignOperation();
        await restoreOperation();
      },
    });
    for (const sample of report.samples) {
      expect(sample.cost.relations['library.label_assignment']?.sequentialScans ?? 0).toBe(0);
      expect(sample.cost.relations['library.personal_label']?.sequentialScans ?? 0).toBe(0);
    }
    console.info(JSON.stringify(report));
  }
}, 1_800_000);
