import canonicalize from 'canonicalize';
import { createResourcePublicEligibility } from './domain-ports.ts';
import type { ResourceEligibility } from '../access/index.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { AccessCheck, AccessClient, Actor, Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { readRealm } from './realm-read.ts';
import { systemCommunityClock, type CommunityAmbient } from './ambient.ts';
import { spaceEligibilityAccessWork, viewerActionEligibilityWork } from './eligibility-access-work.ts';
import type { Space, SpaceDependencies } from './space.ts';
import read from './space-read.sql';
import realmSpace from './realm-space.sql';
import bindingRead from './container-lifecycle-binding.sql';
import eligibilityRead from './space-eligibility-read.sql';

/** One routed point read joining only the current exact revision. No authorization is implied. */
export async function readSpace(
  client: AccessClient,
  spaceId: string,
  time: string,
): Promise<(Space & { lifecycleVersion: string }) | null> {
  const route = routeOf(spaceId);
  if (route === null) return null;
  const row = await read.run(client, { route, id: spaceId, at: time });
  if (!row) return null;
  return {
    spaceId: row.space_id,
    lifecycleVersion: row.lifecycle_version,
    state: row.state,
    headRevisionId: row.head_revision_id,
    createdAt: new Date(row.created_at).toISOString(),
    creator: row.creator,
    predecessor: row.predecessor,
    address: row.address,
    title: row.title,
    summary: row.summary,
    revisionCreatedAt: new Date(row.revision_created_at).toISOString(),
    author: row.author,
  };
}

/** Read the Space and its exact Realm slot together. Callers supply Space authorization;
 * the derived Realm id always uses the ordinary Realm reader and its own authorization.
 */
export async function readSpaceForViewer(
  deps: Pick<SpaceDependencies, 'pool' | 'access'> & Partial<CommunityAmbient>,
  actor: Actor,
  spaceId: string,
  time: string,
  context: { deadline: number },
  check?: AccessCheck,
): Promise<(Space & { realmId: string | null }) | null> {
  const route = routeOf(spaceId);
  if (route === null) return null;
  const current = await withConnection(deps.pool, async (client) => {
    if (check && !(await check(client))) return null;
    const space = await readSpace(client, spaceId, time);
    if (!space) return null;
    const slot = await realmSpace.run(client, { route, space: spaceId, at: time });
    const realmId = slot?.realm_id ?? null;
    const binding = realmId ? await bindingRead.run(client, { route, id: realmId, at: time, subject: null }) : null;
    return { space, realmId, binding };
  });
  if (!current) return null;
  // Release the Space connection before Access prepares separately anchored evidence.
  // In particular, a pool of one must never need a nested checkout.
  const realm = current.realmId ? await readRealm(deps, actor, current.realmId, context) : null;
  return withConnection(deps.pool, async (client) => {
    if (check && !(await check(client))) return null;
    const final = await readSpace(client, spaceId, time);
    if (
      !final ||
      final.headRevisionId !== current.space.headRevisionId ||
      final.lifecycleVersion !== current.space.lifecycleVersion
    )
      return null;
    const binding = realm ? await bindingRead.run(client, { route, id: realm.realmId, at: time, subject: null }) : null;
    return {
      ...final,
      realmId: binding && canonicalize(binding) === canonicalize(current.binding) ? (realm?.realmId ?? null) : null,
    };
  });
}

export function spaceReadEligibility(
  identity: Resource,
  clock: () => Date = systemCommunityClock,
): ResourceEligibility {
  const resource = Object.freeze({ route: identity.route, id: identity.id });
  const native = spaceEligibilityAccessWork<Awaited<ReturnType<typeof eligibilityRead.run>>>(resource);
  return createResourcePublicEligibility<NonNullable<Awaited<ReturnType<typeof eligibilityRead.run>>>>({
    resource,
    action: 'space:read',
    work: native.work,
    prepare(context) {
      return native.prepare(context, async (dispatch) => {
        const { pool, resource: identity } = context;
        const parameters = { route: identity.route, id: identity.id, at: clock().toISOString() };
        return (
          (await dispatch(native.spacePlan, parameters, () => eligibilityRead.run(pool, parameters), true)) ?? null
        );
      });
    },
    verify(context) {
      return native.verify(context, async (dispatch) => {
        const { client, at, evidence } = context;
        const parameters = { ...resource, at };
        const current = await dispatch(native.spacePlan, parameters, () => eligibilityRead.run(client, parameters));
        if (
          !current ||
          current.head_revision_id !== evidence.head_revision_id ||
          current.lifecycle_version !== evidence.lifecycle_version
        )
          throw new ProblemError('not_found');
        return true;
      });
    },
  });
}

/** The read route's exact identity/head eligibility, batched by supplied full keys. */
export const spaceViewerActionResource: import('../access/viewer-actions.ts').ViewerActionResource = {
  readAction: 'space:read',
  async read(client, ids, at, _time, work) {
    const dispatch = async () => {
      const result = await client.query<{ id: string; public: boolean }>(
        `SELECT row.* FROM unnest($1::integer[], $2::uuid[]) AS wanted(route,id)
       CROSS JOIN LATERAL (
         WITH identity AS MATERIALIZED (
           SELECT h.* FROM community.space h
           WHERE h.route = wanted.route AND h.space_id = wanted.id
           ORDER BY h.route, h.space_id LIMIT 1
         )
         SELECT h.space_id AS id, true AS public
         FROM identity h
         CROSS JOIN LATERAL (
           SELECT r.created_at FROM community.space_revision r
           WHERE r.route = h.route AND r.space_id = h.space_id AND r.revision_id = h.head_revision_id
           ORDER BY r.route, r.space_id, r.revision_id LIMIT 1
         ) r
         WHERE h.state = 'active' AND h.created_at <= $3::timestamptz AND r.created_at <= $3::timestamptz
       ) row`,
        [ids.map((id) => routeOf(id)!), ids, at],
      );
      return Object.fromEntries(result.rows.map((row) => [row.id, row.public]));
    };
    return work
      ? work.run('community.space.viewer-resource', viewerActionEligibilityWork('space', ids, at), dispatch)
      : dispatch();
  },
};
