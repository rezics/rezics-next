import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { PoolClient } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import {
  authoritativeTimeValue,
  runCommand,
  type CommandAttempt,
  type CommandBasis,
  type CommandAuthorization,
} from '../../src/command/command.ts';
import { resourceAuthorization, type ResourceAuthorizationInput } from '../../src/access/resource-authorization.ts';
import { AccessUnavailableError } from '../../src/access/index.ts';
import { parentCreationAuthorization, creationCapability } from '../../src/access/parent-creation.ts';
import { initializeResourceGrants } from '../../src/access/resource-initialization.ts';
import type { ResourceCreationManifest } from '../../src/access/creation-manifest.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/permission.ts';
import { problemResponse, ProblemError } from '../../src/http/problem.ts';
import type { Access, AccountActor, Resource } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { actorFixture, type ActorFixture } from './actor-side-fixture.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
const statements: string[] = [];
pool.on('connect', (client) => {
  const query = client.query.bind(client);
  client.query = ((...args: Parameters<PoolClient['query']>) => {
    const config: unknown = args[0];
    if (typeof config === 'string') statements.push(config);
    else if (typeof config === 'object' && config !== null && 'text' in config && typeof config.text === 'string')
      statements.push(config.text);
    return query(...args);
  }) as PoolClient['query'];
});
const admin = createPool(url);
const action = 'subject:read';
const targetPartition = partitionOf(0x9876);
const event = { type: 'com.rezics.test.resource-authorized.v1', data: {} };
const platform: Resource = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
let f: ActorFixture;
beforeAll(async () => {
  await admin.query(`CREATE TABLE public.authorization_resource (
    route integer NOT NULL, id uuid NOT NULL,
    creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), PRIMARY KEY(route,id)
  )`);
  await admin.query(`CREATE TABLE public.authorization_effect (
    route integer NOT NULL, source text NOT NULL, external_key text NOT NULL, value text NOT NULL,
    PRIMARY KEY(route,source,external_key)
  )`);
}, 30_000);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function fixture(identity?: AccountActor) {
  f = await actorFixture(pool, admin);
  await admin.query('INSERT INTO public.authorization_resource(route,id) VALUES ($1,$2)', [
    f.resource.route,
    f.resource.id,
  ]);
  const actor = identity ?? f.delegated;
  const account = await readAccount(admin, routeOf(actor.accountId)!, actor.accountId);
  const access = f.permissions({
    actions: new Map([
      [action, { anonymous: false, 'x-resource-types': ['fixture.owned'] }],
      ['subject:update', { anonymous: false }],
    ]),
    accountEvidence: () => account,
    resourceRoles: {
      roles: { 'fixture.owner': [action] },
      types: { 'fixture.owned': { owner: 'fixture.owner', standing: [] } },
    },
  });
  const input: ResourceAuthorizationInput = {
    access,
    actor,
    action,
    anchor: {
      resource: f.resource,
      async validate(client, time) {
        authoritativeTimeValue(time);
        return (
          (
            await client.query('SELECT 1 FROM public.authorization_resource WHERE route=$1 AND id=$2', [
              f.resource.route,
              f.resource.id,
            ])
          ).rowCount === 1
        );
      },
    },
    context: { pool, partition: targetPartition, deadline: Date.now() + 5000 },
  };
  return {
    input,
    basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
  };
}
function execute(
  input: ResourceAuthorizationInput,
  options: {
    authorization?: CommandAuthorization;
    basis?: CommandBasis;
    partition?: number;
    key?: string;
    body?: Parameters<typeof runCommand>[2];
    clock?: () => Date;
  } = {},
) {
  const actor = input.actor as AccountActor;
  return runCommand(
    pool,
    {
      partition: options.partition ?? input.context.partition,
      deadline: input.context.deadline,
      basis:
        options.basis === undefined
          ? { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy }
          : options.basis,
      authorization: options.authorization ?? resourceAuthorization(input),
      clock: options.clock,
      receipt: {
        actorAccountId: options.basis?.actorAccountId ?? actor.accountId,
        kind: 'fixture.resource',
        key: options.key ?? Bun.randomUUIDv7(),
        digest: Buffer.alloc(32),
      },
    },
    options.body ??
      (async (tx) => {
        await tx.query(
          `INSERT INTO public.authorization_effect VALUES ($1,'catalog',$2,'secret-response')
      ON CONFLICT(route,source,external_key) DO UPDATE SET value=EXCLUDED.value`,
          [0x9876, options.key ?? actor.accountId],
        );
        return { value: { secret: 'secret-response' }, events: [event] };
      }),
  );
}
async function effects(key: string) {
  return (await admin.query('SELECT * FROM public.authorization_effect WHERE external_key=$1', [key])).rows;
}

test('stable composite upsert uses the authority formula at T before target checkout, without creation rights', async () => {
  const { input } = await fixture();
  const phases: string[] = [];
  let preparedTime = '';
  const access: Access = {
    ...input.access,
    async prepare(...args) {
      phases.push('evidence');
      return input.access.prepare!(...args);
    },
    async authorize(client, actor, verb, resource, evidence, time) {
      phases.push('formula');
      expect(statements.some((sql) => /^BEGIN ISOLATION LEVEL SERIALIZABLE/i.test(sql))).toBe(false);
      expect(authoritativeTimeValue(time!)).toBe(preparedTime);
      expect(resource).toEqual(f.resource);
      return input.access.authorize(client, actor, verb, resource, evidence, time);
    },
  };
  const anchor = {
    ...input.anchor,
    async validate(client: Parameters<Access['authorize']>[0], time: CommandAttempt['time']) {
      phases.push('anchor');
      preparedTime = authoritativeTimeValue(time);
      return input.anchor.validate(client, time);
    },
  };
  const authorization = resourceAuthorization({ ...input, access, anchor });
  statements.length = 0;
  const result = await execute(input, {
    authorization,
    body: async (tx, command) => {
      phases.push('body');
      expect(authoritativeTimeValue(command.time)).toBe(preparedTime);
      await expect(creationCapability(tx, f.resource, f.actorId)).rejects.toBeInstanceOf(GrantDeniedError);
      await tx.query(
        `INSERT INTO public.authorization_effect VALUES ($1,'catalog','stable','v1')
      ON CONFLICT(route,source,external_key) DO UPDATE SET value=EXCLUDED.value`,
        [0x9876],
      );
      return { value: 'v1', events: [event] };
    },
  });
  expect(result.replayed).toBe(false);
  expect(phases).toEqual(['evidence', 'anchor', 'formula', 'body']);
  await execute(input, { key: 'stable' });
  expect(await effects('stable')).toHaveLength(1);
  expect(pool.options.max).toBe(1);
});

test('HTTP denied replay discloses neither stored body nor receipt and applies exactly one effect', async () => {
  const { input } = await fixture();
  const key = Bun.randomUUIDv7();
  const app = new Elysia()
    .onError(({ error }) =>
      problemResponse(error instanceof GrantDeniedError ? new ProblemError('forbidden') : error, {
        method: 'POST',
        id: 'resource-test',
        action,
      }),
    )
    .post('/fixture/upsert', async () => {
      const result = await execute(input, { key });
      return { value: result.value, replayed: result.replayed };
    });
  const request = () => app.handle(new Request('http://localhost/fixture/upsert', { method: 'POST' }));
  expect(await (await request()).json()).toEqual({ value: { secret: 'secret-response' }, replayed: false });
  expect(await (await request()).json()).toEqual({ value: { secret: 'secret-response' }, replayed: true });
  await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    f.resource.route,
    f.resource.id,
    f.principalId,
  ]);
  statements.length = 0;
  const denied = await request();
  expect(statements.some((sql) => /core\.receipt|^BEGIN ISOLATION LEVEL SERIALIZABLE/i.test(sql))).toBe(false);
  expect(denied.status).toBe(403);
  const body = await denied.text();
  expect(body).toContain('forbidden');
  for (const hidden of ['secret-response', 'replayed', 'transactionId', 'position']) expect(body).not.toContain(hidden);
  expect(await effects(key)).toHaveLength(1);
  expect(
    (
      await admin.query('SELECT 1 FROM core.receipt WHERE command_kind=$1 AND idempotency_key=$2', [
        'fixture.resource',
        key,
      ])
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await admin.query(
        'SELECT 1 FROM core.outbox WHERE (partition_no,epoch,position)=(SELECT partition_no,epoch,position FROM core.receipt WHERE command_kind=$1 AND idempotency_key=$2)',
        ['fixture.resource', key],
      )
    ).rowCount,
  ).toBe(1);
});

test('every formula operand independently denies on the general path', async () => {
  for (const operand of [
    'actor-grant',
    'principal-grant',
    'actor-denial',
    'principal-denial',
    'scope',
    'state',
    'actor-state',
    'principal-state',
    'authn-epoch',
    'group-membership',
    'group-denial',
    'inverse-coverage',
    'expired-grant',
    'assignment',
    'unknown',
    'anchor',
    'evidence',
    'missing-prepare',
    'deadline',
    'anonymous',
  ] as const) {
    const { input } = await fixture();
    let changed = input;
    if (operand === 'actor-grant' || operand === 'principal-grant')
      await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
        f.resource.route,
        f.resource.id,
        operand === 'actor-grant' ? f.actorId : f.principalId,
      ]);
    if (operand === 'actor-denial' || operand === 'principal-denial')
      await f.deny(operand === 'actor-denial' ? f.actorId : f.principalId, '');
    if (operand === 'scope') changed = { ...input, actor: { ...f.delegated, scopes: [] } };
    if (operand === 'state') changed = { ...input, access: f.permissions({ accountEvidence: () => null }) };
    if (operand === 'actor-state') {
      await suspendAccount(admin, f.actorId);
      const account = await readAccount(admin, routeOf(f.actorId)!, f.actorId);
      changed = { ...input, access: f.permissions({ accountEvidence: () => account }) };
    }
    if (operand === 'principal-state')
      await admin.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
        routeOf(f.principalId),
        f.principalId,
      ]);
    if (operand === 'authn-epoch') changed = { ...input, actor: { ...f.delegated, authnEpoch: 0 } };
    if (operand === 'group-membership') {
      await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
        f.resource.route,
        f.resource.id,
      ]);
      await f.grant(f.organizationId, 'owner');
      await admin.query(
        'DELETE FROM access.organization_member WHERE route=$1 AND organization_id=$2 AND member_account_id=$3',
        [routeOf(f.organizationId), f.organizationId, f.actorId],
      );
    }
    if (operand === 'group-denial') await f.deny(f.organizationId, 'owner');
    if (operand === 'inverse-coverage')
      await admin.query(
        'UPDATE access.account SET membership_inverse_complete=false WHERE route=$1 AND account_id=$2',
        [routeOf(f.actorId), f.actorId],
      );
    if (operand === 'expired-grant')
      await admin.query(
        "UPDATE access.resource_grant SET valid='[1900-01-01,1901-01-01)' WHERE route=$1 AND resource_id=$2 AND subject_id=$3",
        [f.resource.route, f.resource.id, f.actorId],
      );
    if (operand === 'assignment')
      await admin.query('DELETE FROM access.principal_assignment WHERE principal_id=$1', [f.principalId]);
    if (operand === 'unknown') changed = { ...input, action: 'unmounted:action' };
    if (operand === 'anchor') changed = { ...input, anchor: { ...input.anchor, validate: async () => false } };
    if (operand === 'evidence')
      changed = { ...input, access: { ...input.access, prepare: async () => ({ allowed: true }) } };
    if (operand === 'missing-prepare') {
      const { prepare: _, ...access } = input.access;
      changed = { ...input, access };
    }
    if (operand === 'deadline') changed = { ...input, context: { ...input.context, deadline: Date.now() - 1 } };
    if (operand === 'anonymous') changed = { ...input, actor: { kind: 'anonymous' } };
    await expect(
      execute(operand === 'deadline' ? input : changed, {
        ...(operand === 'deadline' ? { authorization: resourceAuthorization(changed) } : {}),
        basis: { actorAccountId: f.actorId, clientId: f.delegated.clientId, requestedBy: f.delegated.requestedBy },
      }),
    ).rejects.toBeInstanceOf(operand === 'deadline' ? AccessUnavailableError : GrantDeniedError);
  }
});

test('proofs cannot be borrowed, replaced by booleans, rebound or retained into a retry', async () => {
  for (const attack of [
    'boolean',
    'missing-proof',
    'other-binding',
    'basis',
    'client',
    'requested-by',
    'partition',
    'retry',
    'expired',
  ] as const) {
    const { input, basis } = await fixture();
    const base = resourceAuthorization(
      attack === 'expired' ? { ...input, context: { ...input.context, deadline: Date.now() + 1000 } } : input,
    );
    let oldProof: unknown;
    let attempts = 0;
    const authorization: CommandAuthorization = {
      ...base,
      async prepare(attempt) {
        attempts++;
        if (attack === 'boolean') return true;
        if (attack === 'missing-proof') return undefined;
        if (attack === 'other-binding') return resourceAuthorization(input).prepare!(attempt);
        if (attack === 'retry' && attempts > 1) return oldProof;
        const proof = await base.prepare!(attempt);
        if (attack === 'expired') await new Promise((resolve) => setTimeout(resolve, 1100));
        oldProof = proof;
        return proof;
      },
    };
    await expect(
      execute(input, {
        authorization,
        basis:
          attack === 'basis'
            ? { ...basis, actorAccountId: f.principalId }
            : attack === 'client'
              ? { ...basis, clientId: 'borrowed' }
              : attack === 'requested-by'
                ? { ...basis, requestedBy: null }
                : basis,
        partition: attack === 'partition' ? targetPartition + 1 : targetPartition,
        body: async () => {
          throw Object.assign(new Error('retry'), { code: '40001' });
        },
      }),
    ).rejects.toBeInstanceOf(attack === 'expired' ? AccessUnavailableError : GrantDeniedError);
    if (attack === 'retry') expect(attempts).toBe(2);
  }
});

test('serialization retry prepares fresh T and independent anchors; parent removal or grant revocation denies the next attempt', async () => {
  for (const mutation of ['none', 'parent', 'grant'] as const) {
    const { input } = await fixture();
    // Exercise the matching group anchor in addition to the independent authority.
    await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
      f.resource.route,
      f.resource.id,
    ]);
    await f.grant(f.organizationId, 'owner');
    let prepares = 0;
    const times: string[] = [];
    const opaqueTimes: CommandAttempt['time'][] = [];
    const access: Access = {
      ...input.access,
      async prepare(...args) {
        prepares++;
        return input.access.prepare!(...args);
      },
    };
    const anchor = {
      ...input.anchor,
      async validate(client: Parameters<Access['authorize']>[0], time: CommandAttempt['time']) {
        times.push(authoritativeTimeValue(time));
        opaqueTimes.push(time);
        return input.anchor.validate(client, time);
      },
    };
    let bodies = 0;
    const result = execute(input, {
      authorization: resourceAuthorization({ ...input, access, anchor }),
      clock: () => new Date(Date.now() + prepares),
      body: async (tx) => {
        bodies++;
        if (bodies === 1) {
          if (mutation === 'parent')
            await admin.query('DELETE FROM public.authorization_resource WHERE route=$1 AND id=$2', [
              f.resource.route,
              f.resource.id,
            ]);
          if (mutation === 'grant')
            await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
              f.resource.route,
              f.resource.id,
            ]);
          throw Object.assign(new Error('serialization'), { code: '40001' });
        }
        await tx.query(`INSERT INTO public.authorization_effect VALUES ($1,'retry',$2,'once')`, [0x9876, f.actorId]);
        return { value: 'once', events: [event] };
      },
    });
    if (mutation === 'none') expect((await result).value).toBe('once');
    else await expect(result).rejects.toBeInstanceOf(GrantDeniedError);
    expect(prepares).toBe(2);
    expect(opaqueTimes[0]).not.toBe(opaqueTimes[1]);
    expect(times[0]).not.toBe(times[1]);
    expect(bodies).toBe(mutation === 'none' ? 2 : 1);
    for (const time of opaqueTimes) expect(() => authoritativeTimeValue(time)).toThrow();
  }
});

test('the seeded Global Context requires real scope and grant authority for protected actions', async () => {
  const { input } = await fixture();
  const account = await readAccount(admin, routeOf(f.actorId)!, f.actorId);
  const access = createAccess({
    actions: new Map([['subject:create', { anonymous: true }]]),
    accountEvidence: () => account,
  });
  const actor = { ...f.actor, scopes: ['subject:create'] };
  const check: ResourceAuthorizationInput = {
    ...input,
    access,
    actor,
    action: 'subject:create',
    anchor: {
      resource: platform,
      async validate(client) {
        return (
          (
            await client.query('SELECT 1 FROM semantic.context WHERE route=$1 AND context_id=$2', [
              platform.route,
              platform.id,
            ])
          ).rowCount === 1
        );
      },
    },
  };
  await expect(execute(check)).rejects.toBeInstanceOf(GrantDeniedError);
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,'subject:create','(,)',$3)`,
    [platform.id, f.actorId, f.transactionId],
  );
  expect((await execute(check)).replayed).toBe(false);
  await expect(execute({ ...check, actor: { ...actor, scopes: [] } })).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(
    execute(
      { ...check, actor: { kind: 'anonymous' } },
      { basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: null } },
    ),
  ).rejects.toBeInstanceOf(GrantDeniedError);
});

test('parent creation alone mints a single-use exact child INSERT capability and preserves the manifest guard', async () => {
  const { input } = await fixture();
  const child = { route: 0x9876, id: newId(0x9876) };
  const creation = {
    async validate(tx: Parameters<Access['authorize']>[0], resource: Readonly<Resource>) {
      return (
        (
          await tx.query(
            'SELECT 1 FROM public.authorization_resource WHERE route=$1 AND id=$2 AND creation_xid=pg_current_xact_id()',
            [resource.route, resource.id],
          )
        ).rowCount === 1
      );
    },
  };
  const context = { pool, deadline: input.context.deadline, resource: child, creation };
  expect(() =>
    parentCreationAuthorization({
      ...input,
      parent: input.anchor,
      context: { ...context, manifest: {} as ResourceCreationManifest },
    }),
  ).toThrow(TypeError);
  expect(() =>
    parentCreationAuthorization({
      ...input,
      parent: input.anchor,
      context: { ...context, creation: {} as typeof creation },
    }),
  ).toThrow(GrantDeniedError);
  for (const mode of ['new', 'reused', 'existing', 'wrong-id', 'wrong-creator', 'wrong-partition'] as const) {
    const child = { route: 0x9876, id: newId(0x9876) };
    if (mode === 'existing')
      await admin.query('INSERT INTO public.authorization_resource(route,id) VALUES ($1,$2)', [child.route, child.id]);
    const authorization = parentCreationAuthorization({
      ...input,
      parent: input.anchor,
      context: { ...context, resource: child },
    });
    const promise = execute(input, {
      authorization,
      partition: mode === 'wrong-partition' ? targetPartition + 1 : targetPartition,
      body: async (tx) => {
        if (mode !== 'existing')
          await tx.query('INSERT INTO public.authorization_resource(route,id) VALUES ($1,$2)', [child.route, child.id]);
        if (mode === 'new' || mode === 'reused') {
          await initializeResourceGrants(tx, { resource: child, creator: f.actorId, type: 'fixture.owned' });
          if (mode === 'reused')
            await expect(creationCapability(tx, child, f.actorId)).rejects.toBeInstanceOf(GrantDeniedError);
        } else
          await creationCapability(
            tx,
            mode === 'wrong-id' ? f.resource : child,
            mode === 'wrong-creator' ? f.principalId : f.actorId,
          );
        return { value: child, events: [event] };
      },
    });
    if (mode === 'new') {
      expect((await promise).value).toEqual(child);
      expect(
        (
          await admin.query(
            'SELECT 1 FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3',
            [child.route, child.id, f.actorId],
          )
        ).rowCount,
      ).toBe(1);
    } else await expect(promise).rejects.toBeInstanceOf(GrantDeniedError);
    await admin.query('DELETE FROM public.authorization_resource WHERE route=$1 AND id=$2', [child.route, child.id]);
  }
});
