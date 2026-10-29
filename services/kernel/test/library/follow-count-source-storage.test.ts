import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import pg, { type PoolClient } from 'pg';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { createSpace } from '../../src/community/space.ts';
import { createFollowCommands } from '../../src/library/follows.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { authenticateAccount } from '../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let db: GrowthDatabase;
let fixture: NativeProfileFixture;
let reader: pg.Pool;
let follows: ReturnType<typeof createFollowCommands>;
const migration = new URL('../../db/library/migrations/20261029061530_follow_count_source.sql', import.meta.url);

beforeAll(async () => {
  db = await openGrowthDatabase();
  fixture = await createProfileEntryFixture({ pool: db.pool });
  follows = createFollowCommands({ pool: db.pool, access: fixture.access });
  reader = new pg.Pool({ connectionString: db.url, options: '-c default_transaction_read_only=on' });
}, 120_000);
afterAll(async () => {
  await reader?.end();
  await fixture?.close();
  await db?.close();
});

async function inspect(accountId = fixture.owner.actor.accountId) {
  const client = await reader.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const keys = [routeOf(accountId), accountId];
    const owner = (
      await client.query('SELECT * FROM library.follow_count_owner WHERE route=$1 AND account_id=$2', keys)
    ).rows;
    const sources = (
      await client.query(
        `SELECT target_type, target_id, revision::text, source_following, desired_eligible,
              pending_since::text FROM library.follow_count_source
       WHERE route=$1 AND account_id=$2 ORDER BY target_type,target_id`,
        keys,
      )
    ).rows;
    await client.query('COMMIT');
    return { owner, sources };
  } finally {
    client.release();
  }
}

function source(snapshot: Awaited<ReturnType<typeof inspect>>, targetId: string) {
  return snapshot.sources.find((row) => row.target_id === targetId)!;
}
function live(snapshot: Awaited<ReturnType<typeof inspect>>, count: number) {
  expect(snapshot.owner).toMatchObject([{ observed_live_count: String(count), bootstrap_complete: false }]);
}

// Every positive business fact below uses released definitions and real native commands.
test('actual native follow writers atomically retain per-original source replacement revisions pending age and own outgoing counter changes while replay no-op explicit-unfollow precedence rollback and bigint overflow preserve exact source truth', async () => {
  const owner = fixture.owner.actor;
  const first = await fixture.createSubject('game');
  const second = await fixture.createSubject('game');
  expect(await inspect()).toEqual({ owner: [], sources: [] });
  const key = entryKey();
  const response = await fixture.send('owner', 'PUT', `/v1/follows/${first}`, undefined, key);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(Object.keys(body.follow).sort()).toEqual(['reason', 'state', 'targetId', 'targetType', 'updatedAt']);
  const initial = await inspect();
  live(initial, 1);
  expect(source(initial, first)).toMatchObject({ revision: '1', source_following: true, desired_eligible: true });
  expect(source(initial, first).pending_since).not.toBeNull();
  const artifacts = await fixture.inspect();
  expect((await fixture.send('owner', 'PUT', `/v1/follows/${first}`, undefined, key)).status).toBe(200);
  expect((await fixture.send('owner', 'PUT', `/v1/follows/${first}`)).status).toBe(200);
  expect(await inspect()).toEqual(initial);
  expect(await fixture.inspect()).toEqual(artifacts);

  expect((await fixture.send('owner', 'DELETE', `/v1/follows/${first}`)).status).toBe(200);
  const negative = await inspect();
  live(negative, 0);
  expect(source(negative, first)).toMatchObject({ revision: '2', source_following: false, desired_eligible: false });
  expect(source(negative, first).pending_since).toBe(source(initial, first).pending_since);
  // The existing native writer implies follows for in_progress. Profile-specific
  // state binding remains a separate runtime slice. Entry-implied follow must preserve the explicit negative and its pending age/revision.
  await fixture.commands.putEntry(owner, first, { state: 'in_progress' }, entryKey());
  expect(await inspect()).toEqual(negative);
  const entryKeyValue = entryKey();
  await fixture.commands.putEntry(owner, second, { state: 'in_progress' }, entryKeyValue);
  const implied = await inspect();
  live(implied, 1);
  expect(source(implied, second)).toMatchObject({ revision: '1', source_following: true, desired_eligible: true });
  await fixture.commands.putEntry(owner, second, { state: 'in_progress' }, entryKeyValue);
  expect(await inspect()).toEqual(implied);
  // Changing library reason to explicit is a genuine replacement, with zero outgoing delta.
  await follows.follow(owner, second, entryKey());
  live(await inspect(), 1);
  expect(source(await inspect(), second).revision).toBe('2');
  await follows.follow(owner, first, entryKey());
  live(await inspect(), 2);
  expect(source(await inspect(), first).revision).toBe('3');
  const other = await follows.follow(fixture.other.actor, first, entryKey());
  expect(other.changed).toBe(true);
  live(await inspect(fixture.other.actor.accountId), 1);
  expect(source(await inspect(fixture.other.actor.accountId), first).revision).toBe('1');

  // Provision a real Space through its ordinary authorized command; membership uses
  // the official trusted owner writer that Community calls, not a fake membership model.
  const spaceOwner = await fixture.identity([...owner.scopes, 'space:create', 'space:read']);
  const steward = await authenticateAccount(
    fixture.access,
    { pool: db.pool, deadline: deadlineFor(30_000) },
    {
      accountId: fixture.steward.actor.accountId,
      clientId: fixture.steward.actor.clientId,
      scopes: [...fixture.steward.actor.scopes, 'space:create'],
    },
  );
  const grants = createGrantCommands({ pool: db.pool, access: fixture.access, managementAction: 'access:grant' });
  await grants.create(
    { pool: db.pool, actor: steward, deadline: deadlineFor(30_000) },
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: spaceOwner.actor.accountId },
      actions: ['space:create'],
      valid: '(,)',
      key: entryKey(),
    },
  );
  const space = await createSpace(
    { pool: db.pool, access: fixture.access, routeKey: testRouteKey() },
    spaceOwner.actor,
    { title: 'Native membership source' },
    { idempotencyKey: entryKey(), deadline: deadlineFor(30_000) },
  );
  const membership = { accountId: spaceOwner.actor.accountId, spaceId: space.value.spaceId, stepKey: entryKey() };
  expect((await follows.followForMembership(membership)).changed).toBe(true);
  const joined = await inspect(membership.accountId);
  live(joined, 1);
  expect(source(joined, membership.spaceId)).toMatchObject({
    target_type: 'space',
    revision: '1',
    desired_eligible: true,
  });
  expect((await follows.followForMembership(membership)).command?.replayed).toBe(true);
  expect((await follows.followForMembership({ ...membership, stepKey: entryKey() })).changed).toBe(false);
  expect(await inspect(membership.accountId)).toEqual(joined);
  await follows.unfollow(spaceOwner.actor, { targetId: membership.spaceId, targetType: 'space' }, entryKey());
  const left = await inspect(membership.accountId);
  live(left, 0);
  expect((await follows.followForMembership({ ...membership, stepKey: entryKey() })).changed).toBe(false);
  expect(await inspect(membership.accountId)).toEqual(left);

  // Ordinary fences remain authoritative; suspension does not mutate raw outgoing intent.
  await fixture.suspend(fixture.other.actor.accountId);
  await expect(follows.unfollow(fixture.other.actor, first, entryKey())).rejects.toThrow();
  expect(await inspect(fixture.other.actor.accountId)).toMatchObject({ owner: [{ observed_live_count: '1' }] });
  const ownArtifacts = await fixture.inspect();
  const events = ownArtifacts.events
    .map(({ row }) => row)
    .filter((row) => row.type === 'com.rezics.library.follow.updated.v1');
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) expect(Object.keys(event.data)).toEqual(['targetId']);
}, 120_000);

async function primitive<T>(body: (client: PoolClient, schema: string) => Promise<T>) {
  const client = await db.admin.connect();
  const schema = `follow_primitive_${entryKey().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    const original = await Bun.file(
      new URL('../../db/library/migrations/20261025164145_library_follows.sql', import.meta.url),
    ).text();
    await client.query(original.replaceAll('library', schema));
    return await body(client, schema);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// Primitive-only: raw storage invariants and DDL cutover, never product acceptance fixtures.
test('primitive-only old prepared source SQL cutover retains incomplete legacy coverage, deletes, rollback and bigint overflow', async () => {
  await primitive(async (client, schema) => {
    const account = newId(0x1234);
    const targets = [newId(0x5678), newId(0x5678), newId(0x5678)];
    const raw = await Bun.file(new URL('../../src/library/follow-store-apply.sql', import.meta.url)).text();
    const names: string[] = [];
    const sql = raw.replaceAll('library', schema).replace(/(?<!:):(\w+)/g, (_, name: string) => {
      if (!names.includes(name)) names.push(name);
      return `$${names.indexOf(name) + 1}`;
    });
    const prepared = `old_follow_${entryKey().replaceAll('-', '')}`;
    await client.query(`PREPARE ${prepared} AS ${sql}`);
    const write = (target: string, intent: 'follow' | 'unfollow') => {
      const args: Record<string, string | number> = {
        account_id: account,
        target_id: target,
        target_type: 'subject',
        state: intent === 'follow' ? 'following' : 'unfollowed',
        reason: 'explicit',
        time: '2026-10-01T00:00:00Z',
        transaction_id: newId(0x1234),
        intent,
        route: 0x1234,
      };
      // EXECUTE parameters cannot be bound through the wire protocol. Values here are
      // generated UUIDs, a fixed timestamp and closed literals, never caller text.
      return client.query(`EXECUTE ${prepared} (${names.map((name) => `'${args[name]}'`).join(',')})`);
    };
    await write(targets[0]!, 'follow');
    await write(targets[1]!, 'follow');
    await client.query((await Bun.file(migration).text()).replaceAll('library', schema));
    const snapshot = async () => ({
      follow: (await client.query(`SELECT * FROM ${schema}.follow ORDER BY target_id`)).rows,
      source: (await client.query(`SELECT * FROM ${schema}.follow_count_source ORDER BY target_id`)).rows,
      counter: (await client.query(`SELECT * FROM ${schema}.follow_count_owner`)).rows,
    });
    expect((await snapshot()).counter).toEqual([]);
    // Missing metadata never pretends a legacy owner is ready0. First legacy delete
    // records a negative without subtracting an unobserved edge from a fabricated total.
    await client.query(`DELETE FROM ${schema}.follow WHERE target_id=$1`, [targets[0]]);
    expect((await snapshot()).counter).toMatchObject([{ observed_live_count: '0', bootstrap_complete: false }]);
    expect((await snapshot()).source).toMatchObject([
      { revision: '1', source_following: false, desired_eligible: false },
    ]);
    await write(targets[2]!, 'follow');
    expect((await snapshot()).counter).toMatchObject([{ observed_live_count: '1', bootstrap_complete: false }]);
    await write(targets[1]!, 'unfollow');
    expect((await snapshot()).counter).toMatchObject([{ observed_live_count: '1', bootstrap_complete: false }]);
    await write(targets[1]!, 'follow');
    expect((await snapshot()).counter).toMatchObject([{ observed_live_count: '2', bootstrap_complete: false }]);
    // DELETE/reinsert retains the same original revision; no-op UPDATE allocates nothing.
    await client.query(`DELETE FROM ${schema}.follow WHERE target_id=$1`, [targets[2]]);
    await write(targets[2]!, 'follow');
    expect((await snapshot()).source.find((row) => row.target_id === targets[2]).revision).toBe('3');
    const before = await snapshot();
    await client.query(`UPDATE ${schema}.follow SET state=state`);
    expect(await snapshot()).toEqual(before);
    await client.query('SAVEPOINT rollback_source');
    await write(targets[2]!, 'unfollow');
    await client.query('ROLLBACK TO SAVEPOINT rollback_source');
    expect(await snapshot()).toEqual(before);
    for (const statement of [
      `UPDATE ${schema}.follow SET target_id='${newId(0x5678)}' WHERE target_id='${targets[2]}'`,
      `UPDATE ${schema}.follow SET target_type='space' WHERE target_id='${targets[2]}'`,
      `UPDATE ${schema}.follow SET route=1 WHERE target_id='${targets[2]}'`,
    ]) {
      await client.query('SAVEPOINT invalid_identity');
      await expect(client.query(statement)).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT invalid_identity');
      expect(await snapshot()).toEqual(before);
    }
    await client.query(`UPDATE ${schema}.follow_count_source SET revision=9223372036854775807 WHERE target_id=$1`, [
      targets[2],
    ]);
    const maxRevision = await snapshot();
    await client.query('SAVEPOINT revision_overflow');
    await expect(write(targets[2]!, 'unfollow')).rejects.toMatchObject({ code: '22003' });
    await client.query('ROLLBACK TO SAVEPOINT revision_overflow');
    expect(await snapshot()).toEqual(maxRevision);
    await client.query(`UPDATE ${schema}.follow_count_owner SET observed_live_count=9223372036854775807`);
    const maxCounter = await snapshot();
    await client.query('SAVEPOINT counter_overflow');
    await expect(write(newId(0x5678), 'follow')).rejects.toMatchObject({ code: '22003' });
    await client.query('ROLLBACK TO SAVEPOINT counter_overflow');
    expect(await snapshot()).toEqual(maxCounter);
    await client.query(`DEALLOCATE ${prepared}`);
  });
});

// Synthetic cardinality is primitive-only negative history. Measured positive paths
// below use fresh released subjects for every run, with the same native owner/partition.
test('native source hook rows and statements stay constant with logarithmic blocks as unrelated owners targets and own negative history grow', async () => {
  const owner = fixture.owner.actor;
  const before = await inspect();
  const slots: { target: string; followKey: string; unfollowKey: string; pendingSince: string }[] = [];
  const populations: { scale: number; ownNegativeHistory: number; unrelatedOwnersAndTargets: number; slots: number }[] =
    [];
  const runs: { scale: number; repetition: number; target: string; plans: unknown[] }[] = [];
  let activeRun: (typeof runs)[number] | undefined;
  // Retain the actual nested auto_explain documents alongside the shared harness's
  // per-occurrence accounting; this listener neither changes nor filters its costs.
  const listeners = new Map<PoolClient, (notice: { message?: string }) => void>();
  const listen = (client: PoolClient) => {
    if (listeners.has(client)) return;
    const listener = (notice: { message?: string }) => {
      const message = notice.message;
      if (activeRun && message?.startsWith('duration:') && message.includes('plan:\n'))
        activeRun.plans.push(JSON.parse(message.slice(message.indexOf('plan:\n') + 6)));
    };
    listeners.set(client, listener);
    client.on('notice', listener);
  };
  db.pool.on('acquire', listen);
  const evidence = new URL('../../../../.temp/follow-count-source/', import.meta.url);
  await mkdir(evidence, { recursive: true });
  try {
    const report = await checkGrowth(db, {
      name: 'Native follow source replacements',
      scales: [256, 1024, 4096],
      rule: 'series',
      warmups: 1,
      repetitions: 5,
      includeBackends: true,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_db, scale, previous) {
        await db.admin.query(
          `INSERT INTO library.follow
       (route,account_id,target_id,target_type,state,reason,created_at,updated_at,transaction_id)
       SELECT $1, CASE WHEN population=0 THEN $2::uuid ELSE
         ('10000000-0000-7000-8000-' || lpad(to_hex($1::int),4,'0') || lpad(to_hex(n),8,'0'))::uuid END,
         ('20000000-0000-7000-8000-5678' || lpad(to_hex(n),8,'0'))::uuid,
         'subject','unfollowed','explicit',now(),now(),$3
       FROM generate_series($4::int+1,$5::int) n CROSS JOIN generate_series(0,1) population`,
          [routeOf(owner.accountId), owner.accountId, newId(routeOf(owner.accountId)!), previous, scale],
        );
        // One warm-up plus five measured runs, all independent consumable pairs.
        // Provision real subjects and the negative UPDATE baseline outside captures.
        for (let slot = 0; slot < 6; slot++) {
          const target = await fixture.createSubject('game');
          await follows.follow(owner, target, entryKey());
          await follows.unfollow(owner, target, entryKey());
          slots.push({ target, followKey: entryKey(), unfollowKey: entryKey(), pendingSince: '' });
        }
        const prepared = await inspect();
        for (const slot of slots.slice(-6)) {
          const negative = source(prepared, slot.target);
          expect(negative).toMatchObject({ revision: '2', source_following: false, desired_eligible: false });
          slot.pendingSince = negative.pending_since;
        }
        populations.push({ scale, ownNegativeHistory: scale, unrelatedOwnersAndTargets: scale, slots: slots.length });
      },
      async operation(_db, scale, repetition) {
        const slot = slots[repetition]!;
        activeRun = { scale, repetition, target: slot.target, plans: [] };
        runs.push(activeRun);
        try {
          const followed = await follows.follow(owner, slot.target, slot.followKey);
          expect(followed).toMatchObject({
            changed: true,
            follow: { targetId: slot.target, targetType: 'subject', state: 'following', reason: 'explicit' },
          });
          const unfollowed = await follows.unfollow(owner, slot.target, slot.unfollowKey);
          expect(unfollowed).toMatchObject({
            changed: true,
            follow: { targetId: slot.target, targetType: 'subject', state: 'unfollowed', reason: 'explicit' },
          });
        } finally {
          activeRun = undefined;
        }
      },
    });
    // Keep every repetition, statement attribution and relation population, rather
    // than treating returned row counts or an isolated sample as physical work.
    await Bun.write(new URL('growth.json', evidence), JSON.stringify({ populations, report }, null, 2));
    for (const sample of report.samples) {
      for (const cost of sample.repetitions) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.statements).toBeGreaterThan(0);
        expect(cost.blocks).toBeGreaterThan(0);
        for (const relation of ['library.follow_count_source', 'library.follow_count_owner']) {
          expect(cost.relations[relation]?.rows).toBeGreaterThan(0);
          expect(cost.relations[relation]?.sequentialScans).toBe(0);
        }
      }
      console.info(
        'Native follow source growth:',
        JSON.stringify({
          population: populations.find(({ scale }) => scale === sample.scale),
          repetitions: sample.repetitions.map(({ rows, statements, blocks }) => ({ rows, statements, blocks })),
        }),
      );
    }
    console.info('Native follow source series verdict:', JSON.stringify(report.shadow));
    const after = await inspect();
    expect(after.owner).toEqual(before.owner);
    for (const slot of slots)
      expect(source(after, slot.target)).toMatchObject({
        revision: '4',
        source_following: false,
        desired_eligible: false,
        pending_since: slot.pendingSince,
      });
    for (const run of runs.filter(({ repetition }) => repetition % 6 !== 0))
      expect(run.plans.length).toBeGreaterThan(0);
  } finally {
    db.pool.off('acquire', listen);
    for (const [client, listener] of listeners) client.off('notice', listener);
    await Bun.write(new URL('plans.json', evidence), JSON.stringify({ populations, runs }, null, 2));
  }
}, 120_000);
