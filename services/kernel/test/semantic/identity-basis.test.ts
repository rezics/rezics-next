import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { nativeIdentityCapabilities } from '../../src/semantic/identity-adapter-bind.ts';
import { createIdentityReaders } from '../../src/semantic/identity-adapters/identity-epoch-read.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { newId } from '../../src/route/route.ts';
import { readIdentityBasis, readIdentityHome } from '../../src/semantic/identity-basis.ts';
import { readIdentityMappings } from '../../src/semantic/identity-epoch-read.ts';
import { bindSearchIdentityCursorRequest } from '../../src/search/canonical-keyset-admit.ts';
import { decodeSearchCursor, encodeSearchCursor } from '../../src/search/cursor.ts';
import { createIdentityMappingFixture } from './support/identity-epoch-mapping.ts';
import { digest, home, identityEpochDatabase, release } from './support/identity-epoch.ts';
import { appendEdge } from './support/identity-terminal-closure.ts';

const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
const binding = (basis: string) => ({
  operation: 'subjects.search',
  principal: 'anonymous',
  request: bindSearchIdentityCursorRequest({ sort: 'name' }, basis),
});

const observe = (pool: Pool) => readIdentityBasis(pool, { deadline: Date.now() + 5000 });
async function ready(pool: Pool) {
  const result = await observe(pool);
  expect(result.state).toBe('ready');
  if (result.state !== 'ready') throw new Error('Expected clean identity shards');
  return result.basis.digest;
}

test('fresh shards bind native topology, ignore ordinary positions and invalidate authenticated continuation on commit', async () => {
  const db = await identityEpochDatabase();
  const client = await db.admin.connect();
  try {
    expect((await client.query('SELECT count(*)::int homes FROM semantic.identity_home')).rows).toEqual([
      { homes: 4096 },
    ]);
    expect(
      (
        await client.query(
          'SELECT count(*)::int shards FROM semantic.identity_basis_shard WHERE pending=0 AND active_homes=64',
        )
      ).rows,
    ).toEqual([{ shards: 64 }]);
    // Flush only the two owned backends. Tuple counters include all native
    // accesses inside the real double collection, including aggregate inputs.
    const tuples = async () =>
      Number(
        (
          await client.query(`
      SELECT sum(seq_tup_read + idx_tup_fetch) n FROM pg_stat_user_tables
      WHERE relname IN ('partition','identity_epoch_control','identity_epoch_group','redirect','identity_home','identity_basis_shard')
        AND schemaname IN ('core','semantic')`)
        ).rows[0]!.n,
      );
    await client.query('SELECT pg_stat_force_next_flush()');
    const before = await tuples();
    const initial = await ready(db.pool);
    await db.pool.query('SELECT pg_stat_force_next_flush()');
    expect((await tuples()) - before).toBe(128);
    const published = createHash('sha256').update('rezics.identity-basis.v2');
    const shards = await client.query<{ basis: Buffer }>(
      'SELECT basis FROM semantic.identity_basis_shard ORDER BY shard',
    );
    for (const row of shards.rows) published.update(row.basis);
    expect(initial).toBe(published.digest('hex'));
    const token = await encodeSearchCursor(ring, binding(initial), { generation: 1, after: ['Book'] });
    await client.query('UPDATE core.partition SET position=position+1 WHERE partition_no=17');
    expect(await ready(db.pool)).toBe(initial);
    expect((await decodeSearchCursor(ring, binding(initial), token)).ok).toBe(true);

    // A full scan looks cheap after ANALYZE, but its predicate covers every shard.
    await client.query('ANALYZE semantic.identity_basis_shard');
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await client.query("UPDATE core.partition SET write_state='moved',moved_to='next' WHERE partition_no=17");
      expect(
        (
          await client.query(`SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND mode='SIReadLock'
          AND relation='semantic.identity_basis_shard'::regclass AND locktype='relation'`)
        ).rowCount,
      ).toBe(0);
      await expect(readIdentityHome(client, 17)).rejects.toMatchObject({ reason: 'moved', movedTo: 'next' });
      expect(await ready(db.pool)).toBe(initial);
    } finally {
      await client.query('ROLLBACK');
    }
    expect(await ready(db.pool)).toBe(initial);

    await client.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=17");
    expect(await observe(db.pool)).toEqual({ state: 'not_ready' });
    await client.query("UPDATE core.partition SET write_state='active' WHERE partition_no=17");
    // The controlled migration reconciles Access lineage and native routing together.
    const rotate = async (epoch: number, node: string) => {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL session_replication_role='replica'");
        await client.query('UPDATE access.live_copy_domain SET epoch=$1,node=$2 WHERE partition_no=17', [epoch, node]);
        await client.query('UPDATE core.partition SET epoch=$1,node=$2 WHERE partition_no=17', [epoch, node]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
    const reactivated = await ready(db.pool);
    const prior = await readIdentityHome(client, 17);
    await rotate(2, prior.home);
    const epoch = await ready(db.pool);
    expect(epoch).not.toBe(reactivated);
    await rotate(2, 'new-writer');
    const moved = await ready(db.pool);
    expect(moved).not.toBe(epoch);
    expect(await readIdentityHome(client, 17)).toMatchObject({ epoch: 2, home: 'new-writer' });
    expect((await decodeSearchCursor(ring, binding(moved), token)).ok).toBe(false);
    await client.query('DELETE FROM semantic.identity_basis_shard WHERE shard=63');
    expect(await observe(db.pool)).toEqual({ state: 'not_ready' });
    expect(await readIdentityBasis(db.pool, { deadline: Date.now() + 5000, freshSearch: true })).toEqual({
      state: 'not_ready',
    });
  } finally {
    client.release();
    await db.close();
  }
});

const birthIntervalMigration = new URL(
  '../../db/semantic/migrations/20261122120000_certify_identity_birth_intervals.sql',
  import.meta.url,
);

test('an unbound ranked page accepts only certified fresh self births between independent complete observations', async () => {
  const db = await identityEpochDatabase();
  try {
    const f = await createIdentityMappingFixture({ poolMax: 1, url: db.url });
    try {
      async function createBook(label: string) {
        const key = randomUUID();
        const route = 0x5210;
        const created = await createSubject(f.pool, {
          actor: await f.actor(),
          target: { route, id: newId(route) },
          item: { type: 'schema:Book', labels: { en: label } },
          idempotencyKey: key,
          digest: digest(key),
          release,
          authorization: await f.authorization('subject:create'),
        });
        return created.subject.id;
      }
      const native = nativeIdentityCapabilities();
      async function between(freshSearch: boolean, commit: () => Promise<unknown>) {
        let snapshots = 0;
        const readers = createIdentityReaders({
          ...native,
          read: {
            ...native.read,
            async withReadStatement<T>(pool: Pool, read: (c: PoolClient) => Promise<T>, deadline: number) {
              const result = await native.read.withReadStatement!(pool, read, deadline);
              if (++snapshots === 1) await commit();
              return result;
            },
          },
        });
        const observed = await readers.readIdentityBasis(f.pool, { deadline: Date.now() + 10_000, freshSearch });
        expect(snapshots).toBe(2);
        return observed;
      }
      const initial = await ready(db.pool);
      const cursor = await encodeSearchCursor(ring, binding(initial), { generation: 1, after: ['selected'] });
      expect(await between(false, () => createBook('Strict observation'))).toEqual({ state: 'not_ready' });
      const original = await createBook('First original');
      const terminal = await createBook('Second original');
      const born = await between(true, async () => {
        await createBook('First overlapping birth');
        await createBook('Second overlapping birth');
      });
      const current = await ready(db.pool);
      expect(born).toEqual({ state: 'ready', basis: { digest: current } });
      expect(current).not.toBe(initial);
      expect((await decodeSearchCursor(ring, binding(current), cursor)).ok).toBe(false);
      expect(
        await between(true, async () => {
          await appendEdge(db, original, terminal);
          await createBook('Birth alongside redirect on its own shard');
        }),
      ).toEqual({ state: 'not_ready' });
      expect(
        await between(true, async () => {
          await db.admin.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=17");
          await db.admin.query("UPDATE core.partition SET write_state='active' WHERE partition_no=17");
        }),
      ).toEqual({ state: 'not_ready' });
      expect(
        await between(true, () =>
          db.admin.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=17"),
        ),
      ).toEqual({ state: 'not_ready' });
      expect(
        await between(true, () =>
          db.admin.query("UPDATE core.partition SET write_state='active' WHERE partition_no=17"),
        ),
      ).toEqual({ state: 'not_ready' });

      const home = 0x5210 / 16;
      await db.admin.query(`CREATE FUNCTION semantic.relocate_at_birth_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE core.partition SET write_state='fenced' WHERE partition_no=NEW.partition_no;
          UPDATE core.partition SET write_state='active' WHERE partition_no=NEW.partition_no;
          RETURN NULL;
        END $$;
        CREATE TRIGGER relocate_at_birth_test AFTER INSERT ON semantic.identity_epoch_original
        FOR EACH ROW WHEN (NEW.partition_no=${home}) EXECUTE FUNCTION semantic.relocate_at_birth_test()`);
      try {
        expect(
          await between(true, () => createBook('Birth and competing transition in the same native transaction')),
        ).toEqual({ state: 'not_ready' });
      } finally {
        await db.admin.query(
          'DROP TRIGGER relocate_at_birth_test ON semantic.identity_epoch_original; DROP FUNCTION semantic.relocate_at_birth_test()',
        );
      }
      // An older initializer still writes and advances v2, without certifying its group as an isolated birth.
      const previous = (
        await Bun.file(
          new URL('../../db/semantic/migrations/20261122033200_initialize_identity_birth.sql', import.meta.url),
        ).text()
      ).split('-- migrate:down')[0]!;
      await db.admin.query(previous.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
      expect(await between(true, () => createBook('Native birth from the previous writer'))).toEqual({
        state: 'not_ready',
      });
      const [up, down] = (await Bun.file(birthIntervalMigration).text()).split('-- migrate:down');
      await db.admin.query(down!);
      await createBook('Older native owner after rollback');
      expect(await ready(db.pool)).not.toBe(current);
      await db.admin.query(up!);
      expect(
        await between(true, async () => {
          // Even a full down/up that preserves the native basis starts a new structural lineage.
          await db.admin.query(down!);
          await db.admin.query(up!);
        }),
      ).toEqual({ state: 'not_ready' });
      const pending = await between(true, () => f.admitMerge());
      expect(pending).toEqual({ state: 'not_ready' });
      expect(await between(true, () => createBook('Birth while the real merge remains pending'))).toEqual({
        state: 'not_ready',
      });
    } finally {
      await f.close();
    }
  } finally {
    await db.close();
  }
}, 180_000);

test('forward migration captures retained redirects and off-page claims and follows the admitted native mapping writer', async () => {
  const db = await identityEpochDatabase();
  try {
    const f = await createIdentityMappingFixture({ poolMax: 1, url: db.url });
    try {
      const [up, down] = (
        await Bun.file(
          new URL('../../db/semantic/migrations/20261119004704_identity_basis.sql', import.meta.url),
        ).text()
      ).split('-- migrate:down');
      const page = (await f.create('Selected original', 0x3410)).id;
      const alias = (await f.create('Retained redirect', 0x5210)).id;
      const oldBasis = await ready(db.pool);
      const held = await db.admin.connect();
      let target: string;
      try {
        await held.query('BEGIN');
        await held.query('SELECT shard FROM semantic.identity_basis_shard WHERE shard=$1 FOR UPDATE', [
          home(alias) % 64,
        ]);
        // Another home in the same shard can commit a new Subject while the shard row is held.
        target = (await f.create('Retained terminal', 0x5610)).id;
      } finally {
        await held.query('ROLLBACK');
        held.release();
      }
      expect(await ready(db.pool)).toBe(oldBasis);
      // Reinstalling the same singleton over an existing Subject changes structural evidence.
      const removed = await db.admin.query(
        'DELETE FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2 RETURNING to_jsonb(identity_epoch_group) AS header',
        [home(target), target],
      );
      const missing = await ready(db.pool);
      expect(missing).not.toBe(oldBasis);
      await db.admin.query(
        'INSERT INTO semantic.identity_epoch_group SELECT * FROM jsonb_populate_record(NULL::semantic.identity_epoch_group,$1)',
        [removed.rows[0]!.header],
      );
      const groupBasis = await ready(db.pool);
      expect(groupBasis).not.toBe(missing);
      const token = await encodeSearchCursor(ring, binding(groupBasis), { generation: 1, after: [page] });
      await appendEdge(db, alias, target);
      const committed = await ready(db.pool);
      expect(committed).not.toBe(groupBasis);
      expect((await decodeSearchCursor(ring, binding(committed), token)).ok).toBe(false);
      const [guardUp, guardDown] = (await Bun.file(birthIntervalMigration).text()).split('-- migrate:down');
      await db.admin.query(guardDown!);
      await db.admin.query(down!);
      const {
        job,
        survivor,
        redirectedOriginals: [original],
      } = await f.admitMerge();
      const expected = (
        await db.admin.query(
          `
        SELECT h home,(coalesce((SELECT sum(version) FROM semantic.identity_epoch_group WHERE partition_no=h),0)
                +coalesce((SELECT sum(sequence) FROM semantic.redirect WHERE route/16=h),0))::text generation,
               ((SELECT count(pending_job) FROM semantic.identity_epoch_group WHERE partition_no=h)
                +(SELECT count(pending_job) FROM semantic.identity_epoch_control WHERE partition_no=h))::text pending
        FROM unnest($1::int[]) h ORDER BY h`,
          [[home(alias), home(original!), home(survivor)]],
        )
      ).rows;
      expect(expected.some((row) => BigInt(row.pending) > 0n)).toBe(true);
      expect(await f.nativeDirectRedirect(alias)).toBe(target);
      await db.admin.query(`BEGIN;\n${up}\n${guardUp}\nCOMMIT;`);
      expect(
        (
          await db.admin.query(
            `SELECT partition_no home,generation::text,pending::text FROM semantic.identity_home
        WHERE partition_no=ANY($1::int[]) ORDER BY partition_no`,
            [expected.map((row) => row.home)],
          )
        ).rows,
      ).toEqual(expected);
      expect(await observe(db.pool)).toEqual({ state: 'not_ready' });

      expect(await readIdentityMappings(db.pool, [page])).toMatchObject([{ state: 'mapped', terminal: page }]);
      const steps = await f.drainMapping(job, 512);
      expect(steps.at(-1)?.state).toBe('complete');
      expect(await f.nativeDirectRedirect(original!)).toBe(survivor);
      const source = (
        await db.admin.query('SELECT generation FROM semantic.identity_home WHERE partition_no=$1', [home(original!)])
      ).rows[0]!;
      expect(BigInt(source.generation)).toBeGreaterThan(
        BigInt(expected.find((row) => row.home === home(original!))!.generation),
      );
      expect(await observe(db.pool)).toEqual({ state: 'not_ready' });
    } finally {
      await f.close();
    }
  } finally {
    await db.close();
  }
}, 180_000);
