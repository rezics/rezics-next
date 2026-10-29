import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import type pg from 'pg';
import { readAccount, type Account } from '../../src/access/account-data.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { EVENT_TYPES, readBatch } from '../../src/events/log.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { createEntryCommands } from '../../src/library/entries.ts';
import { createFollowCommands } from '../../src/library/follows.ts';
import type { EntryState } from '../../src/library/entry-model.ts';
import type { Access, AccountActor, Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { admittedAccess, accountToken, authenticateAccount } from '../support/admitted-access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { compileEntryRelease, entryTypes } from './support/profile-entry-fixture.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  measure,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type GrowthSample,
  type Population,
} from '../support/growth.ts';

const route = 0x21c0;
const updatedEvent = 'com.rezics.library.entry.updated.v1';
const deletedEvent = 'com.rezics.library.entry.deleted.v1';
const entryScopes = [
  'subject:read',
  'library_entry:update',
  'library_entry:delete',
  'library_entry:read',
  'library_entry:list',
];
const scopes = [...entryScopes, 'follow:create', 'follow:delete', 'subject:create'];
const actor = (accountId: string, permissions: readonly string[] = scopes): AccountActor => ({
  kind: 'account',
  accountId,
  scopes: permissions,
  clientId: 'library-entries-test',
  requestedBy: null,
  authnEpoch: 1,
});
let owner = actor(newId(route));
let other = actor(newId(route));
const suspended = actor(newId(route));
let noScope = actor(newId(route), ['subject:read']);
const setupIdentity = actor(newId(route), [
  'access:grant',
  'subject:create',
  'subject:read',
  'exposure:open',
  'gate:any',
]);
const anonymous: Actor = { kind: 'anonymous' };
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(61)]]) };

let database: GrowthDatabase;
let access: Access;
let kernel: ReturnType<typeof createKernel>;
let accounts: Map<string, Account>;
let commands: ReturnType<typeof createEntryCommands>;
let followCommands: ReturnType<typeof createFollowCommands>;
let now = Date.parse('2026-10-26T12:00:00.000Z');
const clock = () => new Date(now);
const tick = () => {
  now += 1000;
};
const key = () => randomUUID();

async function installAccount(accountId: string, state: 'active' | 'suspended'): Promise<Account> {
  await database.admin.query(
    `INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
     VALUES ($1, $2, 'actor', $3, $4, false, 1)`,
    [route, accountId, state, newId(route)],
  );
  const current = await readAccount(database.admin, route, accountId);
  if (!current) throw new Error('Test account was not created');
  return current;
}

async function createReadableSubject(forActor: AccountActor = owner, label: string = randomUUID()): Promise<string> {
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/subjects', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await accountToken(forActor)}`,
        'content-type': 'application/json',
        'idempotency-key': `"${key()}"`,
      },
      body: JSON.stringify({ type: entryTypes.game, labels: { en: label } }),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { subject: { id: string } }).subject.id;
}

async function denyOwnerRead(subjectId: string): Promise<void> {
  const subjectRoute = routeOf(subjectId);
  if (subjectRoute === null) throw new Error('Test subject must have a route');
  await database.admin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     VALUES ($1, $2, $3, '', 'subject:read', 'resource', '(,)'::tstzrange, $4)`,
    [subjectRoute, subjectId, owner.accountId, newId(subjectRoute)],
  );
}

async function snapshot(accountId = owner.accountId) {
  const result = await database.admin.query(
    `SELECT
       (SELECT count(*)::int FROM library.entry WHERE account_id = $1) AS entries,
       (SELECT count(*)::int FROM library.follow WHERE account_id = $1) AS follows,
       (SELECT count(*)::int FROM core.outbox WHERE subject = $1::text AND type = ANY($2::text[])) AS entry_events`,
    [accountId, [updatedEvent, deletedEvent]],
  );
  return result.rows[0];
}

async function eventRows(subjectId: string) {
  const result = await database.admin.query(
    `SELECT partition_no, type, subject, data
       FROM core.outbox
      WHERE data->>'subjectId' = $1
      ORDER BY position, event_seq`,
    [subjectId],
  );
  return result.rows;
}

async function transaction<T>(body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    return await body(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function unrelatedPopulation(name: string): Population {
  return {
    name,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows(place) {
      const subjectId = newId((route + 1) % 65_536);
      const transactionId = newId(route);
      return {
        'library.entry': [
          {
            route,
            account_id: owner.accountId,
            subject_id: subjectId,
            requested_subject_id: null,
            state: 'planned',
            revision: 1,
            created_at: '2026-10-26T00:00:00.000Z',
            updated_at: new Date(Date.parse('2026-10-26T00:00:00.000Z') + place.ordinal).toISOString(),
            transaction_id: transactionId,
          },
        ],
      };
    },
  };
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  await bootstrapRelease(database.pool, await compileEntryRelease('original'));
  accounts = new Map<string, Account>();
  await installAccount(setupIdentity.accountId, 'active');
  accounts.set(owner.accountId, await installAccount(owner.accountId, 'active'));
  accounts.set(other.accountId, await installAccount(other.accountId, 'active'));
  accounts.set(suspended.accountId, await installAccount(suspended.accountId, 'suspended'));
  accounts.set(noScope.accountId, await installAccount(noScope.accountId, 'active'));
  kernel = createKernel({
    pool: database.pool,
    clock,
    tokens,
    routeKey: new Uint8Array(32).fill(73),
    writeRate: createWriteRateLimiter({ secret: 'native-library-entry-baseline-rate-secret' }),
    access(config) {
      return (access = admittedAccess(config));
    },
  });
  await kernel.handle(new Request('http://kernel.test/v1/definitions/active'));
  const admit = (candidate: AccountActor) =>
    authenticateAccount(access, { pool: database.pool, deadline: deadlineFor(120_000) }, candidate);
  owner = await admit(owner);
  other = await admit(other);
  noScope = await admit(noScope);
  const steward = await admit(setupIdentity);
  await bootstrapGovernance(database.pool, steward.accountId);
  await createGrantCommands({ pool: database.pool, access, managementAction: 'access:grant' }).create(
    { pool: database.pool, actor: steward, deadline: deadlineFor(30_000) },
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'active_accounts' },
      actions: ['subject:create'],
      valid: '(,)',
      key: key(),
    },
  );
  const opened = await kernel.handle(
    new Request('http://kernel.test/v1/platform/exposure/personal_library:open', {
      method: 'POST',
      headers: { authorization: `Bearer ${await accountToken(steward)}`, 'idempotency-key': `"${key()}"` },
    }),
  );
  expect(opened.status).toBe(200);
  commands = createEntryCommands({ pool: database.pool, access, tokens, clock });
  followCommands = createFollowCommands({ pool: database.pool, access, clock });
});

afterAll(async () => {
  if (database) await database.close();
});

test('an account keeps one library entry per readable subject whose state changes only by revision CAS', async () => {
  const subjectId = await createReadableSubject(owner, 'CAS book');
  const createKey = key();
  tick();
  const created = await commands.putEntry(owner, subjectId, { state: 'planned' }, createKey);
  expect(created).toMatchObject({
    replayed: false,
    partition: partitionOf(route),
    value: {
      created: true,
      entry: {
        accountId: owner.accountId,
        subjectId,
        requestedSubjectId: null,
        state: 'planned',
        revision: 1,
        updatedAt: clock().toISOString(),
      },
    },
  });
  expect(await commands.putEntry(owner, subjectId, { state: 'planned' }, createKey)).toMatchObject({
    replayed: true,
    value: created.value,
  });
  await expect(commands.putEntry(owner, subjectId, { state: 'completed' }, createKey)).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  await expect(commands.putEntry(owner, subjectId, { state: 'dropped' }, key())).rejects.toMatchObject({
    name: 'LibraryConflictError',
  });

  tick();
  const progressed = await commands.putEntry(owner, subjectId, { state: 'in_progress', revision: 1 }, key());
  expect(progressed.value).toMatchObject({
    created: false,
    entry: { state: 'in_progress', revision: 2, updatedAt: clock().toISOString() },
  });
  expect(await followCommands.readFollow(owner, subjectId)).toMatchObject({
    state: 'following',
    reason: 'library',
    accountId: owner.accountId,
  });
  const beforeStale = await snapshot();
  await expect(commands.putEntry(owner, subjectId, { state: 'paused', revision: 1 }, key())).rejects.toMatchObject({
    name: 'LibraryConflictError',
  });
  expect(await snapshot()).toEqual(beforeStale);

  tick();
  const completed = await commands.putEntry(owner, subjectId, { state: 'completed', revision: 2 }, key());
  expect(completed.value.entry).toMatchObject({ state: 'completed', revision: 3 });
  expect(await followCommands.readFollow(owner, subjectId)).toMatchObject({ state: 'following', reason: 'library' });
  expect(await commands.readEntry(owner, subjectId)).toEqual(completed.value.entry);

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO library.copy
         (route, copy_id, account_id, subject_id, status, location, source, acquired_on, disposed_on, note, revision,
          created_at, updated_at, transaction_id)
       VALUES ($1, $2, $3, $4, 'owned', NULL, NULL, NULL, NULL, NULL, 1, $5, $5, $6)`,
      [route, newId(route), owner.accountId, subjectId, clock().toISOString(), newId(route)],
    );
  });
  const copiesBeforeDelete = await database.admin.query(
    'SELECT count(*)::int AS n FROM library.copy WHERE account_id = $1',
    [owner.accountId],
  );
  const removed = await commands.deleteEntry(owner, subjectId, 3, key());
  expect(removed.value).toEqual({ deletionId: removed.transactionId, revision: 4 });
  expect(removed.value).not.toHaveProperty('state');
  expect(await commands.readEntry(owner, subjectId).catch((error) => error)).toBeInstanceOf(LibraryNotFoundError);
  expect(await followCommands.readFollow(owner, subjectId)).toMatchObject({ state: 'following', reason: 'library' });
  const copiesAfterDelete = await database.admin.query(
    'SELECT count(*)::int AS n FROM library.copy WHERE account_id = $1',
    [owner.accountId],
  );
  expect(copiesAfterDelete.rows[0].n).toBe(copiesBeforeDelete.rows[0].n);
  await expect(commands.deleteEntry(owner, subjectId, 3, key())).rejects.toBeInstanceOf(LibraryNotFoundError);

  expect(await eventRows(subjectId)).toEqual([
    { partition_no: partitionOf(route), type: updatedEvent, subject: owner.accountId, data: { subjectId } },
    { partition_no: partitionOf(route), type: updatedEvent, subject: owner.accountId, data: { subjectId } },
    { partition_no: partitionOf(route), type: updatedEvent, subject: owner.accountId, data: { subjectId } },
    { partition_no: partitionOf(route), type: deletedEvent, subject: owner.accountId, data: { subjectId } },
  ]);
  for (const type of [updatedEvent, deletedEvent] as const) {
    expect(Value.Check(EVENT_TYPES[type], { subjectId })).toBe(true);
    expect(Value.Check(EVENT_TYPES[type], { subjectId, state: 'completed' })).toBe(false);
  }
  const seen: { type: string; subject?: string; data: unknown }[] = [];
  expect(
    await readBatch(database.pool, {
      consumer: 'library_entry_test',
      partition: partitionOf(route),
      apply: async (envelopes) => {
        seen.push(...envelopes.flatMap((envelope) => envelope.events));
      },
    }),
  ).toMatchObject({ status: 'read' });
  expect(seen.filter((event) => event.type === updatedEvent || event.type === deletedEvent)).toEqual(
    expect.arrayContaining([expect.objectContaining({ subject: owner.accountId, data: { subjectId } })]),
  );
});

test('setting in progress follows the subject in the same command unless it was explicitly unfollowed', async () => {
  const subjectId = await createReadableSubject(owner, 'Unfollowed book');
  await followCommands.follow(owner, { targetId: subjectId, targetType: 'subject' }, key());
  await followCommands.unfollow(owner, { targetId: subjectId, targetType: 'subject' }, key());
  const beforeEvents = await database.admin.query(
    `SELECT count(*)::int AS n FROM core.outbox
      WHERE type = 'com.rezics.library.follow.updated.v1' AND subject = $1 AND data->>'targetId' = $2`,
    [owner.accountId, subjectId],
  );

  const result = await commands.putEntry(owner, subjectId, { state: 'in_progress' }, key());
  expect(result.value).toMatchObject({ created: true, entry: { state: 'in_progress', revision: 1 } });
  expect(await followCommands.readFollow(owner, subjectId)).toMatchObject({
    state: 'unfollowed',
    reason: 'explicit',
  });
  const afterEvents = await database.admin.query(
    `SELECT count(*)::int AS n FROM core.outbox
      WHERE type = 'com.rezics.library.follow.updated.v1' AND subject = $1 AND data->>'targetId' = $2`,
    [owner.accountId, subjectId],
  );
  expect(afterEvents.rows[0].n).toBe(beforeEvents.rows[0].n);
});

test('every entry state can be listed by a signed account and state bound keyset cursor', async () => {
  const pageIdentity = actor(newId(route));
  accounts.set(pageIdentity.accountId, await installAccount(pageIdentity.accountId, 'active'));
  const pageOwner = await authenticateAccount(
    access,
    { pool: database.pool, deadline: deadlineFor(120_000) },
    pageIdentity,
  );
  const states: EntryState[] = ['planned', 'in_progress', 'completed', 'paused', 'dropped'];
  for (const state of states) {
    const subjectId = await createReadableSubject(pageOwner, `Page ${state}`);
    tick();
    await commands.putEntry(pageOwner, subjectId, { state }, key());
    expect((await commands.listEntries(pageOwner, { state })).entries.map((entry) => entry.state)).toEqual([state]);
  }

  const first = await commands.listEntries(pageOwner, { limit: 2 });
  expect(first.entries).toHaveLength(2);
  expect(first.next).toEqual(expect.any(String));
  const second = await commands.listEntries(pageOwner, { limit: 2, cursor: first.next! });
  expect(second.entries).toHaveLength(2);
  expect(second.next).toEqual(expect.any(String));
  const third = await commands.listEntries(pageOwner, { limit: 2, cursor: second.next! });
  expect(third.entries).toHaveLength(1);
  expect(third.next).toBeNull();
  const all = [...first.entries, ...second.entries, ...third.entries];
  expect(all.map((entry) => entry.state).toSorted()).toEqual([...states].toSorted());
  expect(all.map((entry) => entry.updatedAt)).toEqual([...all.map((entry) => entry.updatedAt)].toSorted().toReversed());

  await expect(commands.listEntries(pageOwner, { state: 'planned', cursor: first.next! })).rejects.toMatchObject({
    name: 'ProblemError',
    code: 'invalid_cursor',
  });
  await expect(commands.listEntries(pageOwner, { cursor: `${first.next!}tampered` })).rejects.toMatchObject({
    name: 'ProblemError',
    code: 'invalid_cursor',
  });
  await expect(commands.listEntries(other, { cursor: first.next! })).rejects.toMatchObject({
    name: 'ProblemError',
    code: 'invalid_cursor',
  });
  await expect(commands.listEntries(pageOwner, { limit: 101 })).rejects.toBeInstanceOf(RangeError);
  await expect(commands.listEntries(pageOwner, { limit: 0 })).rejects.toBeInstanceOf(RangeError);
});

test('unknown, unreadable, malformed, foreign, anonymous and suspended requests reveal or change nothing', async () => {
  const subjectId = await createReadableSubject(owner, 'Private entry');
  const unreadable = await createReadableSubject(owner, 'Unreadable subject');
  await denyOwnerRead(unreadable);
  await commands.putEntry(owner, subjectId, { state: 'planned' }, key());

  const notFound = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      expect(error).toBeInstanceOf(LibraryNotFoundError);
      return error as Error;
    }
    throw new Error('Expected a not-found response');
  };
  const concealed = await Promise.all([
    notFound(() => commands.putEntry(owner, newId(route + 1), { state: 'planned' }, key())),
    notFound(() => commands.putEntry(owner, unreadable, { state: 'planned' }, key())),
    notFound(() => commands.readEntry(owner, newId(route + 2))),
    notFound(() => commands.readEntry(owner, 'malformed')),
    notFound(() => commands.readEntry(other, subjectId)),
  ]);
  expect(concealed.every((error) => error.name === concealed[0]!.name && error.message === concealed[0]!.message)).toBe(
    true,
  );

  const before = await snapshot();
  await expect(commands.readEntry(anonymous, subjectId)).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(commands.putEntry(anonymous, subjectId, { state: 'completed' }, key())).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  await expect(commands.deleteEntry(anonymous, subjectId, 1, key())).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(commands.readEntry(suspended, subjectId)).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(commands.putEntry(suspended, subjectId, { state: 'completed' }, key())).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  await expect(commands.deleteEntry(suspended, subjectId, 1, key())).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(commands.readEntry(noScope, subjectId)).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(commands.putEntry(noScope, subjectId, { state: 'completed' }, key())).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  await expect(commands.deleteEntry(noScope, subjectId, 1, key())).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(commands.deleteEntry(other, subjectId, 1, key())).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect(await snapshot()).toEqual(before);
});

test('put, delete and list statement counts stay equal at three scales of unrelated account entries', async () => {
  const populations = {
    put: unrelatedPopulation(`library-entry-put-${randomUUID()}`),
    delete: unrelatedPopulation(`library-entry-delete-${randomUUID()}`),
    page: unrelatedPopulation(`library-entry-page-${randomUUID()}`),
  };
  const putSubjects = await Promise.all([0, 1, 2].map(() => createReadableSubject(owner)));
  const deleteSubjects = await Promise.all([0, 1, 2].map(() => createReadableSubject(owner)));
  for (const subjectId of deleteSubjects) await commands.putEntry(owner, subjectId, { state: 'planned' }, key());
  const sample = async (population: Population, operation: (repetition: number) => Promise<unknown>) => {
    const samples: GrowthSample[] = [];
    let previous = 0;
    for (const [repetition, scale] of [1, 8, 64].entries()) {
      await seed(database, population, { from: previous, to: scale });
      const measured = await measure(database, () => operation(repetition));
      samples.push({ scale, cost: measured.cost });
      previous = scale;
    }
    return samples;
  };
  const put = await sample(populations.put, (repetition) =>
    commands.putEntry(owner, putSubjects[repetition]!, { state: 'planned' }, key()),
  );
  const remove = await sample(populations.delete, (repetition) =>
    commands.deleteEntry(owner, deleteSubjects[repetition]!, 1, key()),
  );
  const page = await sample(populations.page, () => commands.listEntries(owner, { limit: 20 }));
  for (const samples of [put, remove, page]) {
    const statements = samples.map((item) => item.cost.statements);
    const first = statements[0]!;
    expect(statements).toEqual([first, first, first]);
  }
});
