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
async function grow(scale: number, previous: number, parents: readonly string[]) {
  time = origin + 86400000;
  for (let n = previous; n < scale; n++) {
    if (n % 16 === 0) await renew();
    if (parents.includes(parentId)) await add(parentId);
    for (const id of parents) {
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
  const path = `/v1/collections/${parentId}/members/${chosen.id}`;
  const mountedUndo = await f.send(
    owner.bearer,
    'POST',
    path + ':restore',
    { deletionId: removed.value.deletionId, revision: removed.value.revision },
    key,
  );
  expect(mountedUndo.status).toBe(200);
  expect((await mountedUndo.json()).member).toEqual({
    id: chosen.id,
    subjectId: chosen.subjectId,
    note: chosen.note,
    addedAt: chosen.addedAt,
  });
  const mountedRemove = await f.send(
    owner.bearer,
    'DELETE',
    `${path}?revision=${expectedRevision}`,
    undefined,
    deleteKey,
  );
  expect(mountedRemove.status).toBe(204);
  expect(mountedRemove.headers.get('Library-Collection-Member-Deletion-Id')).toBe(removed.value.deletionId);
  expect((await parent(parentId)).memberCount).toBe(before.memberCount + 1);
  // Leave the same live neighbourhood size for every measured repetition.
  await remove(parentId, chosen.id);
}
test('whole native occurrence lifecycle and indexed raw readers stay bounded at 64/512/4096 live and deleted same-parent and other-parent histories', async () => {
  for (const parents of [[parentId], [privateId, publicId]]) {
    const report = await checkGrowth(db, {
      name: `curated member exact episode Undo and mounted replay, growing ${parents[0] === parentId ? 'same-parent' : 'other-parent'} histories`,
      scales: [64, 512, 4096],
      repetitions: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_db, scale, previous) {
        await grow(scale, previous, parents);
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
  }
}, 300000);

async function segment(cutoff: string, firstPartition = partition) {
  const root = `member-retention-growth:${crypto.randomUUID()}`;
  let timer: ReturnType<typeof setTimeout>;
  const committed = new Promise<void>((resolve, reject) => {
    completed.set(root, resolve);
    timer = setTimeout(() => reject(new Error(`Native member workflow did not commit: ${root}`)), 120000);
  });
  try {
    const handle = await client.enqueue(
      { workflowName: 'library.memberRetentionSegment', workflowID: root, queueName: 'maintenance' },
      { root, sequence: 0, cutoff, cursor: { partition: firstPartition } },
    );
    await committed;
    await handle.getResult();
  } finally {
    clearTimeout(timer!);
    completed.delete(root);
  }
  const pages: {
    examined: number;
    purged: number;
    probes: number;
    cursor: { partition: number; after?: DueMemberDeletionKey };
  }[] = [];
  let id = root,
    sequence = 0;
  for (;;) {
    await client.retrieveWorkflow(id).getResult();
    const steps = await client.listWorkflowSteps(id);
    const outputs = steps?.filter((step) => step.name === 'library.memberRetentionPage') ?? [];
    expect(outputs.length).toBeGreaterThan(0);
    for (const step of outputs) {
      const page = step.output as (typeof pages)[number];
      expect(page.examined).toBeLessThanOrEqual(100);
      expect(page.probes).toBeLessThanOrEqual(4096);
      expect(Buffer.byteLength(JSON.stringify(step.output))).toBeLessThanOrEqual(4096);
      expect(page.cursor.partition).toBeGreaterThanOrEqual(firstPartition);
      pages.push(page);
    }
    if (pages.at(-1)!.cursor.partition === 4096) return pages;
    id = `library.memberRetention:${root}:${++sequence}`;
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

test('growing due populations require change-proportional durable pages and drain to repeatable empty', async () => {
  const selectedOwner = await f.identity(scopes, 4093);
  const selectedId = (
    await commands.createCollection(
      selectedOwner.actor,
      { title: 'Due selected episodes', visibility: 'private' },
      entryKey(),
    )
  ).value.id;
  const cutoff = new Date(origin + 28 * 86400000).toISOString();
  const report = await checkGrowth(db, {
    name: 'due member population through original page, segment, SDK checkpoint and post-drain empty',
    scales: [64, 512, 4096],
    repetitions: 1,
    bounds: { rows: 'linear', statements: 'linear', blocks: 'linear' },
    async grow(_db, scale) {
      time = origin - 2 * 86400000;
      for (let n = 0; n < scale; n++) {
        if (n % 16 === 0) {
          selectedOwner.bearer = await accountToken(selectedOwner.actor);
          selectedOwner.actor = await f.access.authenticate(selectedOwner.bearer, {
            pool: db.pool,
            deadline: deadlineFor(30000),
          });
        }
        const member = (
          await commands.addMember(selectedOwner.actor, selectedId, { subjectId, note: 'selected due' }, entryKey())
        ).value;
        await commands.removeMember(
          selectedOwner.actor,
          selectedId,
          member.id,
          (await parent(selectedId)).revision,
          entryKey(),
        );
      }
      time = Date.parse(cutoff);
    },
    async warmup() {
      // Warm the actual SDK/empty seek path without consuming the measured due population.
      await segment(new Date(origin - 3 * 86400000).toISOString(), 4093);
    },
    async operation(_db, scale) {
      const pages = await segment(cutoff, 4093);
      expect(pages.reduce((n, page) => n + page.purged, 0)).toBe(scale);
      expect(pages.reduce((n, page) => n + page.examined, 0)).toBe(scale);
      expect(pages.length).toBeGreaterThanOrEqual(Math.ceil(scale / 100));
      for (let n = 0; n < 2; n++) {
        const empty = await segment(cutoff, 4093);
        expect(empty.every((page) => page.examined === 0 && page.purged === 0)).toBe(true);
        expect(empty.at(-1)!.cursor.partition).toBe(4096);
      }
    },
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) expect(sample.cost.plans).toBeGreaterThan(0);
}, 300000);
