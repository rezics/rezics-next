import { realmRecord, voteMap } from './realm-record.ts';
import { RealmInputError } from './contract/index.ts';
export { RealmInputError } from './contract/index.ts';
export {
  readRealm,
  readRealmSettingsHead,
  realmReadEligibility,
  allowRealmRead,
  realmViewerActionResource,
} from './realm-read.ts';
import { bindRealmDiscoveryCommand } from './discovery-source.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  initializeResourceGrants,
  parentCreationAuthorization,
  resourceAuthorization,
  accessCommandAttempt,
  deadlineClient,
  within,
  permissionEvidenceDeadline,
  platformRootAnchor,
  claimRealmPresentationMedia,
  prepareRealmRulesSelection,
} from './domain-ports.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { GrantDeniedError } from '../access/resource-access-errors.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../access/resource-roles.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { type Access, type Actor, type Resource } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { publicContextEligibility } from '../semantic/context.ts';
import { ensureRealmMemberGrant } from './participation.ts';
import { realmGovernanceAuthorization, type RealmContinuity } from './realm-governance.ts';
import type { RealmVotes } from './realm-votes.ts';
import type { SpaceDependencies, SpaceContext } from './space.ts';
import { type CommunityAmbient } from './ambient.ts';
import { emptyRealmPresentation, realmPresentation, type RealmPresentation } from './presentation.ts';
import read from './realm-read.sql';
import insert from './realm-insert.sql';
import append from './realm-revision.sql';
import moveHead from './realm-head.sql';
import host from './realm-space.sql';

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
function account(actor: Actor) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  return actor;
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
type Requirement = { action: string; resource: Resource };
/** Add independently anchored checks to the parent's exact trusted context.
 * Production Access caches its single admission observation by actor/live T.
 * Typed Global parent creation uses `preparePage`; extra host/context checks
 * wrap that port too, or permission evidence has no deadline.
 */
function requirements(
  access: Access,
  extra: readonly Requirement[],
  deadlineNow: () => number,
  validate?: (client: Parameters<Access['authorize']>[0], time: AuthoritativeTime) => Promise<boolean>,
) {
  const preparedAttempts = new WeakMap<CommandAttempt, number>();
  async function prepareAnchors(
    actor: Parameters<NonNullable<Access['prepare']>>[0],
    context: Parameters<NonNullable<Access['prepare']>>[3],
    primaryPrepare: () => Promise<unknown> | undefined,
  ) {
    const attempt = accessCommandAttempt(context);
    if (!attempt) throw new GrantDeniedError();
    const primary = await primaryPrepare();
    let deadline = Math.min(context.deadline, permissionEvidenceDeadline(primary) ?? -Infinity);
    const checks: (Requirement & { evidence: unknown })[] = [];
    for (const requirement of extra) {
      const evidence = await access.prepare?.(actor, requirement.action, requirement.resource, context);
      deadline = Math.min(deadline, permissionEvidenceDeadline(evidence) ?? -Infinity);
      checks.push({ ...requirement, evidence });
    }
    if (deadlineNow() >= deadline) throw new GrantDeniedError();
    await within(deadline, () =>
      withConnection(context.pool, async (client) => {
        const bounded = deadlineClient(client, deadline);
        if (validate && !(await validate(bounded, attempt.time))) throw new GrantDeniedError();
        for (const check of checks)
          if (!(await access.authorize(bounded, actor, check.action, check.resource, check.evidence, attempt.time)))
            throw new GrantDeniedError();
      }),
    );
    preparedAttempts.set(attempt, deadline);
    return primary;
  }
  const combined = deriveAccess(access, {
    async prepare(actor, action, resource, context) {
      return prepareAnchors(actor, context, () => access.prepare?.(actor, action, resource, context));
    },
    ...(access.preparePage
      ? {
          async preparePage(actor, action, page, context) {
            return prepareAnchors(actor, context, () => access.preparePage?.(actor, action, page, context));
          },
        }
      : {}),
  });
  const roles = resourceRoleCatalogue(access);
  if (roles) installResourceRoleCatalogue(combined, roles);
  return {
    access: combined,
    bound(authorization: CommandAuthorization): CommandAuthorization {
      return {
        ...authorization,
        async prepare(attempt) {
          const proof = await authorization.prepare!(attempt);
          if (preparedAttempts.get(attempt) === undefined) throw new GrantDeniedError();
          return proof;
        },
        async authorize(tx, attempt, proof) {
          // Extras already ran at prepare for this attempt. Access re-checks parent
          // evidence TTL on the proof; a missing extras record is a grant denial.
          if (preparedAttempts.get(attempt) === undefined) throw new GrantDeniedError();
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

export async function createRealm(
  deps: RealmDependencies & CommunityAmbient,
  actor: Actor,
  input: RealmInput,
  context: RealmContext,
) {
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
    deps.deadlineNow,
    async (client, time) => {
      const row = await host.run(client, { route, space: body.spaceId, at: authoritativeTimeValue(time) });
      const free = !!row && row.realm_id === null;
      available.set(time, free);
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

export async function updateRealm(
  deps: RealmDependencies & CommunityAmbient,
  actor: Actor,
  input: RealmUpdate,
  context: RealmContext,
) {
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
  const combined = requirements(
    deps.access,
    body.contextId === undefined ? [] : [contextRequirement(body.contextId)],
    deps.deadlineNow,
  );
  const authorization = resourceAuthorization({
    access: combined.access,
    actor,
    action: 'realm:manage',
    anchor: {
      resource: { route, id: body.realmId },
      async validate(client, time) {
        const row = await read.run(client, { route, id: body.realmId, at: authoritativeTimeValue(time) });
        if (!row) return false;
        current.set(time, realmRecord(row));
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
