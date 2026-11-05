import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { testKernel, type TestKernel } from '../support/test-kernel.ts';
import { createPersonas, type Persona } from '../support/personas.ts';
import { nativeFixture } from './native-account-bindings-fixture.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { createResourcePublicEligibility } from '../../src/access/eligibility.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import {
  accessExplicitCheck,
  prepareReadDecisions,
  type AccessClient,
  type ReadDecisionInput,
} from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { currentCommand, principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { recordResourceDenial } from '../../src/access/resource-denials.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
const context = () => ({ pool, deadline: Date.now() + 10000 });
const action = 'account:read';
const publicAction = 'account:read_public_identity';
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
let people: Awaited<ReturnType<typeof createPersonas>>;
let grants: ReturnType<typeof createGrantCommands>;
const resource = (person: { accountId: string }) => ({ route: routeOf(person.accountId)!, id: person.accountId });
async function caller(person: Persona) {
  const ctx = context();
  return { ...ctx, actor: await kernel.testAccess.authenticate(person.bearer, ctx) };
}
async function grant(to: string, role: '' | 'owner' = '') {
  const ctx = await caller(people.alice);
  for (const ownAction of ['account:update', action]) {
    const check = await accessExplicitCheck(kernel.testAccess, ctx.actor, ownAction, resource(people.alice), ctx);
    expect(await check(pool), `grantor holds ${ownAction} before granting to ${to}`).toEqual({
      allowed: true,
      explicit: true,
    });
  }
  return grants.create(ctx, {
    resource: resource(people.alice),
    subjectId: to,
    subjectRole: role,
    actions: [action],
    valid: '(,)',
    key: crypto.randomUUID(),
  });
}
async function snapshot<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    return await operation(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
function counted(client: AccessClient) {
  const statements: string[] = [];
  const query = client.query.bind(client);
  return {
    statements,
    client: {
      query: ((...args: Parameters<AccessClient['query']>) => {
        const first = args[0];
        statements.push(typeof first === 'string' ? first : (first as { text: string }).text);
        return (query as Function)(...args);
      }) as AccessClient['query'],
    },
  };
}
beforeAll(async () => {
  auth = await nativeFixture(pool);
  const service = auth.host.service;
  kernel = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'read-decisions-native-write-rate-secret' }),
  });
  people = await createPersonas(kernel, { version: 1, pool, auth });
  grants = createGrantCommands({ pool, access: kernel.testAccess, managementAction: 'account:update' });
  await grant(people.bob.accountId);
  await grant(people.organization.accountId, 'owner');
  await grant(people.delegated.accountId);
}, 360000);
afterAll(async () => {
  try {
    await auth?.close();
  } finally {
    await pool.end();
  }
});

test('ordinary, organization and delegated grants equal the single-resource explicit decisions across routes', async () => {
  const ids = [people.alice.accountId, people.bob.accountId, people.orgOwner.accountId];
  expect(new Set(ids.map((id) => partitionOf(routeOf(id)!))).size).toBeGreaterThan(1);
  for (const person of [people.alice, people.bob, people.orgOwner, people.delegated, people.software]) {
    const ctx = await caller(person);
    // Single-resource evidence is prepared outside the snapshot, like the batch.
    const singles = await Promise.all(
      ids.map((id) => accessExplicitCheck(kernel.testAccess, ctx.actor, action, { route: routeOf(id)!, id }, ctx)),
    );
    const prepared = await prepareReadDecisions(deriveAccess(kernel.testAccess, { authorize: async () => false }), {
      ...ctx,
      context: ctx,
      actions: new Set([action]),
    });
    await snapshot(async (client) => {
      const measured = counted(client);
      const result = await prepared.decide(measured.client, { action, resourceType: 'account', ids });
      expect(measured.statements).toHaveLength(1);
      expect(Object.isFrozen(result)).toBe(true);
      for (let i = 0; i < ids.length; i++) {
        expect(Object.isFrozen(result[ids[i]!])).toBe(true);
        expect(result[ids[i]!]).toEqual(await singles[i]!(client));
      }
      expect(result[people.alice.accountId]!.allowed).toBe(person !== people.software);
    });
  }
});

test('one preparation admits 64 actions, costs constant E, and serves repeated actions and batches', async () => {
  const ctx = await caller(people.orgOwner);
  const actions = new Set([...new Set([action, publicAction, ...actionCatalogue(kernel).keys()])].slice(0, 64));
  expect(actions.size).toBe(64);
  const measured = counted(pool);
  // Identity requires the original pool; count its query boundary in place.
  const original = pool.query;
  pool.query = measured.client.query as typeof pool.query;
  let handle;
  try {
    handle = await prepareReadDecisions(kernel.testAccess, { actor: ctx.actor, actions, context: ctx });
  } finally {
    pool.query = original;
  }
  expect(measured.statements).toHaveLength(3); // time, inverse, all organization anchors
  await snapshot(async (client) => {
    const checks = counted(client);
    for (const size of [1, 100, 200]) {
      const ids = [people.alice.accountId, ...Array.from({ length: size - 1 }, () => newId(0x6200))];
      for (const selected of [action, publicAction]) {
        const before = checks.statements.length;
        const result = await handle.decide(checks.client, { action: selected, resourceType: 'account', ids });
        expect(Object.keys(result)).toHaveLength(size);
        expect(checks.statements.length - before).toBe(1);
      }
    }
  });
  expect(measured.statements).toHaveLength(3);
});

test('owner public eligibility supplies the anonymous floor, including an unscoped token, at snapshot T', async () => {
  const narrow = await people.unscoped(action);
  await grant(narrow.accountId);
  for (const actor of [(await caller(narrow)).actor, { kind: 'anonymous' as const }]) {
    const ctx = context();
    const id = people.alice.accountId;
    for (const selected of [action, publicAction]) {
      const capability = createResourcePublicEligibility({
        resource: resource(people.alice),
        action: selected,
        prepare: async () => ({}),
        verify: async () => true,
      });
      const single = await accessExplicitCheck(
        kernel.testAccess,
        actor,
        selected,
        { ...resource(people.alice), eligibility: capability },
        ctx,
      );
      const handle = await prepareReadDecisions(kernel.testAccess, {
        actor,
        context: ctx,
        actions: new Set([selected]),
      });
      await snapshot(async (client) => {
        const measured = counted(client);
        const result = await handle.decide(measured.client, {
          action: selected,
          resourceType: 'account',
          ids: [id],
          async eligibility(reader, ids, at) {
            const rows = await reader.query('SELECT transaction_timestamp()::text AS at');
            expect(rows.rows[0].at).toBe(at);
            return Object.fromEntries(ids.map((id) => [id, true]));
          },
        });
        expect(measured.statements).toHaveLength(2);
        expect(result[id]).toEqual(await single(client));
        expect(result[id]).toEqual({ allowed: selected === publicAction, explicit: false });
      });
    }
  }
});

test('revocation after preparation is visible in the next snapshot without re-preparing', async () => {
  const ctx = await caller(people.bob);
  const handle = await prepareReadDecisions(kernel.testAccess, {
    actor: ctx.actor,
    context: ctx,
    actions: new Set([action]),
  });
  await grants.revoke(await caller(people.alice), {
    resource: resource(people.alice),
    subjectId: people.bob.accountId,
    subjectRole: '',
    actions: [action],
    valid: '(,)',
    key: crypto.randomUUID(),
  });
  await snapshot(async (client) => {
    const result = await handle.decide(client, { action, resourceType: 'account', ids: [people.alice.accountId] });
    expect(result[people.alice.accountId]).toEqual({ allowed: false, explicit: false });
  });
});

test('an explicit denial defeats the ordinary grant and equals the single-resource decision', async () => {
  const ctx = await caller(people.alice);
  const target = resource(people.alice);
  await runCommand(
    pool,
    {
      ...principalCommandIdentity(ctx.actor),
      partition: partitionOf(target.route),
      deadline: ctx.deadline,
      receipt: { kind: 'test.read-denial', key: crypto.randomUUID(), digest: Buffer.alloc(32) },
      authorization: resourceAuthorization({
        access: kernel.testAccess,
        actor: ctx.actor,
        action: 'account:update',
        anchor: { resource: target, validate: async () => true },
        context: { ...ctx, partition: partitionOf(target.route) },
      }),
    },
    async (tx) => {
      await recordResourceDenial(tx, {
        resource: target,
        subjectId: people.alice.accountId,
        subjectRole: '',
        action,
        reason: 'resource',
        at: currentCommand(tx).time,
      });
      return { value: null, events: [{ type: 'com.rezics.test.checked.v1', data: {} }] };
    },
  );
  const single = await accessExplicitCheck(kernel.testAccess, ctx.actor, action, target, ctx);
  const handle = await prepareReadDecisions(kernel.testAccess, {
    actor: ctx.actor,
    context: ctx,
    actions: new Set([action]),
  });
  await snapshot(async (client) => {
    const result = await handle.decide(client, { action, resourceType: 'account', ids: [target.id] });
    expect(result[target.id]).toEqual(await single(client));
    expect(result[target.id]).toEqual({ allowed: false, explicit: false });
  });
});

test('refusals precede every statement, deadline and failing dependencies return no partial result', async () => {
  const ctx = await caller(people.alice);
  const handle = await prepareReadDecisions(kernel.testAccess, {
    actor: ctx.actor,
    context: ctx,
    actions: new Set([action]),
  });
  const measured = counted(pool);
  const batch = { action, resourceType: 'account', ids: [people.alice.accountId] };
  for (const invalid of [
    { ...batch, action: publicAction },
    { ...batch, ids: [] },
    { ...batch, ids: Array.from({ length: 201 }, () => newId(0x6200)) },
    { ...batch, ids: [people.alice.accountId, people.alice.accountId] },
    { ...batch, ids: ['bad'] },
    { ...batch, ids: [people.alice.accountId, 42] },
    { ...batch, resourceType: ['account', 'post'] },
  ])
    await expect(handle.decide(measured.client, invalid as ReadDecisionInput)).rejects.toBeInstanceOf(RangeError);
  expect(measured.statements).toHaveLength(0);
  for (const actions of [
    new Set<string>(),
    new Set(['absent:action']),
    new Set([...actionCatalogue(kernel).keys()].slice(0, 65)),
  ])
    await expect(
      prepareReadDecisions(kernel.testAccess, { actor: ctx.actor, context: ctx, actions }),
    ).rejects.toBeInstanceOf(RangeError);
  await expect(
    handle.decide(
      {
        query: (() => {
          throw new Error('storage failed');
        }) as AccessClient['query'],
      },
      batch,
    ),
  ).rejects.toBeInstanceOf(AccessUnavailableError);
  await expect(
    snapshot((client) =>
      handle.decide(client, {
        ...batch,
        eligibility: async () => {
          throw new Error('owner unavailable');
        },
      }),
    ),
  ).rejects.toBeInstanceOf(AccessUnavailableError);
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now + 1100);
  try {
    await expect(handle.decide(measured.client, batch)).rejects.toBeInstanceOf(AccessUnavailableError);
  } finally {
    clock.mockRestore();
  }
  expect(measured.statements).toHaveLength(0);
  const failed = counted(pool);
  const original = pool.query;
  pool.query = (() => {
    throw new Error('preparation storage failed');
  }) as typeof pool.query;
  try {
    await expect(
      prepareReadDecisions(kernel.testAccess, { actor: ctx.actor, context: ctx, actions: new Set([action]) }),
    ).rejects.toBeInstanceOf(AccessUnavailableError);
  } finally {
    pool.query = original;
  }
  expect(failed.statements).toHaveLength(0);
});

test('governance read decisions write nothing and their handle authorizes no command', async () => {
  const ctx = await caller(people.staff);
  const before = await pool.query(
    'SELECT (SELECT count(*) FROM access.governance_reach)::text AS uses, (SELECT count(*) FROM core.receipt)::text AS receipts',
  );
  const handle = await prepareReadDecisions(kernel.testAccess, {
    actor: ctx.actor,
    context: ctx,
    actions: new Set(['access:grant']),
  });
  await snapshot(async (client) => {
    const measured = counted(client);
    const result = await handle.decide(measured.client, {
      action: 'access:grant',
      resourceType: 'account',
      ids: [people.bob.accountId],
    });
    expect(result[people.bob.accountId]).toEqual({ allowed: true, explicit: false });
    expect(measured.statements).toHaveLength(1);
    expect(measured.statements[0]).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(await kernel.testAccess.authorize(client, ctx.actor, 'access:grant', resource(people.bob), handle)).toBe(
      false,
    );
  });
  expect(Object.keys(handle)).toEqual(['decide']);
  expect(
    (
      await pool.query(
        'SELECT (SELECT count(*) FROM access.governance_reach)::text AS uses, (SELECT count(*) FROM core.receipt)::text AS receipts',
      )
    ).rows,
  ).toEqual(before.rows);
});

test('the native Realm adapter batches current and negative proofs across routes in one statement', async () => {
  const { createKernelAccessResolver } = await import('../../src/http/kernel.ts');
  const { testTokens } = await import('../support/test-kernel.ts');
  const { GLOBAL_CONTEXT } = await import('../../src/semantic/definitions.ts');
  const resolver = createKernelAccessResolver({
    pool,
    tokens: testTokens(),
    clock: () => new Date(),
    access: kernel.testAccess,
  });
  resolver.resolveAccess({ actions: actionCatalogue(kernel) });
  const reader = resolver.realmRoleReader;
  const at = '2026-10-01T00:00:00.000Z';
  const pairs = [];
  for (const route of [0x2130, 0xa140]) {
    const realmId = newId(route);
    const spaceId = newId(route);
    const spaceRevision = newId(route);
    const realmRevision = newId(route);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
        VALUES($1,$2,'active',$3,'2020-01-01',$4)`,
        [route, spaceId, spaceRevision, people.alice.accountId],
      );
      await client.query(
        `INSERT INTO community.space_revision(route,space_id,revision_id,predecessor,title,summary,created_at,author)
        VALUES($1,$2,$3,NULL,'Host','','2020-01-01',$4)`,
        [route, spaceId, spaceRevision, people.alice.accountId],
      );
      await client.query(
        `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
        VALUES($1,$2,$3,'active','protected',$4,$5,'2020-01-01',$6)`,
        [route, realmId, spaceId, GLOBAL_CONTEXT, realmRevision, people.alice.accountId],
      );
      await client.query(
        `INSERT INTO community.realm_revision(route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
        VALUES($1,$2,$3,NULL,'Realm','','protected',$4,'2020-01-01',$5)`,
        [route, realmId, realmRevision, GLOBAL_CONTEXT, people.alice.accountId],
      );
      await client.query(
        `INSERT INTO community.realm_member(route,realm_id,account_id,role,valid,reservation_id,transaction_id)
        VALUES($1,$2,$3,'member','[2020-01-01,)',$4,$5)`,
        [route, realmId, people.bob.accountId, newId(routeOf(people.bob.accountId)!), newId(route)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    pairs.push({ realmId, accountId: people.bob.accountId }, { realmId, accountId: people.alice.accountId });
  }
  const singles = await Promise.all(pairs.map((pair) => reader(pool, { ...pair, at })));
  await reader.batch!(pool, { pairs, at });
  const measured = counted(pool);
  const proofs = await reader.batch!(measured.client, { pairs, at });
  expect(measured.statements).toHaveLength(1);
  expect(proofs).toHaveLength(pairs.length * 2);
  for (const [index, pair] of pairs.entries()) {
    const single = singles[index];
    expect(
      proofs!
        .filter((proof) => proof.realmId === pair.realmId && proof.accountId === pair.accountId)
        .map(({ role, member, valid }) => ({ role, member, valid }))
        .sort((a, b) => a.role.localeCompare(b.role)),
    ).toEqual([...single!].sort((a, b) => a.role.localeCompare(b.role)));
  }
});
