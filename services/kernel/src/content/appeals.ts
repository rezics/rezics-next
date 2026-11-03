import {
  prepareDiscoveryMutation,
  discoveryMutationAuthorization,
  lockDiscoveryMutation,
  applyDiscoveryMutation,
  abortDiscoveryMutation,
} from './discovery-mutation.ts';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { deadlineClient, within } from '../access/authenticate.ts';
import { readAccount } from '../access/account-data.ts';
import { notificationAllowed } from '../access/preferences.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import {
  CommandUnavailableError,
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandEvent,
} from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { Effect } from '../events/effects.ts';
import { ProblemError } from '../http/problem.ts';
import { requestDigest } from '../http/request.ts';
import { readPartition } from '../partition/partition.ts';
import {
  AuthenticationError,
  accessCheck,
  accessCommandAuthorization,
  type Access,
  type AccessClient,
  type Actor,
} from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { CONTENT_EVENTS } from './events.ts';
import { liftTakedown } from './lift-takedown.ts';
import { writeNotices } from './notices.ts';
import type { RequestContext } from './model.ts';
import {
  appealReviewSnapshot,
  readAppealReviewIdentities,
  readAppealReviewTargetContexts,
  targetKey,
  type AppealReviewAnchor,
  type AppealReviewIdentity,
  type AppealReviewTargetContext,
} from './appeal-review-page.ts';
import readDecision from './read-moderation-decision.sql';
import author from './author-moderation-decision.sql';
import insert from './insert-appeal.sql';
import read from './read-appeal.sql';
import resolve from './resolve-appeal.sql';
import project from './project-appeal.sql';
import boardPage from './page-board-appeals.sql';
import threadPage from './page-thread-appeals.sql';

const createdType = 'com.rezics.content.moderation.appeal-created.v1';
const resolvedType = 'com.rezics.content.moderation.appeal-resolved.v1';
export type AppealDependencies = { pool: Pool; access: Access; tokens?: KeyRing; clock?: () => Date };
type ReadContext = { actor: Actor; deadline: number };
const missing = () => new ProblemError('not_found');

export async function createAppeal(
  deps: AppealDependencies,
  actor: Actor,
  id: string,
  statement: string,
  context: RequestContext,
) {
  const route = routeOf(id);
  if (route === null || actor.kind !== 'account') throw missing();
  // The self-account anchor admits the authenticated author independently of the
  // taken-down target's disclosure. Ownership is rechecked before receipt replay.
  const selfRoute = routeOf(actor.accountId)!;
  const admission = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'account:read',
    anchor: {
      resource: { route: selfRoute, id: actor.accountId },
      validate: async (client) => !!(await readAccount(client, selfRoute, actor.accountId)),
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(route) },
  });
  let decision: Awaited<ReturnType<typeof readDecision.run>>;
  let target: Awaited<ReturnType<typeof author.run>>[number] | undefined;
  const authorization: CommandAuthorization = {
    ...admission,
    async authorize(tx, attempt, proof) {
      await admission.authorize(tx, attempt, proof);
      decision = await readDecision.run(tx, { route, decision_id: id });
      if (!decision) throw missing();
      [target] = await author.run(tx, { route, target_kind: decision.target_kind, target_id: decision.target_id });
      if (!target || target.author_account_id !== actor.accountId) throw missing();
      return 'execute';
    },
  };
  return runCommand(
    deps.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: {
        kind: 'content.appeal',
        key: context.idempotencyKey,
        digest: requestDigest('content.appeal', actor, { id, statement }),
      },
    },
    async (tx, command) => {
      if (!decision || !target) throw missing();
      if (decision.appeal_id !== null) throw new ProblemError('conflict');
      const at = authoritativeTimeValue(command.time);
      if (Date.parse(at) > new Date(decision.decided_at).getTime() + 183 * 86400000)
        throw new ProblemError('unsupported_query', { detail: 'The appeal deadline has passed.' });
      const appealId = newId(route);
      const added = await insert.run(tx, {
        route,
        appeal_id: appealId,
        decision_id: id,
        appellant: actor.accountId,
        statement,
        thread_id: target.thread_id,
        board_id: target.board_id,
        created_at: at,
      });
      if (!added) throw new ProblemError('conflict');
      return { value: { id: appealId }, events: [{ type: createdType, subject: appealId, data: { appealId } }] };
    },
  );
}

export async function resolveAppeal(
  deps: AppealDependencies,
  actor: Actor,
  id: string,
  input: { outcome: 'uphold' | 'reverse'; statement: string },
  context: RequestContext,
) {
  const route = routeOf(id);
  if (route === null || actor.kind !== 'account') throw missing();
  const reference = await appealReviewSnapshot(deps.pool, route, context.deadline, (client) =>
    read.run(client, { route, appeal_id: id }),
  );
  if (!reference.value) throw missing();
  const admission = await accessCommandAuthorization(
    deps.access,
    actor,
    'moderation:takedown',
    { route, id: reference.value.target_id },
    { pool: deps.pool, deadline: context.deadline },
    () => new GrantDeniedError(),
  );
  const authorization: CommandAuthorization = {
    ...admission,
    async authorize(tx, attempt, proof) {
      await admission.authorize(tx, attempt, proof);
      const current = await read.run(tx, { route, appeal_id: id });
      if (!current || current.target_id !== reference.value!.target_id) throw missing();
      if (current.decider_account_id === actor.accountId) throw new ProblemError('forbidden');
      return 'execute';
    },
  };
  const identity = principalCommandIdentity(actor);
  const receipt = {
    kind: 'content.resolve-appeal',
    key: context.idempotencyKey,
    digest: requestDigest('content.resolve-appeal', actor, { id, ...input }),
  };
  const discovery =
    input.outcome === 'reverse'
      ? await prepareDiscoveryMutation(deps, {
          identity,
          authorization,
          receipt,
          deadline: context.deadline,
          target: { kind: reference.value.target_kind as 'thread' | 'post', id: reference.value.target_id },
          effect: 'restore',
        })
      : null;
  try {
    return await runCommand(
      deps.pool,
      {
        ...identity,
        partition: partitionOf(route),
        deadline: context.deadline,
        clock: deps.clock,
        receipt,
        authorization: discoveryMutationAuthorization(deps, authorization, discovery),
      },
      async (tx, command) => {
        await lockDiscoveryMutation(tx, discovery);
        const changed = await resolve.run(tx, {
          route,
          appeal_id: id,
          outcome: input.outcome === 'uphold' ? 'upheld' : 'reversed',
          resolver: actor.accountId,
          statement: input.statement,
          resolved_at: authoritativeTimeValue(command.time),
        });
        if (!changed) throw new ProblemError('conflict');
        const events: CommandEvent[] = [];
        if (input.outcome === 'reverse')
          await liftTakedown(
            tx,
            { target: { kind: reference.value!.target_kind as 'thread' | 'post', id: reference.value!.target_id } },
            { events },
          );
        events.push(...(await applyDiscoveryMutation(tx, discovery)));
        events.push({ type: resolvedType, subject: id, data: { appealId: id } });
        return { value: { id }, events };
      },
    );
  } catch (error) {
    await abortDiscoveryMutation(deps.pool, discovery);
    throw error;
  }
}

async function canAct(
  deps: AppealDependencies,
  row: NonNullable<Awaited<ReturnType<typeof read.run>>>,
  context: ReadContext,
) {
  const route = routeOf(row.appeal_id)!;
  const check = await accessCheck(
    deps.access,
    context.actor,
    'moderation:takedown',
    { route, id: row.target_id },
    { pool: deps.pool, deadline: context.deadline },
  );
  return appealReviewSnapshot(deps.pool, route, context.deadline, (client) => check(client));
}

type AppealSourceRow = NonNullable<Awaited<ReturnType<typeof read.run>>>;
type AppealScope = Readonly<{ kind: 'board' | 'thread'; id: string }>;

async function readAppealReviewRow(client: AccessClient, route: number, appealId: string) {
  const row = await read.run(client, { route, appeal_id: appealId });
  if (!row) return row;
  // The existing decision reader owns current statement retention. Its exact
  // join also confirms the appeal's native decision and target references.
  const decision = await readDecision.run(client, { route, decision_id: row.decision_id });
  if (
    !decision ||
    decision.appeal_id !== appealId ||
    decision.target_kind !== row.target_kind ||
    decision.target_id !== row.target_id
  )
    return null;
  return {
    ...row,
    decision_statement: decision.statement,
    decider_account_id: decision.decider_account_id,
  };
}

function sourceView(anchor: AppealReviewAnchor) {
  return { partition: anchor.partition, epoch: anchor.epoch, position: anchor.position.toString() };
}

function provenance(context: ReadContext, anchor: AppealReviewAnchor) {
  if (context.actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  return {
    actorId: context.actor.accountId,
    session: { clientId: context.actor.clientId, authnEpoch: context.actor.authnEpoch },
    source: sourceView(anchor),
  };
}

function belongsToScope(row: AppealSourceRow, scope: AppealScope): boolean {
  return scope.kind === 'board' ? row.board_id === scope.id : row.thread_id === scope.id;
}

function sameAppealReference(left: AppealSourceRow, right: AppealSourceRow): boolean {
  return (
    left.appeal_id === right.appeal_id &&
    left.decision_id === right.decision_id &&
    left.appellant_account_id === right.appellant_account_id &&
    left.target_kind === right.target_kind &&
    left.target_id === right.target_id &&
    left.board_id === right.board_id &&
    left.thread_id === right.thread_id
  );
}

function linkedTargetContext(row: AppealSourceRow, current: AppealReviewTargetContext): AppealReviewTargetContext {
  if (current.state !== 'available') return current;
  const destination = current.destination;
  const linked =
    row.target_kind === 'board'
      ? destination.kind === 'board' && destination.id === row.target_id && row.board_id === destination.id
      : row.target_kind === 'thread'
        ? destination.kind === 'thread' &&
          destination.id === row.target_id &&
          row.thread_id === destination.id &&
          row.board_id === destination.boardId
        : destination.kind === 'thread' && row.thread_id === destination.id && row.board_id === destination.boardId;
  return linked ? current : { state: 'unavailable' };
}

function projectAppeal(
  row: AppealSourceRow,
  anchor: AppealReviewAnchor,
  actor: Actor,
  appellantIdentity: AppealReviewIdentity,
  targetContext: AppealReviewTargetContext,
  canTakedown: boolean,
) {
  const canResolve =
    actor.kind === 'account' && row.outcome === null && row.decider_account_id !== actor.accountId && canTakedown;
  return {
    id: row.appeal_id,
    decisionId: row.decision_id,
    appellantId: row.appellant_account_id,
    appellantIdentity,
    statement: row.statement,
    createdAt: new Date(row.created_at).toISOString(),
    decision: {
      statement: row.decision_statement,
      target: { kind: row.target_kind, id: row.target_id },
    },
    targetContext: linkedTargetContext(row, targetContext),
    canResolve,
    resolutionCommand: {
      operationId: 'moderation_appeal.resolve',
      method: 'POST',
      path: `/v1/moderation-appeals/${row.appeal_id}:resolve`,
    },
    source: sourceView(anchor),
  };
}

async function selectedAppeal(
  deps: AppealDependencies,
  scope: AppealScope,
  context: ReadContext,
  appealId: string,
): Promise<{ value: ReturnType<typeof projectAppeal> & { resolution: unknown }; anchor: AppealReviewAnchor }> {
  const route = routeOf(appealId);
  if (route === null || route !== routeOf(scope.id)) throw missing();
  const initial = await appealReviewSnapshot(deps.pool, route, context.deadline, (client) =>
    readAppealReviewRow(client, route, appealId),
  );
  if (
    !initial.value ||
    initial.value.appeal_id !== appealId ||
    !belongsToScope(initial.value, scope) ||
    routeOf(initial.value.decision_id) !== route ||
    routeOf(initial.value.target_id) !== route
  )
    throw missing();

  const target = { kind: initial.value.target_kind, id: initial.value.target_id } as const;
  const [firstIdentities, targetContexts] = await Promise.all([
    readAppealReviewIdentities(deps, [initial.value.appellant_account_id], context.deadline),
    readAppealReviewTargetContexts(deps, [target], context),
  ]);
  // Re-read the public allowlist after foreign context preparation so an identity
  // reduction is reflected by the response being serialized.
  const finalIdentities = await readAppealReviewIdentities(
    deps,
    [initial.value.appellant_account_id],
    context.deadline,
  );
  const final = await appealReviewSnapshot(deps.pool, route, context.deadline, (client) =>
    readAppealReviewRow(client, route, appealId),
  );
  if (!final.value || !belongsToScope(final.value, scope) || !sameAppealReference(initial.value, final.value))
    throw missing();
  const canTakedown = final.value.outcome === null ? (await canAct(deps, final.value, context)).value : false;
  const row = projectAppeal(
    final.value,
    final.anchor,
    context.actor,
    finalIdentities.get(final.value.appellant_account_id) ??
      firstIdentities.get(final.value.appellant_account_id) ?? {
        state: 'concealed',
      },
    targetContexts.get(targetKey(target)) ?? { state: 'unavailable' },
    canTakedown,
  );
  if (final.value.outcome !== null && (!final.value.resolver_statement || !final.value.resolved_at))
    throw new Error('Resolved appeal is missing its retained resolution');
  const resolution =
    final.value.outcome === null
      ? null
      : {
          outcome: final.value.outcome,
          statement: final.value.resolver_statement!,
          resolvedAt: new Date(final.value.resolved_at!).toISOString(),
        };
  return { value: { ...row, resolution }, anchor: final.anchor };
}

export async function listAppeals(
  deps: AppealDependencies,
  target: { kind: 'board' | 'thread'; id: string },
  context: ReadContext,
  query: { cursor?: string; limit?: number; inspect?: string },
) {
  const route = routeOf(target.id);
  if (context.actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (route === null) throw missing();
  const check = await accessCheck(
    deps.access,
    context.actor,
    'moderation:read_reports',
    { route, id: target.id },
    { pool: deps.pool, deadline: context.deadline },
  );
  const initial = await appealReviewSnapshot(deps.pool, route, context.deadline, (client) => check(client));
  if (!initial.value) throw missing();
  const ring = deps.tokens;
  if (!ring) throw new ProblemError('dependency_unavailable');
  const binding = {
    operation: 'content.pending-appeals',
    parameters: { kind: target.kind, id: target.id, actor: context.actor.accountId },
  };
  let after: { at: string; id: string } | null = null;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(ring, binding, query.cursor);
    if (
      !decoded.ok ||
      decoded.epoch !== initial.anchor.epoch ||
      decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'string' ||
      typeof decoded.after[1] !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(decoded.after[0]) ||
      !Number.isFinite(Date.parse(decoded.after[0])) ||
      routeOf(decoded.after[1]) === null
    )
      throw new ProblemError('invalid_cursor');
    after = { at: decoded.after[0], id: decoded.after[1] };
  }
  const limit = query.limit ?? 20;
  const candidates = await appealReviewSnapshot(deps.pool, route, context.deadline, (client) =>
    (target.kind === 'board' ? boardPage : threadPage).run(client, {
      route,
      id: target.id,
      created_at: after?.at ?? 'infinity',
      appeal_id: after?.id ?? '00000000-0000-0000-0000-000000000000',
      limit: limit + 1,
    }),
  );
  const selected = candidates.value.slice(0, limit);
  const scoped = target as AppealScope;
  const admitted: Array<{ row: AppealSourceRow; anchor: AppealReviewAnchor }> = [];
  for (const candidate of selected) {
    const candidateRoute = routeOf(candidate.appeal_id);
    if (candidateRoute === null || candidateRoute !== route) continue;
    const result = await appealReviewSnapshot(deps.pool, candidateRoute, context.deadline, (client) =>
      readAppealReviewRow(client, candidateRoute, candidate.appeal_id),
    );
    const row = result.value;
    if (!row || row.outcome !== null || !belongsToScope(row, scoped)) continue;
    admitted.push({ row, anchor: result.anchor });
  }
  const targets = admitted.map(({ row }) => ({ kind: row.target_kind, id: row.target_id }) as const);
  const appellantIds = admitted.map(({ row }) => row.appellant_account_id);
  const firstIdentities = await readAppealReviewIdentities(deps, appellantIds, context.deadline);
  const targetContexts = await readAppealReviewTargetContexts(deps, targets, context);
  const finalIdentities = await readAppealReviewIdentities(deps, appellantIds, context.deadline);
  const appeals = [];
  for (const item of admitted) {
    const sourceRoute = routeOf(item.row.appeal_id)!;
    const current = await appealReviewSnapshot(deps.pool, sourceRoute, context.deadline, (client) =>
      readAppealReviewRow(client, sourceRoute, item.row.appeal_id),
    );
    if (
      !current.value ||
      current.value.outcome !== null ||
      !belongsToScope(current.value, scoped) ||
      !sameAppealReference(item.row, current.value)
    )
      continue;
    const canTakedown = (await canAct(deps, current.value, context)).value;
    const targetForRow = { kind: current.value.target_kind, id: current.value.target_id } as const;
    appeals.push(
      projectAppeal(
        current.value,
        current.anchor,
        context.actor,
        finalIdentities.get(current.value.appellant_account_id) ??
          firstIdentities.get(current.value.appellant_account_id) ?? { state: 'concealed' },
        targetContexts.get(targetKey(targetForRow)) ?? { state: 'unavailable' },
        canTakedown,
      ),
    );
  }
  const selectedRead =
    query.inspect === undefined ? undefined : await selectedAppeal(deps, scoped, context, query.inspect);
  const final = await appealReviewSnapshot(deps.pool, route, context.deadline, (client) => check(client));
  if (!final.value) throw missing();
  const last = selected.at(-1);
  if (last && last.created_at === null) throw new Error('Appeal cursor time is missing');
  return {
    value: {
      appeals,
      next:
        candidates.value.length > limit && last
          ? encodeCursor(ring, binding, { epoch: final.anchor.epoch, after: [last.created_at!, last.appeal_id] })
          : null,
      ...(selectedRead ? { selectedAppeal: selectedRead.value } : {}),
      provenance: provenance(context, final.anchor),
    },
    anchor: final.anchor,
    selectedAnchor: selectedRead?.anchor,
  };
}

/** Cross-partition delivery releases the source snapshot before projecting on
 * the board route or notifying on the appellant route. Replays are monotone. */
export function createAppealEffect(pool: Pool): Effect {
  return {
    name: 'content_moderation_appeal',
    types: [createdType, resolvedType],
    async run(event) {
      if (
        (event.type !== createdType && event.type !== resolvedType) ||
        !Value.Check(CONTENT_EVENTS[event.type], event.data)
      )
        throw new TypeError('Invalid appeal event');
      const { appealId } = event.data as { appealId: string };
      const route = routeOf(appealId);
      const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
      if (route === null || !source || Number(source[1]) !== partitionOf(route) || !/^\d{19}$/.test(event.sequence))
        throw new TypeError('Invalid appeal source');
      const deadline = Date.now() + 30_000;
      const { value: row, anchor } = await appealReviewSnapshot(pool, route, deadline, (client) =>
        read.run(client, { route, appeal_id: appealId }),
      );
      if (
        Number(source[2]) > anchor.epoch ||
        (Number(source[2]) === anchor.epoch && BigInt(event.sequence) > anchor.position)
      )
        throw new Error('Appeal source unavailable');
      if (!row || (event.type === resolvedType && row.outcome === null)) throw new Error('Appeal source missing');
      async function write(destination: number, work: (client: AccessClient) => Promise<unknown>) {
        await withConnection(pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          try {
            await client.query('BEGIN');
            const partition = await readPartition(client, partitionOf(destination));
            if (!partition) throw new CommandUnavailableError('deadline', partitionOf(destination));
            if (partition.writeState !== 'active')
              throw new CommandUnavailableError(
                partition.writeState === 'moved' ? 'moved' : 'fenced',
                partitionOf(destination),
                partition.movedTo,
              );
            await work(client);
            await client.query('COMMIT');
          } catch (error) {
            try {
              await connection.query('ROLLBACK');
            } catch (rollback) {
              discardConnection(connection, rollback as Error);
            }
            throw error;
          }
        });
      }
      const boardRoute = routeOf(row.board_id)!;
      await write(boardRoute, (client) =>
        project.run(client, {
          route: boardRoute,
          board_id: row.board_id,
          appeal_id: appealId,
          created_at: new Date(row.created_at).toISOString(),
          pending: row.outcome === null,
        }),
      );
      if (event.type !== resolvedType) return;
      const recipientRoute = routeOf(row.appellant_account_id)!;
      await write(recipientRoute, async (client) => {
        if (await notificationAllowed(client, { recipient: row.appellant_account_id, kind: 'moderation_decision' }))
          await writeNotices(client, [
            {
              recipientId: row.appellant_account_id,
              noticeId: newId(recipientRoute),
              kind: 'moderation_decision',
              actorId: null,
              threadId: row.thread_id,
              postId: row.target_kind === 'post' ? row.target_id : null,
              decisionId: row.decision_id,
              reportId: null,
              sourceId: appealId,
              createdAt: new Date(row.resolved_at!),
            },
          ]);
      });
    },
  };
}
