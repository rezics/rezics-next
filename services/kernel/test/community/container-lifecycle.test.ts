import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { mintReadTime } from '../../src/command/command.ts';
import { accessCheck } from '../../src/request/access.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { realmReadEligibility } from '../../src/community/realm-read.ts';
import {
  readContainerBinding,
  revalidateContainerBinding,
  type ContainerLifecycle,
} from '../../src/community/container-lifecycle.ts';
import {
  createNativeContentSystemWithWriteRateOverrides,
  type NativeContentSystem,
} from '../content/support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';
import type { ContentCredential } from '../content/support/system.ts';

let system: NativeContentSystem;
const owner = () => system.actors.other;
const moderator = () => system.actors.moderator;
const peer = () => system.actors.author;
const day = 86_400_000;
// Keep every authoritative boundary before credential expiry while advancing the real native clock.
const initial = new Date(Date.now() - 61 * day).toISOString();

async function call(
  person: ContentCredential,
  method: string,
  path: string,
  body?: unknown,
  head?: string,
  key: string = crypto.randomUUID(),
) {
  return system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${person.bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(head === undefined ? {} : { 'if-match': JSON.stringify(head) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function body<T>(response: Response, status: number): Promise<T> {
  const value: unknown = await response.json();
  expect({ status: response.status, value }).toMatchObject({ status });
  return value as T;
}
async function create() {
  const { context } = await body<{ context: { id: string } }>(
    await call(owner(), 'POST', '/v1/contexts', {
      labels: { en: 'Independent editorial Context' },
    }),
    201,
  );
  const { space } = await body<{ space: { spaceId: string; headRevisionId: string } }>(
    await call(owner(), 'POST', '/v1/spaces', { title: 'Container material' }),
    201,
  );
  const { realm } = await body<{ realm: { realmId: string; headRevisionId: string; contextId: string } }>(
    await call(owner(), 'POST', '/v1/realms', {
      spaceId: space.spaceId,
      title: 'Realm material',
      visibility: 'public',
      contextId: context.id,
    }),
    201,
  );
  return { context, space, realm };
}
async function lifecycle(person: ContentCredential, kind: 'space' | 'realm', id: string) {
  return (await body<{ container: ContainerLifecycle }>(await call(person, 'GET', `/v1/${kind}s/${id}/lifecycle`), 200))
    .container;
}
async function change(
  person: ContentCredential,
  container: ContainerLifecycle,
  verb: 'removal' | 'restoration',
  key?: string,
) {
  return call(
    person,
    'POST',
    `/v1/${container.kind}s/${container.id}/${verb}`,
    {
      expectedVersion: container.version,
      ...(verb === 'removal' ? { reason: 'Recorded native moderation reason' } : {}),
    },
    container.headRevisionId,
    key,
  );
}
async function grantModerator(realmId: string, person: ContentCredential, revoke = false) {
  return call(owner(), 'POST', `/v1/roleGrants${revoke ? ':revoke' : ''}`, {
    resource: { route: routeOf(realmId), id: realmId },
    subject: { kind: 'account', id: person.actor.accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  });
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    HIGH_RATE_OVERRIDES,
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
  await seedGovernanceAuthority(
    system.database.pool,
    0,
    '00000000-0000-8000-8000-000000000000',
    owner().actor.accountId,
    ['context:create'],
  );
  await system.clock.setCommandTime(initial);
});
afterAll(async () => {
  await system?.close();
});

test('removal hides owned public navigation and restoration uses current visibility, including stale restoration replay', async () => {
  await system.clock.setCommandTime(initial);
  const listed = async (id: string) => {
    const response = await system.kernel.handle(new Request('https://content.test/v1/sitemap/realms'));
    const page = await body<{ items: { id: string }[] }>(response, 200);
    return page.items.some((item) => item.id === id);
  };
  for (const visibility of ['public', 'protected'] as const) {
    for (const kind of ['space', 'realm'] as const) {
      const { space, realm } = await create();
      if (visibility === 'protected')
        expect(
          (await call(owner(), 'PATCH', `/v1/realms/${realm.realmId}`, { visibility }, realm.headRevisionId)).status,
        ).toBe(200);
      const id = kind === 'space' ? space.spaceId : realm.realmId;
      expect(await listed(realm.realmId)).toBe(visibility === 'public');
      expect((await change(owner(), await lifecycle(owner(), kind, id), 'removal')).status).toBe(200);
      expect(await listed(realm.realmId)).toBe(false);
      const removed = await lifecycle(owner(), kind, id),
        key = crypto.randomUUID();
      expect((await change(owner(), removed, 'restoration', key)).status).toBe(200);
      expect(await listed(realm.realmId)).toBe(visibility === 'public');
      expect((await change(owner(), await lifecycle(owner(), kind, id), 'removal')).status).toBe(200);
      expect((await change(owner(), removed, 'restoration', key)).status).toBe(200);
      expect(await listed(realm.realmId)).toBe(false);
    }
  }
});

test('native moderator reason, current-role restoration and inclusive 30-day boundary', async () => {
  const { realm } = await create();
  expect((await grantModerator(realm.realmId, moderator())).status).toBe(201);
  expect((await grantModerator(realm.realmId, peer())).status).toBe(201);
  const active = await lifecycle(moderator(), 'realm', realm.realmId);
  expect(
    (
      await call(
        moderator(),
        'POST',
        `/v1/realms/${realm.realmId}/removal`,
        {
          expectedVersion: active.version,
          reason: ' ',
        },
        active.headRevisionId,
      )
    ).status,
  ).toBe(400);
  const removalKey = crypto.randomUUID();
  expect((await change(moderator(), active, 'removal', removalKey)).status).toBe(200);
  const removed = await lifecycle(moderator(), 'realm', realm.realmId);
  expect(removed).toMatchObject({
    state: 'removed',
    version: '1',
    reason: 'Recorded native moderation reason',
    removerRole: 'moderator',
    mayRestore: true,
  });
  expect((await call(owner(), 'GET', `/v1/realms/${realm.realmId}`)).status).toBe(404);
  expect((await change(peer(), removed, 'restoration')).status).toBe(403);
  expect((await grantModerator(realm.realmId, moderator(), true)).status).toBe(200);
  expect((await change(moderator(), active, 'removal', removalKey)).status).toBe(403);
  expect((await change(moderator(), removed, 'restoration')).status).toBe(403);
  // Current higher native owner can restore a moderator's removal.
  expect((await change(owner(), removed, 'restoration')).status).toBe(200);
  expect((await grantModerator(realm.realmId, moderator())).status).toBe(201);
  expect((await change(moderator(), await lifecycle(moderator(), 'realm', realm.realmId), 'removal')).status).toBe(200);
  const again = await lifecycle(moderator(), 'realm', realm.realmId);
  await system.clock.setCommandTime(new Date(Date.parse(initial) + 30 * day).toISOString());
  expect((await change(moderator(), again, 'restoration')).status).toBe(200);
  expect((await change(moderator(), await lifecycle(moderator(), 'realm', realm.realmId), 'removal')).status).toBe(200);
  const expired = await lifecycle(moderator(), 'realm', realm.realmId);
  await system.clock.setCommandTime(new Date(Date.parse(initial) + 60 * day + 1).toISOString());
  expect((await change(owner(), expired, 'restoration')).status).toBe(403);
});

test('stale container binding discloses nothing, independent Context survives, restore retains pointer and needs live Context', async () => {
  await system.clock.setCommandTime(initial);
  const { space, realm, context } = await create();
  const resource = { route: routeOf(realm.realmId)!, id: realm.realmId };
  const stale = await accessCheck(
    system.access,
    owner().actor,
    'realm:read',
    {
      ...resource,
      eligibility: realmReadEligibility(resource),
    },
    { pool: system.database.pool, deadline: Date.now() + 30_000 },
  );
  const at = await mintReadTime(system.database.pool, () => new Date(initial));
  const binding = await readContainerBinding(system.database.pool, { realmId: realm.realmId, at });
  if (!binding) throw new Error('Native binding missing');
  const active = await lifecycle(owner(), 'space', space.spaceId);
  expect((await change(owner(), active, 'removal')).status).toBe(200);
  expect(await revalidateContainerBinding(system.database.pool, binding, at)).toBe(false);
  expect((await call(owner(), 'GET', `/v1/spaces/${space.spaceId}`)).status).toBe(404);
  expect((await call(owner(), 'GET', `/v1/realms/${realm.realmId}`)).status).toBe(404);
  expect((await call(owner(), 'GET', `/v1/contexts/${context.id}`)).status).toBe(200);
  const removed = await lifecycle(owner(), 'space', space.spaceId);
  expect((await change(owner(), removed, 'restoration')).status).toBe(200);
  // A remove/restore cycle invalidates the old preparation even though both heads survived.
  const allowed = await stale(system.database.pool, at).catch((error: unknown) => {
    expect(error).toBeInstanceOf(ProblemError);
    if (!(error instanceof ProblemError)) throw error;
    expect(error.code).toBe('not_found');
    return false;
  });
  expect(allowed).toBe(false);
  expect(await revalidateContainerBinding(system.database.pool, binding, at)).toBe(false);
  const restored = await body<{ realm: { contextId: string; headRevisionId: string } }>(
    await call(owner(), 'GET', `/v1/realms/${realm.realmId}`),
    200,
  );
  expect(restored.realm).toMatchObject({ contextId: context.id, headRevisionId: realm.headRevisionId });
  expect((await change(owner(), await lifecycle(owner(), 'space', space.spaceId), 'removal')).status).toBe(200);
  expect((await call(owner(), 'DELETE', `/v1/contexts/${context.id}`)).status).toBe(200);
  const unavailable = await lifecycle(owner(), 'space', space.spaceId);
  expect(unavailable.mayRestore).toBe(false);
  expect((await change(owner(), unavailable, 'restoration')).status).toBe(403);
  expect(await readContainerBinding(system.database.pool, { realmId: realm.realmId, at })).toBeNull();
});
