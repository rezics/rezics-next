import { expect, expectTypeOf, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  resourceAuthorization,
  ResourceAuthorizationUnavailableError,
  type AuthorizationAnchor,
  type ResourceAuthorizationContext,
  type ResourceAuthorizationInput,
} from '../../src/access/resource-authorization.ts';
import type * as accessExports from '../../src/access/index.ts';
import type { ParentCreationContext, ResourceCreationPort } from '../../src/access/parent-creation.ts';
import type { AuthoritativeTime, CommandAuthorization } from '../../src/command/command.ts';
import type { Access, AccessClient, AccessContext, Actor, Resource } from '../../src/request/access.ts';

function fixture() {
  const calls: string[] = [];
  const pool = new Proxy({} as Pool, {
    get(_target, key) {
      calls.push(`pool.${String(key)}`);
      throw new Error('The unavailable contract must not access the pool');
    },
  });
  const access: Access = {
    async authenticate() {
      calls.push('authenticate');
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
  const anchor: AuthorizationAnchor = {
    resource: { route: 0, id: '00000000-0000-8000-8000-000000000000' },
    async validate() {
      calls.push('validate');
      return true;
    },
  };
  const input: ResourceAuthorizationInput = {
    access,
    actor: { kind: 'anonymous' },
    action: 'subject:batch_write',
    anchor,
    context: { pool, deadline: Date.now() + 60_000, partition: 0x123 },
  };
  return { input, calls };
}

test('action-general authorization contract accepts a stable target partition without unique creation proof', () => {
  expectTypeOf<AuthorizationAnchor>().toEqualTypeOf<
    Readonly<{
      resource: Readonly<Resource>;
      validate(client: AccessClient, time: AuthoritativeTime): Promise<boolean>;
    }>
  >();
  expectTypeOf<ResourceAuthorizationContext>().toEqualTypeOf<AccessContext & { partition: number }>();
  expectTypeOf<ResourceAuthorizationInput>().toEqualTypeOf<{
    access: Access;
    actor: Actor;
    action: string;
    anchor: AuthorizationAnchor;
    context: ResourceAuthorizationContext;
  }>();
  expectTypeOf<typeof resourceAuthorization>().toEqualTypeOf<
    (input: ResourceAuthorizationInput) => CommandAuthorization
  >();
  expectTypeOf<accessExports.AuthorizationAnchor>().toEqualTypeOf<AuthorizationAnchor>();
  expectTypeOf<accessExports.ResourceAuthorizationContext>().toEqualTypeOf<ResourceAuthorizationContext>();
  expectTypeOf<accessExports.ResourceAuthorizationInput>().toEqualTypeOf<ResourceAuthorizationInput>();
  expectTypeOf<typeof accessExports.resourceAuthorization>().toEqualTypeOf<typeof resourceAuthorization>();
  expectTypeOf<typeof accessExports.ResourceAuthorizationUnavailableError>().toEqualTypeOf<
    typeof ResourceAuthorizationUnavailableError
  >();

  const { input, calls } = fixture();
  // The stable tuple/upsert target has no new resource UUID or creation port.
  expect(input.context.partition).not.toBe(input.anchor.resource.route >>> 4);
  expect(() => resourceAuthorization(input)).toThrow(ResourceAuthorizationUnavailableError);
  expect(calls).toEqual([]);
});

test('unavailable stub throws before I/O', () => {
  const { input, calls } = fixture();
  for (const action of [
    'subject:create',
    'subject:batch_write',
    'media:importFromUrl',
    'source_fence:read',
    'takedown',
  ]) {
    for (const actor of [
      input.actor,
      {
        kind: 'account',
        accountId: '00000000-0000-8000-8000-123400000001',
        clientId: 'web',
        scopes: ['*'],
        requestedBy: null,
        authnEpoch: 1,
      } satisfies Actor,
    ]) {
      expect(() => resourceAuthorization({ ...input, action, actor })).toThrow(ResourceAuthorizationUnavailableError);
    }
  }
  // Even inspecting input would run caller code; unavailability is unconditional.
  const unreadable = new Proxy(input, {
    get(_target, key) {
      calls.push(`input.${String(key)}`);
      throw new Error('Input must not be inspected');
    },
  });
  expect(() => resourceAuthorization(unreadable)).toThrow(ResourceAuthorizationUnavailableError);
  expect(calls).toEqual([]);
  const error = new ResourceAuthorizationUnavailableError();
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('ResourceAuthorizationUnavailableError');
});

test('creation capability is not minted by generic authorization', () => {
  expectTypeOf<Extract<'creation' | 'resource', keyof ResourceAuthorizationContext>>().toEqualTypeOf<never>();
  expectTypeOf<ParentCreationContext['creation']>().toEqualTypeOf<ResourceCreationPort>();
  expectTypeOf<{}>().not.toExtend<Pick<ParentCreationContext, 'creation'>>();
  const { input, calls } = fixture();
  let initialized = false;
  const create = () => {
    const authorization = resourceAuthorization({ ...input, action: 'subject:create' });
    // Unavailability must stop consumers before any command or initialization.
    initialized = true;
    return authorization;
  };
  expect(create).toThrow(ResourceAuthorizationUnavailableError);
  expect(initialized).toBe(false);
  expect(calls).toEqual([]);
  expectTypeOf<Extract<'creationCapability', keyof typeof accessExports>>().toEqualTypeOf<never>();
});
