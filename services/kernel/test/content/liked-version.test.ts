import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import * as liked from '../../src/content/liked-read.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { Pool } from 'pg';
import reactionSlot from '../../src/content/reaction-slot.sql';
import { measure } from '../support/growth.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { reactionFixture, request } from './reactions.test.ts';

const migrationName = '20261029172138_reaction_liked_version.sql';
const readers = liked as unknown as {
  readLikedVersion: (client: Pool, input: { actorAccountId: string }) => Promise<bigint>;
  readLikedSubjectPage: (
    client: Pool,
    input: { actorAccountId: string; after?: string; limit: number },
  ) => Promise<{ subjects: readonly unknown[]; version: bigint }>;
  readLikedMembership: (
    client: Pool,
    input: { actorAccountId: string; subjectIds: readonly string[] },
  ) => Promise<{ subjects: ReadonlySet<string>; version: bigint }>;
};

let f: Awaited<ReturnType<typeof reactionFixture>>;
let commands: typeof import('../../src/content/reactions.ts');
beforeAll(async () => {
  f = await reactionFixture();
  commands = await import('../../src/content/reactions.ts');
}, 120_000);
afterAll(async () => {
  await f?.close();
});

async function subject(): Promise<string> {
  const id = newId(f.targetRoute);
  await createSubject(f.db.pool, {
    actor: await f.verified(f.managerId),
    target: { route: f.targetRoute, id },
    idempotencyKey: crypto.randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    item: { type: 'schema:Book', labels: { en: 'Version target' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return id;
}

async function react(
  targetId: string,
  kind: Parameters<typeof commands.setReaction>[2]['kind'],
  actorId = f.accountId,
  targetKind: 'subject' | 'thread' | 'post' = 'subject',
) {
  return commands.setReaction(
    { pool: f.db.pool, access: f.access },
    await f.verified(actorId),
    { targetId, targetKind, kind },
    request(),
  );
}

async function version(actorAccountId = f.accountId): Promise<bigint> {
  return readers.readLikedVersion(f.db.pool, { actorAccountId });
}

test("the Liked version increases on every change of the actor's like and love subject set and on no other reaction change", async () => {
  const id = await subject();
  const before = await version();
  for (const [kind, increment] of [
    ['like', 1n],
    ['love', 2n],
    ['laugh', 3n],
    ['sad', 3n],
    ['like', 4n],
  ] as const) {
    await react(id, kind);
    expect(await version()).toBe(before + increment);
  }
  await react(id, 'like');
  expect(await version()).toBe(before + 4n);
  await f.db.admin.query(
    'UPDATE content.reaction SET updated_at=clock_timestamp() WHERE route=$1 AND actor_account_id=$2',
    [f.home, f.accountId],
  );
  expect(await version()).toBe(before + 4n);
  const targets = await f.target();
  await react(targets.thread, 'like', f.accountId, 'thread');
  await react(targets.post, 'love', f.accountId, 'post');
  await react(id, 'love', f.managerId);
  expect(await version()).toBe(before + 4n);
  await commands.clearReaction(
    { pool: f.db.pool, access: f.access },
    await f.verified(),
    { targetKind: 'subject', targetId: id },
    request(),
  );
  expect(await version()).toBe(before + 5n);
});

test('an update that moves a reaction between actors, targets, target kinds or kinds bumps every affected actor', async () => {
  let id = await subject();
  await react(id, 'like');
  const before = await version();
  const otherBefore = await version(f.managerId);
  // No command moves a slot's identity; direct updates prove future writers are covered.
  await f.db.admin.query(
    `UPDATE content.reaction SET route=$3, actor_account_id=$4
    WHERE route=$1 AND actor_account_id=$2 AND target_id=$5`,
    [f.home, f.accountId, routeOf(f.managerId), f.managerId, id],
  );
  expect(await version()).toBe(before + 1n);
  expect(await version(f.managerId)).toBe(otherBefore + 1n);
  const update = async (set: string, values: unknown[]) =>
    f.db.admin.query(`UPDATE content.reaction SET ${set} WHERE route=$1 AND actor_account_id=$2 AND target_id=$3`, [
      routeOf(f.managerId),
      f.managerId,
      id,
      ...values,
    ]);
  const moved = newId(0x4531);
  await update('target_route=$4, target_id=$5', [routeOf(moved), moved]);
  id = moved;
  expect(await version(f.managerId)).toBe(otherBefore + 2n);
  // Move within one route, then change kind: neither should double-bump the same actor.
  const sameRoute = newId(routeOf(id)!);
  await update('target_id=$4', [sameRoute]);
  id = sameRoute;
  expect(await version(f.managerId)).toBe(otherBefore + 3n);
  await update("kind='love'", []);
  expect(await version(f.managerId)).toBe(otherBefore + 4n);
  await update("target_kind='post'", []);
  expect(await version(f.managerId)).toBe(otherBefore + 5n);
  await update("kind='like'", []);
  expect(await version(f.managerId)).toBe(otherBefore + 5n);
  await update("target_kind='subject'", []);
  expect(await version(f.managerId)).toBe(otherBefore + 6n);
  await update("kind='laugh'", []);
  expect(await version(f.managerId)).toBe(otherBefore + 7n);
  await update('route=$4, actor_account_id=$5', [f.home, f.accountId]);
  expect(await version()).toBe(before + 1n);
  expect(await version(f.managerId)).toBe(otherBefore + 7n);
});

test('the trigger cutover waits for open reaction writers and fires for statements prepared before it', async () => {
  const pool = new Pool({ connectionString: f.db.url, max: 3 });
  const writer = await pool.connect();
  const ddl = await pool.connect();
  const prepared = await pool.connect();
  let installing: Promise<unknown> | undefined;
  try {
    await writer.query('DROP TRIGGER reaction_liked_version ON content.reaction');
    const values = (id: string, kind: string) => {
      const input = {
        route: f.home,
        actor_id: f.accountId,
        target_kind: 'subject',
        target_route: f.targetRoute,
        target_id: id,
        kind,
        at: new Date().toISOString(),
      };
      return reactionSlot.params.map((name) => input[name as keyof typeof input]);
    };
    const id = newId(f.targetRoute);
    const preparedQuery = { name: 'liked-before-cutover', text: reactionSlot.sql, values: values(id, 'laugh') };
    await prepared.query(preparedQuery);
    await writer.query('BEGIN');
    await writer.query(reactionSlot.sql, values(newId(f.targetRoute), 'like'));
    const migration = await Bun.file(new URL(`../../db/content/migrations/${migrationName}`, import.meta.url)).text();
    const trigger = migration.split('-- migrate:down')[0]!.match(/CREATE TRIGGER[\s\S]*?;/)?.[0];
    if (!trigger) throw new Error('Migration must create the reaction trigger');
    const pid = (await ddl.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    installing = ddl.query(trigger);
    // Poll the actual lock conflict rather than infer waiting from elapsed time.
    const deadline = Date.now() + 10_000;
    let waiting = false;
    while (Date.now() < deadline) {
      const locks = await f.db.admin.query(
        `SELECT 1 FROM pg_locks
        WHERE pid=$1 AND relation='content.reaction'::regclass AND NOT granted
          AND mode='ShareRowExclusiveLock' AND $2=ANY(pg_blocking_pids($1))`,
        [pid, (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid],
      );
      if (locks.rowCount) {
        waiting = true;
        break;
      }
      await Bun.sleep(20);
    }
    expect(waiting).toBe(true);
    await writer.query('COMMIT');
    await installing;
    const before = await version();
    await prepared.query({ ...preparedQuery, values: values(id, 'like') });
    expect(await version()).toBe(before + 1n);
  } finally {
    await writer.query('ROLLBACK');
    await installing;
    writer.release();
    ddl.release();
    prepared.release();
    await pool.end();
  }
}, 30_000);

test('a version overflow rolls back the reaction write', async () => {
  const id = await subject();
  await react(id, 'laugh');
  const max = '9223372036854775807';
  await f.db.admin.query(
    `INSERT INTO content.reaction_liked_version(route,actor_account_id,version)
    VALUES ($1,$2,$3) ON CONFLICT (route,actor_account_id) DO UPDATE SET version=EXCLUDED.version`,
    [f.home, f.accountId, max],
  );
  try {
    const before = (
      await f.db.admin.query('SELECT * FROM content.reaction WHERE route=$1 AND actor_account_id=$2 AND target_id=$3', [
        f.home,
        f.accountId,
        id,
      ])
    ).rows;
    await expect(react(id, 'like')).rejects.toMatchObject({ code: '22003' });
    expect(
      (
        await f.db.admin.query(
          'SELECT * FROM content.reaction WHERE route=$1 AND actor_account_id=$2 AND target_id=$3',
          [f.home, f.accountId, id],
        )
      ).rows,
    ).toEqual(before);
    expect(await version()).toBe(9223372036854775807n);
  } finally {
    // Restore only this test fixture so later tests can keep using the same actor.
    await f.db.admin.query(
      'UPDATE content.reaction_liked_version SET version=1 WHERE route=$1 AND actor_account_id=$2',
      [f.home, f.accountId],
    );
  }
});

test('page, membership and version reads return the version in one statement, empty results included, and a missing row reads as 0', async () => {
  const actorAccountId = newId(f.home);
  const read = async (expected: bigint) => {
    const operations = [
      () => readers.readLikedSubjectPage(f.db.pool, { actorAccountId, limit: 1 }),
      () => readers.readLikedMembership(f.db.pool, { actorAccountId, subjectIds: [] }),
      () => readers.readLikedMembership(f.db.pool, { actorAccountId, subjectIds: [newId(f.targetRoute)] }),
      () => readers.readLikedVersion(f.db.pool, { actorAccountId }),
    ];
    for (const operation of operations) {
      const { value, cost } = await measure(f.db, operation);
      expect(cost.statements).toBe(1);
      if (typeof value === 'bigint') expect(value).toBe(expected);
      else {
        expect(value.version).toBe(expected);
        expect(value.subjects).toEqual(Array.isArray(value.subjects) ? [] : new Set());
      }
    }
  };
  await read(0n);
  // Exact int8 parsing beyond Number's precision, including empty source sets.
  await f.db.admin.query('INSERT INTO content.reaction_liked_version VALUES ($1,$2,$3)', [
    f.home,
    actorAccountId,
    '9007199254740993',
  ]);
  await read(9007199254740993n);
});

test('a version reader against a database without the version migration fails closed instead of reading 0', async () => {
  const name = `liked_before_${crypto.randomUUID().replaceAll('-', '')}`;
  const url = new URL(f.db.url);
  url.pathname = `/${name}`;
  let pool: Pool | undefined;
  try {
    await f.db.admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    pool = new Pool({ connectionString: url.href, max: 1 });
    const root = new URL('../../', import.meta.url);
    const files = Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: root.pathname }))
      .filter((path) => path.split('/').at(-1)!.split('_')[0]! < migrationName.split('_')[0]!)
      .sort((a, b) => a.split('/').at(-1)!.localeCompare(b.split('/').at(-1)!));
    // Apply precisely the migrations preceding this change, in ordinary global version order.
    for (const file of files) {
      const sql = (await Bun.file(new URL(file, root)).text()).split('-- migrate:up')[1]?.split('-- migrate:down')[0];
      if (!sql) throw new Error(`Missing migration up section: ${file}`);
      await pool.query(sql);
    }
    const actorAccountId = newId(f.home);
    await expect(readers.readLikedSubjectPage(pool, { actorAccountId, limit: 1 })).rejects.toMatchObject({
      code: '42P01',
    });
    await expect(readers.readLikedMembership(pool, { actorAccountId, subjectIds: [] })).rejects.toMatchObject({
      code: '42P01',
    });
    await expect(
      readers.readLikedMembership(pool, { actorAccountId, subjectIds: [newId(f.targetRoute)] }),
    ).rejects.toMatchObject({ code: '42P01' });
    await expect(readers.readLikedVersion(pool, { actorAccountId })).rejects.toMatchObject({ code: '42P01' });
  } finally {
    await pool?.end();
    await dropTestDatabase(f.db.admin, name);
  }
}, 120_000);
