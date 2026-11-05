import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  accessCommandAuthorization,
  type AccessCommandAuthorization,
  type Access,
  type AccessContext,
  type Actor,
  type Resource,
} from '../request/access.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { realmReadEligibility } from '../community/realm.ts';
import {
  principalCommandIdentity,
  runCommand,
  type CommandAttempt,
  type CommandAuthorization,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { RequestContext } from './model.ts';
import { ContentNotFoundError, readResource, type ContentReadDependencies } from './reads.ts';
import readChain from './read-chain.sql';
import lockBoard from './board-pin-lock-board.sql';
import lockTarget from './board-pin-lock-target.sql';
import lockSlots from './board-pin-lock-slots.sql';
import setSlot from './board-pin-set.sql';
import advanceRevision from './board-pin-advance.sql';
import { MAX_BOARD_PINS } from './board-projection.ts';

export type BoardPinDependencies = Pick<ContentReadDependencies, 'pool' | 'access'> & {
  clock?: () => Date;
};
export type BoardPinInput = Readonly<{ boardId: string; threadId: string; pinned: boolean }>;
export type BoardPinValue = Readonly<{
  boardId: string;
  threadId: string;
  pinned: boolean;
  pinPosition: number | null;
}>;

export class BoardPinLimitError extends Error {
  constructor() {
    super('A board can have at most five pinned threads');
    this.name = 'BoardPinLimitError';
  }
}

type ContentRow = Parameters<typeof readResource>[0];
type PinSlot = Readonly<{ thread_id: string; pin_slot: number }>;
type PreparedCheck = Readonly<{ authorization: AccessCommandAuthorization; evidence: unknown }>;

async function readContentRow(
  pool: Pool,
  deadline: number,
  id: string,
  kind: 'board' | 'thread' | 'post',
  threadId: string,
): Promise<ContentRow | null> {
  const route = routeOf(id);
  if (route === null) return null;
  return withConnection(pool, async (client) => {
    const rows = await readChain.run(deadlineClient(client, deadline), {
      route,
      id,
      kind,
      thread_id: threadId,
      include_body: false,
    });
    return (rows[0] as ContentRow | undefined) ?? null;
  });
}

async function prepareCheck(
  access: Access,
  actor: Actor,
  action: string,
  resource: Resource,
  context: AccessContext,
  denied: () => Error,
  attempt: CommandAttempt,
): Promise<PreparedCheck> {
  const authorization = await accessCommandAuthorization(access, actor, action, resource, context, denied);
  return { authorization, evidence: await authorization.prepare!(attempt) };
}

function assertCompact(pins: readonly PinSlot[]): void {
  if (
    pins.length > MAX_BOARD_PINS ||
    pins.some((pin, index) => pin.pin_slot !== index + 1) ||
    new Set(pins.map((pin) => pin.thread_id)).size !== pins.length
  )
    throw new Error('Board pin positions are inconsistent');
}

export async function setBoardThreadPin(
  dependencies: BoardPinDependencies,
  actor: Actor,
  input: BoardPinInput,
  context: RequestContext,
) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  if (typeof input.pinned !== 'boolean') throw new TypeError('Invalid board pin state');
  const boardRoute = routeOf(input.boardId);
  const threadRoute = routeOf(input.threadId);
  if (boardRoute === null || threadRoute === null) throw new ContentNotFoundError();

  const identity = principalCommandIdentity(actor);
  const commandKind = 'content.board-thread.pin-state';
  const body = { boardId: input.boardId, threadId: input.threadId, pinned: input.pinned };
  const receipt = {
    kind: commandKind,
    key: context.idempotencyKey,
    digest: createHash('sha256')
      .update(canonicalize([identity, body])!)
      .digest(),
  };
  const accessContext: AccessContext = { pool: dependencies.pool, deadline: context.deadline };

  const authorization: CommandAuthorization = {
    action: 'moderation:takedown',
    resource: { route: boardRoute, id: input.boardId },
    denied: () => new GrantDeniedError(),
    async prepare(attempt) {
      const board = await readContentRow(dependencies.pool, context.deadline, input.boardId, 'board', input.boardId);
      if (!board) throw new ContentNotFoundError();
      const thread = await readContentRow(
        dependencies.pool,
        context.deadline,
        input.threadId,
        'thread',
        input.threadId,
      );
      if (!thread || thread.board_id !== input.boardId || !thread.first_post_id) throw new ContentNotFoundError();
      const post = await readContentRow(
        dependencies.pool,
        context.deadline,
        thread.first_post_id,
        'post',
        input.threadId,
      );
      if (!post || post.thread_id !== input.threadId || routeOf(post.id) !== threadRoute)
        throw new ContentNotFoundError();

      const boardIdentity = { route: boardRoute, id: input.boardId };
      const boardRead = readResource(board, Object.freeze({}));
      const threadRead = readResource(thread, Object.freeze({}));
      const postRead = readResource(post, Object.freeze({}));
      const realmId = board.realm_id;
      const realmRoute = realmId ? routeOf(realmId) : null;
      if (realmId && realmRoute !== boardRoute) throw new ContentNotFoundError();
      const moderatorResource = realmId ? { route: boardRoute, id: realmId } : boardIdentity;
      const moderator = await accessCommandAuthorization(
        dependencies.access,
        actor,
        'moderation:takedown',
        moderatorResource,
        accessContext,
        () => new GrantDeniedError(),
      );
      const checks: PreparedCheck[] = [];
      checks.push(
        await prepareCheck(
          dependencies.access,
          actor,
          'board:read',
          boardRead,
          accessContext,
          () => new ContentNotFoundError(),
          attempt,
        ),
      );
      if (realmId) {
        const realmIdentity = { route: boardRoute, id: realmId };
        checks.push(
          await prepareCheck(
            dependencies.access,
            actor,
            'realm:read',
            { ...realmIdentity, eligibility: realmReadEligibility(realmIdentity) },
            accessContext,
            () => new ContentNotFoundError(),
            attempt,
          ),
        );
      }
      checks.push(
        await prepareCheck(
          dependencies.access,
          actor,
          'thread:read',
          threadRead,
          accessContext,
          () => new ContentNotFoundError(),
          attempt,
        ),
      );
      checks.push(
        await prepareCheck(
          dependencies.access,
          actor,
          'post:read',
          postRead,
          accessContext,
          () => new ContentNotFoundError(),
          attempt,
        ),
      );
      const moderatorProof = await moderator.prepare!(attempt);
      return { moderator, moderatorProof, checks };
    },
    async authorize(tx, attempt, evidence) {
      const prepared = evidence as {
        moderator: AccessCommandAuthorization;
        moderatorProof: unknown;
        checks: readonly PreparedCheck[];
      };
      if ((await prepared.moderator.authorize(tx, attempt, prepared.moderatorProof)) !== 'execute')
        throw new GrantDeniedError();
      for (const check of prepared.checks) {
        if ((await check.authorization.authorize(tx, attempt, check.evidence)) !== 'execute')
          throw new ContentNotFoundError();
      }
      return 'execute';
    },
  };

  return runCommand<BoardPinValue>(
    dependencies.pool,
    {
      ...identity,
      partition: partitionOf(boardRoute),
      deadline: context.deadline,
      clock: dependencies.clock,
      receipt,
      authorization,
    },
    async (tx, command) => {
      const boardParameters = { route: boardRoute, board_id: input.boardId };
      const lockedBoard = await tx.query<{ board_id: string }>(
        lockBoard.sql,
        lockBoard.params.map((name) => boardParameters[name as keyof typeof boardParameters]),
      );
      if (lockedBoard.rows.length !== 1) throw new ContentNotFoundError();

      const targetParameters = { ...boardParameters, thread_id: input.threadId };
      const targetResult = await tx.query<{ thread_id: string; pin_slot: number | null }>(
        lockTarget.sql,
        lockTarget.params.map((name) => targetParameters[name as keyof typeof targetParameters]),
      );
      const target = targetResult.rows[0];
      if (!target) throw new ContentNotFoundError();

      const { rows: pins } = await tx.query<PinSlot>(
        lockSlots.sql,
        lockSlots.params.map((name) => boardParameters[name as keyof typeof boardParameters]),
      );
      assertCompact(pins);
      const current = pins.find((pin) => pin.thread_id === input.threadId);
      if ((current?.pin_slot ?? null) !== target.pin_slot) throw new Error('Board pin projection is inconsistent');
      let pinPosition: number | null = current?.pin_slot ?? null;

      if (input.pinned && !current) {
        if (pins.length >= MAX_BOARD_PINS) throw new BoardPinLimitError();
        for (let index = pins.length - 1; index >= 0; index--) {
          const pin = pins[index]!;
          const parameters = { ...targetParameters, thread_id: pin.thread_id, pin_slot: pin.pin_slot + 1 };
          await tx.query(
            setSlot.sql,
            setSlot.params.map((name) => parameters[name as keyof typeof parameters]),
          );
        }
        const parameters = { ...targetParameters, pin_slot: 1 };
        await tx.query(
          setSlot.sql,
          setSlot.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        pinPosition = 1;
      } else if (!input.pinned && current) {
        const clear = { ...targetParameters, pin_slot: null };
        await tx.query(
          setSlot.sql,
          setSlot.params.map((name) => clear[name as keyof typeof clear]),
        );
        for (const pin of pins) {
          if (pin.pin_slot <= current.pin_slot) continue;
          const parameters = { ...targetParameters, thread_id: pin.thread_id, pin_slot: pin.pin_slot - 1 };
          await tx.query(
            setSlot.sql,
            setSlot.params.map((name) => parameters[name as keyof typeof parameters]),
          );
        }
        pinPosition = null;
      }

      // The board lock serializes capacity and this counter in the same command
      // transaction. Desired-state no-ops and receipt replays keep traversals valid.
      if (input.pinned !== Boolean(current)) {
        const advanced = await tx.query(
          advanceRevision.sql,
          advanceRevision.params.map((name) => boardParameters[name as keyof typeof boardParameters]),
        );
        if (advanced.rows.length !== 1) throw new ContentNotFoundError();
      }

      const value: BoardPinValue = {
        boardId: input.boardId,
        threadId: input.threadId,
        pinned: input.pinned,
        pinPosition,
      };
      return {
        value,
        events: [
          {
            type: 'com.rezics.content.board-thread.pin.changed.v1',
            subject: input.boardId,
            data: { ...value, actorId: actor.accountId },
          },
        ],
      };
    },
  );
}
