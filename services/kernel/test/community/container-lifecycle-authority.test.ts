import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { bundledRelease } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { restoreContainer, type ContainerKind } from '../../src/community/container-lifecycle.ts';
import {
  createNativeContentSystemWithWriteRateOverrides,
  type NativeContentSystem,
} from '../content/support/native-system.ts';
import {
  HIGH_RATE_OVERRIDES,
  seedGovernanceAuthority,
  seedResourceDenial,
} from '../content/support/disclosure-fixtures.ts';
import type { ContentCredential } from '../content/support/system.ts';

let system: NativeContentSystem;
const owner = () => system.actors.other;
const peer = () => system.actors.author;
const platform = () => system.actors.moderator;
const current = new Date(Date.now() - 86_400_000).toISOString();
const identity = Type.Object({ id: Type.String(), head: Type.String() });
const lifecycle = Type.Object({
  container: Type.Object({
    kind: Type.Union([Type.Literal('space'), Type.Literal('realm')]),
    id: Type.String(),
    headRevisionId: Type.String(),
    version: Type.String(),
    mayRestore: Type.Boolean(),
  }),
});

function call(person: ContentCredential, method: string, path: string, body?: unknown, head?: string) {
  return system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${person.bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(head === undefined ? {} : { 'if-match': JSON.stringify(head) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function create(kind: ContainerKind) {
  const created = await call(owner(), 'POST', '/v1/spaces', { title: 'Native Space ownership' });
  expect(created.status).toBe(201);
  const { space } = Value.Parse(
    Type.Object({
      space: Type.Object({
        spaceId: Type.String(),
        headRevisionId: Type.String(),
      }),
    }),
    await created.json(),
  );
  if (kind === 'space') return Value.Parse(identity, { id: space.spaceId, head: space.headRevisionId });
  const createdRealm = await call(owner(), 'POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Native Realm ownership',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  expect(createdRealm.status).toBe(201);
  const { realm } = Value.Parse(
    Type.Object({
      realm: Type.Object({
        realmId: Type.String(),
        headRevisionId: Type.String(),
      }),
    }),
    await createdRealm.json(),
  );
  return Value.Parse(identity, { id: realm.realmId, head: realm.headRevisionId });
}
async function read(kind: ContainerKind, id: string) {
  const response = await call(owner(), 'GET', `/v1/${kind}s/${id}/lifecycle`);
  expect(response.status).toBe(200);
  return Value.Parse(lifecycle, await response.json()).container;
}
function change(
  person: ContentCredential,
  container: Awaited<ReturnType<typeof read>>,
  verb: 'removal' | 'restoration',
) {
  return call(
    person,
    'POST',
    `/v1/${container.kind}s/${container.id}/${verb}`,
    {
      expectedVersion: container.version,
      ...(verb === 'removal' ? { reason: 'Native owner removal' } : {}),
    },
    container.headRevisionId,
  );
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    HIGH_RATE_OVERRIDES,
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
  await system.clock.setCommandTime(current);
});
afterAll(async () => {
  await system?.close();
});

test('equal owners have no higher rank; an authorized remover still needs the exact current restore action and generation', async () => {
  for (const kind of ['space', 'realm'] as const) {
    const target = await create(kind);
    const route = routeOf(target.id)!;
    // Space owners do not intrinsically hold access:grant. Provision only the fixture's exact grant authority.
    await seedGovernanceAuthority(system.database.pool, route, target.id, owner().actor.accountId, ['access:grant']);
    const granted = await call(owner(), 'POST', '/v1/roleGrants', {
      resource: { route, id: target.id },
      subject: { kind: 'account', id: peer().actor.accountId },
      role: `community.${kind}.owner`,
      valid: '(,)',
    });
    expect(granted.status).toBe(201);
    expect((await change(owner(), await read(kind, target.id), 'removal')).status).toBe(200);
    const removed = await read(kind, target.id);
    expect((await change(peer(), removed, 'restoration')).status).toBe(403);
    const capped = await system.auth.issue({
      accountId: owner().actor.accountId,
      clientId: system.auth.ordinaryClient.id,
      scopes: system.auth.ordinaryScopes.filter((scope) => scope !== `${kind}:restore`),
    });
    expect((await change(capped, removed, 'restoration')).status).toBe(403);
    expect((await change(owner(), removed, 'restoration')).status).toBe(200);
    expect((await change(owner(), await read(kind, target.id), 'removal')).status).toBe(200);
    expect((await change(owner(), removed, 'restoration')).status).toBe(412);
    await seedResourceDenial(system.database.pool, route, target.id, owner().actor.accountId, [`${kind}:restore`]);
    expect((await read(kind, target.id)).mayRestore).toBe(false);
    expect((await change(owner(), await read(kind, target.id), 'restoration')).status).toBe(403);
  }
});

test('platform restoration uses the installed exact Global action, independently of target grants and derived booleans', async () => {
  for (const kind of ['space', 'realm'] as const) {
    const target = await create(kind);
    expect((await change(owner(), await read(kind, target.id), 'removal')).status).toBe(200);
    const removed = await read(kind, target.id);
    await seedGovernanceAuthority(system.database.pool, routeOf(target.id)!, target.id, platform().actor.accountId, [
      `${kind}:restore`,
    ]);
    await seedGovernanceAuthority(system.database.pool, 0, GLOBAL_CONTEXT, platform().actor.accountId, [
      'realm:manage',
      'moderation:takedown',
    ]);
    expect((await change(platform(), removed, 'restoration')).status).toBe(403);
    const derived = deriveAccess(system.access, {
      async authorize(client, actor, action, resource, evidence, time) {
        if (resource.id === GLOBAL_CONTEXT && action === `${kind}:restore`) return true;
        return system.access.authorize(client, actor, action, resource, evidence, time);
      },
    });
    await expect(
      restoreContainer(
        {
          pool: system.database.pool,
          access: derived,
          routeKey: system.routeKey,
          clock: () => new Date(current),
          deadlineNow: () => Date.now(),
        },
        platform().actor,
        {
          kind,
          id: target.id,
          expectedHead: target.head,
          expectedVersion: removed.version,
        },
        { deadline: Date.now() + 30_000, idempotencyKey: crypto.randomUUID() },
      ),
    ).rejects.toBeInstanceOf(GrantDeniedError);
    await seedGovernanceAuthority(system.database.pool, 0, GLOBAL_CONTEXT, platform().actor.accountId, [
      `${kind}:restore`,
    ]);
    expect((await change(platform(), removed, 'restoration')).status).toBe(200);
  }
});
