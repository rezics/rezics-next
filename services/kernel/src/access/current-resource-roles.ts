import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import type { AccessClient, Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';

export type CurrentResourceRoleKey = Readonly<{
  grantRole: string;
  subjectKind: 'identity' | 'active_accounts';
  subjectId: string;
  subjectRole: '' | 'owner' | 'member';
  intervalKey: string;
}>;
export type CurrentResourceRoleFrontier = Readonly<{
  resource: Readonly<{ route: number; id: string }>;
  version: string;
  validFrom: string;
  validUntil: string | null;
  roles: readonly string[];
}>;
export type CurrentResourceRoleAfter = Readonly<{
  frontier: CurrentResourceRoleFrontier;
  key: CurrentResourceRoleKey;
}>;
export type CurrentResourceRoleUnavailable = Readonly<{ status: 'unavailable' }>;
export type CurrentResourceRolePage =
  | CurrentResourceRoleUnavailable
  | Readonly<{
      status: 'ready';
      rows: readonly Readonly<CurrentResourceRoleKey & { valid: string }>[];
      frontier: CurrentResourceRoleFrontier;
      after: CurrentResourceRoleAfter | null;
    }>;
export type CurrentResourceRolePageInput = Readonly<{
  resource: Resource;
  roles: readonly string[];
  at: AuthoritativeTime;
  after: CurrentResourceRoleAfter | null;
  limit: number;
}>;
export type CurrentResourceRoleVerificationInput = Readonly<{
  resource: Resource;
  frontier: CurrentResourceRoleFrontier;
  at: AuthoritativeTime;
}>;
export type CurrentResourceRoleVerification = Readonly<{ status: 'ready' }> | CurrentResourceRoleUnavailable;

const unavailable: CurrentResourceRoleUnavailable = Object.freeze({ status: 'unavailable' });
function validateResource(resource: Resource) {
  if (!resource || routeOf(resource.id) !== resource.route || routeOf(resource.id) === null)
    throw new TypeError('Invalid current resource role resource');
}
function sameFrontier(a: CurrentResourceRoleFrontier, b: CurrentResourceRoleFrontier): boolean {
  return (
    a.resource.route === b.resource.route &&
    a.resource.id === b.resource.id &&
    a.version === b.version &&
    a.validFrom === b.validFrom &&
    a.validUntil === b.validUntil &&
    JSON.stringify(a.roles) === JSON.stringify(b.roles)
  );
}

const frontierSql = `SELECT f.version::text, f.processed_at::text AS "validFrom",
  (SELECT d.due_at::text FROM access.current_resource_role_due d
   WHERE d.route=f.route AND d.resource_id=f.resource_id ORDER BY d.due_at,d.interval_key LIMIT 1) AS "validUntil",
  f.processed_at <= $3::timestamptz AND i.complete AND NOT EXISTS (
    SELECT 1 FROM access.current_resource_role_due d WHERE d.route=f.route AND d.resource_id=f.resource_id
    AND d.due_at <= $3::timestamptz LIMIT 1) AS ready
  FROM access.current_resource_role_frontier f CROSS JOIN access.current_resource_role_install i
  WHERE f.route=$1 AND f.resource_id=$2 AND i.singleton`;
type FrontierRow = { version: string; validFrom: string; validUntil: string | null; ready: boolean };

/** Internal authorized writer-client read. Missing coverage is unavailable, including an unknown empty resource.
 * A continuation carries its original writer version/horizon. No Account liveness or permission is implied.
 */
export async function readCurrentResourceRolePage(
  client: AccessClient,
  input: CurrentResourceRolePageInput,
): Promise<CurrentResourceRolePage> {
  const { resource, at, after, limit } = input;
  validateResource(resource);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Array.isArray(input.roles) ||
    input.roles.length < 1 ||
    input.roles.length > 1000 ||
    input.roles.some(
      (role) => typeof role !== 'string' || role.length > 128 || /^[a-z][a-z0-9_.-]*$/.exec(role)?.[0] !== role,
    )
  )
    throw new TypeError('Invalid current resource role page');
  const roles = [...new Set(input.roles)].sort();
  const time = authoritativeTimeValue(at);
  // Frontier and directory are read in ONE statement snapshot. A second statement would allow a mutation
  // between the version read and the page, incorrectly certifying absence with the old version.
  const result = await client.query<FrontierRow & { rows: (CurrentResourceRoleKey & { valid: string | null })[] }>(
    `WITH frontier AS MATERIALIZED (${frontierSql}), page AS MATERIALIZED (
      SELECT c.* FROM unnest($4::text[]) role(grant_role) CROSS JOIN LATERAL (
        SELECT c.* FROM access.current_resource_role_key c, frontier f
        WHERE f.ready AND c.route=$1 AND c.resource_id=$2 AND c.grant_role=role.grant_role
          AND ($5::text IS NULL OR ROW(c.grant_role,c.subject_kind,c.subject_id,c.subject_role,c.interval_key) >
            ROW($5::text,$6::text,$7::uuid,$8::text,$9::bigint))
        ORDER BY c.grant_role,c.subject_kind,c.subject_id,c.subject_role,c.interval_key LIMIT $10
      ) c ORDER BY c.grant_role,c.subject_kind,c.subject_id,c.subject_role,c.interval_key LIMIT $10
    ) SELECT f.*, COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'grantRole',p.grant_role,'subjectKind',p.subject_kind,'subjectId',p.subject_id,
        'subjectRole',p.subject_role,'intervalKey',p.interval_key::text,'valid',g.valid::text)
        ORDER BY p.grant_role,p.subject_kind,p.subject_id,p.subject_role,p.interval_key)
      FROM page p LEFT JOIN LATERAL (
        SELECT source.* FROM access.resource_role_grant source
        WHERE source.erasure_key >= p.interval_key AND source.erasure_key <= p.interval_key
        ORDER BY source.erasure_key LIMIT 1
      ) g ON g.route=p.route AND g.resource_id=p.resource_id AND g.grant_role=p.grant_role
        AND g.subject_kind=p.subject_kind AND g.subject_id=p.subject_id AND g.subject_role=p.subject_role
        AND g.valid @> $3::timestamptz), '[]'::jsonb) AS rows FROM frontier f`,
    [
      resource.route,
      resource.id,
      time,
      roles,
      after?.key.grantRole ?? null,
      after?.key.subjectKind ?? null,
      after?.key.subjectId ?? null,
      after?.key.subjectRole ?? null,
      after?.key.intervalKey ?? null,
      limit + 1,
    ],
  );
  const row = result.rows[0];
  if (!row?.ready || row.rows.some((key) => key.valid === null)) return unavailable;
  const frontier: CurrentResourceRoleFrontier = {
    resource: { route: resource.route, id: resource.id },
    version: row.version,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    roles,
  };
  if (after && !sameFrontier(after.frontier, frontier)) return unavailable;
  const more = row.rows.length > limit;
  const rows = row.rows.slice(0, limit) as (CurrentResourceRoleKey & { valid: string })[];
  const last = rows.at(-1);
  return {
    status: 'ready',
    rows,
    frontier,
    after:
      more && last
        ? {
            frontier,
            key: {
              grantRole: last.grantRole,
              subjectKind: last.subjectKind,
              subjectId: last.subjectId,
              subjectRole: last.subjectRole,
              intervalKey: last.intervalKey,
            },
          }
        : null,
  };
}

/** Call on the SAME real Realm writer transaction before concluding a traversal or applying selection.
 * FOR SHARE serializes native role writers through commit. The Realm owner supplies its own serialization.
 * Applying a candidate additionally requires shareAccount(tx,id) / fenceOperationalAccount(tx,id).
 */
export async function verifyCurrentResourceRoleFrontier(
  client: AccessClient,
  input: CurrentResourceRoleVerificationInput,
): Promise<CurrentResourceRoleVerification> {
  validateResource(input.resource);
  const result = await client.query<FrontierRow>(`${frontierSql} FOR SHARE OF f`, [
    input.resource.route,
    input.resource.id,
    authoritativeTimeValue(input.at),
  ]);
  const row = result.rows[0];
  if (
    !row?.ready ||
    !sameFrontier(input.frontier, {
      resource: input.resource,
      version: row.version,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      roles: input.frontier.roles,
    })
  )
    return unavailable;
  return { status: 'ready' };
}
