import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ENTRY_RETENTION_SCHEDULE } from '../../src/library/entry-due-work.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { routeOf } from '../../src/route/route.ts';
import { archive, deletionKey } from './entry-retention-worker-runtime.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
let time = Date.now();
let client: Awaited<ReturnType<typeof createWorkClient>>;
const executor = `entry-retention-crash-${crypto.randomUUID()}`;
const directory = resolve(import.meta.dir, '../../../../.temp/entry-retention', executor);
const timePath = resolve(directory, 'clock');
const children: ReturnType<typeof runtime>[] = [];
beforeAll(async () => {
  mkdirSync(directory, { recursive: true });
  f = await createProfileEntryFixture({ clock: () => new Date(time) });
  client = await createWorkClient(process.env.DATABASE_URL!);
}, 120000);
afterAll(async () => {
  for (const child of children) {
    if (child.process.exitCode === null) child.process.kill('SIGKILL');
    await child.process.exited;
  }
  await client?.close();
  await f?.close();
});

function runtime(mode: string) {
  const child = Bun.spawn(
    [process.execPath, `${import.meta.dir}/entry-retention-worker-runtime.ts`, mode, executor, timePath],
    {
      env: process.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let output = '';
  let errors = '';
  void (async () => {
    for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
  })();
  void (async () => {
    for await (const chunk of child.stderr) errors += new TextDecoder().decode(chunk);
  })();
  const result = {
    process: child,
    async until(marker: string) {
      const end = Date.now() + 120000;
      while (!output.includes(marker)) {
        if (child.exitCode !== null || Date.now() >= end) throw new Error(`Missing ${marker}: ${output}\n${errors}`);
        await Bun.sleep(20);
      }
    },
  };
  children.push(result);
  return result;
}
async function count(deletionId: string) {
  return Number(
    (
      await f.pool.query(
        'SELECT count(*) FROM library.entry_deleted WHERE route=$1 AND account_id=$2 AND deletion_id=$3',
        [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, deletionId],
      )
    ).rows[0].count,
  );
}
async function waitGone(deletionId: string) {
  const end = Date.now() + 120000;
  while (await count(deletionId)) {
    if (Date.now() >= end) throw new Error('Recovered scheduled worker did not consume due archive');
    await Bun.sleep(20);
  }
}

test('native commit before DBOS page checkpoint recovers on the same executor and workflow without a second effect', async () => {
  const subject = await f.createSubject('game');
  const k = await archive(f, subject);
  const replacement = (await f.commands.putEntry(f.owner.actor, subject, { state: 'planned' }, entryKey())).value.entry;
  writeFileSync(timePath, String(Date.parse(k.restoreUntil)));
  const first = runtime('crash');
  await first.until('worker-ready');
  const triggered = await client.triggerSchedule(ENTRY_RETENTION_SCHEDULE);
  await first.until('native-committed');
  expect(await count(k.deletionId)).toBe(0);
  const before = await f.pool.query(
    'SELECT response FROM core.receipt WHERE principal_id=$1 AND command_kind=$2 AND idempotency_key=$3',
    [k.accountId, 'library.entry.retention.purge', k.deletionId],
  );
  expect(before.rows).toEqual([{ response: { purged: true } }]);
  const checkpoints = await client.listWorkflowSteps(triggered.workflowID);
  expect(checkpoints?.every((s) => !JSON.stringify(s.output ?? null).includes(k.deletionId))).toBe(true);
  first.process.kill('SIGKILL');
  await first.process.exited;
  const recovered = runtime('recover');
  await recovered.until('worker-ready');
  await triggered.getResult({ pollingIntervalMs: 20 });
  await waitGone(k.deletionId);
  const events = await f.pool.query(
    "SELECT data FROM core.outbox WHERE subject=$1 AND type='com.rezics.library.entry.purged.v1' AND data->>'deletionId'=$2",
    [k.accountId, k.deletionId],
  );
  expect(events.rows).toEqual([{ data: { deletionId: k.deletionId } }]);
  expect((await f.commands.readEntry(f.owner.actor, subject)).incarnationId).toBe(replacement.incarnationId);
  recovered.process.kill('SIGTERM');
  expect(await recovered.process.exited).toBe(0);
}, 300000);

test('the actual worker delivers a parked D1 after restore and clear to D3 and preserves the live replacement', async () => {
  const subject = await f.createSubject('game');
  const live = (await f.commands.putEntry(f.owner.actor, subject, { state: 'planned' }, entryKey())).value.entry;
  const removed = await f.commands.deleteEntry(f.owner.actor, subject, live.revision, entryKey(), live.incarnationId!);
  const d1 = await deletionKey(f.pool, f.owner.actor.accountId, removed.transactionId);
  writeFileSync(timePath, String(Date.parse(d1.restoreUntil)));
  const parked = runtime('park');
  await parked.until('worker-ready');
  const triggered = await client.triggerSchedule(ENTRY_RETENTION_SCHEDULE);
  await parked.until('source-parked');
  // Discovery and delivery straddle a domain clock correction. Native owner Undo is still strictly before D1.
  time += 1000;
  const restored = (
    await f.commands.restoreEntry(
      f.owner.actor,
      subject,
      { deletionId: d1.deletionId, revision: live.revision + 1 },
      entryKey(),
    )
  ).value.entry;
  const d3 = await f.commands.deleteEntry(
    f.owner.actor,
    subject,
    restored.revision,
    entryKey(),
    restored.incarnationId!,
  );
  const k3 = await deletionKey(f.pool, f.owner.actor.accountId, d3.transactionId);
  const replacement = (await f.commands.putEntry(f.owner.actor, subject, { state: 'planned' }, entryKey())).value.entry;
  parked.process.stdin.write('deliver\n');
  await triggered.getResult({ pollingIntervalMs: 20 });
  expect(await count(k3.deletionId)).toBe(1);
  const receipt = await f.pool.query(
    'SELECT response FROM core.receipt WHERE principal_id=$1 AND command_kind=$2 AND idempotency_key=$3',
    [d1.accountId, 'library.entry.retention.purge', d1.deletionId],
  );
  expect(receipt.rows).toEqual([{ response: { purged: false } }]);
  expect((await f.commands.readEntry(f.owner.actor, subject)).incarnationId).toBe(replacement.incarnationId);
  writeFileSync(timePath, String(Date.parse(k3.restoreUntil)));
  await (await client.triggerSchedule(ENTRY_RETENTION_SCHEDULE)).getResult({ pollingIntervalMs: 20 });
  await waitGone(k3.deletionId);
  expect((await f.commands.readEntry(f.owner.actor, subject)).incarnationId).toBe(replacement.incarnationId);
  parked.process.kill('SIGTERM');
  expect(await parked.process.exited).toBe(0);
}, 300000);
