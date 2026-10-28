import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createPool } from '../../src/database/pool.ts';
import { createCopyCommands } from '../../src/library/copies.ts';
import { createFollowCommands } from '../../src/library/follows.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from '../semantic/real-access.ts';

let db: GrowthDatabase;
// A separate command pool lets deletion reach the database while the Library command is held.
let deletionPool: ReturnType<typeof createPool>;
beforeAll(async () => {
  db = await openGrowthDatabase();
  deletionPool = createPool(process.env.DATABASE_URL!);
  await bootstrapRelease(db.pool, bundledRelease);
  // Keep the artificial insert pause independent of the command's normal lock timeout.
  await db.admin.query(`CREATE FUNCTION library.fixture_owner_barrier_pause() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM set_config('lock_timeout', '0', true);
      PERFORM pg_advisory_xact_lock(27168);
      RETURN NEW;
    END $$`);
});
afterAll(async () => {
  await deletionPool?.end();
  await db?.close();
});

async function blockedBy(pid: number, query: string, check = () => {}): Promise<number> {
  const deadline = Date.now() + 10000;
  do {
    check();
    const result = await db.admin.query<{ pid: number }>(
      'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE $2',
      [pid, query],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await Bun.sleep(5);
  } while (Date.now() < deadline);
  throw new Error(`No database command blocked by ${pid}: ${query}`);
}

for (const table of ['copy', 'follow'] as const) {
  test(`a real lifecycle barrier waits for a private ${table} write and denies later writes and replay`, async () => {
    const route = 0x6a20;
    const accountId = newId(route);
    const scopes = [...LIFECYCLE_ACTIONS.keys(), 'subject:read', 'copy:create', 'follow:create'];
    const fixture = await createRealAccess(db.admin, { owner: accountId }, scopes);
    const actions = new Map([...scopes.map((action) => [action, { anonymous: false }] as const), ...LIFECYCLE_ACTIONS]);
    const access = fixture.access({ actions });
    const actor = await access.authenticate(fixture.bearer('owner'), { pool: db.pool, deadline: Date.now() + 10000 });
    const deletionActor = await access.authenticate(fixture.bearer('owner'), {
      pool: deletionPool,
      deadline: Date.now() + 10000,
    });
    await fixture.grant({ route, id: accountId }, 'owner', 'account:delete');
    const key = randomUUID();
    const subject = await createSubject(db.pool, {
      actor,
      target: subjectTarget(new Uint8Array(32), accountId, key),
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { type: 'schema:Book', labels: { en: 'Owner barrier' } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    });
    await fixture.grant({ route: routeOf(subject.subject.id)!, id: subject.subject.id }, 'owner', 'subject:read');
    const copies = createCopyCommands({
      pool: db.pool,
      access,
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32)]]) },
    });
    const follows = createFollowCommands({ pool: db.pool, access });
    const requestKey = randomUUID();
    const write = (key = requestKey) =>
      table === 'copy'
        ? copies.createCopy(actor, { subjectId: subject.subject.id, status: 'owned' }, key)
        : follows.follow(actor, { targetId: subject.subject.id, targetType: 'subject' }, key);
    const commands = createLifecycleCommands({ pool: deletionPool, access });
    const locker = await db.admin.connect();
    await db.admin.query(`CREATE TRIGGER fixture_owner_barrier_pause BEFORE INSERT ON library.${table}
      FOR EACH ROW EXECUTE FUNCTION library.fixture_owner_barrier_pause()`);
    let writing: ReturnType<typeof write> | undefined;
    let deleting: ReturnType<typeof commands.tombstone> | undefined;
    let writeError: unknown;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT pg_advisory_xact_lock(27168)');
      const { rows } = await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      writing = write();
      void writing.catch((error) => {
        writeError = error;
      });
      const ownerPid = await blockedBy(rows[0]!.pid, `%library.${table}%`, () => {
        if (writeError) throw writeError;
      });
      deleting = commands.tombstone(
        { actor: deletionActor, deadline: Date.now() + 10000 },
        { accountId, key: randomUUID() },
      );
      void deleting.catch(() => {});
      await blockedBy(ownerPid, '%FOR UPDATE%');
      await locker.query('ROLLBACK');
      const written = await writing;
      const barrier = await deleting;
      const outcome = 'command' in written ? written.command! : written;
      expect(outcome.replayed).toBe(false);
      expect(outcome.position < barrier.position).toBe(true);
      expect(
        (await db.admin.query(`SELECT count(*)::int AS n FROM library.${table} WHERE account_id=$1`, [accountId]))
          .rows[0].n,
      ).toBe(1);
      expect(
        (
          await db.admin.query('SELECT type FROM core.outbox WHERE partition_no=$1 AND position=$2', [
            barrier.partition,
            String(barrier.position),
          ])
        ).rows.map((row) => row.type),
      ).toContain('com.rezics.access.account-tombstoned.v1');
      await expect(write()).rejects.toBeInstanceOf(GrantDeniedError);
      await expect(write(randomUUID())).rejects.toBeInstanceOf(GrantDeniedError);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await Promise.allSettled([writing, deleting]);
      await db.admin.query(`DROP TRIGGER fixture_owner_barrier_pause ON library.${table}`);
    }
  });
}
