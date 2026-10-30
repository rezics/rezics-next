import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import pg from 'pg';
import { createWorkClient } from '../../src/work/client.ts';
import { LABEL_RETENTION_SCHEDULE, LABEL_RETENTION_SWEEP_WORKFLOW } from '../../src/library/work-module.ts';
import { purgeLabelRetentionPage } from '../../src/library/label-retention.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { assignment, label } from './support/label-retention-runtime.ts';
import { observeRetentionQueries } from './entry-retention-worker-runtime.ts';
let f: NativeProfileFixture;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let worker: ChildProcessWithoutNullStreams | undefined;
let time = Date.now();
const origin = time, clock = () => new Date(time), windowMs = 720 * 60 * 60 * 1000;
const directory = `.temp/label-retention-${crypto.randomUUID()}`;
const timePath = `${directory}/clock`;
let output = '';
const signals = new Set<() => void>();
const reader = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, options: '-c default_transaction_read_only=on' });
beforeAll(async () => {
  mkdirSync(directory, { recursive: true });
  f = await createProfileEntryFixture({ clock });
  client = await createWorkClient(process.env.DATABASE_URL!);
}, 120000);
afterAll(async () => { await stop(); await client?.close(); await reader.end(); await f?.close(); });
function tick(value: number) { time = value; writeFileSync(timePath, String(time)); }
async function waitFor(marker: string) {
  if (output.includes(marker)) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { signals.delete(ready); reject(new Error(`Missing ${marker}: ${output}`)); }, 120000);
    const ready = () => { if (output.includes(marker)) { clearTimeout(timeout); signals.delete(ready); resolve(); } };
    signals.add(ready);
  });
}
async function start(mode = 'recover') {
  output = ''; tick(time);
  worker = spawn(process.execPath, ['test/library/support/label-retention-runtime.ts', mode, crypto.randomUUID(), timePath],
    { cwd: process.cwd(), env: process.env, stdio: 'pipe' });
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', (data) => { output += data.toString(); for (const signal of signals) signal(); });
  await waitFor('worker-ready');
}
async function stop(kill = false) {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  const process = worker;
  await new Promise<void>((resolve) => { process.once('exit', () => resolve()); process.kill(kill ? 'SIGKILL' : 'SIGTERM'); });
  worker = undefined;
}
async function rows(accountId: string, id: string) {
  const args = [routeOf(accountId), accountId, id];
  return {
    labels: (await reader.query('SELECT normalized_name,revision,deleted_at::text,purge_after::text FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3', args)).rows,
    children: (await reader.query('SELECT subject_id,assignment_id,revision,slot_no,deleted_at::text,purge_after::text FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND label_id=$3 ORDER BY subject_id', args)).rows,
  };
}
async function drain(partition: number, after: string | null = null, limit = 100) {
  let examined = 0, removed = 0, pages = 0;
  do {
    const result = await purgeLabelRetentionPage({ pool: f.pool, clock }, { partition, limit, after });
    expect(result.examined).toBeLessThanOrEqual(limit);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
    examined += result.examined; removed += result.removed; after = result.next; pages++;
    if (pages > 1000) throw new Error('Unbounded retention cursor');
  } while (after);
  return { examined, removed, pages };
}
async function segment(partition: number) {
  const root = `label-retention:${crypto.randomUUID()}`;
  const handle = await client.enqueue({ workflowName: 'library.labelRetentionSegment', workflowID: root, queueName: 'maintenance' },
    { root, sequence: 0, partition, after: null });
  return { handle, root };
}

test('default scheduled exact label and assignment purge is child-first replacement-safe bounded and does not revive or double-remove private facts', async () => {
  tick(origin);
  const owner = (await f.identity(['library_entry:update'], 4095)).actor;
  const other = (await f.identity(['library_entry:update'], 4095)).actor;
  const target = await label(f, owner, clock, 'Private shared normalized name');
  const untouched = await label(f, other, clock, 'Private shared normalized name');
  const subject = await f.createSubject('game');
  const subjects = [subject];
  for (let n = 0; n < 101; n++) subjects.push(await f.createSubject('game'));
  for (const subjectId of subjects) await assignment(f, owner, target.id, subjectId, clock);
  const individual = await label(f, owner, clock);
  await assignment(f, owner, individual.id, subject, clock);
  await assignment(f, owner, individual.id, subject, clock, 'unassign');
  const deleted = await target.commands.deleteLabel(owner, target.id, target.revision, entryKey());
  const replacement = await label(f, owner, clock, 'Private shared normalized name');
  await assignment(f, owner, replacement.id, subject, clock);
  const liveBefore = await rows(owner.accountId, replacement.id), otherBefore = await rows(other.accountId, untouched.id);
  tick(origin + windowMs - 1);
  expect((await drain(4095)).removed).toBe(0);
  expect((await rows(owner.accountId, target.id)).children).toHaveLength(102);
  tick(origin + windowMs);
  await start();
  try {
    expect(Object.keys(WORK_QUEUES)).toContain('locator-effects');
    const schedule = await client.getSchedule(LABEL_RETENTION_SCHEDULE);
    expect(schedule?.workflowName).toBe(LABEL_RETENTION_SWEEP_WORKFLOW);
    expect(schedule?.cronTimezone).toBe('UTC');
    const scheduled = await client.triggerSchedule(LABEL_RETENTION_SCHEDULE);
    await scheduled.getResult({ pollingIntervalMs: 20 });
    // A full sweep may continue in finite segments. Queueing this terminal partition also proves the very same default page.
    const { handle, root } = await segment(4095);
    await handle.getResult({ pollingIntervalMs: 20 });
    const steps = await client.listWorkflowSteps(root);
    for (const step of steps ?? []) if (step.name === 'library.labelRetentionPage') {
      const page = step.output as { examined: number };
      expect(page.examined).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(step.output))).toBeLessThanOrEqual(4096);
    }
    expect(await rows(owner.accountId, target.id)).toEqual({ labels: [], children: [] });
    expect((await rows(owner.accountId, individual.id)).children).toEqual([]);
    expect(await rows(owner.accountId, replacement.id)).toEqual(liveBefore);
    expect(await rows(other.accountId, untouched.id)).toEqual(otherBefore);
    expect((await drain(4095)).removed).toBe(0);
    expect(deleted.value.revision).toBe(2);
  } finally { await stop(); }
}, 300000);

test('captured D1 cannot consume restored D3 or a reclaimed slot; original individual expiry and exact timestamps survive stale work', async () => {
  tick(origin);
  const owner = (await f.identity(['library_entry:update'], 4094)).actor;
  const target = await label(f, owner, clock);
  const subject = await f.createSubject('game');
  await assignment(f, owner, target.id, subject, clock);
  const d1 = await target.commands.deleteLabel(owner, target.id, 1, entryKey());
  tick(origin + windowMs);
  const captured = await purgeLabelRetentionPage({ pool: f.pool, clock }, { partition: 4094, limit: 1, after: null });
  expect(captured.next).not.toBeNull(); expect(captured.removed).toBe(0);
  tick(origin + 1000);
  await target.commands.restoreLabel(owner, target.id, d1.value.revision, entryKey());
  await target.commands.deleteLabel(owner, target.id, 3, entryKey());
  const before = await rows(owner.accountId, target.id);
  tick(origin + windowMs);
  await drain(4094, captured.next);
  expect(await rows(owner.accountId, target.id)).toEqual(before);
  // The individually deleted row's later window also prevents the old parent page from erasing its new episode.
  tick(origin + 2000);
  await assignment(f, owner, target.id, subject, clock, 'unassign');
  tick(origin + windowMs + 1000);
  await drain(4094);
  expect((await rows(owner.accountId, target.id)).labels).toHaveLength(1);
  tick(origin + windowMs + 2000);
  await drain(4094);
  expect(await rows(owner.accountId, target.id)).toEqual({ labels: [], children: [] });
}, 120000);

test('parked source versus restore and native commit before checkpoint recover on the actual default durable worker', async () => {
  tick(origin);
  const owner = (await f.identity(['library_entry:update'], 4093)).actor;
  const target = await label(f, owner, clock);
  const d1 = await target.commands.deleteLabel(owner, target.id, 1, entryKey());
  tick(origin + windowMs);
  await start('park');
  const parked = await segment(4093);
  await waitFor('source-parked');
  tick(origin + 1000);
  await target.commands.restoreLabel(owner, target.id, d1.value.revision, entryKey());
  await target.commands.deleteLabel(owner, target.id, 3, entryKey());
  const d3 = await rows(owner.accountId, target.id);
  tick(origin + windowMs);
  worker!.stdin.write('continue\n');
  await parked.handle.getResult({ pollingIntervalMs: 20 });
  expect(await rows(owner.accountId, target.id)).toEqual(d3);
  await stop();
  tick(origin + windowMs + 1000);
  await start('crash');
  const crashed = await segment(4093);
  await waitFor('native-committed');
  expect((await rows(owner.accountId, target.id)).labels).toEqual([]);
  await stop(true);
  await start();
  try {
    await client.recoverPendingWorkflows();
    await crashed.handle.getResult({ pollingIntervalMs: 20 });
    expect(await rows(owner.accountId, target.id)).toEqual({ labels: [], children: [] });
    expect((await drain(4093)).removed).toBe(0);
    const steps = await client.listWorkflowSteps(crashed.root);
    expect(steps?.some((step) => step.name === 'library.labelRetentionPage')).toBe(true);
  } finally { await stop(); }
}, 300000);

test('native rollback is effect free and the current owner fence wins over a captured ordinary purge', async () => {
  tick(origin);
  const owner = (await f.identity(['library_entry:update'], 4092)).actor;
  const target = await label(f, owner, clock);
  await target.commands.deleteLabel(owner, target.id, 1, entryKey());
  tick(origin + windowMs);
  const captured = await purgeLabelRetentionPage({ pool: f.pool, clock }, { partition: 4092, limit: 1, after: null });
  const before = await rows(owner.accountId, target.id);
  let fail = true;
  await observeRetentionQueries(f.pool, ({ sql, result }) => {
    if (fail && /DELETE FROM library.personal_label AS p/i.test(sql) && result.rows.length) {
      fail = false; throw new Error('injected pre-commit failure');
    }
  });
  await expect(drain(4092, captured.next)).rejects.toThrow('injected pre-commit failure');
  expect(await rows(owner.accountId, target.id)).toEqual(before);
  await f.revokeIdentity(owner.accountId);
  expect((await drain(4092, captured.next)).removed).toBe(0);
  expect(await rows(owner.accountId, target.id)).toEqual(before);
}, 120000);
