import canonicalize from 'canonicalize';
import { createResourcePublicEligibility, deadlineClient, accessCheck } from './domain-ports.ts';
import type { ResourceEligibility } from '../access/index.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { AccessCheck, AccessClient, Actor, Resource } from '../request/access.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { systemCommunityAmbient, type CommunityAmbient } from './ambient.ts';
import {
  realmEligibilityAccessWork,
  realmReadBanAccounts,
  viewerActionEligibilityWork,
} from './eligibility-access-work.ts';
import { realmRecord as record } from './realm-record.ts';
import type { RealmDependencies, RealmView } from './realm.ts';
import read from './realm-read.sql';
import bindingRead from './container-lifecycle-binding.sql';
import currentReadBan from './read-ban-current.sql';

type RealmRow = NonNullable<Awaited<ReturnType<typeof read.run>>>;

/** Exact current source for a composed management read. The caller owns disclosure,
 * management, partition and lifecycle checks on this same snapshot. */
export async function readRealmSettingsHead(
  client: Parameters<typeof read.run>[0],
  realmId: string,
  at: string,
): Promise<RealmView | null> {
  const route = routeOf(realmId);
  if (route === null) return null;
  const row = await read.run(client, { route, id: realmId, at });
  return row ? record(row) : null;
}

/** One head seek at Access's authoritative T, with the native grant branch
 * and no current ban required for protected Realms. Missing and denied resources both return null.
 */
export async function readRealm(
  deps: Pick<RealmDependencies, 'pool' | 'access'> & Partial<CommunityAmbient>,
  actor: Actor,
  realmId: string,
  context: { deadline: number },
): Promise<RealmView | null> {
  const route = routeOf(realmId);
  const now = deps.deadlineNow ?? systemCommunityAmbient.deadlineNow;
  if (route === null || !Number.isFinite(context.deadline) || now() >= context.deadline) return null;
  let current: RealmRow | null = null;
  const resource = { route, id: realmId };
  const eligibility = readEligibility(resource, (row) => {
    current = row;
  });
  try {
    const check = await accessCheck(
      deps.access,
      actor,
      'realm:read',
      { ...resource, eligibility },
      { pool: deps.pool, deadline: context.deadline },
    );
    return await withConnection(deps.pool, async (client) => {
      if (!(await allowRealmRead(check, deadlineClient(client, context.deadline)))) return null;
      return current ? record(current) : null;
    });
  } catch (error) {
    if (realmReadDenied(error)) return null;
    throw error;
  }
}

// Access and HTTP problem mapping share this module graph; construct the error only during a read.
const realmReadDenials = new WeakSet<Error>();
function realmReadDeniedError(): ProblemError {
  const error = new ProblemError('not_found');
  realmReadDenials.add(error);
  return error;
}

function realmReadDenied(error: unknown): boolean {
  return (
    (error instanceof Error && realmReadDenials.has(error)) ||
    (error instanceof ProblemError && error.code === 'not_found')
  );
}

/** Boolean Realm-read checks conceal eligibility not_found as a closed miss. */
export async function allowRealmRead(
  check: AccessCheck,
  client: AccessClient,
  time?: AuthoritativeTime,
): Promise<boolean> {
  try {
    return await check(client, time);
  } catch (error) {
    if (realmReadDenied(error)) return false;
    throw error;
  }
}

type BindingRow = Awaited<ReturnType<typeof bindingRead.run>>;
/** Identity and lifecycle only. Heads change on metadata revisions; visibility is rechecked from the current row. */
function containerChain(binding: NonNullable<BindingRow>) {
  return {
    realm_id: binding.realm_id,
    space_id: binding.space_id,
    context_id: binding.context_id,
    realm_version: binding.realm_version,
    space_version: binding.space_version,
  };
}

function readEligibility(identity: Resource, observe?: (row: RealmRow | null) => void): ResourceEligibility {
  const resource = Object.freeze({ route: identity.route, id: identity.id });
  const native = realmEligibilityAccessWork<{ binding: BindingRow }>(resource);
  return createResourcePublicEligibility({
    resource,
    action: 'realm:read',
    work: native.work,
    prepare(context) {
      return native.prepare(context, async (dispatch) => {
        const parameters = { ...resource, at: 'infinity', subject: null };
        return {
          binding: await dispatch(
            native.bindingPlan,
            parameters,
            () => bindingRead.run(deadlineClient(context.pool, context.deadline), parameters),
            true,
          ),
        };
      });
    },
    verify(context) {
      return native.verify(context, async (dispatch) => {
        const { client, actor, at, evidence } = context;
        const parameters = { ...resource, at };
        const row = await dispatch(native.realmPlan, parameters, () => read.run(client, parameters));
        const binding = { ...resource, at, subject: null };
        const current = await dispatch(native.bindingPlan, binding, () => bindingRead.run(client, binding));
        if (
          !row ||
          !current ||
          !evidence.binding ||
          canonicalize(containerChain(current)) !== canonicalize(containerChain(evidence.binding))
        )
          throw realmReadDeniedError();
        if (row.visibility === 'protected' && actor.kind === 'account') {
          // Auth/Access validates the assignment reference. Its principal is a
          // second fixed identity, never an expansion of grants or memberships.
          const accountIds = realmReadBanAccounts(actor);
          const ban = { route: resource.route, realm_id: resource.id, account_ids: accountIds, at };
          if (await dispatch(native.banPlan(accountIds.length), ban, () => currentReadBan.run(client, ban)))
            // A false floor alone would leave independent grants available.
            throw realmReadDeniedError();
        }
        observe?.(row);
        return row.visibility === 'public';
      });
    },
  });
}

export function realmReadEligibility(identity: Resource): ResourceEligibility {
  return readEligibility(identity);
}

export const realmViewerActionResource: import('../access/viewer-actions.ts').ViewerActionResource = {
  readAction: 'realm:read',
  async read(client, ids, at, _time, work) {
    const dispatch = async () => {
      const result = await client.query<{ id: string; public: boolean }>(
        `SELECT row.* FROM unnest($1::integer[], $2::uuid[]) AS wanted(route,id)
       CROSS JOIN LATERAL (
         WITH identity AS MATERIALIZED (
           SELECT h.* FROM community.realm h
           WHERE h.route = wanted.route AND h.realm_id = wanted.id
           ORDER BY h.route, h.realm_id LIMIT 1
         )
         SELECT h.realm_id AS id, h.visibility = 'public' AS public
         FROM identity h
         CROSS JOIN LATERAL (
           SELECT r.created_at FROM community.realm_revision r
           WHERE r.route = h.route AND r.realm_id = h.realm_id AND r.revision_id = h.head_revision_id
           ORDER BY r.route, r.realm_id, r.revision_id LIMIT 1
         ) r
         WHERE h.state = 'active'
           AND EXISTS (SELECT 1 FROM community.space s WHERE s.route=h.route AND s.space_id=h.space_id AND s.state='active')
           AND h.created_at <= $3::timestamptz AND r.created_at <= $3::timestamptz
       ) row`,
        [ids.map((id) => routeOf(id)!), ids, at],
      );
      return Object.fromEntries(result.rows.map((row) => [row.id, row.public]));
    };
    return work
      ? work.run('community.realm.viewer-resource', viewerActionEligibilityWork('realm', ids, at), dispatch)
      : dispatch();
  },
};
