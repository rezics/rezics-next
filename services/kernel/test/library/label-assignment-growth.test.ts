import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { setLabelAssignment, type SetLabelAssignmentResult } from '../../src/library/label-assignment-store.ts';
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
const expired = '2026-12-01T00:00:00.000Z';
const context = { transactionId: id(90), time: at };
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

function input(subject: number, label: number, account = 1) {
  return { route, accountId: id(account), subjectId: id(subject), labelId: id(label) };
}
function applied(result: SetLabelAssignmentResult) {
  expect(result.kind).toBe('applied');
  if (result.kind !== 'applied') throw new Error('Expected applied assignment');
  return result.assignment;
}
async function labels(c: PoolClient, start: number, count: number) {
  for (let n = start; n < start + count; n++)
    await insertPersonalLabel(c, route, { accountId: id(1), id: id(n), name: `Label ${n}` }, context);
}
async function fill(c: PoolClient, subject: number, start: number, count: number) {
  for (let n = 0; n < count; n++) applied(await setLabelAssignment(c, input(subject, start + n), context));
}
async function snapshot(c: PoolClient, subject: number) {
  return (
    await c.query(
      'SELECT * FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 ORDER BY label_id',
      [route, id(1), id(subject)],
    )
  ).rows;
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

// Only this test controller retries entire real transactions; the DAO never retries a statement.
async function command(subject: number, label: number): Promise<SetLabelAssignmentResult> {
  for (let attempt = 0; ; attempt++) {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await setLabelAssignment(c, input(subject, label), context);
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

test('native concurrent 32nd and 33rd claims serialize and duplicate races preserve one identity', async () => {
  const c = await db.admin.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await labels(c, 100, 34);
    await fill(c, 20, 100, 31);
    await fill(c, 21, 100, 31);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  const race = await Promise.all([command(20, 131), command(20, 132)]);
  expect(race.map((r) => r.kind).sort()).toEqual(['applied', 'capacity']);
  const duplicates = await Promise.all([command(21, 131), command(21, 131)]);
  expect(duplicates.map((r) => r.kind).sort()).toEqual(['applied', 'existing']);
  if (!('assignment' in duplicates[0]!) || !('assignment' in duplicates[1]!)) throw new Error('Missing identity');
  expect(duplicates[0].assignment).toEqual(duplicates[1].assignment);
  for (const subject of [20, 21]) {
    const result = await db.admin.query(
      'SELECT slot_no,assignment_id FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND slot_no IS NOT NULL',
      [route, id(1), id(subject)],
    );
    expect(result.rows).toHaveLength(32);
    expect(new Set(result.rows.map((r) => r.slot_no)).size).toBe(32);
    expect(new Set(result.rows.map((r) => r.assignment_id)).size).toBe(32);
  }
});

test('retained reassignment keeps identity and creation time; missing and legacy tuples write nothing', async () => {
  await rollback(async (c) => {
    await labels(c, 200, 5);
    const first = applied(await setLabelAssignment(c, input(22, 200), context));
    await c.query(
      "UPDATE library.label_assignment SET slot_no=NULL,deleted_at=$1,purge_after=$1::timestamptz+interval '720 hours',revision=revision+1 WHERE route=$2 AND account_id=$3 AND subject_id=$4 AND label_id=$5",
      [at, route, id(1), id(22), id(200)],
    );
    const assigned = applied(await setLabelAssignment(c, input(22, 200), { ...context, time: expired }));
    expect(assigned).toMatchObject({
      id: first.id,
      createdAt: first.createdAt,
      revision: 3,
      updatedAt: expired,
      deletedAt: null,
      purgeAfter: null,
    });
    // Physical erasure ends retained identity continuity.
    await c.query(
      'DELETE FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
      [route, id(1), id(22), id(200)],
    );
    expect(applied(await setLabelAssignment(c, input(22, 200), context)).id).not.toBe(first.id);
    await c.query(
      'INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,assignment_id,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,NULL,1,$5,$5,$6),($1,$2,$3,$7,gen_random_uuid(),1,$5,$5,$6)',
      [route, id(1), id(22), id(201), at, id(90), id(202)],
    );
    const before = await snapshot(c, 22);
    expect((await setLabelAssignment(c, input(22, 201), context)).kind).toBe('migration_required');
    expect((await setLabelAssignment(c, input(22, 202), context)).kind).toBe('migration_required');
    expect((await setLabelAssignment(c, input(22, 999), context)).kind).toBe('not_found');
    await deletePersonalLabel(c, route, id(1), id(203), 1, context);
    expect((await setLabelAssignment(c, input(22, 203), context)).kind).toBe('not_found');
    expect(await snapshot(c, 22)).toEqual(before);
    // UUID spelling cannot change the guard, parent lookup, or duplicate identity.
    const upper = await setLabelAssignment(
      c,
      {
        ...input(22, 200),
        accountId: id(1).toUpperCase(),
        subjectId: id(22).toUpperCase(),
        labelId: id(200).toUpperCase(),
      },
      context,
    );
    expect(upper.kind).toBe('existing');
  });
});

test('duplicate precedes reclaim; one expired parent deadline is inherited and rollback restores both claims', async () => {
  await rollback(async (c) => {
    await labels(c, 300, 34);
    await fill(c, 23, 300, 32);
    for (const n of [300, 301]) await deletePersonalLabel(c, route, id(1), id(n), 1, context);
    const before = await snapshot(c, 23);
    expect((await setLabelAssignment(c, input(23, 302), { ...context, time: expired })).kind).toBe('existing');
    expect(await snapshot(c, 23)).toEqual(before);
    await c.query('SAVEPOINT reclaim_pair');
    const created = applied(await setLabelAssignment(c, input(23, 332), { ...context, time: expired }));
    const after = await snapshot(c, 23);
    const changed = after.filter((row) => row.deleted_at !== null);
    expect(changed).toHaveLength(1);
    const victim = changed[0]!;
    const original = before.find((row) => row.assignment_id === victim.assignment_id)!;
    expect(victim).toMatchObject({
      assignment_id: original.assignment_id,
      created_at: original.created_at,
      revision: original.revision + 1,
      slot_no: null,
      transaction_id: context.transactionId,
    });
    expect(new Date(victim.deleted_at).toISOString()).toBe(at);
    expect(new Date(victim.purge_after).toISOString()).toBe('2026-11-27T00:00:00.000Z');
    expect(created.slotNo).toBe(original.slot_no);
    await c.query('ROLLBACK TO SAVEPOINT reclaim_pair');
    expect(await snapshot(c, 23)).toEqual(before);
    // Restoring a definition alone does not touch children, including an explicitly reclaimed claim.
    applied(await setLabelAssignment(c, input(23, 332), context));
    const reclaimed = (await snapshot(c, 23)).find((row) => row.deleted_at !== null)!;
    expect(await restorePersonalLabel(c, route, id(1), reclaimed.label_id, 2, context)).not.toBeNull();
    expect((await snapshot(c, 23)).find((row) => row.assignment_id === reclaimed.assignment_id)).toEqual(reclaimed);
  });
});

test('revision exhaustion is checked before reclaim and duplicate at maximum revision remains effect-free', async () => {
  await rollback(async (c) => {
    await labels(c, 400, 34);
    await fill(c, 24, 400, 32);
    await deletePersonalLabel(c, route, id(1), id(400), 1, context);
    await c.query(
      'UPDATE library.label_assignment SET revision=2147483647 WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
      [route, id(1), id(24), id(400)],
    );
    let before = await snapshot(c, 24);
    await expect(setLabelAssignment(c, input(24, 432), context)).rejects.toThrow('revision exhausted');
    expect(await snapshot(c, 24)).toEqual(before);
    await c.query(
      'UPDATE library.label_assignment SET revision=1 WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
      [route, id(1), id(24), id(400)],
    );
    const retained = applied(await setLabelAssignment(c, input(25, 433), context));
    await c.query(
      "UPDATE library.label_assignment SET subject_id=$1,slot_no=NULL,deleted_at=$2,purge_after=$2::timestamptz+interval '720 hours',revision=2147483647 WHERE route=$3 AND account_id=$4 AND assignment_id=$5",
      [id(24), at, route, id(1), retained.id],
    );
    before = await snapshot(c, 24);
    await expect(setLabelAssignment(c, input(24, 433), context)).rejects.toThrow('revision exhausted');
    expect(await snapshot(c, 24)).toEqual(before);
    await c.query(
      'UPDATE library.label_assignment SET revision=2147483647 WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4',
      [route, id(1), id(24), id(401)],
    );
    before = await snapshot(c, 24);
    expect((await setLabelAssignment(c, input(24, 401), context)).kind).toBe('existing');
    expect(await snapshot(c, 24)).toEqual(before);
  });
});

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value === null || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  return [...(typeof row['Node Type'] === 'string' ? [row] : []), ...Object.values(row).flatMap(nodes)];
}
function assertPlans(raw: Capture) {
  const plans = raw.plans.flatMap(nodes);
  for (const node of plans.filter((node) => node.Schema === 'library' && node['Relation Name'])) {
    expect(['Seq Scan', 'Bitmap Heap Scan']).not.toContain(node['Node Type']);
  }
  const source = plans.filter((node) => node['Index Name'] === 'label_assignment_reserved_source');
  expect(source.length).toBeGreaterThan(0);
  for (const node of source) expect(Number(node['Actual Rows']) * Number(node['Actual Loops'])).toBeLessThanOrEqual(32);
  const parent = plans.filter(
    (node) => node['Relation Name'] === 'personal_label' && typeof node['Index Name'] === 'string',
  );
  for (const node of parent) expect(Number(node['Actual Rows']) * Number(node['Actual Loops'])).toBeLessThanOrEqual(33);
}

async function growHistory(scale: number, previous: number) {
  const uuid = (expression: string) => `('00000000-0000-7000-8000-6c76'||lpad(to_hex(${expression}),8,'0'))::uuid`;
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
  // Legally distributed unrelated owners have only 32 reservations each; no planner settings are forced.
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

async function admissionOperation() {
  await rollback(async (c) => {
    expect((await setLabelAssignment(c, input(30, 502), context)).kind).toBe('existing');
    expect((await setLabelAssignment(c, input(31, 534), context)).kind).toBe('capacity');
    applied(await setLabelAssignment(c, input(30, 534), { ...context, time: expired }));
    const first = applied(await setLabelAssignment(c, input(32, 535), context));
    expect(await setLabelAssignment(c, input(32, 535), context)).toEqual({ kind: 'existing', assignment: first });
    expect((await setLabelAssignment(c, input(30, 500), context)).kind).toBe('not_found');
    expect((await setLabelAssignment(c, input(30, 999), context)).kind).toBe('not_found');
  });
}

test('native admission all-pool SQL plans remain bounded at 64 512 4096 inactive same-subject histories', async () => {
  const c = await db.admin.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await labels(c, 500, 37);
    await fill(c, 30, 500, 32);
    await fill(c, 31, 502, 32);
    await fill(c, 32, 502, 31);
    await deletePersonalLabel(c, route, id(1), id(500), 1, context);
    await deletePersonalLabel(c, route, id(1), id(501), 1, context);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  const evidence = new Map<number, unknown>();
  const report = await checkGrowth(db, {
    name: 'private label set admission including duplicates rejections reclaim and rollback',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: (_db, scale, previous) => growHistory(scale, previous),
    async warmup(_db, scale) {
      const measured = await capture(db, admissionOperation);
      assertPlans(measured.capture);
      evidence.set(scale, {
        cost: costOf(measured.capture),
        statements: measured.capture.statements,
        plans: measured.capture.plans.map((plan) =>
          nodes(plan).map((node) =>
            Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'Plans' && key !== 'Output')),
          ),
        ),
      });
    },
    operation: admissionOperation,
  });
  for (const sample of report.samples) {
    expect(sample.cost.relations['library.label_assignment']?.sequentialScans ?? 0).toBe(0);
    expect(sample.cost.relations['library.personal_label']?.sequentialScans ?? 0).toBe(0);
  }
  console.info(JSON.stringify({ name: report.name, samples: report.samples, evidence: [...evidence] }));
}, 1_800_000);
