import { afterAll, expect, expectTypeOf, test } from 'bun:test';
import {
  createAccess,
  createResourceAnonymousEligibility,
  resourceAuthorization,
  type AnonymousResourceAuthorizationInput,
  type ResourceAuthorizationInput,
  type ResourceEligibility,
} from '../../src/access/index.ts';
import type * as authorizationExports from '../../src/access/resource-authorization.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  ANONYMOUS_PRINCIPAL_ID,
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
} from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import type { Access, Actor, Resource } from '../../src/request/access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
afterAll(() => pool.end());
const actor: Extract<Actor, { kind: 'anonymous' }> = { kind: 'anonymous' };
const resource: Resource = { route: 0x1234, id: '019a1b2c-3d4e-7f00-8a00-123400000001' };
const action = 'report:create';
const calls: string[] = [];
const access: Access = {
  async authenticate() {
    throw new Error('Authentication must not run');
  },
  async prepare() {
    calls.push('prepare');
    return {};
  },
  async authorize() {
    calls.push('authorize');
    return true;
  },
};
function eligibility(target = resource, verb = action) {
  return createResourceAnonymousEligibility({
    resource: target,
    action: verb,
    async prepare() {
      calls.push('eligibility.prepare');
      return {};
    },
    async verify() {
      calls.push('eligibility.verify');
      return true;
    },
  });
}
function input(): AnonymousResourceAuthorizationInput {
  return {
    access,
    actor,
    action,
    anchor: {
      resource: { ...resource, eligibility: eligibility() },
      async validate() {
        calls.push('validate');
        return true;
      },
    },
    context: { pool, partition: 0x987, deadline: Date.now() + 5000 },
  };
}

test('same authorization accepts the typed anonymous contract and preserves account and Actor union callers', () => {
  expectTypeOf<AnonymousResourceAuthorizationInput>().toEqualTypeOf<authorizationExports.AnonymousResourceAuthorizationInput>();
  expectTypeOf<AnonymousResourceAuthorizationInput['actor']>().toEqualTypeOf<Extract<Actor, { kind: 'anonymous' }>>();
  expectTypeOf<
    AnonymousResourceAuthorizationInput['anchor']['resource']['eligibility']
  >().toEqualTypeOf<ResourceEligibility>();
  expectTypeOf<typeof resourceAuthorization>().toExtend<(value: ResourceAuthorizationInput) => CommandAuthorization>();
  const anonymous = input();
  const account: Extract<Actor, { kind: 'account' }> = {
    kind: 'account',
    accountId: resource.id,
    clientId: 'web',
    requestedBy: null,
    scopes: [],
    authnEpoch: 1,
  };
  const general = (actor: Actor): CommandAuthorization => resourceAuthorization({ ...anonymous, actor });
  const existing: ResourceAuthorizationInput = {
    ...anonymous,
    actor: account,
    anchor: { ...anonymous.anchor, resource },
  };
  expectTypeOf(resourceAuthorization(anonymous)).toEqualTypeOf<CommandAuthorization>();
  expect(resourceAuthorization(existing).action).toBe(action);
  expect(general(account).action).toBe(action);
  expect(general(actor).action).toBe(action);
  expect(calls).toEqual([]);
});

test('anonymous contract requires opaque eligibility and rejects structural or decoded JSON authority', () => {
  type Target = AnonymousResourceAuthorizationInput['anchor']['resource'];
  expectTypeOf<Resource>().not.toExtend<Target>();
  expectTypeOf<{ route: number; id: string; eligibility: { verified: true } }>().not.toExtend<Target>();
  const json: unknown = JSON.parse(JSON.stringify(input().anchor.resource.eligibility));
  // @ts-expect-error decoded JSON cannot manufacture server authority
  const _json: ResourceEligibility = json;
  // @ts-expect-error a structural object cannot manufacture server authority
  const _structural: ResourceEligibility = { verified: true };
  // @ts-expect-error eligibility is required on the anonymous anchor
  const _missing: Target = resource;
  expectTypeOf<Extract<'creationCapability', keyof CommandAuthorization>>().toEqualTypeOf<never>();
});

test('hostile anonymous command attempts deny before receipts, body or domain callbacks', async () => {
  const genuine = {
    ...input(),
    access: createAccess({ actions: new Map([[action, { anonymous: true }]]) }),
  };
  const token = genuine.anchor.resource.eligibility;
  const targets: Resource[] = [
    genuine.anchor.resource,
    resource,
    { ...resource, eligibility: {} as ResourceEligibility },
    { ...resource, eligibility: JSON.parse(JSON.stringify(token)) as ResourceEligibility },
    { ...resource, eligibility: eligibility(resource, 'report:read') },
    { ...resource, eligibility: eligibility({ ...resource, id: '019a1b2c-3d4e-7f00-8a00-123400000002' }) },
  ];
  let attempts = 0;
  let bodies = 0;
  for (const target of targets) {
    for (const selected of [action, 'unknown:create', 'private:create', 'takedown']) {
      if (target === genuine.anchor.resource && selected === action) continue;
      const authorization = resourceAuthorization({
        ...genuine,
        action: selected,
        anchor: { ...genuine.anchor, resource: target },
      });
      await expect(
        runCommand(
          pool,
          {
            ...principalCommandIdentity(actor),
            partition: genuine.context.partition,
            authorization: {
              ...authorization,
              async prepare(attempt) {
                attempts++;
                expect(authoritativeTimeValue(attempt.time)).toBeTruthy();
                expect(attempt.basis).toEqual({
                  principal: { kind: 'anonymous', id: ANONYMOUS_PRINCIPAL_ID },
                  actorAccountId: null,
                  clientId: null,
                  requestedBy: null,
                });
                return authorization.prepare!(attempt);
              },
            },
            receipt: { kind: 'report.create', key: 'EA6EB068-708D-4B11-A207-568C31303D60', digest: Buffer.alloc(32) },
          },
          async () => {
            bodies++;
            return { value: { accepted: true }, events: [{ type: 'com.rezics.test.report.v1', data: {} }] };
          },
        ),
      ).rejects.toBeInstanceOf(GrantDeniedError);
    }
  }
  expect(attempts).toBe(targets.length * 4 - 1);
  expect(bodies).toBe(0);
  expect(calls).toEqual([]);
  expect(
    (
      await pool.query(
        `SELECT position,
    (SELECT count(*)::int FROM core.receipt WHERE partition_no=$1) AS receipts,
    (SELECT count(*)::int FROM core.outbox WHERE partition_no=$1) AS events
    FROM core.partition WHERE partition_no=$1`,
        [genuine.context.partition],
      )
    ).rows,
  ).toEqual([{ position: '0', receipts: 0, events: 0 }]);
});

test('real anonymous command succeeds through the same installed formula with opaque eligibility', async () => {
  const genuine = input();
  const access = createAccess({ actions: new Map([[action, { anonymous: true }]]) });
  const result = await runCommand(
    pool,
    {
      ...principalCommandIdentity(actor),
      partition: genuine.context.partition,
      authorization: resourceAuthorization({ ...genuine, access }),
      receipt: { kind: 'report.create', key: 'EA6EB068-708D-4B11-A207-568C31303D60', digest: Buffer.alloc(32) },
    },
    async () => ({ value: { accepted: true }, events: [{ type: 'com.rezics.test.report.v1', data: {} }] }),
  );
  expect(result.value).toEqual({ accepted: true });
  expect(result.replayed).toBe(false);
  expect(calls).toEqual(['eligibility.prepare', 'validate', 'eligibility.verify']);
});
