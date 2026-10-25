import { expect, expectTypeOf, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  MAX_CREATION_RESOURCES,
  createResourceCreationManifest,
  CreationManifestUnavailableError,
  parentCreationAuthorization,
  type ParentCreationContext,
  type ResourceCreationEntry,
  type ResourceCreationManifest,
  type ResourceCreationPort,
} from '../../src/access/index.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import type { CommandAuthorization } from '../../src/command/command.ts';
import type { Access, Resource } from '../../src/request/access.ts';

const creator = '019a1b2c-3d4e-7f00-8a00-987600000001';
function entry(index = 0, route = 0x1230): ResourceCreationEntry {
  return {
    resource: { route, id: `019a1b2c-3d4e-7f00-8a00-${route.toString(16)}${index.toString(16).padStart(8, '0')}` },
    type: index === 0 ? 'content.thread' : 'content.post',
    creator,
    creation: {
      async validate() {
        return true;
      },
    },
  };
}

function fixture() {
  const calls: string[] = [];
  const pool = new Proxy({} as Pool, {
    get(_target, key) {
      calls.push(`pool.${String(key)}`);
      throw new Error('The unavailable manifest must not access the pool');
    },
  });
  const access: Access = {
    async authenticate() {
      calls.push('authenticate');
      throw new Error('Unexpected authentication');
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
  const first = entry();
  const input: Parameters<typeof parentCreationAuthorization>[0] = {
    access,
    actor: { kind: 'account', accountId: creator, clientId: 'web', scopes: [], requestedBy: null, authnEpoch: 1 },
    action: 'thread:create',
    parent: {
      resource: { route: 0, id: '00000000-0000-8000-8000-000000000000' },
      async validate() {
        calls.push('parent.validate');
        return true;
      },
    },
    context: { pool, deadline: Date.now() + 60_000, resource: first.resource, creation: first.creation },
  };
  return { input, calls };
}

test('opaque creation manifest admits at most sixteen distinct same partition resources', () => {
  expect(MAX_CREATION_RESOURCES).toBe(16);
  expectTypeOf<ResourceCreationEntry>().toEqualTypeOf<
    Readonly<{
      resource: Readonly<Resource>;
      type: string;
      creator: string;
      creation: ResourceCreationPort;
    }>
  >();
  expectTypeOf<ParentCreationContext['manifest']>().toEqualTypeOf<ResourceCreationManifest | undefined>();
  expectTypeOf<typeof createResourceCreationManifest>().toEqualTypeOf<
    (entries: readonly ResourceCreationEntry[]) => ResourceCreationManifest
  >();
  for (let count = 1; count <= MAX_CREATION_RESOURCES; count++) {
    const manifest = createResourceCreationManifest(Array.from({ length: count }, (_, i) => entry(i, 0x1230 + i)));
    expect(Object.isFrozen(manifest)).toBe(true);
  }
  expect(() => createResourceCreationManifest([])).toThrow();
  // Reject the size before inspecting any entry, including an unbounded tail.
  const oversized = new Proxy(
    Array.from({ length: 17 }, (_, i) => entry(i)),
    {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) throw new Error('Inspected an oversized manifest');
        return Reflect.get(target, key, receiver);
      },
    },
  );
  expect(() => createResourceCreationManifest(oversized)).toThrow(TypeError);
  expect(() => createResourceCreationManifest([entry(), entry(1, 0x1240)])).toThrow();
  for (const duplicate of [entry(), { ...entry(), type: 'content.post', creator: entry(2).resource.id }]) {
    expect(() => createResourceCreationManifest([entry(), duplicate])).toThrow();
  }
});

test('manifest rejects malformed identities, types, creators and missing creation validators without callbacks', () => {
  let calls = 0;
  const valid = {
    ...entry(),
    creation: {
      async validate() {
        calls++;
        return true;
      },
    },
  };
  const invalid: unknown[] = [
    null,
    {},
    { ...valid, resource: null },
    ...[-1, 65536, 1.5, NaN, '4656'].map((route) => ({ ...valid, resource: { ...valid.resource, route } })),
    ...['', valid.resource.id.toUpperCase(), creator, 'not-a-uuid'].map((id) => ({
      ...valid,
      resource: { ...valid.resource, id },
    })),
    ...['', ' ', null, 1].map((type) => ({ ...valid, type })),
    ...['', creator.toUpperCase(), 'not-a-uuid', null, 1].map((creator) => ({ ...valid, creator })),
    ...[null, {}, { validate: true }].map((creation) => ({ ...valid, creation })),
  ];
  for (const value of invalid) expect(() => createResourceCreationManifest([value as ResourceCreationEntry])).toThrow();
  for (const value of [null, {}, { length: 1, 0: valid }]) {
    expect(() => createResourceCreationManifest(value as unknown as ResourceCreationEntry[])).toThrow();
  }
  createResourceCreationManifest([valid]);
  expect(calls).toBe(0);
});

test('manifest cannot be forged or mutated and exposes no serialized capability', () => {
  // @ts-expect-error structural objects cannot manufacture a manifest
  const _forged: ResourceCreationManifest = {};
  const mutable = { ...entry(), resource: { ...entry().resource }, creation: { ...entry().creation } };
  const entries = [mutable];
  const manifest = createResourceCreationManifest(entries);
  expect(Object.isFrozen(mutable)).toBe(false);
  expect(Object.isFrozen(mutable.resource)).toBe(false);
  expect(Object.isFrozen(mutable.creation)).toBe(false);
  mutable.resource.id = entry(9).resource.id;
  mutable.type = 'content.media';
  mutable.creator = entry(8).resource.id;
  mutable.creation.validate = async () => {
    throw new Error('Replaced validator must not run');
  };
  entries.length = 0;
  expect(Reflect.ownKeys(manifest)).toEqual([]);
  expect(JSON.stringify(manifest)).toBe('{}');
  expect(Reflect.set(manifest, 'entries', entries)).toBe(false);
  expect(() => Object.setPrototypeOf(manifest, { entries })).toThrow();
  const { input, calls } = fixture();
  for (const forged of [
    JSON.parse(JSON.stringify(manifest)),
    { ...manifest },
    Object.create(manifest),
    { entries: [entry()] },
  ]) {
    expect(() => parentCreationAuthorization({ ...input, context: { ...input.context, manifest: forged } })).toThrow();
  }
  expect(calls).toEqual([]);
});

test('unavailable multi resource implementation fails closed without new grants', () => {
  const { input, calls } = fixture();
  for (const count of [1, 2, 16]) {
    const manifest = createResourceCreationManifest(
      Array.from({ length: count }, (_, i) => ({
        ...entry(i),
        creation: {
          async validate() {
            calls.push('creation.validate');
            return true;
          },
        },
      })),
    );
    // No legacy target or port is read before the manifest guard, even if hostile.
    const context = { ...input.context, manifest };
    Object.defineProperty(context, 'resource', {
      get() {
        calls.push('resource');
        throw new Error('Legacy resource read');
      },
    });
    Object.defineProperty(context, 'creation', {
      get() {
        calls.push('creation');
        throw new Error('Legacy port read');
      },
    });
    for (const actor of [input.actor, { kind: 'anonymous' } as const]) {
      expect(() => parentCreationAuthorization({ ...input, actor, context })).toThrow(CreationManifestUnavailableError);
    }
  }
  expect(calls).toEqual([]);
});

test('legacy single resource still constructs authorization and rejects invalid creation ports', () => {
  const { input, calls } = fixture();
  const authorization: CommandAuthorization = parentCreationAuthorization(input);
  expect(authorization.action).toBe(input.action);
  expect(authorization.resource).toEqual(input.parent.resource);
  expect(Object.isFrozen(authorization.resource)).toBe(true);
  expect(authorization.prepare).toBeFunction();
  expect(authorization.authorize).toBeFunction();
  expect(() =>
    parentCreationAuthorization({
      ...input,
      context: { ...input.context, creation: {} as ResourceCreationPort },
    }),
  ).toThrow(GrantDeniedError);
  expect(calls).toEqual([]);
});
