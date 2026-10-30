import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  IdempotencyConflictError,
  authoritativeTimeValue,
  type AuthoritativeTime,
  type CommandEvent,
  type CommandTransaction,
} from '../../src/command/command.ts';
import type { AccountActor, Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import * as followStore from '../../src/library/follow-store.ts';
import {
  createLibraryCommandRunner,
  LibraryNotFoundError,
  requireRoute,
  sameAccountRoute,
} from '../../src/library/command-support.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const route = 0x5234;
const action = 'library:follow';
const kind = 'library.follow';
const event: CommandEvent = { type: 'com.rezics.library.follow.changed.v1', data: {} };
const accountIds = {
  active: newId(route),
  other: newId(route),
  suspended: newId(route),
  noScope: newId(route),
  transition: newId(route),
  staleEpoch: newId(route),
  fenced: newId(route),
};
const transactionId = newId(route);

function actor(accountId: string, scopes: readonly string[] = [action], authnEpoch = 1): AccountActor {
  return {
    kind: 'account',
    accountId,
    clientId: 'library-command-test',
    scopes,
    requestedBy: null,
    authnEpoch,
  };
}

function commandBody(accountId: string, targetId: string) {
  return async (tx: CommandTransaction, command: { transactionId: string; time: AuthoritativeTime }) => {
    const changed = await followStore.applyFollow(tx, route, {
      accountId,
      targetId,
      targetType: 'subject',
      intent: 'follow',
      reason: 'explicit',
      transactionId: command.transactionId,
      time: authoritativeTimeValue(command.time),
    });
    return { value: { accountId, targetId, changed }, events: [event] };
  };
}

function request(requestKey: string, input: unknown) {
  return { action, kind, requestKey, input };
}

async function followCount(accountId: string): Promise<number> {
  const result = await pool.query(
    'SELECT count(*)::int AS count FROM library.follow WHERE route=$1 AND account_id=$2',
    [route, accountId],
  );
  return result.rows[0].count;
}

async function position(): Promise<bigint> {
  const result = await pool.query('SELECT position FROM core.partition WHERE partition_no=$1', [partitionOf(route)]);
  return BigInt(result.rows[0].position);
}

beforeAll(async () => {
  for (const [name, accountId] of Object.entries(accountIds)) {
    await pool.query(
      `INSERT INTO access.account(route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
       VALUES ($1, $2, 'actor', $3, $4, $5, $6)`,
      [route, accountId, 'active', transactionId, name === 'fenced', name === 'staleEpoch' ? 2 : 1],
    );
  }
  await suspendAccount(pool, accountIds.suspended);
});

afterAll(async () => {
  await pool.query('DELETE FROM library.follow WHERE route=$1 AND account_id = ANY($2::uuid[])', [
    route,
    Object.values(accountIds),
  ]);
  await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id = ANY($2::uuid[])', [
    route,
    Object.values(accountIds),
  ]);
  await pool.end();
});

test('own-account commands execute once, replay the same result, and conflict on changed input', async () => {
  const runner = createLibraryCommandRunner({ pool });
  const targetId = newId(route);
  const requestKey = `follow:${newId(route)}`;
  let runs = 0;
  const body = async (tx: CommandTransaction, command: { transactionId: string; time: AuthoritativeTime }) => {
    runs++;
    return commandBody(accountIds.active, targetId)(tx, command);
  };
  const first = await runner.ownAccount(
    actor(accountIds.active),
    request(requestKey, { targetId, reason: 'explicit' }),
    body,
  );
  const replay = await runner.ownAccount(
    actor(accountIds.active),
    request(requestKey, { reason: 'explicit', targetId }),
    body,
  );

  expect(first).toMatchObject({ value: { accountId: accountIds.active, targetId, changed: true }, replayed: false });
  expect(replay).toEqual({ ...first, replayed: true });
  expect(runs).toBe(1);
  expect(await followCount(accountIds.active)).toBe(1);

  let conflictBodyRan = false;
  const conflict = await runner
    .ownAccount(
      actor(accountIds.active),
      request(requestKey, { targetId: newId(route), reason: 'explicit' }),
      async () => {
        conflictBodyRan = true;
        return { value: null, events: [event] };
      },
    )
    .catch((error: unknown) => error);
  expect(conflict).toBeInstanceOf(IdempotencyConflictError);
  expect(conflictBodyRan).toBe(false);
  expect(await followCount(accountIds.active)).toBe(1);
});

test('a second active account is attributed to its own data', async () => {
  const runner = createLibraryCommandRunner({ pool });
  const targetId = newId(route);
  const result = await runner.ownAccount(
    actor(accountIds.other),
    request(`follow:${newId(route)}`, { targetId }),
    commandBody(accountIds.other, targetId),
  );

  expect(result.value).toMatchObject({ accountId: accountIds.other, targetId, changed: true });
  expect(await followCount(accountIds.other)).toBe(1);
  expect(await followCount(accountIds.active)).toBe(1);
});

test('invalid, foreign, or malformed routes share one not-found error', () => {
  expect(requireRoute(accountIds.active)).toBe(route);
  expect(sameAccountRoute(accountIds.active, newId(route))).toBe(route);
  const invalid = (() => {
    try {
      requireRoute('bad-id');
    } catch (error) {
      return error;
    }
  })();
  const foreign = (() => {
    try {
      sameAccountRoute(accountIds.active, newId(route + 1));
    } catch (error) {
      return error;
    }
  })();
  expect(invalid).toBeInstanceOf(LibraryNotFoundError);
  expect(foreign).toBeInstanceOf(LibraryNotFoundError);
  expect(foreign).toMatchObject({ message: (invalid as Error).message });
});

test('denied actors and stale account state change nothing, including on a replay after suspension', async () => {
  const runner = createLibraryCommandRunner({ pool });
  const refusals: Array<{ name: string; identity: Actor }> = [
    { name: 'suspended', identity: actor(accountIds.suspended) },
    { name: 'without-scope', identity: actor(accountIds.noScope, ['profile:read']) },
    { name: 'stale-epoch', identity: actor(accountIds.staleEpoch, [action], 1) },
    { name: 'fenced', identity: actor(accountIds.fenced) },
    { name: 'anonymous', identity: { kind: 'anonymous' } },
  ];
  let before = await position();

  for (const refusal of refusals) {
    const targetId = newId(route);
    const denied = await runner
      .ownAccount(
        refusal.identity,
        request(`${refusal.name}:${newId(route)}`, { targetId }),
        commandBody(refusal.identity.kind === 'account' ? refusal.identity.accountId : accountIds.active, targetId),
      )
      .catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(GrantDeniedError);
  }

  const transitionActor = actor(accountIds.transition);
  const targetId = newId(route);
  const transitionKey = `transition:${newId(route)}`;
  let runs = 0;
  const body = async (tx: CommandTransaction, command: { transactionId: string; time: AuthoritativeTime }) => {
    runs++;
    return commandBody(accountIds.transition, targetId)(tx, command);
  };
  await runner.ownAccount(transitionActor, request(transitionKey, { targetId }), body);
  const beforeSuspension = await position();
  await suspendAccount(pool, accountIds.transition);
  before += (await position()) - beforeSuspension;
  const replayDenied = await runner
    .ownAccount(transitionActor, request(transitionKey, { targetId }), body)
    .catch((error: unknown) => error);

  expect(replayDenied).toBeInstanceOf(GrantDeniedError);
  expect(runs).toBe(1);
  expect(await position()).toBe(before + 1n);
  expect(await followCount(accountIds.suspended)).toBe(0);
  expect(await followCount(accountIds.noScope)).toBe(0);
  expect(await followCount(accountIds.staleEpoch)).toBe(0);
  expect(await followCount(accountIds.fenced)).toBe(0);
  expect(await followCount(accountIds.transition)).toBe(1);
});

test('trusted workflow steps replay by step key, keep account attribution, and reject suspended accounts', async () => {
  const runner = createLibraryCommandRunner({ pool });
  const targetId = newId(route);
  const stepKey = `community-join:${newId(route)}:follow`;
  let runs = 0;
  const body = async (tx: CommandTransaction, command: { transactionId: string; time: AuthoritativeTime }) => {
    runs++;
    return commandBody(accountIds.other, targetId)(tx, command);
  };
  const first = await runner.trustedAccount(accountIds.other, { kind, stepKey, input: { targetId } }, body);
  const replay = await runner.trustedAccount(accountIds.other, { kind, stepKey, input: { targetId } }, body);

  expect(first).toMatchObject({ value: { accountId: accountIds.other, targetId, changed: true }, replayed: false });
  expect(replay).toEqual({ ...first, replayed: true });
  expect(runs).toBe(1);
  const receipt = await pool.query(
    `SELECT actor_account_id AS "actorAccountId", client_id AS "clientId", requested_by AS "requestedBy"
       FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2`,
    [partitionOf(route), first.transactionId],
  );
  const attributedReceipt = await pool.query(
    `SELECT principal_id AS "principalId" FROM core.receipt
      WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND command_kind=$3 AND idempotency_key=$4`,
    [partitionOf(route), accountIds.other, kind, stepKey],
  );
  expect(receipt.rows).toEqual([]);
  expect(attributedReceipt.rows).toEqual([{ principalId: accountIds.other }]);

  await suspendAccount(pool, accountIds.other);
  const denied = await runner
    .trustedAccount(accountIds.other, { kind, stepKey: `${stepKey}:next`, input: { targetId: newId(route) } }, body)
    .catch((error: unknown) => error);
  expect(denied).toBeInstanceOf(GrantDeniedError);
  expect(runs).toBe(1);
});

test('the injected kernel clock supplies the command time', async () => {
  const expected = new Date('2026-10-26T04:05:06.000Z');
  const runner = createLibraryCommandRunner({ pool, clock: () => expected });
  let actual = '';
  const result = await runner.ownAccount(
    actor(accountIds.active),
    request(`clock:${newId(route)}`, { targetId: newId(route) }),
    async (_tx, command) => {
      actual = authoritativeTimeValue(command.time);
      return { value: { seen: actual }, events: [event] };
    },
  );

  expect(result.value.seen).toBe(actual);
  expect(new Date(actual).toISOString()).toBe(expected.toISOString());
});

test('helper fixtures use routable Access account identities', () => {
  expect(routeOf(accountIds.active)).toBe(route);
});
