import { productionActions } from '../support/production-actions.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { compileViewerActionBindings } from '../../src/access/viewer-actions.ts';
import { readSpaceDiscoveryEntryBatch } from '../../src/community/space-discovery-entry.ts';
import { spaceViewerActionResource } from '../../src/community/space.ts';
import { realmViewerActionResource } from '../../src/community/realm.ts';
import {
  createNativeContentSystemWithOrdinaryScopes,
  type NativeContentSystem,
} from '../content/support/native-system.ts';
let system: NativeContentSystem;
beforeAll(async () => {
  system = await createNativeContentSystemWithOrdinaryScopes(
    { databaseUrl: process.env.DATABASE_URL! },
    [...productionActions().keys()].filter((a) => a !== 'media:complete'),
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
}, 120000);
afterAll(async () => {
  await system?.close();
});
async function call(method: string, path: string, input?: unknown, head?: string) {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${system.actors.author.bearer}`,
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
        'content-type': 'application/json',
        ...(head ? { 'if-match': JSON.stringify(head) } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }),
  );
  const value = await response.json();
  expect(response.status).toBe(method === 'POST' && !path.endsWith('/removal') ? 201 : 200);
  return value as any;
}
test('native current identity and admitted destinations follow address and carrier changes without guessing standalone', async () => {
  const { space } = await call('POST', '/v1/spaces', { title: 'Native place' });
  const address = `entry_${crypto.randomUUID().replaceAll('-', '')}`;
  const { space: addressed } = await call(
    'PUT',
    `/v1/spaces/${space.spaceId}/address`,
    { address },
    space.headRevisionId,
  );
  const runtime = {
    resources: new Map([
      ['community.space', spaceViewerActionResource],
      ['community.realm', realmViewerActionResource],
    ]),
    bindings: compileViewerActionBindings(system.kernel.routes),
  };
  const read = () =>
    readSpaceDiscoveryEntryBatch(
      { pool: system.database.pool, access: system.access, deadlineNow: () => Date.now() },
      system.actors.author.actor,
      [space.spaceId],
      Date.now() + 30000,
      runtime,
    );
  const standalone = (await read()).get(space.spaceId)!;
  expect(standalone.presentation.identity).toEqual({ kind: 'space', id: space.spaceId, name: 'Native place' });
  expect(standalone.destination).toEqual({ kind: 'space', spaceId: space.spaceId, address });
  const replacement = `${address}x`;
  await call('PUT', `/v1/spaces/${space.spaceId}/address`, { address: replacement }, addressed.headRevisionId);
  expect((await read()).get(space.spaceId)?.destination).toEqual({
    kind: 'space',
    spaceId: space.spaceId,
    address: replacement,
  });
  const { realm } = await call('POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Native community',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  const carried = (await read()).get(space.spaceId)!;
  expect(carried.presentation).toEqual({
    identity: { kind: 'realm', id: realm.realmId, name: 'Native community' },
    avatar: { state: 'none' },
  });
  expect(carried.destination).toEqual({ kind: 'realm', realmId: realm.realmId });
  expect(carried.actions.status).toBe('available');
  const withoutAdvice = await readSpaceDiscoveryEntryBatch(
    { pool: system.database.pool, access: system.access, deadlineNow: () => Date.now() },
    system.actors.author.actor,
    [space.spaceId],
    Date.now() + 30000,
  );
  expect(withoutAdvice.get(space.spaceId)?.destination).toEqual({ kind: 'unavailable' });
  const { realm: concealed } = await call(
    'PATCH',
    `/v1/realms/${realm.realmId}`,
    { visibility: 'protected' },
    realm.headRevisionId,
  );
  expect((await read()).has(space.spaceId)).toBe(false);
  const { realm: restored } = await call(
    'PATCH',
    `/v1/realms/${realm.realmId}`,
    { visibility: 'public' },
    concealed.headRevisionId,
  );
  const { container } = await call('GET', `/v1/realms/${realm.realmId}/lifecycle`);
  await call(
    'POST',
    `/v1/realms/${realm.realmId}/removal`,
    { expectedVersion: container.version, reason: 'Removed' },
    restored.headRevisionId,
  );
  expect((await read()).has(space.spaceId)).toBe(false);
}, 120000);
