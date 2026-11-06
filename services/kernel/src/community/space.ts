import { bindRealmDiscoveryCommand } from './discovery-source.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  createResourcePublicEligibility,
  initializeResourceGrants,
  parentCreationAuthorization,
  resourceAuthorization,
  type ResourceEligibility,
} from '../access/index.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandTransaction,
} from '../command/command.ts';
import { platformRootAnchor } from '../commerce/catalogue.ts';
import { ProblemError } from '../http/problem.ts';
import { withConnection } from '../database/pool.ts';
import type { Access, AccessCheck, AccessClient, Actor, Resource } from '../request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../route/route.ts';
import { readRealm } from './realm.ts';
import realmSpace from './realm-space.sql';
import bindingRead from './container-lifecycle-binding.sql';
import read from './space-read.sql';
import insert from './space-insert.sql';
import append from './space-revision.sql';
import moveHead from './space-head.sql';
import eligibilityRead from './space-eligibility-read.sql';
import { viewerActionEligibilityWork, spaceEligibilityAccessWork } from './eligibility-access-work.ts';
import type { CommunityAmbient } from './ambient.ts';

export type SpaceDependencies = Readonly<{ pool: Pool; access: Access; routeKey: Uint8Array; clock?: () => Date }>;
export type SpaceContext = Readonly<{ idempotencyKey: string; deadline: number }>;
export type SpaceInput = Readonly<{ title: string; summary?: string }>;
export type SpaceUpdate = Readonly<{ spaceId: string; expectedHead: string; title?: string; summary?: string }>;
export type Space = Readonly<{
  spaceId: string;
  state: string;
  headRevisionId: string;
  createdAt: string;
  creator: string;
  predecessor: string | null;
  address: string | null;
  title: string;
  summary: string;
  revisionCreatedAt: string;
  author: string;
}>;

export class SpaceConflictError extends Error {
  constructor() {
    super('Space head has changed');
    this.name = 'SpaceConflictError';
  }
}
export class SpaceInputError extends Error {
  constructor() {
    super('Invalid Space metadata or revision identity');
    this.name = 'SpaceInputError';
  }
}
function account(actor: Actor) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  return actor;
}
function metadata(title: unknown, summary: unknown): void {
  if (
    typeof title !== 'string' ||
    [...title].length < 1 ||
    [...title].length > 1024 ||
    typeof summary !== 'string' ||
    [...summary].length > 4096 ||
    title.includes('\0') ||
    summary.includes('\0')
  )
    throw new SpaceInputError();
}
function options(
  deps: SpaceDependencies,
  actor: Actor,
  route: number,
  kind: string,
  input: unknown,
  context: SpaceContext,
) {
  const identity = principalCommandIdentity(account(actor));
  return {
    ...identity,
    partition: partitionOf(route),
    deadline: context.deadline,
    clock: deps.clock,
    receipt: {
      kind,
      key: context.idempotencyKey,
      digest: createHash('sha256')
        .update(canonicalize([identity, kind, input])!)
        .digest(),
    },
  };
}

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

export function spaceReadEligibility(identity: Resource): ResourceEligibility {
  const resource = Object.freeze({ route: identity.route, id: identity.id });
  const native = spaceEligibilityAccessWork<Awaited<ReturnType<typeof eligibilityRead.run>>>(resource);
  return createResourcePublicEligibility<NonNullable<Awaited<ReturnType<typeof eligibilityRead.run>>>>({
    resource,
    action: 'space:read',
    work: native.work,
    prepare(context) {
      return native.prepare(context, async (dispatch) => {
        const { pool, resource: identity } = context;
        const parameters = { route: identity.route, id: identity.id, at: new Date().toISOString() };
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

export async function createSpace(deps: SpaceDependencies, actor: Actor, input: SpaceInput, context: SpaceContext) {
  const creator = account(actor).accountId;
  // Snapshot request fields before authorization or receipt lookup yields.
  const body = { title: input.title, summary: input.summary === undefined ? '' : input.summary };
  const kind = 'community.space.create';
  const route = anchorRoute(deps.routeKey, `${creator}\n${kind}\n${context.idempotencyKey}`);
  const resource = { route, id: newId(route) };
  const revision = newId(route);
  const inserted = new WeakSet<CommandTransaction>();
  const authorization = parentCreationAuthorization({
    access: deps.access,
    actor,
    action: 'space:create',
    parent: platformRootAnchor,
    context: {
      pool: deps.pool,
      deadline: context.deadline,
      resource,
      creation: {
        async validate(tx, target, time) {
          if (!inserted.has(tx)) return false;
          const row = await read.run(tx, { route: target.route, id: target.id, at: authoritativeTimeValue(time) });
          return row?.inserted_here === true && row.creator === creator && row.head_revision_id === revision;
        },
      },
    },
  });
  return runCommand(
    deps.pool,
    { ...options(deps, actor, route, kind, body, context), authorization },
    async (tx, command) => {
      bindRealmDiscoveryCommand(tx);
      metadata(body.title, body.summary);
      const at = authoritativeTimeValue(command.time);
      await insert.run(tx, { route, id: resource.id, revision, at, creator });
      await append.run(tx, {
        route,
        id: resource.id,
        revision,
        predecessor: null,
        address: null,
        ...body,
        at,
        author: creator,
      });
      inserted.add(tx);
      await initializeResourceGrants(tx, { resource, type: 'community.space', creator });
      return {
        value: { spaceId: resource.id, revisionId: revision },
        events: [
          {
            type: 'com.rezics.community.space.created.v1',
            subject: resource.id,
            data: { spaceId: resource.id, revisionId: revision },
          },
        ],
      };
    },
  );
}

export async function updateSpace(deps: SpaceDependencies, actor: Actor, input: SpaceUpdate, context: SpaceContext) {
  const author = account(actor).accountId;
  const body = { spaceId: input.spaceId, expectedHead: input.expectedHead, title: input.title, summary: input.summary };
  const route = routeOf(body.spaceId);
  if (route === null) throw new SpaceInputError();
  const current = new WeakMap<AuthoritativeTime, Space>();
  const authorization = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'space:manage',
    anchor: {
      resource: { route, id: body.spaceId },
      async validate(client, time) {
        const row = await readSpace(client, body.spaceId, authoritativeTimeValue(time));
        if (!row) return false;
        current.set(time, row);
        return true;
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(route) },
  });
  return runCommand(
    deps.pool,
    { ...options(deps, actor, route, 'community.space.update', body, context), authorization },
    async (tx, command) => {
      bindRealmDiscoveryCommand(tx);
      const previous = current.get(command.time)!;
      if (routeOf(body.expectedHead) !== route) throw new SpaceInputError();
      if (previous.headRevisionId !== body.expectedHead) throw new SpaceConflictError();
      const title = body.title === undefined ? previous.title : body.title;
      const summary = body.summary === undefined ? previous.summary : body.summary;
      metadata(title, summary);
      const revision = newId(route);
      await append.run(tx, {
        route,
        id: body.spaceId,
        revision,
        predecessor: body.expectedHead,
        address: previous.address,
        title,
        summary,
        at: authoritativeTimeValue(command.time),
        author,
      });
      const changed = await moveHead.run(tx, { route, id: body.spaceId, revision, expected: body.expectedHead });
      if (!changed) throw new SpaceConflictError();
      return {
        value: { spaceId: body.spaceId, revisionId: revision },
        events: [
          {
            type: 'com.rezics.community.space.updated.v1',
            subject: body.spaceId,
            data: { spaceId: body.spaceId, revisionId: revision },
          },
        ],
      };
    },
  );
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
