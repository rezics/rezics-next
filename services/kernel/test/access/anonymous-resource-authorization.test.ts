import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import type { PoolClient } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { createResourceAnonymousEligibility, type ResourceEligibility } from '../../src/access/eligibility.ts';
import { resourceAuthorization, type ResourceAuthorizationInput } from '../../src/access/resource-authorization.ts';
import { creationCapability } from '../../src/access/parent-creation.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  ANONYMOUS_PRINCIPAL_ID,
  authoritativeTimeValue,
  IdempotencyConflictError,
  principalCommandIdentity,
  runCommand,
  type CommandAttempt,
  type CommandAuthorization,
} from '../../src/command/command.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { actorFixture } from './actor-side-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
const admin = createPool(process.env.DATABASE_URL!);
const statements: string[] = [];
pool.on('connect', (client) => {
  const query = client.query.bind(client);
  client.query = ((...args: Parameters<PoolClient['query']>) => {
    const sql: unknown = args[0];
    if (typeof sql === 'string') statements.push(sql);
    else if (typeof sql === 'object' && sql !== null && 'text' in sql) statements.push(String(sql.text));
    return query(...args);
  }) as PoolClient['query'];
});
const actor: Actor = { kind: 'anonymous' };
const action = 'report:create';
const targetPartition = partitionOf(0x9876);
const event = { type: 'com.rezics.test.anonymous-report.v1', data: {} };
const reportDetail = { operationId: 'report.create', 'x-action': action, security: [{}] };
const routes = new Elysia().post(
  '/reports',
  {
    detail: reportDetail,
  },
  () => {},
);
const permission = createAccess({
  actions: actionCatalogue(routes),
});
beforeAll(async () => {
  await admin.query(`CREATE TABLE public.anonymous_authority (
    route integer NOT NULL, id uuid NOT NULL, eligible boolean NOT NULL DEFAULT true,
    turnstile_required boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
    PRIMARY KEY(route,id))`);
  await admin.query(`CREATE TABLE public.anonymous_report (
    route integer NOT NULL, id uuid NOT NULL, secret text NOT NULL, PRIMARY KEY(route,id))`);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function fixture() {
  const resource = { route: 0x1234, id: newId(0x1234) };
  await admin.query('INSERT INTO public.anonymous_authority(route,id) VALUES ($1,$2)', [resource.route, resource.id]);
  const phases: string[] = [];
  const times: CommandAttempt['time'][] = [];
  let turnstile: { verified: boolean } | null = { verified: true };
  const token = createResourceAnonymousEligibility({
    resource,
    action,
    async prepare({ pool, resource }) {
      phases.push('eligibility.prepare');
      // Bounded owning-route evidence, acquired before any authority checkout.
      const row = (
        await pool.query('SELECT revision FROM public.anonymous_authority WHERE route=$1 AND id=$2', [
          resource.route,
          resource.id,
        ])
      ).rows[0];
      return row && turnstile ? { revision: row.revision, turnstile } : null;
    },
    async verify({ client, at, evidence }) {
      phases.push('eligibility.verify');
      expect(at).toBe(authoritativeTimeValue(times.at(-1)!));
      const row = (
        await client.query(
          `SELECT eligible,turnstile_required,revision
        FROM public.anonymous_authority WHERE route=$1 AND id=$2`,
          [resource.route, resource.id],
        )
      ).rows[0];
      return (
        !!row &&
        row.eligible &&
        row.revision === evidence.revision &&
        (!row.turnstile_required || evidence.turnstile.verified)
      );
    },
  });
  const access: Access = {
    ...permission,
    async prepare(...args) {
      phases.push('prepare');
      return permission.prepare!(...args);
    },
    async authorize(...args) {
      phases.push('formula');
      expect(statements.some((sql) => /^BEGIN ISOLATION LEVEL SERIALIZABLE/i.test(sql))).toBe(false);
      return permission.authorize(...args);
    },
  };
  const input: ResourceAuthorizationInput = {
    access,
    actor: { ...actor },
    action,
    anchor: {
      resource: { ...resource, eligibility: token },
      async validate(client, time) {
        phases.push('validate');
        times.push(time);
        return (
          (
            await client.query('SELECT 1 FROM public.anonymous_authority WHERE route=$1 AND id=$2', [
              resource.route,
              resource.id,
            ])
          ).rowCount === 1
        );
      },
    },
    context: { pool, partition: targetPartition, deadline: Date.now() + 5000 },
  };
  return {
    input,
    phases,
    times,
    resource,
    setTurnstile(value: typeof turnstile) {
      turnstile = value;
    },
  };
}
function execute(
  input: ResourceAuthorizationInput,
  options: {
    key?: string;
    digest?: Buffer;
    authorization?: CommandAuthorization;
    body?: Parameters<typeof runCommand>[2];
  } = {},
) {
  statements.length = 0;
  return runCommand(
    pool,
    {
      ...principalCommandIdentity(actor),
      partition: input.context.partition,
      deadline: input.context.deadline,
      authorization: options.authorization ?? resourceAuthorization(input),
      receipt: {
        kind: 'test.anonymous.report',
        key: options.key ?? randomUUID(),
        digest: options.digest ?? Buffer.alloc(32),
      },
    },
    options.body ??
      (async (tx) => {
        const resource = { route: 0x9876, id: newId(0x9876) };
        expect(partitionOf(input.anchor.resource.route)).not.toBe(input.context.partition);
        await expect(creationCapability(tx, resource, ANONYMOUS_PRINCIPAL_ID)).rejects.toBeInstanceOf(GrantDeniedError);
        await tx.query('INSERT INTO public.anonymous_report VALUES ($1,$2,$3)', [
          resource.route,
          resource.id,
          'private-receipt',
        ]);
        return { value: { secret: 'private-receipt', id: resource.id }, events: [event] };
      }),
  );
}

test('same formula authorizes anonymous at independent T before target checkout; replay stays private after eligibility removal', async () => {
  const f = await fixture();
  const key = randomUUID().toUpperCase();
  const base = resourceAuthorization(f.input);
  const authorization: CommandAuthorization = {
    ...base,
    prepare(attempt) {
      expect(attempt.basis).toEqual({
        principal: { kind: 'anonymous', id: ANONYMOUS_PRINCIPAL_ID },
        actorAccountId: null,
        clientId: null,
        requestedBy: null,
      });
      return base.prepare!(attempt);
    },
  };
  const first = await execute(f.input, { key, authorization });
  expect(first.replayed).toBe(false);
  expect(f.phases).toEqual(['prepare', 'eligibility.prepare', 'validate', 'formula', 'eligibility.verify']);
  expect(statements.filter((sql) => sql.includes('AS allowed'))).toHaveLength(1);
  expect(await execute(f.input, { key: key.toLowerCase(), authorization })).toEqual({ ...first, replayed: true });
  await expect(execute(f.input, { key, authorization, digest: Buffer.alloc(32, 1) })).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  const before = (await admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [targetPartition]))
    .rows;
  await admin.query('UPDATE public.anonymous_authority SET eligible=false WHERE route=$1 AND id=$2', [
    f.resource.route,
    f.resource.id,
  ]);
  await expect(execute(f.input, { key, authorization })).rejects.toBeInstanceOf(GrantDeniedError);
  expect(statements.some((sql) => /FROM core.receipt/.test(sql))).toBe(false);
  expect(
    (await admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [targetPartition])).rows,
  ).toEqual(before);
  expect(
    (
      await admin.query('SELECT count(*)::int AS n FROM public.anonymous_report WHERE id=$1', [
        (first.value as { id: string }).id,
      ])
    ).rows,
  ).toEqual([{ n: 1 }]);
  expect(
    (await admin.query('SELECT count(*)::int AS n FROM core.receipt WHERE idempotency_key=$1', [key.toLowerCase()]))
      .rows,
  ).toEqual([{ n: 1 }]);
  expect(
    (
      await admin.query('SELECT * FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
        0x9876,
        (first.value as { id: string }).id,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await admin.query('SELECT * FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
        0x9876,
        (first.value as { id: string }).id,
      ])
    ).rows,
  ).toEqual([]);
  expect((await admin.query('SELECT count(*)::int AS n FROM public.anonymous_report')).rows).toEqual([{ n: 1 }]);
  expect(
    (
      await admin.query('SELECT count(*)::int AS n FROM core.outbox WHERE partition_no=$1 AND position=$2', [
        targetPartition,
        first.position.toString(),
      ])
    ).rows,
  ).toEqual([{ n: 1 }]);
  expect(statements.some((sql) => /FROM access.account|membership_inverse|principal_assignment/.test(sql))).toBe(false);
  expect(f.times).toHaveLength(4);
  for (const time of f.times) expect(() => authoritativeTimeValue(time)).toThrow();
});

test('missing, forged, substituted, unavailable and changed eligibility denies through installed Access', async () => {
  for (const attack of [
    'missing',
    'alias',
    'conflict',
    'boolean',
    'copy',
    'json',
    'action',
    'resource',
    'unknown',
    'catalogue',
    'false',
    'throw',
    'unavailable',
    'revision',
    'anchor',
    'anchor-throw',
    'turnstile',
    'missing-turnstile',
  ] as const) {
    const f = await fixture();
    let input = f.input;
    const resource = { ...input.anchor.resource };
    const token = resource.eligibility!;
    if (attack === 'missing' || attack === 'alias') delete resource.eligibility;
    if (attack === 'alias') resource.anonymousEligibility = token;
    if (attack === 'conflict') resource.anonymousEligibility = {} as ResourceEligibility;
    if (attack === 'boolean') resource.eligibility = true as unknown as ResourceEligibility;
    if (attack === 'copy') resource.eligibility = { ...token };
    if (attack === 'json') resource.eligibility = JSON.parse(JSON.stringify(token));
    if (['action', 'resource', 'false', 'throw', 'unavailable'].includes(attack))
      resource.eligibility = createResourceAnonymousEligibility({
        resource: attack === 'resource' ? { ...resource, id: newId(resource.route) } : resource,
        action: attack === 'action' ? 'report:read' : action,
        async prepare() {
          if (attack === 'unavailable') throw new Error('unavailable');
          return {};
        },
        async verify() {
          if (attack === 'throw') throw new Error('unavailable');
          return false;
        },
      });
    input = { ...input, anchor: { ...input.anchor, resource } };
    if (attack === 'unknown') input = { ...input, action: 'unknown:create' };
    if (attack === 'catalogue')
      input = {
        ...input,
        access: createAccess({ actions: new Map([[action, { anonymous: false }]]) }),
      };
    if (attack === 'anchor') input = { ...input, anchor: { ...input.anchor, validate: async () => false } };
    if (attack === 'anchor-throw')
      input = {
        ...input,
        anchor: {
          ...input.anchor,
          validate: async () => {
            throw new Error('unavailable');
          },
        },
      };
    if (attack === 'revision')
      input = {
        ...input,
        access: {
          ...input.access,
          async prepare(...args) {
            const evidence = await f.input.access.prepare!(...args);
            await admin.query('UPDATE public.anonymous_authority SET revision=revision+1 WHERE route=$1 AND id=$2', [
              resource.route,
              resource.id,
            ]);
            return evidence;
          },
        },
      };
    if (attack === 'turnstile') f.setTurnstile({ verified: false });
    if (attack === 'missing-turnstile') f.setTurnstile(null);
    await expect(execute(input)).rejects.toBeInstanceOf(GrantDeniedError);
    expect(statements.some((sql) => /FROM core.receipt|INSERT INTO public.anonymous_report/.test(sql))).toBe(false);
  }
});

test('malformed principal attribution and actor/account substitution cannot prepare anonymous proof', async () => {
  const f = await fixture();
  const base = resourceAuthorization(f.input);
  const valid = {
    principal: { kind: 'anonymous', id: ANONYMOUS_PRINCIPAL_ID },
    actorAccountId: null,
    clientId: null,
    requestedBy: null,
  };
  for (const basis of [
    null,
    { ...valid, principal: { kind: 'anonymous', id: newId(0x1234) } },
    { ...valid, principal: { kind: 'account', id: ANONYMOUS_PRINCIPAL_ID } },
    { ...valid, actorAccountId: ANONYMOUS_PRINCIPAL_ID },
    { ...valid, clientId: 'web' },
    { ...valid, requestedBy: 'borrowed' },
    { actorAccountId: newId(0x1234), clientId: 'web', requestedBy: null },
  ]) {
    await expect(
      execute(f.input, {
        authorization: {
          ...base,
          prepare(attempt) {
            return base.prepare!({ ...attempt, basis } as CommandAttempt);
          },
        },
      }),
    ).rejects.toBeInstanceOf(GrantDeniedError);
  }
  expect(f.phases).toEqual([]);
  const authorization = resourceAuthorization(f.input);
  Object.assign(f.input.actor, {
    kind: 'account',
    accountId: newId(0x1234),
    clientId: 'web',
    requestedBy: null,
    scopes: [action],
    authnEpoch: 1,
  });
  await expect(execute(f.input, { authorization })).rejects.toBeInstanceOf(GrantDeniedError);
});

test('opaque single-use attempt proofs reject borrowing, serialization, replay and substituted basis/time', async () => {
  for (const attack of [
    'borrow',
    'copy',
    'json',
    'boolean',
    'basis',
    'time',
    'partition',
    'expired',
    'reuse',
    'account',
    'retry',
  ] as const) {
    const f = await fixture();
    const base = resourceAuthorization(f.input);
    let saved: unknown;
    let attempts = 0;
    const authorization: CommandAuthorization = {
      ...base,
      async prepare(attempt) {
        attempts++;
        if (attack === 'retry' && attempts > 1) return saved;
        if (attack === 'borrow') return resourceAuthorization(f.input).prepare!(attempt);
        const proof = await base.prepare!(attempt);
        saved = proof;
        if (attack === 'copy') return { ...(proof as object) };
        if (attack === 'json') return JSON.parse(JSON.stringify(proof));
        if (attack === 'boolean') return true;
        if (attack === 'expired') await new Promise((resolve) => setTimeout(resolve, 1100));
        return proof;
      },
      async authorize(tx, attempt, proof) {
        if (attack === 'basis') attempt = { ...attempt, basis: { ...attempt.basis! } };
        if (attack === 'time') attempt = { ...attempt, time: JSON.parse(JSON.stringify(attempt.time)) };
        if (attack === 'partition') attempt = { ...attempt, partition: attempt.partition + 1 };
        if (attack === 'account')
          return resourceAuthorization({
            ...f.input,
            actor: {
              kind: 'account',
              accountId: newId(0x1234),
              clientId: 'web',
              requestedBy: null,
              scopes: [action],
              authnEpoch: 1,
            },
          }).authorize(tx, attempt, proof);
        if (attack === 'reuse') await base.authorize(tx, attempt, saved);
        return base.authorize(tx, attempt, proof);
      },
    };
    await expect(
      execute(f.input, {
        authorization,
        ...(attack === 'retry'
          ? {
              body: async () => {
                throw Object.assign(new Error('retry'), { code: '40001' });
              },
            }
          : {}),
      }),
    ).rejects.toBeInstanceOf(GrantDeniedError);
    if (attack === 'retry') expect(attempts).toBe(2);
  }
});

test('serialization retry prepares fresh T and bounded domain evidence; revocation denies the next attempt', async () => {
  for (const revoke of [false, true]) {
    const f = await fixture();
    let bodies = 0;
    const body: Parameters<typeof runCommand>[2] = async (tx) => {
      bodies++;
      if (bodies === 1) {
        if (revoke)
          await admin.query('UPDATE public.anonymous_authority SET eligible=false WHERE route=$1 AND id=$2', [
            f.resource.route,
            f.resource.id,
          ]);
        throw Object.assign(new Error('retry'), { code: '40001' });
      }
      await tx.query('INSERT INTO public.anonymous_report VALUES ($1,$2,$3)', [0x9876, newId(0x9876), 'retry']);
      return { value: 'once', events: [event] };
    };
    // The formula may run after an earlier rolled-back target checkout on a retry.
    const access = {
      ...permission,
      async prepare(...args: Parameters<NonNullable<Access['prepare']>>) {
        statements.length = 0;
        return f.input.access.prepare!(...args);
      },
    };
    const result = execute({ ...f.input, access }, { body });
    if (revoke) await expect(result).rejects.toBeInstanceOf(GrantDeniedError);
    else expect((await result).value).toBe('once');
    expect(bodies).toBe(revoke ? 1 : 2);
    expect(f.times).toHaveLength(2);
    expect(f.times[0]).not.toBe(f.times[1]);
    expect(f.phases.filter((phase) => phase === 'eligibility.prepare')).toHaveLength(2);
  }
});

test('protected platform actions remain unavailable anonymously with real domain eligibility', async () => {
  for (const action of ['source_fence:read', 'source_fence:takedown', 'media:import_from_url']) {
    const f = await fixture();
    const resource = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
    const access = createAccess({ actions: new Map([[action, { anonymous: false }]]) });
    await expect(
      execute({
        ...f.input,
        action,
        access,
        anchor: {
          validate: async () => true,
          resource: {
            ...resource,
            eligibility: createResourceAnonymousEligibility({
              resource,
              action,
              prepare: async () => ({}),
              verify: async () => true,
            }),
          },
        },
      }),
    ).rejects.toBeInstanceOf(GrantDeniedError);
  }
});

test('a genuine account proof cannot be substituted for an anonymous attempt', async () => {
  const f = await fixture();
  const accountFixture = await actorFixture(pool, admin);
  const account = await readAccount(admin, routeOf(accountFixture.actorId)!, accountFixture.actorId);
  await admin.query('INSERT INTO public.anonymous_authority(route,id) VALUES ($1,$2)', [
    accountFixture.resource.route,
    accountFixture.resource.id,
  ]);
  const authorization = resourceAuthorization({
    ...f.input,
    actor: accountFixture.delegated,
    action: 'subject:read',
    access: accountFixture.permissions({ accountEvidence: () => account }),
    anchor: {
      resource: accountFixture.resource,
      async validate(client, time) {
        authoritativeTimeValue(time);
        return (
          (
            await client.query('SELECT 1 FROM public.anonymous_authority WHERE route=$1 AND id=$2', [
              accountFixture.resource.route,
              accountFixture.resource.id,
            ])
          ).rowCount === 1
        );
      },
    },
  });
  let proof: unknown;
  await runCommand(
    pool,
    {
      ...principalCommandIdentity(accountFixture.delegated),
      partition: targetPartition,
      authorization: {
        ...authorization,
        async prepare(attempt) {
          proof = await authorization.prepare!(attempt);
          return proof;
        },
      },
    },
    async () => ({ value: 'account', events: [event] }),
  );
  const anonymous = resourceAuthorization(f.input);
  await expect(
    execute(f.input, { authorization: { ...anonymous, prepare: async () => proof } }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
});
