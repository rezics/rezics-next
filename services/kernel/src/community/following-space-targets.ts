import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import { deadlineClient } from '../access/authenticate.ts';
import {
  readViewerActions,
  type ViewerActionBindings,
  type ViewerActionResource,
  type ViewerActionResources,
} from '../access/viewer-actions.ts';
import { withConnection } from '../database/pool.ts';
import type {
  FollowingSpaceActions,
  FollowingSpaceDestination,
  FollowingSpaceProjection,
} from '../library/following-space-contract.ts';
import { routeOf } from '../route/route.ts';
import { spaceViewerActionResource } from './space.ts';
import { realmViewerActionResource } from './realm.ts';
import { readActiveSpaceAddressClaims } from './space-address.ts';
import followingTargets from './following-space-targets-page.sql';

const SPACE_RESOURCE = 'community.space';
const REALM_RESOURCE = 'community.realm';

export type FollowingSpaceTargetDependencies = Readonly<{
  pool: Pool;
  access: Access;
  resources: ViewerActionResources;
  bindings: ViewerActionBindings;
  clock: () => Date;
}>;

type Snapshot = Awaited<ReturnType<typeof followingTargets.run>>[number];
type LocatedSnapshot = Snapshot & { space_id: string; title: string };
type ViewerResult = Awaited<ReturnType<typeof readViewerActions>>['resources'][number];
type ViewerSuccess = Extract<ViewerResult, { viewerActions: readonly unknown[] }>;
type Group = Readonly<{ spaceId: string; refs: readonly Readonly<{ type: string; id: string }>[] }>;

function key(type: string, id: string) {
  return `${type}/${id}`;
}

function isLocatedSnapshot(row: Snapshot): row is LocatedSnapshot {
  return typeof row.space_id === 'string' && typeof row.title === 'string';
}

function sameSpace(current: Snapshot | undefined, expected: Snapshot): boolean {
  return (
    current !== undefined &&
    current.space_head_revision_id === expected.space_head_revision_id &&
    current.space_lifecycle_version === expected.space_lifecycle_version &&
    current.address === expected.address
  );
}

function sameRealm(current: Snapshot | undefined, expected: Snapshot): boolean {
  return (
    current !== undefined &&
    current.realm_id === expected.realm_id &&
    current.realm_head_revision_id === expected.realm_head_revision_id &&
    current.realm_lifecycle_version === expected.realm_lifecycle_version
  );
}

async function pageSnapshot(
  client: Parameters<ViewerActionResource['read']>[0],
  ids: readonly string[],
  at: string,
): Promise<Map<string, LocatedSnapshot>> {
  const selected = ids.flatMap((id) => {
    const route = routeOf(id);
    return route === null ? [] : [{ id, route }];
  });
  if (!selected.length) return new Map();
  const rows = await followingTargets.run(client, {
    routes: selected.map(({ route }) => route),
    ids: selected.map(({ id }) => id),
    at,
  });
  return new Map(rows.filter(isLocatedSnapshot).map((row) => [row.space_id, row] as const));
}

function spaceResource(
  base: ViewerActionResource,
  expected: ReadonlyMap<string, LocatedSnapshot>,
  activeAddressClaims: Set<string>,
): ViewerActionResource {
  return {
    ...base,
    async prepare(input) {
      const selected = input.ids.flatMap((spaceId) => {
        const snapshot = expected.get(spaceId);
        return typeof snapshot?.address === 'string' ? [{ spaceId, address: snapshot.address }] : [];
      });
      const claims = await withConnection(input.pool, (connection) =>
        readActiveSpaceAddressClaims(deadlineClient(connection, input.deadline), selected),
      );
      for (const claim of claims) activeAddressClaims.add(claim);
      const prepared = base.prepare ? await base.prepare(input) : base;
      return {
        ...prepared,
        async read(client, ids, at, time) {
          const native = await prepared.read(client, ids, at, time);
          const current = await pageSnapshot(client, ids, at);
          return Object.fromEntries(
            ids.map((id) => [id, native[id] === true && sameSpace(current.get(id), expected.get(id)!)]),
          );
        },
      };
    },
  };
}

function realmResource(
  base: ViewerActionResource,
  expectedByRealm: ReadonlyMap<string, LocatedSnapshot>,
): ViewerActionResource {
  return {
    ...base,
    async prepare(input) {
      const prepared = base.prepare ? await base.prepare(input) : base;
      return {
        ...prepared,
        async read(client, ids, at, time) {
          const expected = ids.flatMap((id) => {
            const snapshot = expectedByRealm.get(id);
            return snapshot ? [{ realmId: id, snapshot }] : [];
          });
          const current = await pageSnapshot(
            client,
            expected.map(({ snapshot }) => snapshot.space_id),
            at,
          );
          const native = await prepared.read(client, ids, at, time);
          return Object.fromEntries(
            expected.map(({ realmId, snapshot }) => {
              const source = snapshot.space_id === null ? undefined : current.get(snapshot.space_id);
              return [
                realmId,
                snapshot.space_id !== null &&
                  native[realmId] === true &&
                  sameSpace(source, snapshot) &&
                  sameRealm(source, snapshot),
              ];
            }),
          );
        },
      };
    },
  };
}

function success(result: ViewerResult | undefined): result is ViewerSuccess {
  return result !== undefined && 'viewerActions' in result;
}

function actionProjection(
  resourceType: typeof SPACE_RESOURCE | typeof REALM_RESOURCE,
  resourceId: string,
  result: ViewerResult | undefined,
): FollowingSpaceActions {
  return success(result)
    ? {
        status: 'available',
        resourceType,
        resourceId,
        viewerActions: result.viewerActions,
      }
    : { status: 'unavailable' };
}

/**
 * Resolve a fixed Following page in batches. Address claims are prepared on
 * their own anchor before viewerActions performs its final home transaction.
 */
export async function followingSpaceTargets(
  dependencies: FollowingSpaceTargetDependencies,
  actor: Actor,
  ids: readonly string[],
  deadline: number,
): Promise<ReadonlyMap<string, FollowingSpaceProjection>> {
  const uniqueIds = [...new Set(ids)];
  const valid = uniqueIds.flatMap((id) => {
    const route = routeOf(id);
    return route === null ? [] : [{ id, route }];
  });
  const snapshots = new Map<string, LocatedSnapshot>();
  if (valid.length) {
    const at = dependencies.clock().toISOString();
    const rows = await withConnection(dependencies.pool, (connection) =>
      followingTargets.run(deadlineClient(connection, deadline), {
        routes: valid.map(({ route }) => route),
        ids: valid.map(({ id }) => id),
        at,
      }),
    );
    for (const row of rows.filter(isLocatedSnapshot)) snapshots.set(row.space_id, row);
  }

  const expectedByRealm = new Map<string, LocatedSnapshot>();
  const addressedGroups: Group[] = [];
  const unsupportedGroups: Group[] = [];
  const realmGroups: Group[] = [];
  for (const spaceId of uniqueIds) {
    const snapshot = snapshots.get(spaceId);
    if (!snapshot) continue;
    const spaceRef = { type: SPACE_RESOURCE, id: spaceId };
    if (snapshot.address !== null) {
      addressedGroups.push({ spaceId, refs: [spaceRef] });
    } else if (snapshot.realm_id !== null) {
      expectedByRealm.set(snapshot.realm_id, snapshot);
      realmGroups.push({
        spaceId,
        refs: [spaceRef, { type: REALM_RESOURCE, id: snapshot.realm_id }],
      });
    } else {
      unsupportedGroups.push({ spaceId, refs: [spaceRef] });
    }
  }
  const groups = [...addressedGroups, ...unsupportedGroups, ...realmGroups];

  const chunks: Group[][] = [];
  let chunk: Group[] = [];
  let count = 0;
  for (const group of groups) {
    if (count + group.refs.length > 100) {
      chunks.push(chunk);
      chunk = [];
      count = 0;
    }
    chunk.push(group);
    count += group.refs.length;
  }
  if (chunk.length) chunks.push(chunk);

  const activeAddressClaims = new Set<string>();
  const actionResults = new Map<string, ViewerResult>();
  const resources = new Map(dependencies.resources);
  const baseSpace = resources.get(SPACE_RESOURCE) ?? spaceViewerActionResource;
  const baseRealm = resources.get(REALM_RESOURCE) ?? realmViewerActionResource;
  resources.set(SPACE_RESOURCE, spaceResource(baseSpace, snapshots, activeAddressClaims));
  resources.set(REALM_RESOURCE, realmResource(baseRealm, expectedByRealm));

  for (const selected of chunks) {
    const refs = selected.flatMap(({ refs }) => refs);
    const result = await readViewerActions(
      {
        pool: dependencies.pool,
        access: dependencies.access,
        resources,
        bindings: dependencies.bindings,
        clock: dependencies.clock,
      },
      actor,
      refs,
      deadline,
    );
    for (const resource of result.resources) actionResults.set(key(resource.type, resource.id), resource);
  }

  const projections = new Map<string, FollowingSpaceProjection>();
  for (const spaceId of uniqueIds) {
    const snapshot = snapshots.get(spaceId);
    const spaceResult = actionResults.get(key(SPACE_RESOURCE, spaceId));
    const readable = snapshot !== undefined && snapshot.title !== null && success(spaceResult);
    const target = readable ? { id: spaceId, type: 'space' as const, label: snapshot.title! } : null;
    let destination: FollowingSpaceDestination = { kind: 'unavailable' };
    let actions: FollowingSpaceActions = { status: 'unavailable' };
    if (snapshot !== undefined && readable && snapshot.address !== null) {
      const claim = JSON.stringify([spaceId, snapshot.address]);
      if (activeAddressClaims.has(claim)) {
        destination = { kind: 'space', spaceId, address: snapshot.address };
        actions = actionProjection(SPACE_RESOURCE, spaceId, spaceResult);
      }
    } else if (snapshot !== undefined && readable && snapshot.realm_id !== null) {
      const realmResult = actionResults.get(key(REALM_RESOURCE, snapshot.realm_id));
      if (success(realmResult)) {
        destination = { kind: 'realm', realmId: snapshot.realm_id };
        actions = actionProjection(REALM_RESOURCE, snapshot.realm_id, realmResult);
      }
    }
    projections.set(spaceId, { target, destination, actions });
  }
  return projections;
}
