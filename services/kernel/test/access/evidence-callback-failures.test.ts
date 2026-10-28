import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createResourcePublicEligibility } from '../../src/access/eligibility.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { creationCapability, parentCreationAuthorization } from '../../src/access/parent-creation.ts';
import { createResourceCreationManifest } from '../../src/access/creation-manifest.ts';
import { resourceAuthorization, resourceAuthorizationPage } from '../../src/access/resource-authorization.ts';
import { DurableInitiatorUnavailableError } from '../../src/access/durable-initiator.ts';
import { createWorkflowApprovals, WorkflowApprovalDeniedError } from '../../src/access/workflow-approvals.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { runCommand, type CommandAuthorization } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { ProblemError, problemResponse } from '../../src/http/problem.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { actorFixture, type ActorFixture } from './actor-side-fixture.ts';
import { createMembershipInverseCommands } from '../../src/access/membership-inverse.ts';
import { LifecycleDeniedError } from '../../src/access/lifecycle-20261025094010-command.ts';
import { ContentNotFoundError } from '../../src/content/reads.ts';
import { nativeModule } from './durable-initiator.test.ts';
import { installStandingParentGrant } from '../../src/access/standing-parent.ts';

const pool = createPool(process.env.DATABASE_URL!);
let f: ActorFixture;
let realm: ActorFixture;
let durable: Awaited<ReturnType<typeof nativeModule>>;
let operation: Awaited<ReturnType<typeof durable.fixture>>;
let account: Awaited<ReturnType<(typeof import('../../src/access/account-data.ts'))['readAccount']>>;
let requestDeadlineMs = 5000;
const context = () => ({ pool, deadline: Date.now() + requestDeadlineMs });
const actions = new Map([
  ['subject:read', { anonymous: false }],
  ['account:update', { anonymous: false }],
]);
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'evidence-test', alg: 'ES256' };
const auth = {
  issuer: 'https://evidence.test',
  audience: 'https://api.evidence.test',
  jwksUrl: 'https://evidence.test/jwks',
  fetch: async () => Response.json({ keys: [jwk] }),
};
let bearer: string;
const keys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(81)]]) };
const realmId = newId(0x789a);
const workflowInput = () => ({
  operationKey: crypto.randomUUID(),
  operation: {
    kind: 'rename' as const,
    accountId: f.actorId,
    handle: 'evidence',
    expectedHandle: null,
    authorization: 'bound-input',
  },
});
let workflow: ReturnType<typeof workflowInput>;
let approvalReference: string;
const permissions = () => f.permissions({ accountEvidence: () => account });

beforeAll(async () => {
  f = await actorFixture(pool);
  const { readAccount } = await import('../../src/access/account-data.ts');
  account = await readAccount(pool, 0x1234, f.actorId);
  await pool.query('CREATE TABLE public.callback_effect (id uuid PRIMARY KEY)');
  const now = Math.floor(Date.now() / 1000);
  bearer = await new SignJWT({
    client_id: 'first-party',
    scope: 'account:update',
    authn_epoch: 1,
    auth_time: now,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid })
    .setIssuer(auth.issuer)
    .setAudience(auth.audience)
    .setSubject(f.actorId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(signing.privateKey);
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'account:update','(,)',$3)`,
    [0x1234, f.actorId, f.actorId],
  );
  realm = await actorFixture(pool);
  await realm.admit(realmId, realm.actorId, 'realm');
  await realm.grant(realmId, 'member');
  workflow = workflowInput();
  const approvals = createWorkflowApprovals({
    pool,
    access: createAccess({ actions, auth }),
    actions,
    referenceKeys: keys,
  });
  approvalReference = (await approvals.approve(bearer, workflow, context())).reference;
  // Complete the first exact approval read before per-fault console spies begin;
  // Reylo's first-use SQL trace can otherwise arrive during a later fault case.
  await approvals.resolve(approvalReference, workflow.operation, { pool, deadline: Date.now() + 5000 });
  durable = await nativeModule();
  operation = await durable.fixture();
}, 60_000);
afterAll(async () => {
  await durable?.close();
  await pool.end();
});

// Intercept the real evidence SQL on its existing client, without replacing the
// callback or adding a checkout. Setup and unrelated reads still use PostgreSQL.
function intercept(base: Pool, failure: (sql: string, values: readonly unknown[]) => void): Pool {
  const seam = Object.create(base) as Pool;
  const query = (client: Pool | PoolClient) =>
    ((query: QueryConfig | string, values?: unknown[]) => {
      failure(
        typeof query === 'string' ? query : query.text,
        values ?? (typeof query === 'string' ? [] : (query.values ?? [])),
      );
      return typeof query === 'string' ? client.query(query, values) : client.query(query);
    }) as Pool['query'];
  seam.query = query(base);
  seam.connect = (async () => {
    const client = await base.connect();
    const bounded = Object.create(client) as PoolClient;
    bounded.query = query(client) as PoolClient['query'];
    bounded.release = client.release.bind(client);
    return bounded;
  }) as Pool['connect'];
  return seam;
}

async function effects(client: Pool = pool) {
  return (
    await client.query(`SELECT
    (SELECT count(*)::int FROM core.receipt) AS receipts,
    (SELECT count(*)::int FROM core.outbox) AS events`)
  ).rows[0];
}

async function execute(authorization: CommandAuthorization, child?: string, type?: string) {
  const deadline = context().deadline;
  return runCommand(
    pool,
    {
      partition: partitionOf(f.resource.route),
      deadline,
      basis: { actorAccountId: f.actorId, clientId: f.actor.clientId, requestedBy: null },
      authorization,
      receipt: { actorAccountId: f.actorId, kind: 'callback.test', key: crypto.randomUUID(), digest: Buffer.alloc(32) },
    },
    async (tx) => {
      await tx.query('INSERT INTO public.callback_effect VALUES ($1)', [child ?? newId(f.resource.route)]);
      if (child) {
        const capability = await creationCapability(tx, { route: f.resource.route, id: child }, f.actorId, type);
        capability.complete();
      }
      return { value: true, events: [{ type: 'com.rezics.test.callback.v1', data: {} }] };
    },
  );
}

type Fail = () => Promise<never>;
const sites: Record<string, (fail: Fail) => Promise<unknown>> = {
  async 'eligibility prepare'(fail) {
    const eligibility = createResourcePublicEligibility({
      resource: f.resource,
      action: 'subject:read',
      prepare: fail,
      verify: async () => true,
    });
    return f.run(f.actor, permissions(), { ...f.resource, eligibility });
  },
  async 'eligibility verify'(fail) {
    const eligibility = createResourcePublicEligibility({
      resource: f.resource,
      action: 'subject:read',
      prepare: async () => ({}),
      verify: fail,
    });
    return f.run(f.actor, permissions(), { ...f.resource, eligibility });
  },
  async 'resource anchor validate'(fail) {
    await execute(
      resourceAuthorization({
        access: permissions(),
        actor: f.actor,
        action: 'subject:read',
        anchor: { resource: f.resource, validate: fail },
        context: { ...context(), partition: partitionOf(f.resource.route) },
      }),
    );
  },
  async 'page anchor validate'(fail) {
    await execute(
      resourceAuthorizationPage({
        access: permissions(),
        actor: f.actor,
        action: 'subject:read',
        anchor: { route: f.resource.route, ids: [f.resource.id], resourceType: 'fixture.owned', validate: fail },
        context: { ...context(), partition: partitionOf(f.resource.route) },
      }),
    );
  },
  async 'parent anchor validate'(fail) {
    const child = newId(f.resource.route);
    await execute(
      parentCreationAuthorization({
        access: permissions(),
        actor: f.actor,
        action: 'subject:read',
        parent: { resource: f.resource, validate: fail },
        context: {
          ...context(),
          resource: { route: f.resource.route, id: child },
          creation: { validate: async () => true },
        },
      }),
      child,
    );
  },
  async 'creation validate'(fail) {
    const child = newId(f.resource.route);
    await execute(
      parentCreationAuthorization({
        access: permissions(),
        actor: f.actor,
        action: 'subject:read',
        parent: { resource: f.resource, validate: async () => true },
        context: { ...context(), resource: { route: f.resource.route, id: child }, creation: { validate: fail } },
      }),
      child,
    );
  },
  async 'manifest creation validate'(fail) {
    const child = newId(f.resource.route);
    const resource = { route: f.resource.route, id: child };
    const manifest = createResourceCreationManifest([
      { resource, creator: f.actorId, type: 'fixture.owned', creation: { validate: fail } },
    ]);
    await execute(
      parentCreationAuthorization({
        access: f.permissions({
          accountEvidence: () => account,
          actions: new Map([['subject:read', { anonymous: false, 'x-resource-types': ['fixture.owned'] }]]),
        }),
        actor: f.actor,
        action: 'subject:read',
        parent: { resource: f.resource, validate: async () => true },
        context: { ...context(), resource, creation: { validate: async () => true }, manifest },
      }),
      child,
      'fixture.owned',
    );
  },
  async 'durable operation reader'(fail) {
    await durable.step(operation, { reader: fail });
  },
  async 'durable anchor validate'(fail) {
    await durable.step({ ...operation, anchor: { ...operation.anchor, validate: fail } });
  },
  async 'workflow resolve anchor validate'(fail) {
    let prepared = false;
    const seam = intercept(pool, (sql, values) => {
      if (sql.includes('AS "databaseAt"')) prepared = true;
      if (prepared && sql.includes('FROM access.account') && values.includes(f.actorId)) {
        // The native callback performs this exact target account read.
        throw failure;
      }
    });
    let failure: unknown;
    try {
      await fail();
    } catch (error) {
      failure = error;
    }
    const access = createAccess({ actions, auth });
    const approvals = createWorkflowApprovals({ pool: seam, access, actions, referenceKeys: keys });
    await approvals.resolve(approvalReference, workflow.operation, { pool: seam, deadline: Date.now() + 5000 });
  },
  async 'realm role reader'(fail) {
    return realm.run(realm.actor, realm.permissions({ realmRoleReader: fail }));
  },
  async 'realm terminal evidence'(fail) {
    await createMembershipInverseCommands({ pool, realmAuthority: { readTerminal: fail, readChange: fail } }).release({
      accountId: f.actorId,
      principal: { kind: 'realm', id: realmId },
      reservationId: newId(0x789a),
      key: crypto.randomUUID(),
    });
  },
  async 'realm change evidence'(fail) {
    await createMembershipInverseCommands({
      pool,
      realmAuthority: { readTerminal: fail, readChange: fail },
    }).bootstrapStep({
      accountId: f.actorId,
      principal: { kind: 'realm', id: realmId },
      sourceTransactionId: newId(0x789a),
      key: crypto.randomUUID(),
    });
  },
  async 'standing parent validate'(fail) {
    await installStandingParentGrant({
      access: permissions(),
      parent: { resource: f.resource, validate: fail },
      authority: {
        action: 'subject:read',
        resource: f.resource,
        denied: () => new GrantDeniedError(),
        authorize: async () => 'execute',
      },
      context: { ...context(), actor: f.actor },
      actions: ['subject:read'],
    });
  },
};

const faults = [
  ['existing unavailability', () => new AccessUnavailableError('overloaded'), 'overloaded'],
  ['pool timeout', () => new Error('timeout exceeded when trying to connect'), 'overloaded'],
  ['query timeout', () => new Error('Query read timeout'), 'deadline'],
  ...['08006', '53300', '57P01', '57P02', '57P03', '57014', '40001', '40P01', '55P03'].map(
    (code) =>
      [
        code,
        () => Object.assign(new Error(`private ${code}`), { code }),
        code === '57014' ? 'deadline' : ['40001', '40P01', '55P03'].includes(code) ? 'contention' : 'overloaded',
      ] as const,
  ),
  ['module denial', () => new ProblemError('not_found'), null],
  ['content denial', () => new ContentNotFoundError(), null],
  ['unexpected error', () => new TypeError('private callback bug'), null],
  ['unclassified SQLSTATE', () => Object.assign(new Error('private schema failure'), { code: '42P01' }), null],
  ['non-error', () => ({ private: 'callback failure' }), null],
] as const;

for (const [site, invoke] of Object.entries(sites)) {
  for (const [name, error, reason] of faults) {
    test(`${site}: ${name} closes the request without effects`, async () => {
      requestDeadlineMs = reason === 'contention' ? 35 : 5000;
      const cause = error();
      let calls = 0;
      const before = await effects(site.startsWith('durable') ? durable.db.pool : pool);
      const rows = (await pool.query('SELECT * FROM public.callback_effect')).rows;
      const logged: unknown[] = [];
      const log = spyOn(console, 'error').mockImplementation((error) => {
        logged.push(error);
      });
      let caught: unknown;
      let result: unknown;
      try {
        result = await invoke(async () => {
          calls++;
          throw cause;
        });
      } catch (error) {
        caught = error;
      } finally {
        log.mockRestore();
        requestDeadlineMs = 5000;
      }
      expect(calls).toBeGreaterThan(0);
      if (reason) {
        expect(caught).toBeInstanceOf(AccessUnavailableError);
        expect((caught as AccessUnavailableError).reason).toBe(reason);
        if (cause instanceof AccessUnavailableError) expect(caught).toBe(cause);
        expect(problemResponse(caught, { method: 'POST', id: 'evidence-test' }).status).toBe(503);
        expect(logged).toHaveLength(0);
      } else if (name === 'module denial' || name === 'content denial') {
        expect(caught).toBe(cause);
        expect(logged).toHaveLength(0);
      } else if (site.startsWith('eligibility') || site === 'realm role reader') {
        expect(caught).toBeUndefined();
        expect(result).toBe(false);
        expect(logged).toHaveLength(1);
        expect((logged[0] as Error).cause).toBe(cause);
      } else {
        expect(caught).toBeInstanceOf(
          site.startsWith('durable')
            ? DurableInitiatorUnavailableError
            : site.startsWith('workflow')
              ? WorkflowApprovalDeniedError
              : site.startsWith('realm terminal') || site.startsWith('realm change')
                ? LifecycleDeniedError
                : GrantDeniedError,
        );
        expect(logged).toHaveLength(1);
        expect((logged[0] as Error).cause).toBe(cause);
      }
      expect(await effects(site.startsWith('durable') ? durable.db.pool : pool)).toEqual(before);
      expect((await pool.query('SELECT * FROM public.callback_effect')).rows).toEqual(rows);
    });
  }
}

test('real board HTTP read classifies resource evidence failures and hides their causes', async () => {
  const boardId = newId(0x6789);
  await pool.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Evidence board','published',1,$4)`,
    [0x6789, boardId, newId(0x6789), newId(0x6789)],
  );
  let reads = 0;
  let cause: unknown;
  const seam = intercept(pool, (sql) => {
    if (sql.includes('JOIN content.board b') && ++reads === 3) throw cause;
  });
  const app = createKernel({ pool: seam, routeKey: new Uint8Array(32).fill(80), tokens: keys });
  for (const [, makeError, reason] of faults) {
    reads = 0;
    cause = makeError();
    const before = await effects();
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await app.handle(new Request(`http://kernel.test/v1/boards/${boardId}`));
      expect(reads).toBe(3);
      expect(response.status).toBe(reason ? 503 : 404);
      const body = await response.json();
      expect(body).toMatchObject({ retryable: !!reason, effect_status: 'not_applicable' });
      expect(JSON.stringify(body)).not.toContain('private');
      expect(await effects()).toEqual(before);
    } finally {
      log.mockRestore();
      cause = undefined;
    }
  }
});
