import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId, routeOf } from '../../src/route/route.ts';
import { seedResourceDenial } from '../content/support/disclosure-fixtures.ts';
import { axes, containerGrowthFixture, type ContainerGrowthFixture } from './growth-container-fixture.ts';

let f: ContainerGrowthFixture;
beforeAll(async () => {
  f = await containerGrowthFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

for (const axis of axes) {
  test(`empty and denied Space reads stay bounded with independent ${axis} growth`, async () => {
    const { space } = await f.call<{ space: { spaceId: string; headRevisionId: string } }>(
      'POST',
      '/v1/spaces',
      201,
      f.owner,
      { title: 'Empty carried-Realm slot' },
    );
    await seedResourceDenial(f.db.admin, routeOf(space.spaceId)!, space.spaceId, f.outsider.actor.accountId, [
      'space:read',
    ]);
    const path = `/v1/spaces/${space.spaceId}`;
    await f.measure('community empty carried-Realm Space read', { space }, axis, async () => {
      const result = await f.call<{ space: { spaceId: string; realmId: string | null } }>('GET', path, 200, null);
      expect(result.space).toMatchObject({ spaceId: space.spaceId, realmId: null });
    });
    await f.measure('community denied Space read', { space }, axis, async () => {
      const result = await f.call<Record<string, unknown>>('GET', path, 404, f.outsider);
      expect(result).toMatchObject({ code: 'not_found' });
      expect(result).not.toHaveProperty('space');
    });
  }, 600_000);

  test(`missing and protected Realm reads stay bounded with independent ${axis} growth`, async () => {
    const selected = await f.community('protected');
    const unknown = newId(routeOf(selected.realm.realmId)!);
    await f.measure('community missing Realm read', selected, axis, async () => {
      const result = await f.call<Record<string, unknown>>('GET', `/v1/realms/${unknown}`, 404, f.owner);
      expect(result).toMatchObject({ code: 'not_found' });
      expect(result).not.toHaveProperty('realm');
    });
    for (const actor of [null, f.outsider]) {
      await f.measure(
        `community protected Realm read denied to ${actor ? 'outsider' : 'anonymous'}`,
        selected,
        axis,
        async () => {
          const result = await f.call<Record<string, unknown>>(
            'GET',
            `/v1/realms/${selected.realm.realmId}`,
            404,
            actor,
          );
          expect(result).toMatchObject({ code: 'not_found' });
          expect(result).not.toHaveProperty('realm');
        },
      );
    }
    await f.measure('community Space read with denied carried Realm', selected, axis, async () => {
      const result = await f.call<{ space: { spaceId: string; realmId: string | null } }>(
        'GET',
        `/v1/spaces/${selected.space.spaceId}`,
        200,
        null,
      );
      expect(result.space).toMatchObject({ spaceId: selected.space.spaceId, realmId: null });
    });
  }, 600_000);
}
