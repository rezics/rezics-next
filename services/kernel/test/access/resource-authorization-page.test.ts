import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createPool } from '../../src/database/pool.ts';
import { authoritativeTimeValue, runCommand, type CommandAuthorization } from '../../src/command/command.ts';
import {
  resourceAuthorization,
  resourceAuthorizationPage,
  type ResourceAuthorizationPageInput,
} from '../../src/access/resource-authorization.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { accessCheck, type AccountActor, type ResourcePage } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { PLATFORM_RESOURCE } from '../../src/access/governance-reach.ts';
import { actorFixture } from './actor-side-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
const admin = createPool(process.env.DATABASE_URL!);
const statements: string[] = [];
pool.on('connect', (client) => {
  const query = client.query.bind(client);
  client.query = ((...args: Parameters<PoolClient['query']>) => {
    const config: unknown = args[0];
    if (typeof config === 'string') statements.push(config);
    else if (config && typeof config === 'object' && 'text' in config && typeof config.text === 'string')
      statements.push(config.text);
    return query(...args);
  }) as PoolClient['query'];
});
const formulas = () => statements.filter((sql) => sql.includes('AS "governanceReach"'));
beforeAll(async () => {
  await admin.query('CREATE TABLE public.authorization_page_resource(route integer, id uuid, PRIMARY KEY(route,id))');
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function fixture(size = 3, action = 'subject:read') {
  const f = await actorFixture(pool, admin);
  const ids = [f.resource.id, ...Array.from({ length: size - 1 }, () => newId(f.resource.route))];
  await admin.query('INSERT INTO public.authorization_page_resource SELECT $1,id FROM unnest($2::uuid[]) id', [
    f.resource.route,
    ids,
  ]);
  await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
    f.resource.route,
    f.resource.id,
  ]);
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     SELECT $1,id,subject,$3,'(,)',$4 FROM unnest($2::uuid[]) id
     CROSS JOIN unnest($5::uuid[]) subject`,
    [f.resource.route, ids, action, f.transactionId, [f.actorId, f.principalId]],
  );
  const actor = { ...f.delegated, scopes: [action] };
  const account = await readAccount(admin, routeOf(f.actorId)!, f.actorId);
  const access = f.permissions({ actions: new Map([[action, { anonymous: false }]]), accountEvidence: () => account });
  const input: ResourceAuthorizationPageInput = {
    access,
    actor,
    action,
    anchor: {
      route: f.resource.route,
      resourceType: 'fixture.page',
      ids,
      async validate(client, time) {
        authoritativeTimeValue(time);
        return (
          (
            await client.query(
              'SELECT id FROM public.authorization_page_resource WHERE route=$1 AND id=ANY($2::uuid[])',
              [f.resource.route, ids],
            )
          ).rowCount === ids.length
        );
      },
    },
    context: { pool, deadline: Date.now() + 10_000, partition: partitionOf(f.resource.route) },
  };
  return { f, ids, input };
}

function execute(input: ResourceAuthorizationPageInput, authorization = resourceAuthorizationPage(input)) {
  const actor = input.actor as AccountActor;
  return runCommand(
    pool,
    {
      partition: input.context.partition,
      deadline: input.context.deadline,
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization,
      receipt: {
        actorAccountId: actor.accountId,
        kind: 'test.page.authorization',
        key: crypto.randomUUID(),
        digest: Buffer.alloc(32),
      },
    },
    async () => ({ value: 'executed', events: [{ type: 'com.rezics.test.resource-authorized.v1', data: {} }] }),
  );
}

function single(input: ResourceAuthorizationPageInput, id: string) {
  return resourceAuthorization({
    ...input,
    anchor: {
      resource: { route: input.anchor.route, id },
      async validate(client) {
        return (
          (
            await client.query('SELECT id FROM public.authorization_page_resource WHERE route=$1 AND id=$2', [
              input.anchor.route,
              id,
            ])
          ).rowCount === 1
        );
      },
    },
  });
}

async function sameDecisions(input: ResourceAuthorizationPageInput, ids: readonly string[]) {
  const results: boolean[] = [];
  for (const id of ids) {
    const check = await accessCheck(
      input.access,
      input.actor,
      input.action,
      { route: input.anchor.route, id },
      input.context,
    );
    results.push(await check(pool));
  }
  const evidence = await input.access.preparePage!(input.actor, input.action, input.anchor, input.context);
  const page = await input.access.authorizePage!(pool, input.actor, input.action, input.anchor, evidence);
  expect(page).toBe(results.every(Boolean));
  return results;
}

test('up to 100 resources execute only after one whole-page validation and one formula at T', async () => {
  for (const size of [1, 3, 100]) {
    const { input, ids } = await fixture(size);
    expect(await sameDecisions(input, ids)).toEqual(ids.map(() => true));
    statements.length = 0;
    expect((await execute(input)).value).toBe('executed');
    expect(formulas()).toHaveLength(1);
    expect(statements.filter((sql) => sql.includes('FROM public.authorization_page_resource'))).toHaveLength(1);
  }
});

test('single resource, Access.check and a page of one execute the identical formula statement', async () => {
  const { input, ids } = await fixture(1);
  statements.length = 0;
  await execute(input, single(input, ids[0]!));
  const singleton = formulas();
  statements.length = 0;
  await execute(input);
  expect(formulas()).toEqual(singleton);
  statements.length = 0;
  await sameDecisions(input, ids);
  expect(formulas()).toEqual([singleton[0]!, singleton[0]!]);
});

for (const operand of [
  'grant',
  'role grant',
  'denial',
  'fence',
  'client scope',
  'principal',
  'delegation bound',
  'governance reach',
] as const) {
  test(`${operand} denying a page member denies execution with the single-check error and no resource disclosure`, async () => {
    const { input, ids, f } = await fixture(3, operand === 'governance reach' ? 'post:erase' : 'subject:read');
    const bad = ids[1]!;
    if (['grant', 'principal', 'role grant', 'governance reach'].includes(operand)) {
      await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
        f.resource.route,
        bad,
        operand === 'principal' ? f.principalId : f.actorId,
      ]);
    }
    if (operand === 'role grant') {
      // Another member is permitted solely through its role grant.
      await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
        f.resource.route,
        ids[2],
        f.actorId,
      ]);
      await admin.query(
        `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
        VALUES ($1,$2,$3,'fixture.reader','(,)',$4)`,
        [f.resource.route, ids[2], f.actorId, f.transactionId],
      );
    }
    if (operand === 'denial')
      await admin.query(
        `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
        VALUES ($1,$2,$3,$4,'resource','(,)',$5)`,
        [f.resource.route, bad, f.actorId, input.action, f.transactionId],
      );
    if (operand === 'fence') {
      await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
        f.resource.route,
        bad,
        f.actorId,
      ]);
      await f.grant(f.organizationId, 'owner', { route: f.resource.route, id: bad });
      await admin.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
        routeOf(f.organizationId),
        f.organizationId,
      ]);
    }
    if (operand === 'client scope') input.actor = { ...(input.actor as AccountActor), scopes: [] };
    if (operand === 'delegation bound') {
      await admin.query(
        "UPDATE access.principal_assignment SET valid='[2000-01-01,2001-01-01)' WHERE principal_id=$1",
        [f.principalId],
      );
    }
    const decisions = await sameDecisions(input, ids);
    expect(decisions[1]).toBe(false);
    if (['grant', 'role grant', 'denial', 'fence', 'principal', 'governance reach'].includes(operand))
      expect(decisions).toEqual([true, false, true]);
    statements.length = 0;
    const pageError = await execute(input).catch((error: unknown) => error);
    const singleError = await execute(input, single(input, bad)).catch((error: unknown) => error);
    expect(pageError).toBeInstanceOf(GrantDeniedError);
    expect(singleError).toBeInstanceOf(GrantDeniedError);
    expect(JSON.stringify(pageError)).toBe(JSON.stringify(singleError));
    expect(String(pageError)).toBe(String(singleError));
    expect(String(pageError)).not.toContain(bad);
    expect(
      statements.some((sql) => sql.includes('core.receipt') || sql.startsWith('BEGIN ISOLATION LEVEL SERIALIZABLE')),
    ).toBe(false);
  });
}

test('malformed pages are refused synchronously before any statement', async () => {
  const { input, ids } = await fixture();
  const invalid: ResourcePage[] = [
    { ...input.anchor, ids: [] },
    { ...input.anchor, ids: Array.from({ length: 101 }, () => ids[0]!) },
    { ...input.anchor, ids: [ids[0]!, ids[0]!] },
    { ...input.anchor, ids: [ids[0]!, newId(input.anchor.route + 1)] },
    { ...input.anchor, ids: [ids[0]!, { id: ids[1], resourceType: 'other' }] as unknown as string[] },
    { ...input.anchor, resourceType: '' },
  ];
  statements.length = 0;
  for (const page of invalid) {
    expect(() => resourceAuthorizationPage({ ...input, anchor: { ...page, validate: input.anchor.validate } })).toThrow(
      RangeError,
    );
    expect(() => input.access.preparePage!(input.actor, input.action, page, input.context)).toThrow(RangeError);
  }
  expect(statements).toEqual([]);
});

test('page proofs bind the exact immutable id set, resource type and attempt', async () => {
  const { input, ids } = await fixture();
  const evidence = await input.access.preparePage!(input.actor, input.action, input.anchor, input.context);
  expect(
    await input.access.authorizePage!(
      pool,
      input.actor,
      input.action,
      { ...input.anchor, ids: [...ids].reverse() },
      evidence,
    ),
  ).toBe(true);
  for (const changed of [
    { ...input.anchor, ids: ids.slice(0, 2) },
    { ...input.anchor, resourceType: 'other' },
  ])
    expect(await input.access.authorizePage!(pool, input.actor, input.action, changed, evidence)).toBe(false);
  const base = resourceAuthorizationPage(input);
  const other = resourceAuthorizationPage({ ...input, anchor: { ...input.anchor, ids: ids.slice(0, 2) } });
  const borrowed: CommandAuthorization = { ...base, prepare: (attempt) => other.prepare!(attempt) };
  await expect(execute(input, borrowed)).rejects.toBeInstanceOf(GrantDeniedError);
  const missing = resourceAuthorizationPage({
    ...input,
    anchor: {
      ...input.anchor,
      async validate() {
        return false;
      },
    },
  });
  statements.length = 0;
  await expect(execute(input, missing)).rejects.toBeInstanceOf(GrantDeniedError);
  expect(formulas()).toEqual([]);
});

test('mixed local and governance reach permits the page with one formula and one exact reach record statement', async () => {
  const { input, ids, f } = await fixture(3, 'post:erase');
  await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=ANY($2::uuid[])', [
    f.resource.route,
    ids.slice(1),
  ]);
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    SELECT 0,$1,subject,'post:erase','(,)',$2 FROM unnest($3::uuid[]) subject`,
    [PLATFORM_RESOURCE.id, f.transactionId, [f.actorId, f.principalId]],
  );
  await sameDecisions(input, ids);
  statements.length = 0;
  await execute(input);
  expect(formulas()).toHaveLength(1);
  expect(statements.filter((sql) => sql.includes('INSERT INTO access.governance_reach'))).toHaveLength(1);
  const rows = await admin.query(
    'SELECT resource_id::text FROM access.governance_reach WHERE actor_account_id=$1 ORDER BY resource_id',
    [f.actorId],
  );
  expect(rows.rows.map((row) => row.resource_id)).toEqual(ids.slice(1).sort());
  await admin.query('DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2', [
    PLATFORM_RESOURCE.id,
    f.principalId,
  ]);
  expect(await sameDecisions(input, ids)).toEqual([true, false, false]);
  await expect(execute(input)).rejects.toBeInstanceOf(GrantDeniedError);
});

test('production Access prepares a page once and retains verified actor and page bindings', async () => {
  const { input, f, ids } = await fixture();
  const requestId = newId(routeOf(f.principalId)!);
  await admin.query(
    `INSERT INTO access.principal_assignment(route,principal_id,request_id,assigned_actor_id,creator_principal_id,valid,transaction_id)
     VALUES($1,$2,$3,$4,$2,'(,)',$5)`,
    [routeOf(f.principalId), f.principalId, requestId, f.actorId, f.transactionId],
  );
  const keys = await generateKeyPair('ES256', { extractable: true });
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: 'page-test' };
  const access = createAccess({
    actions: new Map([[input.action, { anonymous: false }]]),
    auth: {
      issuer: 'https://page-auth.test',
      audience: 'https://page-api.test',
      jwksUrl: 'https://page-auth.test/jwks',
      fetch: async () => Response.json({ keys: [publicKey] }),
    },
  });
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    client_id: 'page-client',
    scope: input.action,
    authn_epoch: 1,
    auth_time: now,
    amr: ['pwd'],
    requested_by: `urn:rezics:request:${f.principalId}:${requestId}`,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'page-test', typ: 'at+jwt' })
    .setIssuer('https://page-auth.test')
    .setAudience('https://page-api.test')
    .setSubject(f.actorId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(keys.privateKey);
  const actor = await access.authenticate(token, input.context);
  const production = { ...input, access, actor };
  statements.length = 0;
  expect((await execute(production)).value).toBe('executed');
  expect(formulas()).toHaveLength(1);
  const evidence = await access.preparePage!(actor, input.action, input.anchor, input.context);
  expect(await access.authorizePage!(pool, actor, input.action, input.anchor, evidence)).toBe(true);
  expect(await access.authorizePage!(pool, { ...actor }, input.action, input.anchor, evidence)).toBe(false);
  expect(await access.authorizePage!(pool, actor, input.action, { ...input.anchor, ids: ids.slice(1) }, evidence)).toBe(
    false,
  );
  await expect(execute({ ...production, actor: { ...actor } })).rejects.toBeInstanceOf(GrantDeniedError);
});
