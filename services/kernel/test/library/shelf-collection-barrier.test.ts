import { setFixtureAccountState } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { createCollectionReads } from '../../src/library/collection-reads.ts';
import { newId } from '../../src/route/route.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => db?.close());
async function fixture() {
  const route = 0x6a20;
  const ownerId = newId(route),
    collaboratorId = newId(route);
  const actions = ['create', 'read', 'update', 'delete']
    .map((verb) => `collection:${verb}`)
    .concat('account:delete', 'subject:read');
  const real = await createRealAccess(db.admin, { owner: ownerId, collaborator: collaboratorId }, actions);
  const access = real.access({
    actions: new Map(
      actions.map((action) => [
        action,
        {
          anonymous: action === 'collection:read' || action === 'subject:read',
          ...(action === 'collection:create' ? { 'x-resource-types': ['library.collection'] } : {}),
        },
      ]),
    ),
  });
  const auth = (persona: 'owner' | 'collaborator', pool = db.pool) =>
    access.authenticate(real.bearer(persona), { pool, deadline: Date.now() + 5000 });
  const commands = createCollectionCommands({ pool: db.pool, access });
  const draft = { title: 'Public', visibility: 'public' as const };
  const created = await commands.createCollection(await auth('owner'), draft, randomUUID());
  const id = created.value.id;
  for (const action of ['collection:update', 'collection:delete'])
    await real.grant({ route, id }, 'collaborator', action);
  await real.grant({ route, id: ownerId }, 'owner', 'account:delete');
  // A separate native command pool lets the race reach PostgreSQL's account lock.
  const nativePool = db.openPool();
  const nativeAccounts = createLifecycleCommands({ pool: nativePool, access });
  const tombstone = async () =>
    nativeAccounts.tombstone(
      { actor: await auth('owner', nativePool), deadline: Date.now() + 5000 },
      { accountId: ownerId, key: randomUUID() },
    );
  return { route, ownerId, id, access, auth, commands, tombstone };
}
// Pause only real account-share SQL, preserving the native Access formula and transaction.
function observeShare(base: Pool, when: 'before' | 'after', pause: (client: PoolClient) => Promise<void>): Pool {
  const seam = Object.create(base) as Pool;
  seam.query = base.query.bind(base);
  let armed = true;
  seam.connect = (async () => {
    const client = await base.connect();
    const wrapped = Object.create(client) as PoolClient;
    wrapped.release = client.release.bind(client);
    wrapped.query = (async (input: QueryConfig | string, values?: unknown[]) => {
      const sql = typeof input === 'string' ? input : input.text;
      const stop = armed && sql.includes('FROM access.account') && sql.includes('FOR SHARE');
      if (stop) armed = false;
      if (stop && when === 'before') await pause(client);
      const result = typeof input === 'string' ? await client.query(input, values) : await client.query(input);
      if (stop && when === 'after') await pause(client);
      return result;
    }) as PoolClient['query'];
    return wrapped;
  }) as Pool['connect'];
  return seam;
}
for (const when of ['before', 'after'] as const) {
  test(`native curator deletion ${when === 'after' ? 'waits for an admitted collaborator' : 'wins before curator sharing'}`, async () => {
    const f = await fixture();
    const reached = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const pool = observeShare(db.openPool(), when, async (client) => {
      const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      reached.resolve(backend.rows[0]!.pid);
      await release.promise;
    });
    const commands = createCollectionCommands({ pool, access: f.access });
    const key = randomUUID(),
      input = { revision: 1, title: 'Before barrier' };
    const writing = commands.updateCollection(await f.auth('collaborator', pool), f.id, input, key);
    void writing.catch(reached.reject);
    let deleting: ReturnType<typeof f.tombstone> | undefined;
    try {
      const holder = await reached.promise;
      deleting = f.tombstone();
      void deleting.catch(() => {});
      if (when === 'after') {
        let blocked = false;
        const deadline = Date.now() + 2000;
        while (!blocked && Date.now() < deadline) {
          const locks = await db.admin.query<{ blocked: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
             WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%access.account%' AND query LIKE '%FOR UPDATE%') AS blocked`,
            [holder],
          );
          blocked = locks.rows[0]!.blocked;
          if (!blocked) await Bun.sleep(5);
        }
        expect(blocked).toBe(true);
        release.resolve();
        expect((await writing).replayed).toBe(false);
        await deleting;
      } else {
        await deleting;
        release.resolve();
        await expect(writing).rejects.toBeInstanceOf(GrantDeniedError);
      }
      await expect(
        commands.updateCollection(await f.auth('collaborator', pool), f.id, input, key),
      ).rejects.toBeInstanceOf(GrantDeniedError);
      const row = await db.admin.query(
        'SELECT state, title, curator_account_id FROM library.collection WHERE route=$1 AND collection_id=$2',
        [f.route, f.id],
      );
      expect(row.rows[0]).toEqual({
        state: 'active',
        title: when === 'after' ? input.title : 'Public',
        curator_account_id: f.ownerId,
      });
      const account = await db.admin.query('SELECT state FROM access.account WHERE route=$1 AND account_id=$2', [
        f.route,
        f.ownerId,
      ]);
      expect(account.rows[0].state).toBe('deleted');
    } finally {
      release.resolve();
      await Promise.allSettled([writing, deleting]);
    }
  });
}
test('unavailable curator freezes all member and Collection mutations while public reads survive', async () => {
  const f = await fixture();
  const memberId = newId(f.route);
  await db.admin.query(
    `INSERT INTO library.collection_member(route,collection_id,member_id,subject_id,note,ordinal_key,added_at,transaction_id)
     VALUES($1,$2,$3,$3,'Published note','V',now(),$3)`,
    [f.route, f.id, memberId],
  );
  await db.admin.query('UPDATE library.collection SET member_count=1 WHERE route=$1 AND collection_id=$2', [
    f.route,
    f.id,
  ]);
  const replayKey = randomUUID(),
    patch = { revision: 1, title: 'Retained' };
  await f.commands.updateCollection(await f.auth('collaborator'), f.id, patch, replayKey);
  const noteKey = randomUUID();
  await f.commands.updateMemberNote(await f.auth('collaborator'), f.id, memberId, { note: 'Retained note' }, noteKey);
  const effects = () =>
    db.admin
      .query('SELECT (SELECT count(*) FROM core.receipt) receipts, (SELECT count(*) FROM core.outbox) events')
      .then(({ rows }) => rows);
  for (const state of ['pending', 'suspended', 'fenced', 'deleted'] as const) {
    await setFixtureAccountState(db.admin, f.ownerId, state === 'fenced' ? 'active' : state);
    await db.admin.query('UPDATE access.account SET authn_fenced=$3 WHERE route=$1 AND account_id=$2', [
      f.route,
      f.ownerId,
      state === 'fenced' || state === 'suspended',
    ]);
    const before = await effects();
    const actor = () => f.auth('collaborator');
    const mutations = [
      async () => f.commands.updateCollection(await actor(), f.id, patch, replayKey),
      async () =>
        f.commands.updateCollection(await actor(), f.id, { revision: 2, visibility: 'private' }, randomUUID()),
      async () => f.commands.deleteCollection(await actor(), f.id, 2, randomUUID()),
      async () => f.commands.addMember(await actor(), f.id, { subjectId: memberId }, randomUUID()),
      async () => f.commands.moveMember(await actor(), f.id, memberId, { after: null }, randomUUID()),
      async () => f.commands.updateMemberNote(await actor(), f.id, memberId, { note: 'Retained note' }, noteKey),
      async () => f.commands.updateMemberNote(await actor(), f.id, memberId, { note: 'Forbidden' }, randomUUID()),
      async () => f.commands.removeMember(await actor(), f.id, memberId, randomUUID()),
    ];
    for (const mutate of mutations) await expect(mutate()).rejects.toBeInstanceOf(GrantDeniedError);
    expect(await effects()).toEqual(before);
  }
  const reads = createCollectionReads({
    pool: db.pool,
    access: f.access,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32)]]) },
  });
  expect(await reads.readCollection({ kind: 'anonymous' }, f.id)).toMatchObject({
    title: 'Retained',
    visibility: 'public',
    curatorAccountId: f.ownerId,
    memberCount: 1,
  });
  const notes = await db.admin.query('SELECT note FROM library.collection_member WHERE route=$1 AND collection_id=$2', [
    f.route,
    f.id,
  ]);
  expect(notes.rows).toEqual([{ note: 'Retained note' }]);
});
test('curator account availability failure remains an availability failure', async () => {
  const f = await fixture();
  const unavailable = new Error('Curator account dependency unavailable');
  const pool = observeShare(db.openPool(), 'before', async () => {
    throw unavailable;
  });
  const commands = createCollectionCommands({ pool, access: f.access });
  const input = { revision: 1, title: 'Forbidden' };
  await expect(commands.updateCollection(await f.auth('collaborator', pool), f.id, input, randomUUID())).rejects.toBe(
    unavailable,
  );
});
