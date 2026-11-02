import { bindRealmDiscoveryCommand } from './discovery-source.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  createResourcePublicEligibility,
  initializeResourceGrants,
  parentCreationAuthorization,
  resourceAuthorization,
  type ResourceEligibility,
} from '../access/index.ts';
import { accessCommandAttempt } from '../access/command-admission.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { permissionEvidenceDeadline } from '../access/permission.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../access/resource-roles.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { platformRootAnchor } from '../commerce/catalogue.ts';
import { REACTION_KINDS } from '../content/events.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type Actor, type Resource } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { publicContextEligibility } from '../semantic/context.ts';
import { ensureRealmMemberGrant } from './participation.ts';
import { realmContinuityView, realmGovernanceAuthorization, type RealmContinuity } from './realm-continuity.ts';
import type { RealmVotes } from './realm-votes.ts';
import type { SpaceDependencies, SpaceContext } from './space.ts';
import { emptyRealmPresentation, realmPresentation, type RealmPresentation } from './presentation.ts';
import { claimRealmPresentationMedia } from '../content/realm-media.ts';
import { prepareRealmRulesSelection } from '../content/community-presentation-rules.ts';
import read from './realm-read.sql';
import bindingRead from './container-lifecycle-binding.sql';
import currentReadBan from './read-ban-current.sql';
import insert from './realm-insert.sql';
import append from './realm-revision.sql';
import moveHead from './realm-head.sql';
import host from './realm-space.sql';
import { realmEligibilityAccessWork, realmReadBanAccounts } from './eligibility-access-work.ts';

export type RealmDependencies = SpaceDependencies;
export type RealmContext = SpaceContext;
export type RealmInput = Readonly<{
  spaceId: string;
  title: string;
  summary?: string;
  visibility: 'public' | 'protected';
  contextId: string;
  votes?: RealmVotes;
}>;
export type RealmUpdate = Readonly<{
  realmId: string;
  expectedHead: string;
  title?: string;
  summary?: string;
  visibility?: 'public' | 'protected';
  contextId?: string;
  votes?: RealmVotes;
  presentation?: RealmPresentation;
}>;
type RealmRow = NonNullable<Awaited<ReturnType<typeof read.run>>>;
export type Realm = Readonly<{
  realmId: string;
  spaceId: string;
  state: string;
  visibility: string;
  contextId: string;
  headRevisionId: string;
  createdAt: string;
  creator: string;
  predecessor: string | null;
  title: string;
  summary: string;
  presentation: RealmPresentation;
  revisionCreatedAt: string;
  author: string;
}>;
/** Head read used by HTTP. The scheme and vote weights travel on the same row. */
export type RealmView = Realm &
  RealmContinuity &
  Readonly<{
    boardSchemeId: string | null;
    votes: RealmVotes;
  }>;
/** Omitted revision votes use this column default, which the inherit trigger copies from the predecessor. */
const inheritedVotes: RealmVotes = Object.freeze({ upvote: 1, downvote: -1 });
export class RealmConflictError extends Error {
  constructor() {
    super('Realm head has changed');
    this.name = 'RealmConflictError';
  }
}
export class RealmInputError extends Error {
  constructor() {
    super('Invalid Realm metadata or revision identity');
    this.name = 'RealmInputError';
  }
}
function account(actor: Actor) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  return actor;
}
function voteMap(value: unknown, invalid: new () => Error): RealmVotes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new invalid();
  const source = value as Record<string, unknown>;
  const present = Object.keys(source);
  if (present.length > 7) throw new invalid();
  const votes: Partial<Record<(typeof REACTION_KINDS)[number], 1 | -1>> = {};
  for (const kind of REACTION_KINDS) {
    if (!Object.hasOwn(source, kind)) continue;
    const weight = source[kind];
    if (weight !== 1 && weight !== -1) throw new invalid();
    votes[kind] = weight;
  }
  if (Object.keys(votes).length !== present.length) throw new invalid();
  return Object.freeze(votes);
}
function metadata(title: unknown, summary: unknown, visibility: unknown, contextId: string) {
  if (
    typeof title !== 'string' ||
    [...title].length < 1 ||
    [...title].length > 1024 ||
    typeof summary !== 'string' ||
    [...summary].length > 4096 ||
    title.includes('\0') ||
    summary.includes('\0') ||
    (visibility !== 'public' && visibility !== 'protected') ||
    routeOf(contextId) === null
  )
    throw new RealmInputError();
}
function options(
  deps: RealmDependencies,
  actor: Actor,
  route: number,
  kind: string,
  input: unknown,
  context: RealmContext,
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
function record(row: RealmRow): RealmView {
  return {
    ...realmContinuityView(row),
    realmId: row.realm_id,
    spaceId: row.space_id,
    state: row.state,
    visibility: row.visibility,
    contextId: row.context_id,
    boardSchemeId: row.board_scheme_id,
    headRevisionId: row.head_revision_id,
    createdAt: new Date(row.created_at).toISOString(),
    creator: row.creator,
    predecessor: row.predecessor,
    title: row.title,
    summary: row.summary,
    revisionCreatedAt: new Date(row.revision_created_at).toISOString(),
    author: row.author,
    votes: voteMap(row.votes, TypeError),
    presentation: realmPresentation(row.presentation),
  };
}

/** One head seek at Access's authoritative T, with the native grant branch
 * and no current ban required for protected Realms. Missing and denied resources both return null.
 */
export async function readRealm(
  deps: Pick<RealmDependencies, 'pool' | 'access'>,
  actor: Actor,
  realmId: string,
  context: { deadline: number },
): Promise<RealmView | null> {
  const route = routeOf(realmId);
  if (route === null || !Number.isFinite(context.deadline) || Date.now() >= context.deadline) return null;
  let current: RealmRow | null = null;
  const resource = { route, id: realmId };
  const eligibility = readEligibility(resource, (row) => {
    current = row;
  });
  const check = await accessCheck(
    deps.access,
    actor,
    'realm:read',
    { ...resource, eligibility },
    { pool: deps.pool, deadline: context.deadline },
  );
  try {
    return await withConnection(deps.pool, async (client) => {
      if (!(await check(deadlineClient(client, context.deadline)))) return null;
      return current ? record(current) : null;
    });
  } catch (error) {
    if (error instanceof Error && realmReadDenials.has(error)) return null;
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

function readEligibility(identity: Resource, observe?: (row: RealmRow | null) => void): ResourceEligibility {
  const resource = Object.freeze({ route: identity.route, id: identity.id });
  const native = realmEligibilityAccessWork<{ binding: Awaited<ReturnType<typeof bindingRead.run>> }>(resource);
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
        if (!row || !current || canonicalize(current) !== canonicalize(evidence.binding)) throw realmReadDeniedError();
        if (row?.visibility === 'protected' && actor.kind === 'account') {
          // Auth/Access validates the assignment reference. Its principal is a
          // second fixed identity, never an expansion of grants or memberships.
          const accountIds = realmReadBanAccounts(actor);
          const ban = { route: resource.route, realm_id: resource.id, account_ids: accountIds, at };
          if (await dispatch(native.banPlan(accountIds.length), ban, () => currentReadBan.run(client, ban)))
            // A false floor alone would leave independent grants available.
            throw realmReadDeniedError();
        }
        observe?.(row);
        return row?.visibility === 'public';
      });
    },
  });
}

export function realmReadEligibility(identity: Resource): ResourceEligibility {
  return readEligibility(identity);
}

type Requirement = { action: string; resource: Resource };
/** Add independently anchored checks to the parent's exact trusted context.
 * Production Access caches its single admission observation by actor/live T.
 */
function requirements(
  access: Access,
  extra: readonly Requirement[],
  validate?: (client: Parameters<Access['authorize']>[0], time: AuthoritativeTime) => Promise<boolean>,
) {
  const deadlines = new WeakMap<AuthoritativeTime, number>();
  const combined = deriveAccess(access, {
    async prepare(actor, action, resource, context) {
      const attempt = accessCommandAttempt(context);
      if (!attempt) throw new GrantDeniedError();
      const primary = await access.prepare?.(actor, action, resource, context);
      let deadline = Math.min(context.deadline, permissionEvidenceDeadline(primary) ?? -Infinity);
      const checks: (Requirement & { evidence: unknown })[] = [];
      for (const requirement of extra) {
        const evidence = await access.prepare?.(actor, requirement.action, requirement.resource, context);
        deadline = Math.min(deadline, permissionEvidenceDeadline(evidence) ?? -Infinity);
        checks.push({ ...requirement, evidence });
      }
      if (Date.now() >= deadline) throw new GrantDeniedError();
      await within(deadline, () =>
        withConnection(context.pool, async (client) => {
          const bounded = deadlineClient(client, deadline);
          if (validate && !(await validate(bounded, attempt.time))) throw new GrantDeniedError();
          for (const check of checks)
            if (!(await access.authorize(bounded, actor, check.action, check.resource, check.evidence, attempt.time)))
              throw new GrantDeniedError();
        }),
      );
      deadlines.set(attempt.time, deadline);
      return primary;
    },
  });
  const roles = resourceRoleCatalogue(access);
  if (roles) installResourceRoleCatalogue(combined, roles);
  return {
    access: combined,
    bound(authorization: CommandAuthorization): CommandAuthorization {
      return {
        ...authorization,
        async authorize(tx, attempt, proof) {
          if (Date.now() >= (deadlines.get(attempt.time) ?? -Infinity)) throw new GrantDeniedError();
          return authorization.authorize(tx, attempt, proof);
        },
      };
    },
  };
}
function contextRequirement(id: string): Requirement {
  const route = routeOf(id);
  if (route === null) throw new RealmInputError();
  const resource = { route, id };
  return { action: 'context:read', resource: { ...resource, eligibility: publicContextEligibility(resource) } };
}

export async function createRealm(deps: RealmDependencies, actor: Actor, input: RealmInput, context: RealmContext) {
  const creator = account(actor).accountId;
  const votes = input.votes === undefined ? undefined : voteMap(input.votes, RealmInputError);
  const body = {
    spaceId: input.spaceId,
    title: input.title,
    summary: input.summary === undefined ? '' : input.summary,
    visibility: input.visibility,
    contextId: input.contextId,
    ...(votes === undefined ? {} : { votes }),
  };
  const route = routeOf(body.spaceId);
  if (route === null) throw new RealmInputError();
  const resource = { route, id: newId(route) },
    revision = newId(route);
  const available = new WeakMap<AuthoritativeTime, boolean>();
  const inserted = new WeakSet<CommandTransaction>();
  const combined = requirements(
    deps.access,
    [{ action: 'space:manage', resource: { route, id: body.spaceId } }, contextRequirement(body.contextId)],
    async (client, time) => {
      const row = await host.run(client, { route, space: body.spaceId, at: authoritativeTimeValue(time) });
      available.set(time, !!row && row.realm_id === null);
      return !!row;
    },
  );
  const authorization = parentCreationAuthorization({
    access: combined.access,
    actor,
    action: 'realm:create',
    parent: platformRootAnchor,
    context: {
      pool: deps.pool,
      deadline: context.deadline,
      resource,
      creation: {
        async validate(tx, target, time) {
          if (!inserted.has(tx)) return false;
          const row = await read.run(tx, { route: target.route, id: target.id, at: authoritativeTimeValue(time) });
          return (
            row?.inserted_here === true &&
            row.creator === creator &&
            row.space_id === body.spaceId &&
            row.head_revision_id === revision
          );
        },
      },
    },
  });
  return runCommand(
    deps.pool,
    {
      ...options(deps, actor, route, 'community.realm.create', body, context),
      authorization: combined.bound(authorization),
    },
    async (tx, command) => {
      bindRealmDiscoveryCommand(tx);
      // An authorized receipt replay returns before this slot gate. New attempts
      // must have observed a free slot at T; the unique key arbitrates contenders.
      if (!available.get(command.time)) throw new GrantDeniedError();
      metadata(body.title, body.summary, body.visibility, body.contextId);
      const at = authoritativeTimeValue(command.time);
      const storedVotes = votes ?? inheritedVotes;
      await insert.run(tx, {
        route,
        id: resource.id,
        space: body.spaceId,
        revision,
        at,
        creator,
        visibility: body.visibility,
        context: body.contextId,
        votes: storedVotes,
      });
      await append.run(tx, {
        route,
        id: resource.id,
        revision,
        predecessor: null,
        title: body.title,
        summary: body.summary,
        visibility: body.visibility,
        context: body.contextId,
        at,
        author: creator,
        votes: storedVotes,
        presentation: emptyRealmPresentation,
      });
      inserted.add(tx);
      await initializeResourceGrants(tx, { resource, type: 'community.realm', creator });
      return {
        value: { realmId: resource.id, revisionId: revision },
        events: [
          {
            type: 'com.rezics.community.realm.created.v1',
            subject: resource.id,
            data: { realmId: resource.id, revisionId: revision },
          },
        ],
      };
    },
  );
}

export async function updateRealm(deps: RealmDependencies, actor: Actor, input: RealmUpdate, context: RealmContext) {
  const author = account(actor).accountId;
  let presentation: RealmPresentation | undefined;
  try {
    presentation = input.presentation === undefined ? undefined : realmPresentation(input.presentation);
  } catch {
    throw new RealmInputError();
  }
  const votes = input.votes === undefined ? undefined : voteMap(input.votes, RealmInputError);
  const body = {
    realmId: input.realmId,
    expectedHead: input.expectedHead,
    title: input.title,
    summary: input.summary,
    visibility: input.visibility,
    contextId: input.contextId,
    ...(votes === undefined ? {} : { votes }),
    ...(presentation === undefined ? {} : { presentation }),
  };
  const route = routeOf(body.realmId);
  if (route === null) throw new RealmInputError();
  const current = new WeakMap<AuthoritativeTime, RealmView>();
  const combined = requirements(deps.access, body.contextId === undefined ? [] : [contextRequirement(body.contextId)]);
  const authorization = resourceAuthorization({
    access: combined.access,
    actor,
    action: 'realm:manage',
    anchor: {
      resource: { route, id: body.realmId },
      async validate(client, time) {
        const row = await read.run(client, { route, id: body.realmId, at: authoritativeTimeValue(time) });
        if (!row) return false;
        current.set(time, record(row));
        return true;
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(route) },
  });
  return runCommand(
    deps.pool,
    {
      ...options(deps, actor, route, 'community.realm.update', body, context),
      authorization: (() => {
        const base = realmGovernanceAuthorization(combined.bound(authorization), { route, id: body.realmId });
        return {
          ...base,
          async prepare(attempt: Parameters<NonNullable<typeof base.prepare>>[0]) {
            const proof = await base.prepare!(attempt);
            if (presentation?.rules) {
              try {
                await prepareRealmRulesSelection(deps, actor, body.realmId, presentation.rules, context);
              } catch (error) {
                if (error instanceof TypeError) throw new RealmInputError();
                throw error;
              }
            }
            return proof;
          },
        };
      })(),
    },
    async (tx, command) => {
      bindRealmDiscoveryCommand(tx);
      const previous = current.get(command.time)!;
      if (routeOf(body.expectedHead) !== route) throw new RealmInputError();
      if (previous.headRevisionId !== body.expectedHead) throw new RealmConflictError();
      const title = body.title === undefined ? previous.title : body.title,
        summary = body.summary === undefined ? previous.summary : body.summary;
      const visibility = body.visibility === undefined ? previous.visibility : body.visibility,
        contextId = body.contextId === undefined ? previous.contextId : body.contextId;
      metadata(title, summary, visibility, contextId);
      const selected = presentation ?? previous.presentation;
      const revision = newId(route);
      // No votes means the column default. The revision trigger then copies the predecessor.
      await append.run(tx, {
        route,
        id: body.realmId,
        revision,
        predecessor: body.expectedHead,
        title,
        summary,
        visibility,
        context: contextId,
        at: authoritativeTimeValue(command.time),
        author,
        votes: votes ?? inheritedVotes,
        presentation: selected,
      });
      if (
        !(await moveHead.run(tx, {
          route,
          id: body.realmId,
          revision,
          expected: body.expectedHead,
          visibility,
          context: contextId,
        }))
      )
        throw new RealmConflictError();
      if (presentation && (presentation.avatarMediaId !== null || presentation.bannerMediaId !== null))
        await claimRealmPresentationMedia(tx, {
          realmId: body.realmId,
          author: actor,
          avatarMediaId: presentation.avatarMediaId,
          bannerMediaId: presentation.bannerMediaId,
        });
      if (visibility === 'protected') await ensureRealmMemberGrant(tx, { realmId: body.realmId });
      return {
        value: { realmId: body.realmId, revisionId: revision },
        events: [
          {
            type: 'com.rezics.community.realm.updated.v1',
            subject: body.realmId,
            data: { realmId: body.realmId, revisionId: revision },
          },
        ],
      };
    },
  );
}

/** The read route's exact identity/head eligibility, batched by supplied full keys. */
export const realmViewerActionResource: import('../access/viewer-actions.ts').ViewerActionResource = {
  readAction: 'realm:read',
  async read(client, ids, at) {
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
  },
};
