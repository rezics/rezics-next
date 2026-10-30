import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { readCollection } from '../../src/library/collection-store.ts';
import { pageDueMemberDeletions, type DueMemberDeletionKey } from '../../src/library/member-retention.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import { accountToken } from '../support/admitted-access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { observeRetentionQueries } from './entry-retention-worker-runtime.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let db: GrowthDatabase, f: NativeProfileFixture;
let commands: ReturnType<typeof createCollectionCommands>;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let parentId: string, privateId: string, publicId: string, subjectId: string;
let work: Awaited<ReturnType<typeof composeWork>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let time = Date.now();
const origin = time;
const partition = 4094;
const scopes = ['subject:read', 'collection:create', 'collection:read', 'collection:update', 'collection:delete'];
const completed = new Map<string, () => void>();
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createProfileEntryFixture({ pool: db.pool, clock: () => new Date(time), projectLinks: false });
  owner = await f.identity(scopes, partition);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
  subjectId = await f.createSubject('game');
  commands = createCollectionCommands({ pool: db.pool, access: f.access, clock: () => new Date(time) });
  parentId = (
    await commands.createCollection(
      owner.actor,
      { title: 'Growing same-parent live and retained histories', visibility: 'private' },
      entryKey(),
    )
  ).value.id;
  privateId = (
    await commands.createCollection(
      owner.actor,
      { title: 'Other parent private history', visibility: 'private' },
      entryKey(),
    )
  ).value.id;
  publicId = (
    await commands.createCollection(
      owner.actor,
      { title: 'Other parent public history', visibility: 'public' },
      entryKey(),
    )
  ).value.id;
  const outcomes = new WeakMap<PoolClient, string>();
  await observeRetentionQueries(db.pool, ({ connection, sql, values }) => {
    if (/INSERT INTO "dbos"\.workflow_output\b/i.test(sql)) outcomes.set(connection, String(values[0]));
    if (/^COMMIT$/i.test(sql.trim())) {
      const id = outcomes.get(connection);
      outcomes.delete(connection);
      if (id) completed.get(id)?.();
    } else if (/^ROLLBACK$/i.test(sql.trim())) outcomes.delete(connection);
  });
  client = await createWorkClient(db.url, db.openPool());
  work = await composeWork([libraryWorkModule], {
    pool: db.pool,
    client,
    databaseUrl: db.url,
    clock: () => new Date(time),
    env: {},
  });
  await client.pauseSchedule('library.entryRetention.every-10-minutes');
  await client.pauseSchedule('library.memberRetention.every-10-minutes');
  await work.launch();
}, 120000);
afterAll(async () => {
  await work?.shutdown();
  await client?.close();
  await f?.close();
  await db?.close();
});
async function renew() {
  owner.bearer = await accountToken(owner.actor);
  owner.actor = await f.access.authenticate(owner.bearer, { pool: db.pool, deadline: deadlineFor(30000) });
}
async function parent(id: string) {
  const connection = await db.pool.connect();
  try {
    return (await readCollection(connection, routeOf(id)!, id))!;
  } finally {
    connection.release();
  }
}
async function add(id: string) {
  return (await commands.addMember(owner.actor, id, { subjectId, note: 'native original' }, entryKey())).value;
}
async function remove(id: string, memberId: string, key = entryKey()) {
  const revision = (await parent(id)).revision;
  return commands.removeMember(owner.actor, id, memberId, revision, key);
}
async function grow(scale: number, previous: number) {
  time = origin + 86400000;
  for (let n = previous; n < scale; n++) {
    if (n % 16 === 0) await renew();
    await add(parentId);
    for (const id of [parentId, privateId, publicId]) {
      const member = await add(id);
      await remove(id, member.id);
    }
  }
}
let chosen: Awaited<ReturnType<typeof add>>;
let removed: Awaited<ReturnType<typeof remove>>;
let deleteKey: string;
let expectedRevision: number;
async function prepare() {
  time = origin;
  await renew();
  chosen = (
    await commands.addMember(
      owner.actor,
      parentId,
      { subjectId, note: 'fixed chosen occurrence', after: null },
      entryKey(),
    )
  ).value;
  expectedRevision = (await parent(parentId)).revision;
  deleteKey = entryKey();
  removed = await commands.removeMember(owner.actor, parentId, chosen.id, expectedRevision, deleteKey);
}
async function operation() {
  const before = await parent(parentId);
  await expect(
    commands.restoreMember(
      owner.actor,
      parentId,
      chosen.id,
      { deletionId: removed.value.deletionId, revision: removed.value.revision + 1 },
      entryKey(),
    ),
  ).rejects.toMatchObject({ code: 'member_restore_stale' });
  const key = entryKey();
  const restored = await commands.restoreMember(owner.actor, parentId, chosen.id, removed.value, key);
  expect(restored.value).toEqual(chosen);
  const replayed = await commands.restoreMember(owner.actor, parentId, chosen.id, removed.value, key);
  expect(replayed.replayed).toBe(true);
  const replay = await commands.removeMember(owner.actor, parentId, chosen.id, expectedRevision, deleteKey);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(removed.value);
  expect((await parent(parentId)).memberCount).toBe(before.memberCount + 1);
  // Leave the same live neighbourhood size for every measured repetition.
  await remove(parentId, chosen.id);
}
test('whole native occurrence lifecycle and indexed raw readers stay bounded at 64/512/4096 live and deleted same-parent and other-parent histories', async () => {
  const report = await checkGrowth(db, {
    name: 'curated member exact episode Undo, stale refusal and authorized receipt replay',
    scales: [64, 512, 4096],
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      await grow(scale, previous);
    },
    prepare,
    async warmup() {
      await prepare();
      await operation();
    },
    operation,
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) expect(sample.cost.plans).toBeGreaterThan(0);
}, 300000);

async function segment(cutoff: string) {
  const root = `member-retention-growth:${crypto.randomUUID()}`;
  let timer: ReturnType<typeof setTimeout>;
  const committed = new Promise<void>((resolve, reject) => {
    completed.set(root, resolve);
    timer = setTimeout(() => reject(new Error(`Native member workflow did not commit: ${root}`)), 120000);
  });
  try {
    const handle = await client.enqueue(
      { workflowName: 'library.memberRetentionSegment', workflowID: root, queueName: 'maintenance' },
      { root, sequence: 0, cutoff, cursor: { partition } },
    );
    await committed;
    await handle.getResult();
  } finally {
    clearTimeout(timer!);
    completed.delete(root);
  }
  const steps = await client.listWorkflowSteps(root);
  const pages = steps?.filter((step) => step.name === 'library.memberRetentionPage') ?? [];
  expect(pages.length).toBeGreaterThan(0);
  for (const step of pages) {
    const page = step.output as { examined: number; cursor: { partition: number; after?: DueMemberDeletionKey } };
    expect(page.examined).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(step.output))).toBeLessThanOrEqual(4096);
    expect(page.cursor.partition).toBeGreaterThanOrEqual(partition);
  }
}
test('actual default durable member due discovery and exact physical work include SDK and checkpoint cost as unrelated future histories grow', async () => {
  let target: Awaited<ReturnType<typeof add>>;
  const report = await checkGrowth(db, {
    name: 'default member maintenance queue: private physical purge and raw due cursor',
    scales: [64, 512, 4096],
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      time = origin + 2 * 86400000;
      for (let n = previous; n < scale; n++) {
        if (n % 16 === 0) await renew();
        const member = await add(privateId);
        await remove(privateId, member.id);
      }
    },
    async prepare() {
      time = origin - 86400000;
      await renew();
      target = await add(privateId);
      await remove(privateId, target.id);
      time += 720 * 3600000;
    },
    async operation() {
      const keys = await pageDueMemberDeletions(db.pool, { partition, cutoff: new Date(time).toISOString(), limit: 1 });
      expect(keys).toHaveLength(1);
      await segment(new Date(time).toISOString());
      expect(
        (
          await db.pool.query(
            'SELECT member_id FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3',
            [routeOf(privateId), privateId, target.id],
          )
        ).rows,
      ).toEqual([]);
    },
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) expect(sample.cost.plans).toBeGreaterThan(0);
}, 300000);
