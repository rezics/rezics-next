import { afterAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool, withConnection } from '../../src/database/pool.ts';
import {
  runCommand,
  currentCommand,
  commandTime,
  authoritativeTimeValue,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandTransaction,
} from '../../src/command/command.ts';
import {
  accessCheck,
  accessCommandAuthorization,
  type Access,
  type ActionCatalogue,
} from '../../src/request/access.ts';
import { deriveAccess } from '../../src/request/derived-access.ts';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { newId, partitionOf } from '../../src/route/route.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = createPool(url);
afterAll(async () => {
  await pool.end();
  await admin.end();
});
const actions: ActionCatalogue = new Map([
  ['account:update', { anonymous: false }],
  ['account:create', { anonymous: false }],
]);
const issuer = 'https://replay-context.example.test';
const audience = 'https://api.replay-context.example.test';
let signingKeys: CryptoKeyPair | undefined;
let jwks: object | undefined;
class Denied extends Error {}
async function fixture(route: number, action = 'account:update') {
  const accountId = newId(route);
  await admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$3)`,
    [route, accountId, Bun.randomUUIDv7()],
  );
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$2,$3,'(,)',$4)`,
    [route, accountId, action, Bun.randomUUIDv7()],
  );
  signingKeys ??= await generateKeyPair('ES256');
  jwks ??= { keys: [{ ...(await exportJWK(signingKeys.publicKey)), kid: 'fixture', alg: 'ES256' }] };
  const access = createAccess({
    actions,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/jwks`,
      async fetch() {
        return Response.json(jwks);
      },
    },
  });
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    iss: issuer,
    aud: audience,
    sub: accountId,
    client_id: 'web',
    scope: action,
    authn_epoch: 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'fixture' })
    .sign(signingKeys.privateKey);
  const actor = await access.authenticate(token, { pool, deadline: Date.now() + 10_000 });
  const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
  const target = { route, id: accountId };
  return { actor, access, basis, target };
}
function observingAccess(
  access: Access,
  prepare: NonNullable<Access['prepare']>,
  authorize: Access['authorize'],
): Access {
  return deriveAccess(access, { prepare, authorize });
}
const event = { type: 'com.rezics.test.authorized.v1', data: {} };

test('one database T is shared by the final formula, body SQL and immutable live context', async () => {
  const f = await fixture(0xb100);
  let prepares = 0;
  let checkedAt = '';
  const binding = await accessCommandAuthorization(
    observingAccess(
      f.access,
      async (...args) => {
        prepares++;
        return f.access.prepare!(...args);
      },
      async (client, actor, action, resource, evidence, time) => {
        expect(time).toBeDefined();
        checkedAt = authoritativeTimeValue(time!);
        expect(() => currentCommand(client)).toThrow('No authorized live command');
        return f.access.authorize(client, actor, action, resource, evidence, time);
      },
    ),
    f.actor,
    'account:update',
    f.target,
    { pool, deadline: Date.now() + 2000 },
    () => new Denied(),
  );
  let retained: CommandTransaction;
  let retainedTime: AuthoritativeTime;
  const result = await runCommand(
    pool,
    { partition: partitionOf(f.target.route), basis: f.basis, authorization: binding },
    async (tx, context) => {
      retained = tx;
      retainedTime = context.time;
      const current = currentCommand(tx);
      expect(current).toMatchObject({
        partition: partitionOf(f.target.route),
        basis: f.basis,
        authorization: { mode: 'execute', action: 'account:update', resource: f.target },
      });
      expect(Object.isFrozen(current)).toBe(true);
      expect(Object.isFrozen(current.basis)).toBe(true);
      expect(Object.isFrozen(current.authorization)).toBe(true);
      expect(Object.isFrozen(current.authorization!.resource)).toBe(true);
      expect(commandTime(tx)).toBe(context.time);
      expect(current.time).toBe(context.time);
      await tx.query('SELECT pg_sleep(0.02)');
      const { rows } = await tx.query(
        'SELECT $1::timestamptz = $2::timestamptz AS same, clock_timestamp() > $1::timestamptz AS later',
        [authoritativeTimeValue(context.time), checkedAt],
      );
      expect(rows).toEqual([{ same: true, later: true }]);
      expect(authoritativeTimeValue(current.time)).toBe(checkedAt);
      return { value: 'written', events: [event] };
    },
  );
  expect(result.value).toBe('written');
  expect(prepares).toBe(1);
  expect(() => currentCommand(retained!)).toThrow('No authorized live command');
  expect(commandTime(retained!)).toBeUndefined();
  expect(() => authoritativeTimeValue(retainedTime!)).toThrow('not from a live command');
  expect(() => authoritativeTimeValue({} as AuthoritativeTime)).toThrow('not from a live command');
  await withConnection(pool, async (tx) => {
    expect(() => currentCommand(tx)).toThrow('No authorized live command');
  });
});

test('a real PostgreSQL retry chooses a fresh T and prepares and reauthorizes on each attempt', async () => {
  const f = await fixture(0xb110);
  let prepares = 0;
  const checked: string[] = [];
  const binding = await accessCommandAuthorization(
    observingAccess(
      f.access,
      async (...args) => {
        prepares++;
        return f.access.prepare!(...args);
      },
      async (client, actor, action, resource, evidence, time) => {
        checked.push(authoritativeTimeValue(time!));
        return f.access.authorize(client, actor, action, resource, evidence, time);
      },
    ),
    f.actor,
    'account:update',
    f.target,
    { pool, deadline: Date.now() + 2000 },
    () => new Denied(),
  );
  let bodies = 0;
  const result = await runCommand(
    pool,
    { partition: partitionOf(f.target.route), basis: f.basis, authorization: binding },
    async (tx, context) => {
      expect(authoritativeTimeValue(context.time)).toBe(checked.at(-1)!);
      if (++bodies === 1)
        await tx.query(`DO $$ BEGIN RAISE EXCEPTION 'serialization retry' USING ERRCODE='40001'; END $$`);
      return { value: 'one commit', events: [event] };
    },
  );
  expect(result.position).toBe(1n);
  expect(bodies).toBe(2);
  expect(prepares).toBe(2);
  expect(checked).toHaveLength(2);
  expect(checked[0]).not.toBe(checked[1]);
});

test('a separately anchored parent is checked at the same T before child checkout without nested connections', async () => {
  const f = await fixture(0xb120, 'account:create');
  const childRoute = 0xb230;
  const childId = newId(childRoute);
  const allowed = await accessCheck(f.access, f.actor, 'account:create', f.target, {
    pool,
    deadline: Date.now() + 2000,
  });
  const proofs = new WeakSet<object>();
  let parentAt = '';
  const authorization: CommandAuthorization = {
    action: 'account:create',
    resource: f.target,
    denied: () => new Denied(),
    async prepare(attempt) {
      parentAt = authoritativeTimeValue(attempt.time);
      const proof = Object.freeze({});
      await withConnection(pool, async (tx) => {
        expect(await allowed(tx, attempt.time)).toBe(true);
        expect(() => currentCommand(tx)).toThrow('No authorized live command');
      });
      proofs.add(proof);
      return proof;
    },
    async authorize(_tx, attempt, proof) {
      if (typeof proof !== 'object' || proof === null || !proofs.has(proof)) throw new Denied();
      expect(authoritativeTimeValue(attempt.time)).toBe(parentAt);
      return 'execute';
    },
  };
  const before = (
    await admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [partitionOf(f.target.route)])
  ).rows;
  await runCommand(pool, { partition: partitionOf(childRoute), basis: f.basis, authorization }, async (tx) => {
    const context = currentCommand(tx);
    expect(context.partition).toBe(partitionOf(childRoute));
    expect(context.basis?.actorAccountId).toBe(f.actor.accountId);
    expect(context.authorization).toMatchObject({ action: 'account:create', resource: f.target, mode: 'execute' });
    expect(authoritativeTimeValue(context.time)).toBe(parentAt);
    await tx.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$3)`,
      [childRoute, childId, Bun.randomUUIDv7()],
    );
    return { value: childId, events: [event] };
  });
  expect(
    (await admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [partitionOf(f.target.route)]))
      .rows,
  ).toEqual(before);
  expect((await readAccount(admin, childRoute, childId))?.state).toBe('pending');
  const denied: CommandAuthorization = {
    ...authorization,
    async prepare() {
      return { verified: true };
    },
  };
  await expect(
    runCommand(pool, { partition: partitionOf(childRoute), basis: f.basis, authorization: denied }, async () => {
      throw new Error('forged parent proof reached a body');
    }),
  ).rejects.toBeInstanceOf(Denied);
});

test('a trusted service clock is minted once and reused, with no transaction setting left on the pooled client', async () => {
  let reads = 0;
  const configured = new Date();
  await runCommand(
    pool,
    {
      partition: partitionOf(0xb240),
      clock: () => {
        reads++;
        return configured;
      },
    },
    async (tx, context) => {
      expect(new Date(authoritativeTimeValue(context.time)).toISOString()).toBe(configured.toISOString());
      expect(currentCommand(tx).authorization).toBeNull();
      return { value: null, events: [event] };
    },
  );
  expect(reads).toBe(1);
  await withConnection(pool, async (tx) => {
    const { rows } = await tx.query(
      "SELECT current_setting('transaction_isolation') AS isolation, current_setting('statement_timeout') AS timeout",
    );
    expect(rows).toEqual([{ isolation: 'read committed', timeout: '0' }]);
  });
});
