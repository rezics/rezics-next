import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mintReadTime } from '../../src/command/command.ts';
import { accessCheck } from '../../src/request/access.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { routeOf } from '../../src/route/route.ts';
import { realmReadEligibility } from '../../src/community/realm.ts';
import {
  readContainerBinding,
  revalidateContainerBinding,
  type ContainerLifecycle,
} from '../../src/community/container-lifecycle.ts';
import { axes, containerGrowthFixture, type ContainerGrowthFixture } from './growth-container-fixture.ts';

let f: ContainerGrowthFixture;
beforeAll(async () => {
  f = await containerGrowthFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

for (const axis of axes)
  for (const kind of ['space', 'realm'] as const) {
    test(`${kind} removal, restoration and stale bindings stay bounded with independent ${axis} growth`, async () => {
      const selected = await f.community();
      const id = kind === 'space' ? selected.space.spaceId : selected.realm.realmId;
      const path = `/v1/${kind}s/${id}`;
      const realmPath = `/v1/realms/${selected.realm.realmId}`;
      const resource = { route: routeOf(selected.realm.realmId)!, id: selected.realm.realmId };
      // A whole cycle is captured, including fresh Access preparation, native commands,
      // current lifecycle reads and final binding validation. No asserted state is seeded.
      await f.measure(`community ${kind} removal restoration and stale binding`, selected, axis, async () => {
        const stale = await accessCheck(
          f.system.access,
          f.owner.actor,
          'realm:read',
          {
            ...resource,
            eligibility: realmReadEligibility(resource),
          },
          { pool: f.db.pool, deadline: Date.now() + 30_000 },
        );
        const at = await mintReadTime(f.db.pool);
        const binding = await readContainerBinding(f.db.pool, { realmId: selected.realm.realmId, at });
        expect(binding).not.toBeNull();
        if (!binding) throw new Error('Native container binding missing');
        const { container: active } = await f.call<{ container: ContainerLifecycle }>('GET', `${path}/lifecycle`, 200);
        expect(active.state).toBe('active');
        const { container: removed } = await f.call<{ container: ContainerLifecycle }>(
          'POST',
          `${path}/removal`,
          200,
          f.owner,
          { expectedVersion: active.version, reason: 'Native growth removal' },
          active.headRevisionId,
        );
        expect(removed.state).toBe('removed');
        expect(BigInt(removed.version)).toBe(BigInt(active.version) + 1n);
        expect(await revalidateContainerBinding(f.db.pool, binding, at)).toBe(false);
        expect(await readContainerBinding(f.db.pool, { realmId: selected.realm.realmId, at })).toBeNull();
        await f.call('GET', realmPath, 404, null);
        // The Context has an independent lifecycle; removal retains this pointer.
        await f.call('GET', `/v1/contexts/${selected.realm.contextId}`, 200);
        const { container: restorable } = await f.call<{ container: ContainerLifecycle }>(
          'GET',
          `${path}/lifecycle`,
          200,
        );
        expect(restorable.mayRestore).toBe(true);
        const { container: restored } = await f.call<{ container: ContainerLifecycle }>(
          'POST',
          `${path}/restoration`,
          200,
          f.owner,
          { expectedVersion: restorable.version },
          restorable.headRevisionId,
        );
        expect(restored.state).toBe('active');
        expect(BigInt(restored.version)).toBe(BigInt(active.version) + 2n);
        expect(await revalidateContainerBinding(f.db.pool, binding, at)).toBe(false);
        const allowed = await stale(f.db.pool, at).catch((error: unknown) => {
          expect(error).toBeInstanceOf(ProblemError);
          if (!(error instanceof ProblemError)) throw error;
          expect(error.code).toBe('not_found');
          return false;
        });
        expect(allowed).toBe(false);
        const fresh = await readContainerBinding(f.db.pool, { realmId: selected.realm.realmId, at });
        expect(fresh).toMatchObject({
          realmId: selected.realm.realmId,
          spaceId: selected.space.spaceId,
          contextId: selected.realm.contextId,
          realmHead: selected.realm.headRevisionId,
          spaceHead: selected.space.headRevisionId,
        });
        expect(fresh).not.toEqual(binding);
        const result = await f.call<{ realm: { contextId: string; headRevisionId: string } }>(
          'GET',
          realmPath,
          200,
          null,
        );
        expect(result.realm).toMatchObject({
          contextId: selected.realm.contextId,
          headRevisionId: selected.realm.headRevisionId,
        });
      });
    }, 600_000);
  }
