import { hasNativeRealmGrantCommands, type createGrantCommands } from './grant-commands.ts';
import type { Pool } from 'pg';
import { realmReadEligibility } from '../community/realm.ts';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { readPublicIdentities, type PublicIdentity } from './account-data.ts';
import { deadlineClient } from './authenticate.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import { mountedExposureCatalogue } from './gates/visibility.ts';
import { createResourcePublicEligibility } from './eligibility.ts';
import type { MountedRoute } from '../http/request.ts';
import type { GrantSubject } from './grant-subject.ts';
import { resourceRoleCatalogue } from './resource-roles.ts';
import type { ViewerActionResources } from './viewer-actions.ts';

export type ManagedGrant = {
  kind: 'direct' | 'role';
  state: 'active' | 'scheduled';
  subject: GrantSubject;
  actions: string[];
  role: string | null;
  valid: string;
  startsAt: string | null;
  endsAt: string | null;
  manageable: boolean;
};
export type GrantReadPage = {
  resource: { id: string; route: number; type: string };
  authority: { accountId: string; principalId: string | null; clientId: string };
  roles: { id: string; actions: string[]; delegable: boolean }[];
  actions: string[];
  grants: ManagedGrant[];
  identities: PublicIdentity[];
  next: string | null;
  /** Realm mutation requires the genuine native command composition. */
  mutationState: 'ready' | 'realm_guard_unavailable';
};

type Row = {
  kind: 'direct' | 'role';
  key: string;
  subject_kind: string;
  subject_id: string;
  subject_role: '' | 'owner' | 'member';
  name: string;
  valid: string;
  active: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
};

/** Exact-resource management read. No caller-supplied type, authority or policy is accepted. */
export async function readResourceGrants(
  deps: {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    resources: ViewerActionResources;
    clock: () => Date;
    commands?: ReturnType<typeof createGrantCommands>;
    routes?: readonly MountedRoute[];
  },
  actor: Actor,
  input: { resourceId: string; cursor?: string },
  deadline: number,
): Promise<GrantReadPage> {
  const route = routeOf(input.resourceId);
  if (actor.kind !== 'account' || route === null) throw new ProblemError('not_found');
  const resource = { route, id: input.resourceId };
  const context = { pool: deps.pool, deadline };
  const management = await accessCheck(deps.access, actor, 'access:grant', resource, context);
  const time = await withConnection(deps.pool, (client) => mintReadTime(client, deps.clock));
  try {
    const at = authoritativeTimeValue(time);
    // Nothing about the target, subjects or even the existence of a page precedes authorization.
    const allowed = await withConnection(deps.pool, (client) => management(deadlineClient(client, deadline), time));
    if (!allowed) throw new ProblemError('not_found');
    const initialized = await deadlineClient(deps.pool, deadline).query<{ resource_type: string }>(
      'SELECT resource_type FROM access.resource_initialization WHERE route = $1 AND resource_id = $2',
      [route, resource.id],
    );
    const global = resource.route === PLATFORM_RESOURCE.route && resource.id === PLATFORM_RESOURCE.id;
    // Global predates ordinary resource initialization; its native owner still
    // verifies actual Context existence/currentness before any disclosure.
    const type = global ? 'semantic.context' : initialized.rows[0]?.resource_type;
    const catalogue = resourceRoleCatalogue(deps.access);
    const template = type ? catalogue?.types.get(type) : undefined;
    const source = type ? deps.resources.get(type) : undefined;
    if (!type || !template || !catalogue || !source) throw new ProblemError('dependency_unavailable');
    const owner = source.prepare
      ? await source.prepare({ pool: deps.pool, access: deps.access, actor, ids: [resource.id], deadline })
      : source;
    const globalReadEligibility = global
      ? createResourcePublicEligibility({
          resource,
          action: owner.readAction,
          async prepare() {
            return {};
          },
          async verify({ client, at, time }) {
            return (await owner.read(client, [resource.id], at, time))[resource.id] === true;
          },
        })
      : undefined;
    const roleIds = [...new Set([...(template.owner ? [template.owner] : []), ...template.standing])];
    const gateActions =
      global && deps.routes ? mountedExposureCatalogue(deps.routes).groups.map((group) => `gate:${group}`) : [];
    const actionIds = [
      ...new Set([
        ...roleIds.flatMap((id) => [...(catalogue.roles.get(id) ?? [])]),
        ...(global ? ['gate:any', ...gateActions] : []),
      ]),
    ].sort();
    const checks = new Map(
      await Promise.all(
        [...new Set([owner.readAction, ...actionIds])].map(
          async (action) =>
            [
              action,
              await accessCheck(
                deps.access,
                actor,
                action,
                type === 'community.realm' && action === owner.readAction
                  ? { ...resource, eligibility: realmReadEligibility(resource) }
                  : globalReadEligibility && action === owner.readAction
                    ? { ...resource, eligibility: globalReadEligibility }
                    : resource,
                context,
              ),
            ] as const,
        ),
      ),
    );
    const binding = {
      route: 'GET /v1/grants',
      viewer: actor.accountId,
      query: { resourceId: resource.id, clientId: actor.clientId, requestedBy: actor.requestedBy, limit: 20 },
    };
    let afterKind = 'direct';
    let afterKey = '0';
    if (input.cursor) {
      const decoded = await decodeListCursor(deps.tokens, binding, input.cursor, new Date(at));
      if (
        !decoded.ok ||
        decoded.epoch !== 1 ||
        decoded.after.length !== 2 ||
        !['direct', 'role'].includes(String(decoded.after[0])) ||
        !/^\d{1,20}$/.test(String(decoded.after[1]))
      )
        throw new ProblemError('invalid_cursor');
      afterKind = String(decoded.after[0]);
      afterKey = String(decoded.after[1]);
    }
    return await withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        if (!(await management(client, time))) throw new ProblemError('not_found');
        const current = await owner.read(client, [resource.id], at, time);
        // The owner's current head/state reader distinguishes absence from a private floor.
        if (!(resource.id in current) || !(await checks.get(owner.readAction)!(client, time)))
          throw new ProblemError('not_found');
        const held = new Set<string>();
        for (const action of actionIds) if (await checks.get(action)!(client, time)) held.add(action);
        // Match ordinary grantCommand's sole covering-action exception. This is
        // delegation advice, never a replacement for command-time authorization.
        if (global && held.has('gate:any')) for (const action of gateActions) held.add(action);
        const rows = (
          await client.query<Row>(
            `
        SELECT * FROM (
          SELECT 'direct'::text AS kind, erasure_key::text AS key, subject_kind, subject_id, subject_role,
                 action AS name, valid::text, lower(valid) AS starts_at, upper(valid) AS ends_at, valid @> $3::timestamptz AS active
          FROM access.resource_grant
          WHERE route = $1 AND resource_id = $2 AND valid && tstzrange($3::timestamptz, NULL, '[)')
            AND ($4::text < 'direct' OR ($4 = 'direct' AND erasure_key > $5::bigint))
          UNION ALL
          SELECT 'role'::text, erasure_key::text, subject_kind, subject_id, subject_role,
                 grant_role, valid::text, lower(valid), upper(valid), valid @> $3::timestamptz
          FROM access.resource_role_grant
          WHERE route = $1 AND resource_id = $2 AND valid && tstzrange($3::timestamptz, NULL, '[)')
            AND ($4::text < 'role' OR ($4 = 'role' AND erasure_key > $5::bigint))
        ) page ORDER BY kind, key::bigint LIMIT 21`,
            [route, resource.id, at, afterKind, afterKey],
          )
        ).rows;
        const page = rows.slice(0, 20);
        const realmGuardMissing =
          type === 'community.realm' && !hasNativeRealmGrantCommands(deps.commands, deps.pool, deps.access);
        const groupIds = [...new Set(page.filter((row) => row.subject_role !== '').map((row) => row.subject_id))];
        // Resolve only the bounded, explicitly granted group anchors. Never expand their members or read a title.
        const realmGroups = new Set(
          groupIds.length
            ? (
                await client.query<{ resource_id: string }>(
                  `SELECT initialized.resource_id FROM unnest($1::integer[], $2::uuid[]) AS wanted(route, id)
         JOIN access.resource_initialization initialized
           ON initialized.route = wanted.route AND initialized.resource_id = wanted.id
         WHERE initialized.resource_type = 'community.realm'`,
                  [groupIds.map((id) => routeOf(id)!), groupIds],
                )
              ).rows.map((row) => row.resource_id)
            : [],
        );
        const grants: ManagedGrant[] = page.map((row) => {
          const actions = row.kind === 'direct' ? [row.name] : [...(catalogue.roles.get(row.name) ?? [])];
          return {
            kind: row.kind,
            state: row.active ? 'active' : 'scheduled',
            subject:
              row.subject_kind === 'active_accounts'
                ? { kind: 'active_accounts' }
                : row.subject_role === ''
                  ? { kind: 'account', id: row.subject_id }
                  : realmGroups.has(row.subject_id)
                    ? { kind: 'realm', id: row.subject_id, role: row.subject_role }
                    : { kind: 'organization', id: row.subject_id, role: row.subject_role },
            actions,
            role: row.kind === 'role' ? row.name : null,
            valid: row.valid,
            startsAt: row.starts_at?.toISOString() ?? null,
            endsAt: row.ends_at?.toISOString() ?? null,
            manageable:
              !realmGuardMissing &&
              !realmGroups.has(row.subject_id) &&
              actions.length > 0 &&
              actions.every((action) => held.has(action)),
          };
        });
        const principalId = actor.requestedBy?.split(':')[3] ?? null;
        const ids = [
          ...new Set([
            actor.accountId,
            ...(principalId ? [principalId] : []),
            ...grants.flatMap((grant) =>
              grant.subject.kind === 'active_accounts' || grant.subject.kind === 'realm' ? [] : [grant.subject.id],
            ),
          ]),
        ];
        const identities = await readPublicIdentities(
          client,
          ids.map((id) => routeOf(id)!),
          ids,
        );
        const last = page.at(-1);
        const next =
          rows.length > 20 && last
            ? await encodeListCursor(deps.tokens, binding, { epoch: 1, after: [last.kind, last.key] }, new Date(at))
            : null;
        await client.query('COMMIT');
        return {
          resource: { ...resource, type },
          authority: { accountId: actor.accountId, principalId, clientId: actor.clientId },
          roles: roleIds.map((id) => ({
            id,
            actions: [...catalogue.roles.get(id)!],
            delegable: !realmGuardMissing && catalogue.roles.get(id)!.every((action) => held.has(action)),
          })),
          actions: realmGuardMissing ? [] : [...held],
          grants,
          identities,
          next,
          mutationState: realmGuardMissing ? 'realm_guard_unavailable' : 'ready',
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } finally {
    releaseOperationalTime(time);
  }
}
