import { readSpace } from './space-read.ts';
export { readSpace, readSpaceForViewer, spaceReadEligibility, spaceViewerActionResource } from './space-read.ts';
import { bindRealmDiscoveryCommand } from './discovery-source.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  initializeResourceGrants,
  parentCreationAuthorization,
  resourceAuthorization,
  platformRootAnchor,
} from './domain-ports.ts';
import { GrantDeniedError } from '../access/resource-access-errors.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandTransaction,
} from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../route/route.ts';
import read from './space-read.sql';
import insert from './space-insert.sql';
import append from './space-revision.sql';
import moveHead from './space-head.sql';

export type SpaceDependencies = Readonly<{ pool: Pool; access: Access; routeKey: Uint8Array; clock: () => Date }>;
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
