import type { Pool } from 'pg';
import { accessCheck, type Access, type AccessClient, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { realmReadEligibility } from './realm.ts';
import { spaceReadEligibility } from './space.ts';
import realm from './report-target-realm.sql';
import space from './report-target-space.sql';

/** Finite native adapters. A report anchor conveys no container or report authority. */
export type CommunityReportTarget = Readonly<{ kind: 'space' | 'realm'; id: string }>;

export async function communityReportTargetFacts(client: AccessClient, target: CommunityReportTarget) {
  const route = routeOf(target.id);
  if (route === null) return null;
  const statement = target.kind === 'space' ? space : realm;
  const parameters = { route, id: target.id };
  const result = await client.query(
    statement.sql,
    statement.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  return result.rows[0] ? { fingerprint: JSON.stringify(result.rows[0]) } : null;
}

/** Uses the ordinary native read eligibility, including Realm host and ban fences.
 * Preparation completes before the caller acquires the source snapshot. */
export function communityReportReadCheck(
  deps: { pool: Pool; access: Access },
  target: CommunityReportTarget,
  context: { actor: Actor; deadline: number },
) {
  const resource = { route: routeOf(target.id)!, id: target.id };
  return accessCheck(
    deps.access,
    context.actor,
    `${target.kind}:read`,
    {
      ...resource,
      eligibility: target.kind === 'space' ? spaceReadEligibility(resource) : realmReadEligibility(resource),
    },
    { pool: deps.pool, deadline: context.deadline },
  );
}
