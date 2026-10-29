import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createSessionCommands, ProgressConflictError } from '../../src/library/sessions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { compileSessionProfile, sessionScopes } from './support/session-profile-fixture.ts';
import { seedSessionActivityBackground, seedSessionActivityReceipts } from './support/session-activity-background.ts';

let db: GrowthDatabase;
let native: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let commands: ReturnType<typeof createSessionCommands>;
let time = Date.now();
const tick = () => {
  time += 1000;
  return new Date(time).toISOString();
};
const input = (subjectId: string, mode = 'scalar_amount', unit = 'minute') => ({ subjectId, mode, unit });
const route = () => routeOf(owner.actor.accountId)!;

beforeAll(async () => {
  db = await openGrowthDatabase();
  native = await createProfileEntryFixture({ pool: db.pool, clock: () => new Date(time) });
  owner = await native.identity([...sessionScopes, 'library_entry:update', 'library_entry:read']);
  await native.activate(await native.publish(await compileSessionProfile()));
  commands = createSessionCommands({ ...native, clock: () => new Date(time) });
}, 120_000);
afterAll(async () => {
  await native?.close();
  await db?.close();
});

async function shelf(subjectId: string) {
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const args = [route(), owner.actor.accountId, subjectId];
    const head = (
      await client.query(
        'SELECT to_jsonb(h) AS row FROM library.progress_head h WHERE route=$1 AND account_id=$2 AND subject_id=$3',
        args,
      )
    ).rows;
    const entry = (
      await client.query(
        "SELECT to_jsonb(e) - 'activity_at' - 'finished_at' AS identity, activity_at, finished_at FROM library.entry e WHERE route=$1 AND account_id=$2 AND subject_id=$3",
        args,
      )
    ).rows;
    await client.query('COMMIT');
    return { head, entry };
  } finally {
    client.release();
  }
}
function changed(snapshot: Awaited<ReturnType<typeof shelf>>) {
  expect(snapshot.head).toHaveLength(1);
  return new Date(snapshot.head[0]!.row.last_changed_at).toISOString();
}

test('native session activity binds exact owner subject head and existing entry without changing entry identity', async () => {
  const subject = await native.createSubject('game');
  await native.commands.putEntry(owner.actor, subject, { state: 'planned' }, entryKey());
  const before = await shelf(subject);
  const identity = before.entry[0]!.identity;
  const createKey = entryKey();
  const startedAt = tick();
  const start = await commands.startSession(owner.actor, input(subject), createKey);
  expect(changed(await shelf(subject))).toBe(startedAt);
  expect((await shelf(subject)).entry[0]!.identity).toEqual(identity);
  const recordKey = entryKey();
  const recordAt = tick();
  await commands.recordProgress(owner.actor, start.value.id, { revision: 1, amount: '4' }, recordKey);
  const recorded = await shelf(subject);
  expect(changed(recorded)).toBe(recordAt);
  expect(recorded.entry[0]!.activity_at.toISOString()).toBe(recordAt);
  expect(recorded.entry[0]!.identity).toEqual(identity);
  tick();
  expect((await commands.startSession(owner.actor, input(subject), createKey)).replayed).toBe(true);
  expect(
    (await commands.recordProgress(owner.actor, start.value.id, { revision: 1, amount: '4' }, recordKey)).replayed,
  ).toBe(true);
  await expect(
    commands.recordProgress(owner.actor, start.value.id, { revision: 1, amount: '5' }, entryKey()),
  ).rejects.toBeInstanceOf(ProgressConflictError);
  expect(await shelf(subject)).toEqual(recorded);
  const completeAt = tick();
  await commands.completeSession(owner.actor, start.value.id, { revision: 2 }, entryKey());
  const completed = await shelf(subject);
  expect(changed(completed)).toBe(completeAt);
  expect(completed.entry[0]!.identity).toEqual(identity);
  expect(completed.entry[0]!.finished_at.toISOString()).toBe(completeAt);
  expect(new Date(completed.head[0]!.row.last_completed_at).toISOString()).toBe(completeAt);
});

test('entryless scalar cursor sparse and accepted equal intents retain exact identities and raise activity', async () => {
  const subject = await native.createSubject('game');
  const scalar = await commands.startSession(owner.actor, input(subject), entryKey());
  const cursor = await commands.startSession(owner.actor, input(subject, 'cursor_position', 'marker'), entryKey());
  const sparse = await commands.startSession(owner.actor, input(subject, 'completed_units', 'plot'), entryKey());
  expect(new Set([scalar.value.id, cursor.value.id, sparse.value.id]).size).toBe(3);
  await commands.recordProgress(owner.actor, scalar.value.id, { revision: 1, amount: '4' }, entryKey());
  await commands.recordProgress(
    owner.actor,
    cursor.value.id,
    { revision: 1, locator: 'exact:opaque', position: '101.123456' },
    entryKey(),
  );
  await commands.recordProgress(owner.actor, sparse.value.id, { revision: 1, add: ['1', '3', '7'] }, entryKey());
  for (const [session, value] of [
    [scalar.value, { amount: '4' }],
    [sparse.value, { add: ['3'] }],
    [sparse.value, { remove: ['2'] }],
  ] as const) {
    const at = tick();
    const revision = (await commands.readSession(owner.actor, session.id)).revision;
    await commands.recordProgress(owner.actor, session.id, { revision, ...value }, entryKey());
    expect(changed(await shelf(subject))).toBe(at);
  }
  expect((await commands.readSession(owner.actor, scalar.value.id)).amount).toBe('4');
  expect(await commands.readSession(owner.actor, cursor.value.id)).toMatchObject({
    locator: 'exact:opaque',
    position: '101.123456',
  });
  expect((await commands.readSession(owner.actor, sparse.value.id)).completedUnitCount).toBe(3);
  const rows = (
    await db.admin.query(
      'SELECT unit_id FROM library.progress_unit WHERE route=$1 AND session_id=$2 ORDER BY unit_id',
      [route(), sparse.value.id],
    )
  ).rows;
  expect(rows.map((r) => r.unit_id)).toEqual(['1', '3', '7']);
  expect((await commands.listChanges(owner.actor, sparse.value.id)).changes.map((c) => c.intent)).toEqual([
    { add: ['1', '3', '7'] },
    { add: ['3'] },
    { remove: ['2'] },
  ]);
  const at = tick();
  await commands.abandonSession(owner.actor, cursor.value.id, { revision: 2 }, entryKey());
  const snapshot = await shelf(subject);
  expect(changed(snapshot)).toBe(at);
  expect(snapshot.head[0]!.row.last_completed_at).toBeNull();
  expect(snapshot.entry).toEqual([]);
});

test('native writers wait on the subject head before acquiring the session lock', async () => {
  const subject = await native.createSubject('game');
  const session = await commands.startSession(owner.actor, input(subject), entryKey());
  const holder = await db.admin.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN');
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await holder.query(
      'SELECT subject_id FROM library.progress_head WHERE route=$1 AND account_id=$2 AND subject_id=$3 FOR UPDATE',
      [route(), owner.actor.accountId, subject],
    );
    pending = commands.recordProgress(owner.actor, session.value.id, { revision: 1, amount: '1' }, entryKey());
    void pending.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
      blocked = (
        await db.admin.query(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked',
          [pid],
        )
      ).rows[0]!.blocked;
      if (!blocked) await Bun.sleep(5);
    }
    expect(blocked).toBe(true);
    // NOWAIT would fail if the pending native writer had taken its session lock first.
    expect(
      (
        await holder.query(
          'SELECT session_id FROM library.progress_session WHERE route=$1 AND session_id=$2 FOR UPDATE NOWAIT',
          [route(), session.value.id],
        )
      ).rows,
    ).toHaveLength(1);
    await holder.query('COMMIT');
    await pending;
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await pending;
  }
}, 30_000);

test('profiled session head activity point work remains constant across unrelated same-owner sessions heads and history', async () => {
  const subject = await native.createSubject('game');
  await native.commands.putEntry(owner.actor, subject, { state: 'planned' }, entryKey());
  // A fixed foreign-owner population keeps every scale on the same physical point-read path.
  // It never adds work to the measured commands or changes the same-owner growth axis.
  const foreign = newId(route());
  await seedSessionActivityBackground(db, route(), foreign, 4096, new Date(time));
  await seedSessionActivityReceipts(db, route(), foreign);
  const report = await checkGrowth(db, {
    name: 'native profiled session activity journey',
    rule: 'series',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 3,
    async grow(database, scale, previous) {
      await seedSessionActivityBackground(database, route(), owner.actor.accountId, scale - previous, new Date(time));
    },
    async operation() {
      tick();
      const first = await commands.startSession(owner.actor, input(subject), entryKey());
      tick();
      await commands.recordProgress(owner.actor, first.value.id, { revision: 1, amount: '4' }, entryKey());
      tick();
      await commands.completeSession(owner.actor, first.value.id, { revision: 2 }, entryKey());
      tick();
      const second = await commands.startSession(owner.actor, input(subject), entryKey());
      tick();
      await commands.abandonSession(owner.actor, second.value.id, { revision: 1 }, entryKey());
    },
  });
  expect(report.rule).toBe('series');
  expect(report.samples.map((s) => s.scale)).toEqual([64, 512, 4096]);
  for (const sample of report.samples)
    for (const [relation, cost] of Object.entries(sample.cost.relations))
      if (relation.startsWith('library.progress_') || relation === 'core.receipt')
        expect(cost.sequentialScans, `${relation} at ${sample.scale}`).toBe(0);
}, 120_000);
