import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import { ENTRY_RETENTION_SCHEDULE, ENTRY_RETENTION_SWEEP_WORKFLOW } from '../../src/library/entry-due-work.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture, work: Awaited<ReturnType<typeof composeWork>> | undefined;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let time: number | undefined;
const clock = () => new Date(time ?? Date.now());
const reader = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  options: '-c default_transaction_read_only=on',
});
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock });
  client = await createWorkClient(process.env.DATABASE_URL!);
}, 120000);
afterAll(async () => {
  await work?.shutdown();
  await client?.close();
  await f?.close();
  await reader.end();
});
async function retained(subjectId: string) {
  return (
    await reader.query(
      'SELECT deletion_id FROM library.entry_deleted WHERE route=$1 AND account_id=$2 AND subject_id=$3 ORDER BY deletion_id',
      [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, subjectId],
    )
  ).rows;
}
test('the default native Library worker automatically discovers original due entry archives after commit before enqueue and a real registered UTC schedule purges them without touching live replacement facts', async () => {
  const owner = f.owner.actor;
  const subjectId = await f.createSubject('record');
  const a = (await f.commands.putEntry(owner, subjectId, { state: 'listening' }, entryKey())).value.entry;
  time = Date.now();
  const deletedAt = time;
  const removed = await f.commands.deleteEntry(owner, subjectId, a.revision, entryKey(), a.incarnationId!);
  const replacement = (await f.commands.putEntry(owner, subjectId, { state: 'listening' }, entryKey())).value.entry;
  expect(replacement.incarnationId).not.toBe(a.incarnationId);
  expect(await retained(subjectId)).toEqual([{ deletion_id: removed.transactionId }]);
  time = deletedAt + 720 * 60 * 60 * 1000;
  // No worker/effect enqueued this archive: recovery must discover already-committed source.
  work = await composeWork([libraryWorkModule], {
    databaseUrl: process.env.DATABASE_URL!,
    pool: f.pool,
    client,
    clock,
    env: {},
  });
  await work.launch();
  const schedule = await client.getSchedule(ENTRY_RETENTION_SCHEDULE);
  expect(schedule).not.toBeNull();
  expect(schedule!.workflowName).toBe(ENTRY_RETENTION_SWEEP_WORKFLOW);
  expect(schedule!.schedule).toBe('*/10 * * * *');
  expect(schedule!.cronTimezone).toBe('UTC');
  const triggered = await client.triggerSchedule(ENTRY_RETENTION_SCHEDULE);
  await triggered.getResult({ pollingIntervalMs: 20 });
  const deadline = Date.now() + 120000;
  while ((await retained(subjectId)).length !== 0) {
    if (Date.now() >= deadline)
      throw new Error('Native registered retention schedule did not purge due committed archive');
    await Bun.sleep(20);
  }
  const live = await f.commands.readEntry(owner, subjectId);
  expect(live.incarnationId).toBe(replacement.incarnationId);
  expect(live.revision).toBe(replacement.revision);
  expect(live.state).toBe('listening');
  const events = (
    await reader.query(
      "SELECT data FROM core.outbox WHERE subject=$1 AND type='com.rezics.library.entry.purged.v1' AND data->>'deletionId'=$2",
      [owner.accountId, removed.transactionId],
    )
  ).rows;
  expect(events).toEqual([{ data: { deletionId: removed.transactionId } }]);
  const replayed = await client.triggerSchedule(ENTRY_RETENTION_SCHEDULE);
  await replayed.getResult({ pollingIntervalMs: 20 });
  expect(await retained(subjectId)).toEqual([]);
  expect((await f.commands.readEntry(owner, subjectId)).incarnationId).toBe(replacement.incarnationId);
}, 300000);
