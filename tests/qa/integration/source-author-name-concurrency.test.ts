import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { SourceAuthorNameStore } from '../../../services/main/src/modules/source/author-name.ts';
import {
  SourceIntakeStore,
  SourceIntakeConflict,
} from '../../../services/main/src/modules/source/intake.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

let databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let pool: Pool;
beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA integration tier');
  databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['content'], 'owner');
  pool = new Pool({ connectionString: databases.urls.content, max: 8 });
  await migrateContent(pool);
}, 60_000);
afterAll(async () => {
  await pool?.end();
  await databases?.close();
});

function store(connection = pool) {
  const intake = new SourceIntakeStore(connection);
  intake.reserveOpenLibrarySlot = async () => {};
  return new SourceAuthorNameStore(connection, intake, (async (url: string | URL | Request) => {
    const key = new URL(String(url)).pathname.replace(/\.json$/, '');
    return Response.json({
      key,
      revision: 1,
      name: `Concurrent factual name ${key}`,
      type: { key: '/type/author' },
    });
  }) as typeof fetch);
}

/** Pause the real command after its head and change row are written. */
function holdNameCommit() {
  let release!: () => void, reach!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const held = new Proxy(pool, {
    get(target, key, receiver) {
      if (key !== 'connect') {
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        let changed = false;
        return new Proxy(client, {
          get(object, name, own) {
            const value = Reflect.get(object, name, own);
            if (name !== 'query') return typeof value === 'function' ? value.bind(object) : value;
            return async (...args: unknown[]) => {
              const sql = typeof args[0] === 'string' ? args[0] : '';
              changed ||= sql.includes('INSERT INTO source.author_name_head');
              if (sql === 'COMMIT' && changed) {
                changed = false;
                reach();
                await released;
              }
              return (value as (...a: unknown[]) => unknown).apply(object, args);
            };
          },
        });
      };
    },
  });
  return { pool: held, reached, release };
}

const refresh = { action: 'refresh' as const, expectedRevision: null };
test('unrelated author refresh commits within one second and search detects a late commit while xmin is pinned', async () => {
  const oldest = await pool.connect();
  await oldest.query('BEGIN');
  await oldest.query('SELECT pg_current_xact_id()');
  const held = holdNameCommit(),
    names = store();
  const heldKey = '/authors/OL9100000001A',
    otherKey = '/authors/OL9100000002A';
  const first = store(held.pool).command(randomUUID(), randomUUID(), heldKey, refresh);
  let pending = true;
  void first.then(
    () => {
      pending = false;
    },
    () => {
      pending = false;
    },
  );
  try {
    await Promise.race([
      held.reached,
      first.then(() => {
        throw new Error('Author command finished before the commit hold');
      }),
    ]);
    const before = await names.search('concurrent factual name', false);
    expect(before.names.has(heldKey)).toBe(false);
    const principal = randomUUID(),
      key = randomUUID(),
      started = performance.now();
    const other = await names.command(principal, key, otherKey, refresh);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(pending).toBe(true);
    const afterOther = await names.search('concurrent factual name', false);
    expect(afterOther.names.get(otherKey)).toEqual(other.name!);
    expect(afterOther.names.has(heldKey)).toBe(false);
    expect(afterOther.generation).not.toBe(before.generation);
    await pool.query('SELECT pg_current_xact_id()');
    expect(await names.searchGeneration()).toBe(afterOther.generation);
    await pool.query('SELECT source.prune_author_name_changes()');
    expect(await names.searchGeneration()).toBe(afterOther.generation);
    expect((await names.command(principal, key, otherKey, refresh)).replayed).toBe(true);
    expect(await names.searchGeneration()).toBe(afterOther.generation);
    await expect(names.command(principal, randomUUID(), otherKey, refresh)).rejects.toBeInstanceOf(
      SourceIntakeConflict,
    );
    expect(await names.searchGeneration()).toBe(afterOther.generation);
    held.release();
    const result = await first;
    const afterHeld = await names.search('concurrent factual name', false);
    expect(afterHeld.generation).not.toBe(afterOther.generation);
    expect(afterHeld.names.get(heldKey)).toEqual(result.name!);
    await oldest.query('ROLLBACK');
    const stable = await names.searchGeneration();
    await pool.query('SELECT pg_current_xact_id()');
    expect(await names.searchGeneration()).toBe(stable);
    expect(
      (await pool.query('SELECT to_regclass($1) AS table_name', ['source.author_name_generation']))
        .rows[0]!.table_name,
    ).toBeNull();
  } finally {
    held.release();
    await first.catch(() => {});
    await oldest.query('ROLLBACK');
    oldest.release();
  }
}, 30_000);

test('author search pruning is bounded and preserves fences across restored high xids and fresh changes', async () => {
  const names = store();
  await pool.query(`INSERT INTO source.author_name_change(epoch,xid)
    SELECT version,'9223372036854775808'::xid8 FROM source.author_name_epoch WHERE singleton`);
  const restored = await names.searchGeneration();
  await pool.query('SELECT source.advance_author_name_restore_epoch()');
  const recovered = await names.searchGeneration();
  expect(recovered).not.toBe(restored);
  await pool.query(`INSERT INTO source.author_name_change(epoch,xid)
    SELECT version,'0'::xid8 FROM source.author_name_epoch CROSS JOIN generate_series(1,600) WHERE singleton`);
  const beforePrune = await names.searchGeneration();
  const prune = async () =>
    (await pool.query<{ removed: number }>('SELECT source.prune_author_name_changes() AS removed'))
      .rows[0]!.removed;
  expect(await prune()).toBe(256);
  expect(await names.searchGeneration()).toBe(beforePrune);
  for (let i = 0; i < 4; i++) {
    expect(await prune()).toBeLessThanOrEqual(256);
    expect(await names.searchGeneration()).toBe(beforePrune);
  }
  expect(await prune()).toBe(0);
  expect(
    (await pool.query('SELECT count(*)::integer AS count FROM source.author_name_change')).rows[0]!
      .count,
  ).toBe(1);
  await names.command(randomUUID(), randomUUID(), '/authors/OL9100000003A', refresh);
  expect(await names.searchGeneration()).not.toBe(beforePrune);
  const fresh = await names.searchGeneration();
  await pool.query('SELECT pg_current_xact_id()');
  expect(await names.searchGeneration()).toBe(fresh);
  const rollback = await pool.connect();
  try {
    await rollback.query('BEGIN');
    await rollback.query(
      `DELETE FROM source.author_name_head WHERE author_key = '/authors/OL9100000003A'`,
    );
    await rollback.query('ROLLBACK');
    expect(await names.searchGeneration()).toBe(fresh);
  } finally {
    rollback.release();
  }
}, 30_000);
