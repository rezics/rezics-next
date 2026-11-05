import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createResourceAnonymousEligibility } from '../../src/access/eligibility.ts';
import { AccessUnavailableError, createAccess } from '../../src/access/index.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { parentCreationAuthorization, creationCapability } from '../../src/access/parent-creation.ts';
import { grantCommand } from '../../src/access/grant-command.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { createOperatorCommands } from '../../src/access/operator.ts';
import {
  accessCheck,
  accessCommandAuthorization,
  actorOf,
  AuthenticationError,
  type Actor,
} from '../../src/request/access.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
} from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { actorFixture } from './actor-side-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
const admin = createPool(process.env.DATABASE_URL!);
const statements: { text: string; values?: unknown[] }[] = [];
let unavailable = false;
pool.on('connect', (client) => {
  const query = client.query.bind(client);
  client.query = ((...args: Parameters<PoolClient['query']>) => {
    const config = args[0] as unknown as string | { text: string; values?: unknown[] };
    const statement = typeof config === 'string' ? { text: config } : config;
    statements.push(statement);
    if (unavailable && actorRead(statement.text)) throw new Error('Anchor unavailable');
    return query(...args);
  }) as PoolClient['query'];
});
const actorRead = (sql: string) =>
  sql.includes('minimum_authn_epoch::text AS "minimumAuthnEpoch"') &&
  sql.includes('FROM access.account') &&
  !sql.includes('FOR UPDATE');
const issuer = 'https://admission.example.test';
const audience = 'https://api.example.test';
const actions = new Map([
  ['subject:read', { anonymous: false }],
  ['subject:update', { anonymous: false }],
  ['subject:public', { anonymous: true }],
  ['account:update', { anonymous: false }],
  ['account:read', { anonymous: false }],
  ['account:delete', { anonymous: false, replay: 'self-account-read' as const }],
  ['account:manage', { anonymous: false }],
  ['account:delegate', { anonymous: false }],
]);
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: object;
let fetches = 0;
const access = createAccess({
  actions,
  auth: {
    issuer,
    audience,
    jwksUrl: `${issuer}/jwks`,
    async fetch() {
      fetches++;
      return Response.json(jwks);
    },
  },
});
beforeAll(async () => {
  keys = await generateKeyPair('ES256');
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'ES256' }] };
  await admin.query('CREATE TABLE public.admission_effect (id uuid PRIMARY KEY, value integer NOT NULL)');
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

// Component fixtures and a local test issuer exercise genuine JWT verification;
// they do not claim to prove the ordinary provisioning/account lifecycle.
async function fixture() {
  const id = newId(0x1234);
  const resource = { route: 0x9876, id: newId(0x9876) };
  await admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(id), id],
  );
  for (const target of [resource, { route: routeOf(id)!, id }])
    for (const action of actions.keys())
      await admin.query(
        `INSERT INTO access.resource_grant
      (route,resource_id,subject_id,action,valid,transaction_id) VALUES($1,$2,$3,$4,'(,)',$3)`,
        [target.route, target.id, id, action],
      );
  const context = { pool, deadline: Date.now() + 180_000 };
  const token = await signed(id);
  const actor = await access.authenticate(token, context);
  return { id, resource, context, token, actor };
}
async function signed(id: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: audience,
    sub: id,
    client_id: 'fixture',
    scope: [...actions.keys()].join(' '),
    authn_epoch: 9,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
    ...overrides,
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'fixture' })
    .sign(keys.privateKey);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function anchor(f: Fixture) {
  return {
    resource: f.resource,
    async validate(client: Parameters<typeof access.authorize>[0]) {
      return (await client.query('SELECT 1')).rowCount === 1;
    },
  };
}
async function execute(f: Fixture, key = Bun.randomUUIDv7(), local = false, actor: Actor = f.actor, source = pool) {
  const context = { ...f.context, pool: source };
  const authorization = local
    ? await accessCommandAuthorization(access, actor, 'subject:read', f.resource, context, () => new Error('Denied'))
    : resourceAuthorization({
        access,
        actor,
        action: 'subject:read',
        anchor: anchor(f),
        context: { ...context, partition: partitionOf(f.resource.route) },
      });
  return run(f, authorization, key, source);
}
function run(
  f: Fixture,
  authorization: CommandAuthorization,
  key: string,
  source = pool,
  body?: Parameters<typeof runCommand>[2],
) {
  return runCommand(
    source,
    {
      partition: partitionOf(f.resource.route),
      deadline: f.context.deadline,
      basis: { actorAccountId: f.id, clientId: f.actor.clientId, requestedBy: null },
      authorization,
      receipt: { actorAccountId: f.id, kind: 'admission', key, digest: Buffer.alloc(32) },
    },
    body ??
      (async (tx) => {
        await tx.query(
          `INSERT INTO public.admission_effect VALUES($1,1) ON CONFLICT(id) DO UPDATE SET value=admission_effect.value+1`,
          [f.resource.id],
        );
        return { value: { secret: key }, events: [{ type: 'com.rezics.test.admission.v1', data: {} }] };
      }),
  );
}
async function denied(promise: Promise<unknown>) {
  expect(
    await promise.then(
      () => false,
      () => true,
    ),
  ).toBe(true);
}
function assertOneRead(f: Fixture) {
  const reads = statements.filter(({ text }) => actorRead(text));
  expect(reads).toHaveLength(1);
  expect(reads[0]!.values).toEqual([routeOf(f.id), f.id]);
  const read = statements.indexOf(reads[0]!);
  const checkout = statements.findIndex(({ text }) => text === 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  expect(read).toBeLessThan(checkout);
}
for (const local of [false, true]) {
  test(`${local ? 'target-local' : 'generic'} commands reject the same authenticated suspended actor before effects and receipt disclosure`, async () => {
    const f = await fixture();
    const key = Bun.randomUUIDv7();
    statements.length = 0;
    expect((await execute(f, key, local)).replayed).toBe(false);
    assertOneRead(f);
    await suspendAccount(admin, f.id);
    for (const attemptKey of [Bun.randomUUIDv7(), key]) {
      statements.length = 0;
      await denied(execute(f, attemptKey, local));
      expect(statements.some(({ text }) => text.includes('FROM core.receipt'))).toBe(false);
      expect(statements.some(({ text }) => text.startsWith('INSERT INTO public.admission_effect'))).toBe(false);
    }
    expect(
      (await admin.query('SELECT value FROM public.admission_effect WHERE id=$1', [f.resource.id])).rows[0].value,
    ).toBe(1);
    const error = await actorOf(
      access,
      new Request(audience, { headers: { authorization: `Bearer ${f.token}` } }),
      f.context,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({ status: 401, challenge: 'Bearer error="invalid_token"' });
  });
}
for (const mutation of ['minimum_authn_epoch=2', 'authn_fenced=true', 'operator_account_id=$3', "state='deleted'"]) {
  test(`original identity denies after ${mutation} without renewing its snapshot`, async () => {
    const f = await fixture();
    const other = await fixture();
    await execute(f);
    await admin.query(
      `UPDATE access.account SET ${mutation} WHERE route=$1 AND account_id=$2`,
      mutation.includes('$3') ? [routeOf(f.id), f.id, other.id] : [routeOf(f.id), f.id],
    );
    await denied(execute(f));
    await denied(execute(f, Bun.randomUUIDv7(), true));
    expect((await execute(other)).replayed).toBe(false);
    // A new token authentication may accept floor 2 under epoch 9; the old
    // identity must still deny because its authenticated floor was 1.
    if (mutation.startsWith('minimum')) {
      const renewed = await access.authenticate(f.token, f.context);
      expect((await execute(f, Bun.randomUUIDv7(), false, renewed)).replayed).toBe(false);
      await denied(execute(f));
    }
  });
}
test('missing/unavailable anchor, copied identity and wrong pool fail closed', async () => {
  const f = await fixture();
  await denied(execute(f, Bun.randomUUIDv7(), false, { ...f.actor }));
  await denied(execute(f, Bun.randomUUIDv7(), false, f.actor, admin));
  unavailable = true;
  try {
    await denied(execute(f));
  } finally {
    unavailable = false;
  }
  await admin.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [routeOf(f.id), f.id]);
  await denied(execute(f));
});
test('grant multi-action commands share exactly one admission read on every serialization retry and fresh T', async () => {
  const f = await fixture();
  const times: string[] = [];
  const jwksReads = fetches;
  statements.length = 0;
  await grantCommand(
    { pool, access },
    { ...f.context, actor: f.actor },
    {
      resource: f.resource,
      actions: ['subject:read', 'subject:update', 'subject:read'],
      kind: 'admission-grant',
      key: Bun.randomUUIDv7(),
      input: {},
      denied: () => new Error('Denied'),
    },
    async (tx) => {
      const { currentCommand } = await import('../../src/command/command.ts');
      times.push(authoritativeTimeValue(currentCommand(tx).time));
      if (times.length === 1) throw Object.assign(new Error('Retry'), { code: '40001' });
      return 'done';
    },
  );
  expect(times).toHaveLength(2);
  expect(times[0]).not.toBe(times[1]);
  expect(statements.filter(({ text }) => actorRead(text))).toHaveLength(2);
  expect(fetches).toBe(jwksReads);
});
test('captured lifecycle check stays stable while evidence refreshes per attempt', async () => {
  const f = await fixture();
  const commands = createLifecycleCommands({ pool, access });
  statements.length = 0;
  await commands.updateAccount(
    { actor: f.actor, deadline: f.context.deadline },
    { accountId: f.id, key: Bun.randomUUIDv7(), patch: { displayName: 'fresh' } },
  );
  assertOneRead(f);
  await admin.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2', [
    routeOf(f.id),
    f.id,
  ]);
  await denied(
    commands.updateAccount(
      { actor: f.actor, deadline: f.context.deadline },
      { accountId: f.id, key: Bun.randomUUIDv7(), patch: { displayName: 'stale' } },
    ),
  );
});
test('parent creation forwards trusted attempt admission without duplicate refresh', async () => {
  const f = await fixture();
  const child = { route: 0x8765, id: newId(0x8765) };
  const authorization = parentCreationAuthorization({
    access,
    actor: f.actor,
    action: 'subject:read',
    parent: anchor(f),
    context: {
      ...f.context,
      resource: child,
      creation: {
        async validate() {
          return true;
        },
      },
    },
  });
  statements.length = 0;
  await run({ ...f, resource: child }, authorization, Bun.randomUUIDv7(), pool, async (tx) => {
    const creation = await creationCapability(tx, child, f.id);
    creation.complete();
    return { value: 'created', events: [{ type: 'com.rezics.test.admission-created.v1', data: {} }] };
  });
  assertOneRead(f);
  await suspendAccount(admin, f.id);
  await denied(run({ ...f, resource: child }, authorization, Bun.randomUUIDv7()));
});
test('operator opening refreshes admission per attempt through the same Access evaluator', async () => {
  const f = await fixture();
  const subject = await fixture();
  const commands = createOperatorCommands({ pool, access, actions, managementAction: 'account:manage' });
  const reservation = await commands.reserveResponsibility({
    operatorAccountId: f.id,
    subjectAccountId: subject.id,
    key: Bun.randomUUIDv7(),
  });
  await commands.recordOperatorRelation({
    ...reservation.value,
    expectedOperatorAccountId: null,
    expectedVersion: '0',
    key: Bun.randomUUIDv7(),
  });
  const key = Bun.randomUUIDv7();
  const context = {
    actor: f.actor,
    deadline: f.context.deadline,
    account: await readAccount(admin, routeOf(f.id)!, f.id),
  };
  const input = { operatorAccountId: f.id, subjectAccountId: subject.id, purpose: 'session' as const, key };
  statements.length = 0;
  await commands.authorizeOpening(context, input);
  assertOneRead(f);
  await admin.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2', [
    routeOf(f.id),
    f.id,
  ]);
  await denied(commands.authorizeOpening(context, { ...input, key: Bun.randomUUIDv7() }));
  await denied(commands.authorizeOpening(context, input));
});
test('read snapshot is bounded by actual authentication observation, original deadline and JWT expiry', async () => {
  const realNow = Date.now;
  const f = await fixture();
  const readActor = await access.authenticate(f.token, { pool, deadline: realNow() + 600_000 });
  const observed = realNow();
  try {
    Date.now = () => observed + 179_000;
    const context = { pool, deadline: observed + 600_000 };
    statements.length = 0;
    expect(await (await accessCheck(access, readActor, 'subject:read', f.resource, context))(pool)).toBe(true);
    expect(statements.filter(({ text }) => actorRead(text))).toHaveLength(0);
    Date.now = () => observed + 180_001;
    await expect(accessCheck(access, readActor, 'subject:read', f.resource, context)).rejects.toBeInstanceOf(
      AccessUnavailableError,
    );
  } finally {
    Date.now = realNow;
  }
  const short = { pool, deadline: Date.now() + 3000 };
  const actor = await access.authenticate(f.token, short);
  try {
    Date.now = () => short.deadline + 1;
    await expect(accessCheck(access, actor, 'subject:read', f.resource, f.context)).rejects.toBeInstanceOf(
      AccessUnavailableError,
    );
  } finally {
    Date.now = realNow;
  }
  await Bun.sleep(1000 - (Date.now() % 1000));
  const now = Math.floor(Date.now() / 1000);
  const expiring = await access.authenticate(await signed(f.id, { exp: now + 1 }), f.context);
  await Bun.sleep(Math.max(0, (now + 1) * 1000 - Date.now()));
  await denied(execute(f, Bun.randomUUIDv7(), true, expiring));
});

test('target-local stable check uses fresh evidence and T after a serialization retry', async () => {
  const f = await fixture();
  const authorization = await accessCommandAuthorization(
    access,
    f.actor,
    'subject:read',
    f.resource,
    f.context,
    () => new Error('Denied'),
  );
  const allowed = authorization.check;
  let attempts = 0;
  const times: string[] = [];
  statements.length = 0;
  await run(f, authorization, Bun.randomUUIDv7(), pool, async (tx, { time }) => {
    expect(authorization.check).toBe(allowed);
    expect(await allowed(tx)).toBe(true);
    times.push(authoritativeTimeValue(time));
    if (++attempts === 1) {
      // A delayed retry must prepare again rather than retain the first
      // closure's evidence, within the same original request deadline.
      await Bun.sleep(1010);
      throw Object.assign(new Error('Retry'), { code: '40001' });
    }
    return { value: 'fresh', events: [{ type: 'com.rezics.test.admission-retry.v1', data: {} }] };
  });
  expect(attempts).toBe(2);
  expect(times[0]).not.toBe(times[1]);
  expect(statements.filter(({ text }) => actorRead(text))).toHaveLength(2);
});
test('a retry denies actor changes committed after its first attempt', async () => {
  const f = await fixture();
  const authorization = await accessCommandAuthorization(
    access,
    f.actor,
    'subject:read',
    f.resource,
    f.context,
    () => new Error('Denied'),
  );
  let bodies = 0;
  statements.length = 0;
  await denied(
    run(f, authorization, Bun.randomUUIDv7(), pool, async () => {
      bodies++;
      await admin.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2', [
        routeOf(f.id),
        f.id,
      ]);
      throw Object.assign(new Error('Retry'), { code: '40001' });
    }),
  );
  expect(bodies).toBe(1);
  expect(statements.filter(({ text }) => actorRead(text))).toHaveLength(2);
});
test('self-account receipt-only replay survives lost grants but never stale acting account admission', async () => {
  const f = await fixture();
  const target = { route: routeOf(f.id)!, id: f.id };
  const key = Bun.randomUUIDv7();
  const executeSelf = async (attemptKey = key) =>
    run(
      { ...f, resource: target },
      await accessCommandAuthorization(access, f.actor, 'account:delete', target, f.context, () => new Error('Denied')),
      attemptKey,
    );
  await executeSelf();
  await admin.query("DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action='account:delete'", [
    target.route,
    target.id,
  ]);
  statements.length = 0;
  expect((await executeSelf()).replayed).toBe(true);
  assertOneRead(f);
  await denied(executeSelf(Bun.randomUUIDv7()));
  await admin.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2', [
    target.route,
    target.id,
  ]);
  statements.length = 0;
  await denied(executeSelf());
  expect(statements.some(({ text }) => text.includes('FROM core.receipt'))).toBe(false);
});
test('command markers must contain a live executor time', async () => {
  const f = await fixture();
  const authorization = resourceAuthorization({
    access,
    actor: f.actor,
    action: 'subject:read',
    anchor: anchor(f),
    context: { ...f.context, partition: partitionOf(f.resource.route) },
  });
  statements.length = 0;
  await denied(
    authorization.prepare!({
      partition: partitionOf(f.resource.route),
      basis: { actorAccountId: f.id, clientId: f.actor.clientId, requestedBy: null },
      time: {} as Parameters<NonNullable<CommandAuthorization['prepare']>>[0]['time'],
    }),
  );
  expect(statements).toHaveLength(0);
});
test('grant revocation, scope and unknown action denial remain independent of actor admission', async () => {
  const f = await fixture();
  const noScope = await access.authenticate(await signed(f.id, { scope: 'subject:update' }), f.context);
  await denied(execute(f, Bun.randomUUIDv7(), false, noScope));
  const unknown = await accessCommandAuthorization(
    access,
    f.actor,
    'unknown:action',
    f.resource,
    f.context,
    () => new Error('Denied'),
  );
  await denied(run(f, unknown, Bun.randomUUIDv7()));
  await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    f.resource.route,
    f.resource.id,
    f.id,
  ]);
  await denied(execute(f));
});

test('anonymous generic eligibility uses no account admission read and still denies an ineligible replay', async () => {
  const f = await fixture();
  const actor = { kind: 'anonymous' as const };
  let eligible = true;
  const capability = createResourceAnonymousEligibility({
    resource: f.resource,
    action: 'subject:public',
    async prepare() {
      return {};
    },
    async verify() {
      return eligible;
    },
  });
  const resource = { ...f.resource, eligibility: capability };
  const key = randomUUID();
  const executeAnonymous = () =>
    runCommand(
      pool,
      {
        ...principalCommandIdentity(actor),
        partition: partitionOf(resource.route),
        deadline: f.context.deadline,
        receipt: { kind: 'admission-anonymous', key, digest: Buffer.alloc(32) },
        authorization: resourceAuthorization({
          access,
          actor,
          action: 'subject:public',
          anchor: { ...anchor(f), resource },
          context: { ...f.context, partition: partitionOf(resource.route) },
        }),
      },
      async () => ({ value: 'anonymous', events: [{ type: 'com.rezics.test.admission-anonymous.v1', data: {} }] }),
    );
  statements.length = 0;
  expect((await executeAnonymous()).replayed).toBe(false);
  expect(statements.filter(({ text }) => actorRead(text))).toHaveLength(0);
  eligible = false;
  statements.length = 0;
  await denied(executeAnonymous());
  expect(statements.filter(({ text }) => actorRead(text))).toHaveLength(0);
  expect(statements.some(({ text }) => text.includes('FROM core.receipt'))).toBe(false);
});
test('the principal grant remains independently required after a successful actor admission', async () => {
  const f = await fixture();
  const principal = await fixture();
  const requestId = newId(routeOf(principal.id)!);
  await createDelegationCommands({ pool, access, action: 'account:delegate' }).create(
    { ...principal.context, actor: principal.actor },
    { principalId: principal.id, requestId, assignedActorId: f.id, valid: '(,)', key: Bun.randomUUIDv7() },
  );
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES($1,$2,$3,'subject:read','(,)',$4)`,
    [f.resource.route, f.resource.id, principal.id, f.id],
  );
  const delegated = await access.authenticate(
    await signed(f.id, { requested_by: `urn:rezics:request:${principal.id}:${requestId}` }),
    f.context,
  );
  // The command basis must retain the verified requested_by attribution.
  const executeDelegated = async () => {
    const authorization = resourceAuthorization({
      access,
      actor: delegated,
      action: 'subject:read',
      anchor: anchor(f),
      context: { ...f.context, partition: partitionOf(f.resource.route) },
    });
    return runCommand(
      pool,
      {
        partition: partitionOf(f.resource.route),
        deadline: f.context.deadline,
        basis: { actorAccountId: f.id, clientId: delegated.clientId, requestedBy: delegated.requestedBy },
        authorization,
      },
      async () => ({ value: 'delegated', events: [{ type: 'com.rezics.test.admission-delegated.v1', data: {} }] }),
    );
  };
  statements.length = 0;
  await executeDelegated();
  assertOneRead(f);
  await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    f.resource.route,
    f.resource.id,
    principal.id,
  ]);
  await denied(executeDelegated());
});

for (const local of [false, true]) {
  test(`${local ? 'target-local' : 'generic'} role proofs include negative membership at the same executor T`, async () => {
    const group = await actorFixture(pool, admin);
    await group.grant(group.organizationId, 'owner');
    const context = { pool, deadline: Date.now() + 180_000 };
    const token = await signed(group.actorId);
    const actor = await access.authenticate(token, context);
    const f = { id: group.actorId, resource: group.resource, context, token, actor };
    const authorization = local
      ? await accessCommandAuthorization(
          access,
          actor,
          'subject:read',
          group.resource,
          context,
          () => new Error('Denied'),
        )
      : resourceAuthorization({
          access,
          actor,
          action: 'subject:read',
          anchor: anchor(f),
          context: { ...context, partition: partitionOf(group.resource.route) },
        });
    statements.length = 0;
    await run(f, authorization, Bun.randomUUIDv7(), pool, async (_tx, { time }) => {
      const memberships = statements.filter(({ text }) =>
        text.includes('COALESCE(m.valid, tstzrange(i.at, n.starts_at'),
      );
      expect(memberships).toHaveLength(1);
      expect(memberships[0]!.values).toContain(authoritativeTimeValue(time));
      return { value: 'roles at T', events: [{ type: 'com.rezics.test.admission-roles.v1', data: {} }] };
    });
    assertOneRead(f);
  });
}
