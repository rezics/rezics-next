import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cutoverEntryIncarnationsPage } from '../../src/library/entry-incarnation-cutover.ts';
import {
  libraryWorkModule,
  ENTRY_INCARNATION_CUTOVER_SCHEDULE,
  ENTRY_INCARNATION_CUTOVER_SWEEP_WORKFLOW,
} from '../../src/library/work-module.ts';
import { KERNEL_WORK_MODULES } from '../support/default-work-modules.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { fact, legacy } from './support/entry-incarnation-cutover-runtime.ts';
import { observeRetentionQueries, renewRetentionIdentities } from './entry-retention-worker-runtime.ts';

let f: NativeProfileFixture, client: Awaited<ReturnType<typeof createWorkClient>>;
let runtime: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
let output = '';
const executor = `entry-cutover-${crypto.randomUUID()}`;
const directory = resolve(import.meta.dir, '../../../../.temp', executor);
const timePath = resolve(directory, 'clock');
beforeAll(async () => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(timePath, String(Date.now()));
  f = await createProfileEntryFixture({ projectLinks: false });
  client = await createWorkClient(process.env.DATABASE_URL!);
}, 120000);
afterAll(async () => {
  await stop();
  await client?.close();
  await f?.close();
});

async function until(marker: string) {
  const end = Date.now() + 120000;
  while (!output.includes(marker)) {
    if (runtime?.exitCode !== null || Date.now() >= end) throw new Error(`Missing ${marker}: ${output}`);
    await Bun.sleep(20);
  }
}
async function start(mode = 'recover') {
  output = '';
  runtime = Bun.spawn(
    [process.execPath, `${import.meta.dir}/support/entry-incarnation-cutover-runtime.ts`, mode, executor, timePath],
    { env: process.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  const child = runtime;
  for (const stream of [child.stdout, child.stderr])
    void (async () => {
      for await (const data of stream) output += new TextDecoder().decode(data);
    })();
  await until('worker-ready');
}
async function stop(kill = false) {
  if (!runtime || runtime.exitCode !== null) return;
  const child = runtime;
  if (!kill) child.stdin.write('release\n');
  child.kill(kill ? 'SIGKILL' : 'SIGTERM');
  await child.exited;
  runtime = undefined;
}
async function segment(partition = 4095) {
  const root = `cutover-test:${crypto.randomUUID()}`;
  const handle = await client.enqueue(
    { workflowName: 'library.entryIncarnationCutoverSegment', queueName: 'maintenance', workflowID: root },
    { root, sequence: 0, partition, after: null },
  );
  return { root, handle };
}
async function make(partition = 4095) {
  await renewRetentionIdentities(f);
  const owner = (
    await f.identity(
      ['subject:read', 'library_entry:read', 'library_entry:update', 'library_entry:delete', 'account:delete'],
      partition,
    )
  ).actor;
  const subject = await f.createSubject('game');
  const entry = (await f.commands.putEntry(owner, subject, { state: 'playing' }, entryKey())).value.entry;
  await legacy(f.pool, owner.accountId, subject);
  return { owner, subject, entry };
}
async function drain(partition: number, limit = 100) {
  let after: string | null = null,
    stamped = 0,
    examined = 0,
    pending = 0;
  do {
    const page = await cutoverEntryIncarnationsPage({ pool: f.pool, client }, { partition, limit, after });
    expect(page.examined).toBeLessThanOrEqual(limit);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
    stamped += page.stamped;
    examined += page.examined;
    pending += page.pending;
    after = page.next;
  } while (after);
  return { stamped, examined, pending };
}

test('private cutover validates routing, raw bounds and cursor format before any database access', async () => {
  let statements = 0;
  await observeRetentionQueries(f.pool, () => {
    statements++;
  });
  for (const partition of [-1, 4096, 0.5, NaN])
    await expect(cutoverEntryIncarnationsPage({ pool: f.pool }, { partition, after: null, limit: 1 })).rejects.toThrow(
      'Invalid partition',
    );
  for (const limit of [0, 101, 1.5, Infinity])
    await expect(cutoverEntryIncarnationsPage({ pool: f.pool }, { partition: 0, after: null, limit })).rejects.toThrow(
      'Invalid page limit',
    );
  for (const after of ['', 'x'.repeat(513), '%%%', 'e30'])
    await expect(cutoverEntryIncarnationsPage({ pool: f.pool }, { partition: 0, after, limit: 1 })).rejects.toThrow(
      'Invalid private entry incarnation cursor',
    );
  expect(statements).toBe(0);
});

test('the single installed default Library module registers a real UTC cutover schedule and bounded deterministic continuation', async () => {
  const target = await make(4095);
  expect(KERNEL_WORK_MODULES.filter((m) => m.name === 'library')).toEqual([libraryWorkModule]);
  await start();
  try {
    const schedule = await client.getSchedule(ENTRY_INCARNATION_CUTOVER_SCHEDULE);
    expect(schedule!.workflowName).toBe(ENTRY_INCARNATION_CUTOVER_SWEEP_WORKFLOW);
    expect(schedule!.schedule).toBe('*/10 * * * *');
    expect(schedule!.cronTimezone).toBe('UTC');
    expect(schedule!.queueName).toBe('maintenance');
    const triggered = await client.triggerSchedule(ENTRY_INCARNATION_CUTOVER_SCHEDULE);
    const frontier = (await triggered.getResult({ pollingIntervalMs: 20 })) as {
      partition: number;
      after: string | null;
    };
    expect(frontier).toEqual({ partition: 100, after: null });
    const end = Date.now() + 180000;
    while (!(await fact(f.pool, target.owner.accountId, target.subject)).incarnation_id) {
      if (Date.now() >= end) throw new Error('Default cutover schedule did not reach the committed legacy fact');
      await Bun.sleep(50);
    }
    expect((await f.commands.readEntry(target.owner, target.subject)).incarnationId).toBeTruthy();
  } finally {
    await stop();
  }
}, 300000);

test('source-before-native-commit and native-commit-before-checkpoint crashes replay through the real default SDK without rekeying', async () => {
  for (const mode of ['source-crash', 'crash']) {
    const { owner, subject } = await make();
    const before = await fact(f.pool, owner.accountId, subject);
    await start(mode);
    const queued = await segment();
    await until(mode === 'crash' ? 'native-committed' : 'source-parked');
    const atCrash = await fact(f.pool, owner.accountId, subject);
    expect(atCrash.incarnation_id === null).toBe(mode === 'source-crash');
    await stop(true);
    await start();
    try {
      await queued.handle.getResult({ pollingIntervalMs: 20 });
      const repaired = await fact(f.pool, owner.accountId, subject);
      expect(repaired.incarnation_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(routeOf(repaired.incarnation_id)).toBe(routeOf(owner.accountId));
      expect({ ...repaired, incarnation_id: null }).toEqual(before);
      if (mode === 'crash') expect(repaired).toEqual(atCrash);
      await (await segment()).handle.getResult({ pollingIntervalMs: 20 });
      expect(await fact(f.pool, owner.accountId, subject)).toEqual(repaired);
      expect((await f.commands.readEntry(owner, subject)).incarnationId).toBe(repaired.incarnation_id);
      const steps = (await client.listWorkflowSteps(queued.root))!.filter(
        (s) => s.name === 'library.entryIncarnationCutoverPage',
      );
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) expect(Buffer.byteLength(JSON.stringify(step.output))).toBeLessThanOrEqual(4096);
    } finally {
      await stop();
    }
  }
}, 300000);

test('owner GET never stamps and native repair allocates no owner chronology receipt event or partition position', async () => {
  const { owner, subject } = await make(4092);
  const before = await fact(f.pool, owner.accountId, subject);
  const technical = async () => ({
    counter: (
      await f.pool.query('SELECT seq::text FROM library.owner_write_counter WHERE route=$1 AND account_id=$2', [
        routeOf(owner.accountId),
        owner.accountId,
      ])
    ).rows,
    partition: (await f.pool.query('SELECT epoch,position::text FROM core.partition WHERE partition_no=$1', [4092]))
      .rows,
    receipts: (
      await f.pool.query(
        "SELECT idempotency_key FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 ORDER BY idempotency_key",
        [4092, owner.accountId],
      )
    ).rows,
    events: (
      await f.pool.query('SELECT id FROM core.outbox WHERE partition_no=$1 AND subject=$2 ORDER BY id', [
        4092,
        owner.accountId,
      ])
    ).rows,
  });
  const metadata = await technical();
  expect((await f.commands.readEntry(owner, subject)).incarnationId).toBeNull();
  expect(await fact(f.pool, owner.accountId, subject)).toEqual(before);
  expect((await drain(4092)).stamped).toBe(1);
  const repaired = await fact(f.pool, owner.accountId, subject);
  expect(repaired.incarnation_id).toBeTruthy();
  expect({ ...repaired, incarnation_id: null }).toEqual(before);
  expect(await technical()).toEqual(metadata);
}, 120000);

test('parked legacy discovery cannot stamp a new native replacement or a changed exact CAS source; a fresh sweep recovers the loser', async () => {
  for (const change of ['replacement', 'revision', 'storage']) {
    const { owner, subject, entry } = await make();
    await start('park');
    const queued = await segment();
    await until('source-parked');
    if (change === 'replacement') {
      await f.commands.deleteEntry(owner, subject, entry.revision, entryKey());
      await f.commands.putEntry(owner, subject, { state: 'planned' }, entryKey());
    } else if (change === 'revision') {
      await f.commands.putEntry(owner, subject, { state: 'planned', revision: entry.revision }, entryKey());
    } else {
      // Same historical NULL storage field, no fabricated positive fact; even unchanged logical values
      // have a new exact native source version and must not accept the parked observation.
      await legacy(f.pool, owner.accountId, subject);
    }
    const current = await fact(f.pool, owner.accountId, subject);
    runtime!.stdin.write('continue\n');
    try {
      await queued.handle.getResult({ pollingIntervalMs: 20 });
      expect(await fact(f.pool, owner.accountId, subject)).toEqual(current);
      if (change !== 'replacement') {
        expect(current.incarnation_id).toBeNull();
        await (await segment()).handle.getResult({ pollingIntervalMs: 20 });
        const repaired = await fact(f.pool, owner.accountId, subject);
        expect(repaired.incarnation_id).toBeTruthy();
        expect({ ...repaired, incarnation_id: null }).toEqual(current);
      }
    } finally {
      await stop();
    }
  }
}, 300000);

test('raw100 includes a nonnull prefix and sparse legacy rows beyond a page; repaired guard works in normal native API', async () => {
  const { owner, subject } = await make(4094);
  // Restore the first fact through the repair, then create 100 further genuine native facts.
  await drain(4094);
  const subjects = [subject];
  for (let n = 0; n < 100; n++) {
    if (n % 20 === 0) await renewRetentionIdentities(f);
    const next = await f.createSubject('game');
    subjects.push(next);
    await f.commands.putEntry(owner, next, { state: 'playing' }, entryKey());
  }
  subjects.sort();
  const tail = subjects.at(-1)!;
  await legacy(f.pool, owner.accountId, tail);
  const before = await Promise.all(subjects.map((id) => fact(f.pool, owner.accountId, id)));
  const first = await cutoverEntryIncarnationsPage(
    { pool: f.pool, client },
    { partition: 4094, after: null, limit: 100 },
  );
  expect(first.examined).toBe(100);
  expect(first.stamped).toBe(0);
  expect(first.next).not.toBeNull();
  const second = await cutoverEntryIncarnationsPage(
    { pool: f.pool, client },
    { partition: 4094, after: first.next, limit: 100 },
  );
  expect(second.examined).toBe(1);
  expect(second.stamped).toBe(1);
  expect(second.next).toBeNull();
  for (let n = 0; n < 100; n++) expect(await fact(f.pool, owner.accountId, subjects[n]!)).toEqual(before[n]);
  const repaired = await f.commands.readEntry(owner, tail);
  const updated = await f.commands.putEntry(
    owner,
    tail,
    { state: 'planned', revision: repaired.revision, incarnationId: repaired.incarnationId! },
    entryKey(),
  );
  expect(updated.value.entry.incarnationId).toBe(repaired.incarnationId);
  expect(updated.value.entry.revision).toBe(repaired.revision + 1);
  expect((await drain(4094)).stamped).toBe(0);
}, 300000);

test('terminal account T wins over parked native repair and remains pending for its owning cleanup', async () => {
  const { owner, subject } = await make();
  await start('park');
  const queued = await segment();
  await until('source-parked');
  await createLifecycleCommands({ pool: f.pool, access: f.access }).tombstone(
    { actor: owner, deadline: deadlineFor(30000) },
    { accountId: owner.accountId, key: entryKey() },
  );
  const before = await fact(f.pool, owner.accountId, subject);
  runtime!.stdin.write('continue\n');
  try {
    await queued.handle.getResult({ pollingIntervalMs: 20 });
    expect(await fact(f.pool, owner.accountId, subject)).toEqual(before);
    const repeated = await drain(4095);
    expect(repeated.stamped).toBe(0);
    expect(repeated.pending).toBeGreaterThan(0);
    expect(await fact(f.pool, owner.accountId, subject)).toEqual(before);
  } finally {
    await stop();
  }
}, 180000);

test('released source checkout precedes the separately entered native transaction and rollback preserves every field', async () => {
  const { owner, subject } = await make(4093);
  const before = await fact(f.pool, owner.accountId, subject);
  let sourceConnection: object | undefined,
    fail = true,
    released = false;
  await observeRetentionQueries(f.pool, ({ connection, sql, result }) => {
    if (/xmin::text AS version/i.test(sql)) sourceConnection = connection;
    if (sourceConnection === connection && /^COMMIT$/i.test(sql.trim())) released = true;
    if (fail && /UPDATE library.entry\s+SET incarnation_id/i.test(sql) && result.rows.length) {
      expect(released).toBe(true);
      fail = false;
      throw new Error('injected cutover pre-commit crash');
    }
  });
  await expect(drain(partitionOf(routeOf(owner.accountId)!))).rejects.toThrow('injected cutover pre-commit crash');
  expect(await fact(f.pool, owner.accountId, subject)).toEqual(before);
  expect((await drain(4093)).stamped).toBe(1);
}, 120000);
