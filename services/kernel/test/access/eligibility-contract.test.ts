import { afterAll, expect, test } from 'bun:test';
import {
  createAccess,
  createResourceAnonymousEligibility,
  createResourcePublicEligibility,
  type ResourceEligibility,
  type ResourceEligibilityOptions,
} from '../../src/access/index.ts';
import { evaluateResourceEligibility, ResourceEligibilityUnavailableError } from '../../src/access/eligibility.ts';
import { createPool } from '../../src/database/pool.ts';
import { accessCheck, type AccessClient, type Actor, type Resource } from '../../src/request/access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());
const resource: Resource = { route: 0x1234, id: '019a1b2c-3d4e-7f00-8a00-123400000001' };
const actor: Actor = { kind: 'anonymous' };
const action = 'report:create';
let calls = 0;
const options: ResourceEligibilityOptions<{ ready: boolean }> = {
  resource,
  action,
  async prepare(context) {
    calls++;
    const _actor: Actor = context.actor;
    const _pool: typeof pool = context.pool;
    // @ts-expect-error preparation context is readonly
    context.deadline = 0;
    // @ts-expect-error resource identity is readonly
    context.resource.id = '';
    // @ts-expect-error captured identity cannot carry another eligibility
    context.resource.eligibility;
    return { ready: true };
  },
  async verify(context) {
    calls++;
    const _client: AccessClient = context.client;
    const _at: string = context.at;
    // @ts-expect-error verification cannot use a separate pool
    context.pool;
    // @ts-expect-error verification context is readonly
    context.action = '';
    return context.evidence.ready;
  },
};

test('public and anonymous eligibility share one opaque server capability contract', () => {
  const publicFactory: typeof createResourceAnonymousEligibility = createResourcePublicEligibility;
  const capabilities: ResourceEligibility[] = [publicFactory(options), createResourceAnonymousEligibility(options)];
  // @ts-expect-error structural input cannot manufacture server authority
  const _forged: ResourceEligibility = {};
  for (const eligibility of capabilities) {
    const _target: Resource = { ...resource, eligibility };
    expect(Object.isFrozen(eligibility)).toBe(true);
    expect(JSON.stringify(eligibility)).toBe('{}');
  }
});

test('creating eligibility does not execute domain callbacks', () => {
  for (const factory of [createResourcePublicEligibility, createResourceAnonymousEligibility]) factory(options);
  expect(calls).toBe(0);
});

test('unimplemented eligibility evaluation fails closed', async () => {
  for (const factory of [createResourcePublicEligibility, createResourceAnonymousEligibility]) {
    await expect(evaluateResourceEligibility(factory(options))).rejects.toBeInstanceOf(
      ResourceEligibilityUnavailableError,
    );
  }
  expect(calls).toBe(0);
});

test('forged anonymous eligibility cannot grant permission through installed Access', async () => {
  const access = createAccess({ actions: new Map([[action, { anonymous: true }]]) });
  const context = () => ({ pool, deadline: Date.now() + 5_000 });
  const wrongResource = { ...resource, id: '019a1b2c-3d4e-7f00-8a00-123400000002' };
  const forged = JSON.parse(JSON.stringify({ resource, action, verified: true })) as ResourceEligibility;
  const genuine = createResourceAnonymousEligibility(options);
  const capabilities = [
    forged,
    JSON.parse(JSON.stringify(genuine)) as ResourceEligibility,
    { ...genuine },
    createResourcePublicEligibility(options),
    createResourceAnonymousEligibility(options),
    createResourceAnonymousEligibility({ ...options, action: 'report:read' }),
    createResourceAnonymousEligibility({ ...options, resource: wrongResource }),
  ];
  expect(await (await accessCheck(access, actor, action, resource, context()))(pool)).toBe(true);
  for (const eligibility of capabilities) {
    const target = { ...resource, eligibility };
    expect(await (await accessCheck(access, actor, action, target, context()))(pool)).toBe(false);
    // Adding a capability after preparation must not bypass the installed guard.
    const evidence = await access.prepare!(actor, action, resource, context());
    expect(await access.authorize(pool, actor, action, target, evidence)).toBe(false);
  }
  expect(calls).toBe(0);
});
