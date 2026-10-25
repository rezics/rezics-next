import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  ANONYMOUS_PRINCIPAL_ID,
  CommandUnavailableError,
  IdempotencyConflictError,
  authoritativeTimeValue,
  currentCommand,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type PrincipalCommandOptions,
  type PrincipalCommandReceipt,
} from '../src/command/command.ts';
import { createPool } from '../src/database/pool.ts';
import type { AccountActor } from '../src/request/access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-beef00000001',
  clientId: 'web',
  requestedBy: 'urn:rezics:request:principal-contract',
  scopes: [],
  authnEpoch: 1,
};
const event = { type: 'com.rezics.test.principal.v1', data: {} };
const body = async () => ({ value: null, events: [event] });
const digest = (text: string) => createHash('sha256').update(text).digest();

function queryTrap() {
  let calls = 0;
  const pool = new Proxy({} as pg.Pool, {
    get() {
      calls++;
      throw new Error('Command touched the pool before rejecting');
    },
  });
  return { pool, calls: () => calls };
}

test('verified actors produce deeply frozen principal identities with no anonymous account ID', () => {
  const account = principalCommandIdentity(actor);
  const anonymous = principalCommandIdentity({ kind: 'anonymous' });
  expect(account).toEqual({
    principal: { kind: 'account', id: actor.accountId },
    basis: { clientId: actor.clientId, requestedBy: actor.requestedBy },
  });
  expect(ANONYMOUS_PRINCIPAL_ID).toBe('00000000-0000-0000-0000-000000000000');
  expect(anonymous).toEqual({
    principal: { kind: 'anonymous', id: ANONYMOUS_PRINCIPAL_ID },
    basis: { clientId: null, requestedBy: null },
  });
  for (const identity of [account, anonymous]) {
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.principal)).toBe(true);
    expect(Object.isFrozen(identity.basis)).toBe(true);
  }
  expect(() => principalCommandIdentity({ ...actor, accountId: ANONYMOUS_PRINCIPAL_ID })).toThrow(TypeError);
});

test('anonymous commands without authorization reject before any pool access or trusted callbacks', async () => {
  const trap = queryTrap();
  let callbacks = 0;
  const receipt: PrincipalCommandReceipt = { kind: 'test.report', key: randomUUID(), digest: digest('report') };
  for (const optionalReceipt of [{}, { receipt }]) {
    const options: PrincipalCommandOptions = {
      ...principalCommandIdentity({ kind: 'anonymous' }),
      partition: 24,
      ...optionalReceipt,
      clock: () => {
        callbacks++;
        return new Date();
      },
    };
    await expect(
      runCommand(trap.pool, options, async () => {
        callbacks++;
        return body();
      }),
    ).rejects.toThrow('Anonymous commands require authorization');
  }
  expect(callbacks).toBe(0);
  expect(trap.calls()).toBe(0);
});

test('authorized anonymous commands remain unavailable before SQL, checkout, authorization or body', async () => {
  const trap = queryTrap();
  const unexpected = () => {
    throw new Error('Unavailable anonymous command invoked a callback');
  };
  const authorization: CommandAuthorization = {
    action: 'test:report',
    resource: { route: 24, id: actor.accountId },
    prepare: unexpected,
    authorize: unexpected,
    denied: unexpected,
  };
  for (const optionalReceipt of [
    {},
    { receipt: { kind: 'test.report', key: randomUUID(), digest: digest('report') } },
  ]) {
    await expect(
      runCommand(
        trap.pool,
        {
          ...principalCommandIdentity({ kind: 'anonymous' }),
          partition: 24,
          ...optionalReceipt,
          authorization,
          clock: unexpected,
        },
        unexpected,
      ),
    ).rejects.toBeInstanceOf(CommandUnavailableError);
  }
  expect(trap.calls()).toBe(0);
});

test('the nil marker cannot become an account or carry anonymous client attribution', async () => {
  const trap = queryTrap();
  await expect(
    runCommand(
      trap.pool,
      {
        principal: { kind: 'account', id: ANONYMOUS_PRINCIPAL_ID },
        basis: { clientId: actor.clientId, requestedBy: actor.requestedBy },
        partition: 24,
      },
      body,
    ),
  ).rejects.toBeInstanceOf(TypeError);
  for (const basis of [
    { clientId: 'web', requestedBy: null },
    { clientId: null, requestedBy: actor.requestedBy },
  ]) {
    // Exercise callers that bypass the typed, verified-Actor identity boundary.
    const forged = {
      principal: { kind: 'anonymous', id: ANONYMOUS_PRINCIPAL_ID },
      basis,
      partition: 24,
    } as PrincipalCommandOptions;
    await expect(runCommand(trap.pool, forged, body)).rejects.toThrow(
      'Anonymous commands require the kind marker and null attribution',
    );
  }
  expect(trap.calls()).toBe(0);
});

test('the account overload shares legacy basis, receipt, digest, authorization and command context semantics', async () => {
  const identity = principalCommandIdentity(actor);
  const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
  const receipt: PrincipalCommandReceipt = { kind: 'test.principal', key: randomUUID(), digest: digest('one') };
  const at = new Date('2026-10-25T12:00:00Z');
  let checks = 0;
  let bodies = 0;
  let allowed = true;
  const denied = new Error('account authorization denied');
  const authorization: CommandAuthorization = {
    action: 'test:write',
    resource: { route: 24, id: actor.accountId },
    async prepare(attempt) {
      expect(attempt.basis).toEqual(basis);
      expect(new Date(authoritativeTimeValue(attempt.time)).toISOString()).toBe(at.toISOString());
      return 'prepared';
    },
    async authorize(_tx, attempt, evidence) {
      checks++;
      expect(attempt.basis).toEqual(basis);
      expect(evidence).toBe('prepared');
      if (!allowed) throw denied;
      return 'execute';
    },
    denied: () => denied,
  };
  const options: PrincipalCommandOptions = { ...identity, partition: 24, receipt, authorization, clock: () => at };
  const execute: Parameters<typeof runCommand<unknown>>[2] = async (tx) => {
    bodies++;
    expect(currentCommand(tx).basis).toEqual(basis);
    expect(currentCommand(tx).authorization).toMatchObject({ action: 'test:write', mode: 'execute' });
    return { value: { written: bodies }, events: [event] };
  };
  const first = await runCommand(pool, options, execute);
  expect(first).toMatchObject({ value: { written: 1 }, replayed: false });
  const { rows } = await pool.query(
    'SELECT actor_account_id, client_id, requested_by FROM editorial.write_basis WHERE partition_no = 24 AND transaction_id = $1',
    [first.transactionId],
  );
  expect(rows).toEqual([
    { actor_account_id: actor.accountId, client_id: actor.clientId, requested_by: actor.requestedBy },
  ]);
  const legacy = {
    partition: 24,
    basis: { ...basis, clientId: actor.clientId },
    receipt: { ...receipt, actorAccountId: actor.accountId },
    authorization,
    clock: () => at,
  };
  expect(await runCommand(pool, legacy, execute)).toEqual({ ...first, replayed: true });
  expect(await runCommand(pool, options, execute)).toEqual({ ...first, replayed: true });
  await expect(
    runCommand(pool, { ...options, receipt: { ...receipt, digest: digest('changed') } }, execute),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  allowed = false;
  await expect(runCommand(pool, options, execute)).rejects.toBe(denied);
  expect(checks).toBe(5);
  expect(bodies).toBe(1);
});
