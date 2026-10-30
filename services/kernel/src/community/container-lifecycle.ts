import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { Type } from 'typebox';
import { resourceAuthorization } from '../access/index.ts';
import { accessCommandAttempt } from '../access/command-admission.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { resourceRoleHeld } from '../access/resource-role-held.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  mintReadTime,
  type AuthoritativeTime,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type AccessClient, type AccessContext, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ContextNotFoundError, editorialContextAnchor, publicContextEligibility } from '../semantic/context.ts';
import type { SpaceDependencies, SpaceContext } from './space.ts';
import readSpace from './container-lifecycle-space-read.sql';
import readRealm from './container-lifecycle-realm-read.sql';
import writeSpace from './container-lifecycle-space-write.sql';
import writeRealm from './container-lifecycle-realm-write.sql';
import binding from './container-lifecycle-binding.sql';

export type ContainerKind = 'space' | 'realm';
export type ContainerLifecycleInput = Readonly<{
  kind: ContainerKind;
  id: string;
  expectedHead: string;
  expectedVersion: string;
}>;
export type ContainerRemovalInput = ContainerLifecycleInput & Readonly<{ reason: string }>;
export type ContainerLifecycle = Readonly<{
  kind: ContainerKind;
  id: string;
  state: 'active' | 'removed';
  headRevisionId: string;
  version: string;
  removedAt: string | null;
  removerRole: 'owner' | 'moderator' | null;
  reason: string | null;
  mayRemove: boolean;
  mayRestore: boolean;
}>;
type Row = NonNullable<Awaited<ReturnType<typeof read>>>;

export class ContainerLifecycleConflictError extends Error {
  constructor() {
    super('Container head or lifecycle has changed');
  }
}

function identity(kind: ContainerKind, id: string) {
  const route = routeOf(id);
  if ((kind !== 'realm' && kind !== 'space') || route === null) throw new ProblemError('invalid_request');
  return { route, id };
}
function action(kind: ContainerKind) {
  return kind === 'space' ? 'space:manage' : 'moderation:takedown';
}
async function read(client: AccessClient, kind: ContainerKind, id: string, at: AuthoritativeTime) {
  const resource = identity(kind, id);
  const params = { route: resource.route, id, at: authoritativeTimeValue(at) };
  return kind === 'space' ? readSpace.run(client, params) : readRealm.run(client, params);
}

/** Current direct native roles are facts, never a substitute for the action/scopes check.
 * Only the installed owner/moderator roles exist; there is no administrator or inherited power.
 */
async function role(
  client: AccessClient,
  kind: ContainerKind,
  id: string,
  actor: Actor,
  at: AuthoritativeTime,
): Promise<'owner' | 'moderator' | null> {
  if (actor.kind !== 'account') return null;
  const input = { resource: identity(kind, id), accountId: actor.accountId, at };
  if (await resourceRoleHeld(client, { ...input, role: `community.${kind}.owner` })) return 'owner';
  if (kind === 'realm' && (await resourceRoleHeld(client, { ...input, role: 'community.realm.moderator' })))
    return 'moderator';
  return null;
}
function mayRestore(row: Row, current: 'owner' | 'moderator' | null, actor: Actor) {
  return (
    row.state === 'removed' &&
    row.restorable === true &&
    current !== null &&
    actor.kind === 'account' &&
    (row.removed_by === actor.accountId || (current === 'owner' && row.remover_role === 'moderator'))
  );
}
function view(kind: ContainerKind, row: Row, current: 'owner' | 'moderator', actor: Actor): ContainerLifecycle {
  if (row.state !== 'active' && row.state !== 'removed') throw new TypeError('Invalid container state');
  if (row.remover_role !== null && row.remover_role !== 'owner' && row.remover_role !== 'moderator')
    throw new TypeError('Invalid recorded container role');
  return {
    kind,
    id: row.id,
    state: row.state,
    headRevisionId: row.head_revision_id,
    version: row.lifecycle_version,
    removedAt: row.removed_at ? new Date(row.removed_at).toISOString() : null,
    removerRole: row.remover_role,
    reason: row.removal_reason,
    mayRemove: row.state === 'active',
    mayRestore: mayRestore(row, current, actor),
  };
}

/** Private moderation read; denied and missing are identical. No removed metadata or Context content escapes. */
export async function readContainerLifecycle(
  deps: Pick<SpaceDependencies, 'pool' | 'access' | 'clock'>,
  actor: Actor,
  kind: ContainerKind,
  id: string,
  context: { deadline: number },
): Promise<ContainerLifecycle | null> {
  const resource = identity(kind, id);
  const check = await accessCheck(deps.access, actor, action(kind), resource, { pool: deps.pool, ...context });
  const initial = await withConnection(deps.pool, async (client) => {
    const bounded = deadlineClient(client, context.deadline);
    const time = await mintReadTime(bounded, deps.clock);
    if (!(await check(bounded, time))) return null;
    const row = await read(bounded, kind, id, time);
    const current = await role(bounded, kind, id, actor, time);
    return row && current ? { row, value: view(kind, row, current, actor), time } : null;
  });
  if (!initial) return null;
  const contextReadable =
    !initial.value.mayRestore ||
    initial.row.context_id === null ||
    (await readableContext(deps, actor, initial.row.context_id, initial.time, { pool: deps.pool, ...context }));
  // Release the independent Context anchor before final native role/version validation.
  return withConnection(deps.pool, async (client) => {
    const bounded = deadlineClient(client, context.deadline);
    const time = await mintReadTime(bounded, deps.clock);
    if (!(await check(bounded, time))) return null;
    const row = await read(bounded, kind, id, time);
    const current = await role(bounded, kind, id, actor, time);
    if (
      !row ||
      !current ||
      row.context_id !== initial.row.context_id ||
      row.head_revision_id !== initial.row.head_revision_id ||
      row.lifecycle_version !== initial.row.lifecycle_version
    )
      return null;
    const value = view(kind, row, current, actor);
    return { ...value, mayRestore: value.mayRestore && contextReadable };
  });
}

async function readableContext(
  deps: { pool: SpaceDependencies['pool']; access: Access },
  actor: Actor,
  id: string,
  time: AuthoritativeTime,
  context: AccessContext,
) {
  const anchor = editorialContextAnchor(id);
  const check = await accessCheck(
    deps.access,
    actor,
    'context:read',
    {
      ...anchor.resource,
      eligibility: publicContextEligibility(anchor.resource),
    },
    context,
  );
  return withConnection(deps.pool, async (client) => {
    const bounded = deadlineClient(client, context.deadline);
    try {
      return (await anchor.validate(bounded, time)) && (await check(bounded, time));
    } catch (error) {
      if (error instanceof ContextNotFoundError) return false;
      throw error;
    }
  });
}

export function removeContainer(
  deps: SpaceDependencies,
  actor: Actor,
  input: ContainerRemovalInput,
  context: SpaceContext,
) {
  return transition(deps, actor, input, context, 'removed');
}
export function restoreContainer(
  deps: SpaceDependencies,
  actor: Actor,
  input: ContainerLifecycleInput,
  context: SpaceContext,
) {
  return transition(deps, actor, { ...input, reason: '' }, context, 'active');
}
function transition(
  deps: SpaceDependencies,
  actor: Actor,
  input: ContainerRemovalInput,
  context: SpaceContext,
  state: 'active' | 'removed',
) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  const body = { ...input, state };
  const resource = identity(body.kind, body.id);
  if (
    routeOf(body.expectedHead) !== resource.route ||
    !/^(0|[1-9][0-9]{0,18})$/.test(body.expectedVersion) ||
    (state === 'removed' &&
      (typeof body.reason !== 'string' ||
        !body.reason.trim() ||
        [...body.reason].length > 1024 ||
        body.reason.includes('\0')))
  )
    throw new ProblemError('invalid_request');
  const prepared = new WeakMap<AuthoritativeTime, Row>();
  // Independently check live Context availability/read authority before target checkout.
  const access = deriveAccess(deps.access, {
    async prepare(preparedActor, requestedAction, target, accessContext) {
      const attempt = accessCommandAttempt(accessContext);
      if (!attempt) throw new GrantDeniedError();
      const primary = await deps.access.prepare?.(preparedActor, requestedAction, target, accessContext);
      const row = await within(context.deadline, () =>
        read(deadlineClient(deps.pool, context.deadline), body.kind, body.id, attempt.time),
      );
      if (!row) throw new GrantDeniedError();
      prepared.set(attempt.time, row);
      if (state === 'active' && row.context_id !== null) {
        if (!(await readableContext(deps, preparedActor, row.context_id, attempt.time, accessContext)))
          throw new GrantDeniedError();
      }
      return primary;
    },
    async authorize(client, checkedActor, checkedAction, target, evidence, time) {
      if (!time || !(await deps.access.authorize(client, checkedActor, checkedAction, target, evidence, time)))
        return false;
      const row = await read(client, body.kind, body.id, time);
      const current = await role(client, body.kind, body.id, checkedActor, time);
      if (!row || !current) return false;
      return state !== 'active' || row.state !== 'removed' || mayRestore(row, current, checkedActor);
    },
  });
  const authorization = resourceAuthorization({
    access,
    actor,
    action: action(body.kind),
    anchor: {
      resource,
      async validate(client, time) {
        const row = await read(client, body.kind, body.id, time);
        const before = prepared.get(time);
        // Fresh authorization before replay; an old receipt carries no native role or binding authority.
        if (
          !row ||
          !before ||
          row.context_id !== before.context_id ||
          row.lifecycle_version !== before.lifecycle_version ||
          row.head_revision_id !== before.head_revision_id
        )
          return false;
        return true;
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(resource.route) },
  });
  const principal = principalCommandIdentity(actor);
  const kind = `community.${body.kind}.${state === 'removed' ? 'remove' : 'restore'}`;
  return runCommand(
    deps.pool,
    {
      ...principal,
      partition: partitionOf(resource.route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: {
        kind,
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(canonicalize([principal, kind, body])!)
          .digest(),
      },
    },
    async (tx, command) => {
      const row = await read(tx, body.kind, body.id, command.time);
      const current = await role(tx, body.kind, body.id, actor, command.time);
      const before = prepared.get(command.time);
      if (!row || !before || !current) throw new GrantDeniedError();
      if (
        row.head_revision_id !== body.expectedHead ||
        row.lifecycle_version !== body.expectedVersion ||
        row.state === state ||
        row.context_id !== before.context_id
      )
        throw new ContainerLifecycleConflictError();
      if (state === 'active' && !mayRestore(row, current, actor)) throw new GrantDeniedError();
      const params = {
        ...resource,
        head: body.expectedHead,
        version: body.expectedVersion,
        state,
        at: authoritativeTimeValue(command.time),
        actor: actor.accountId,
        role: current,
        reason: body.reason,
      };
      const [changed] = body.kind === 'space' ? await writeSpace.run(tx, params) : await writeRealm.run(tx, params);
      if (!changed) throw new ContainerLifecycleConflictError();
      const value = {
        kind: body.kind,
        id: body.id,
        state,
        headRevisionId: row.head_revision_id,
        version: changed.lifecycle_version,
      };
      return {
        value,
        events: [
          {
            type: `com.rezics.community.${body.kind}.${state === 'removed' ? 'removed' : 'restored'}.v1`,
            subject: body.id,
            data: { ...value, at: params.at },
          },
        ],
      };
    },
  );
}

const id = Type.String({ format: 'uuid' });
const version = Type.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
/** Closed data port. These facts convey no permission, Context ownership or erasure ACK. */
export const ContainerBindingSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    realmId: id,
    spaceId: id,
    contextId: id,
    realmHead: id,
    spaceHead: id,
    realmVersion: version,
    spaceVersion: version,
    subjectId: Type.Union([id, Type.Null()]),
    publicationId: Type.Union([id, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ContainerBinding = Readonly<{
  schemaVersion: 1;
  realmId: string;
  spaceId: string;
  contextId: string;
  realmHead: string;
  spaceHead: string;
  realmVersion: string;
  spaceVersion: string;
  subjectId: string | null;
  publicationId: string | null;
}>;

/** One same-home Realm/Space anchor and optional exact publication key. Callers independently authorize
 * the container and live Context on released source anchors, then reread this port before final disclosure.
 */
export async function readContainerBinding(
  client: AccessClient,
  input: { realmId: string; subjectId?: string | null; at: AuthoritativeTime },
): Promise<ContainerBinding | null> {
  const resource = identity('realm', input.realmId);
  const subjectId = input.subjectId ?? null;
  if (subjectId !== null && routeOf(subjectId) === null) throw new TypeError('Invalid binding subject');
  const row = await binding.run(client, { ...resource, subject: subjectId, at: authoritativeTimeValue(input.at) });
  if (!row) return null;
  return Object.freeze({
    schemaVersion: 1,
    realmId: row.realm_id,
    spaceId: row.space_id,
    contextId: row.context_id,
    realmHead: row.head_revision_id,
    spaceHead: row.space_head,
    realmVersion: row.realm_version,
    spaceVersion: row.space_version,
    subjectId,
    publicationId: row.publication_id,
  });
}
export async function revalidateContainerBinding(
  client: AccessClient,
  expected: ContainerBinding,
  at: AuthoritativeTime,
) {
  const current = await readContainerBinding(client, { realmId: expected.realmId, subjectId: expected.subjectId, at });
  return current !== null && canonicalize(current) === canonicalize(expected);
}
