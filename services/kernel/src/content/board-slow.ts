import { createHash, createHmac } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { resourceAuthorization } from '../access/index.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { deadlineClient } from '../access/authenticate.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { accessExplicitCheck, type Actor, type AccessExplicitCheck, type AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { ContentCommandDependencies } from './commands.ts';
import type { ContentCommandValue, RequestContext } from './model.ts';

const RECOVERY_GRACE_MS = 30_000;
export const BOARD_SLOW_RECOVERY_PAGE_SIZE = 25;
export const BOARD_SLOW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class BoardSlowModeError extends Error {
  constructor(
    readonly retryAt: string,
    readonly intervalSeconds: number,
  ) {
    super('Board posting interval has not elapsed');
    this.name = 'BoardSlowModeError';
  }
}

export class BoardSlowAdmissionUnavailableError extends Error {
  readonly retryAfterSeconds = 1;
  constructor() {
    super('Board posting admission is waiting for recovery');
    this.name = 'BoardSlowAdmissionUnavailableError';
  }
}

export class BoardSlowModeInputError extends Error {}

export type BoardSlowReceiptReference = Readonly<{
  kind: string;
  key: string;
  digest: Uint8Array;
}>;

type PermitReference = Readonly<{
  boardRoute: number;
  boardId: string;
  actorKey: Buffer;
  commandKey: Buffer;
  requestDigest: Buffer;
  threadRoute: number;
  commandKind: string;
  generation: string;
  securityEpisode: string;
  intervalSeconds: number;
}>;

type PermitPlan =
  | Readonly<{ kind: 'exempt' }>
  | Readonly<{ kind: 'blocked'; error: BoardSlowModeError | BoardSlowAdmissionUnavailableError }>
  | Readonly<{ kind: 'permit'; reference: PermitReference; bodyAllowed: boolean }>;

type PermitState = 'reserved' | 'in_flight' | 'reconciling' | 'complete' | 'cancelled' | 'pruning';
type TicketState = 'reserved' | 'committed' | 'replayed' | 'cancelled';

type PermitRow = PermitReference & Readonly<{ state: PermitState; updatedAt: string; recoveryFromState: string | null }>;

type TicketRow = Readonly<{
  generation: string;
  state: TicketState;
  boardRoute: number;
  boardId: string;
  requestDigest: Buffer;
  commandKind: string;
  targetPostId: string | null;
  revisionId: string | null;
  transactionId: string | null;
  postedAt: string | null;
  witnessTransactionId: string | null;
}>;

function resource(boardId: string) {
  const route = routeOf(boardId);
  if (route === null) throw new BoardSlowModeInputError();
  return { route, id: boardId };
}

/** The server-keyed value contains no account identifier and is never returned to a caller. */
function actorKey(deps: ContentCommandDependencies, actor: Actor): Buffer {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  return createHmac('sha256', deps.routeKey).update(`content.board.slow-mode.actor\n${actor.accountId}`).digest();
}

/** Rows written before board-home reservations used this board-scoped digest. */
function legacyActorKey(routeKey: Uint8Array, boardId: string, actor: Actor): Buffer {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  return createHmac('sha256', routeKey)
    .update(`content.board.slow-mode\n${boardId}\n${actor.accountId}`)
    .digest();
}

function legacyActorKeyForAccount(routeKey: Uint8Array, boardId: string, accountId: string): Buffer {
  return createHmac('sha256', routeKey).update(`content.board.slow-mode\n${boardId}\n${accountId}`).digest();
}

function actorKeyForAccount(routeKey: Uint8Array, accountId: string): Buffer {
  return createHmac('sha256', routeKey).update(`content.board.slow-mode.actor\n${accountId}`).digest();
}

function commandKey(
  deps: ContentCommandDependencies,
  actor: Actor,
  boardId: string,
  threadRoute: number,
  receipt: BoardSlowReceiptReference,
): Buffer {
  const key = actorKey(deps, actor).toString('hex');
  return createHmac('sha256', deps.routeKey)
    .update(
      `content.board.slow-mode.command\n${boardId}\n${threadRoute}\n${receipt.kind}\n${key}\n${receipt.key}`,
    )
    .digest();
}

function databaseCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function admissionConflict(error: unknown): boolean {
  return ['40001', '40P01', '55P03', '23505'].includes(databaseCode(error) ?? '');
}

function sameDigest(actual: Uint8Array, expected: Uint8Array): boolean {
  return Buffer.from(actual).equals(Buffer.from(expected));
}

async function serializable<T>(
  pool: Pool,
  deadline: number,
  action: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* The original transaction error remains the command result. */
      }
      throw error;
    }
  });
}

function defaultDeadline(): number {
  return Date.now() + 30_000;
}

async function readMode(client: AccessClient, boardId: string) {
  const board = resource(boardId);
  const result = await client.query<{
    interval_seconds: number;
    security_episode: string;
    in_flight_count: number;
  }>(
    `SELECT interval_seconds,security_episode::text,in_flight_count
     FROM content.board_slow_mode WHERE route=$1 AND board_id=$2`,
    [board.route, board.id],
  );
  return result.rows[0] ?? { interval_seconds: 0, security_episode: '0', in_flight_count: 0 };
}

async function ensureMode(client: AccessClient, boardId: string): Promise<void> {
  const board = resource(boardId);
  await client.query(
    `INSERT INTO content.board_slow_mode(route,board_id,interval_seconds)
     VALUES ($1,$2,0) ON CONFLICT (route,board_id) DO NOTHING`,
    [board.route, board.id],
  );
}

function makePermitReference(
  deps: ContentCommandDependencies,
  actor: Actor,
  boardId: string,
  threadRoute: number,
  receipt: BoardSlowReceiptReference,
  generation: string,
  securityEpisode: string,
  intervalSeconds: number,
): PermitReference {
  const board = resource(boardId);
  return {
    boardRoute: board.route,
    boardId,
    actorKey: actorKey(deps, actor),
    commandKey: commandKey(deps, actor, boardId, threadRoute, receipt),
    requestDigest: Buffer.from(receipt.digest),
    threadRoute,
    commandKind: receipt.kind,
    generation,
    securityEpisode,
    intervalSeconds,
  };
}

function referenceFromRow(row: Record<string, unknown>): PermitRow {
  return {
    boardRoute: Number(row.route),
    boardId: String(row.board_id),
    actorKey: Buffer.from(row.actor_key as Uint8Array),
    commandKey: Buffer.from(row.command_key as Uint8Array),
    requestDigest: Buffer.from(row.request_digest as Uint8Array),
    threadRoute: Number(row.thread_route),
    commandKind: String(row.command_kind),
    generation: String(row.generation),
    securityEpisode: String(row.security_episode),
    intervalSeconds: Number(row.interval_seconds),
    state: String(row.state) as PermitState,
    updatedAt: String(row.updated_at),
    recoveryFromState: row.recovery_from_state === null ? null : String(row.recovery_from_state),
  };
}

function permitValues(reference: PermitReference) {
  return [
    reference.boardRoute,
    reference.boardId,
    reference.actorKey,
    reference.commandKey,
    reference.requestDigest,
    reference.threadRoute,
    reference.commandKind,
    reference.generation,
    reference.securityEpisode,
    reference.intervalSeconds,
  ];
}

async function readCommandPermit(
  deps: ContentCommandDependencies,
  actor: Actor,
  boardId: string,
  threadRoute: number,
  receipt: BoardSlowReceiptReference,
  deadline: number,
): Promise<PermitRow | null> {
  const board = resource(boardId);
  const result = await withConnection(deps.pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    return client.query<Record<string, unknown>>(
      `SELECT route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,
              generation::text,security_episode::text,interval_seconds,state,updated_at::text,recovery_from_state
       FROM content.board_slow_permit
       WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4`,
      [board.route, boardId, actorKey(deps, actor), commandKey(deps, actor, boardId, threadRoute, receipt)],
    );
  });
  return result.rows[0] ? referenceFromRow(result.rows[0]) : null;
}

async function reserveOnBoardHome(
  deps: ContentCommandDependencies,
  actor: Actor,
  boardId: string,
  threadRoute: number,
  receipt: BoardSlowReceiptReference,
  time: AuthoritativeTime,
  check: AccessExplicitCheck,
  deadline: number,
): Promise<PermitPlan | Readonly<{ kind: 'stale'; reference: PermitReference }>> {
  const board = resource(boardId);
  const key = actorKey(deps, actor);
  const command = commandKey(deps, actor, boardId, threadRoute, receipt);
  const digest = Buffer.from(receipt.digest);
  return serializable(deps.pool, deadline, async (client) => {
    await ensureMode(client, boardId);
    const modeResult = await client.query<{
      interval_seconds: number;
      security_episode: string;
    }>(
      `SELECT interval_seconds,security_episode::text FROM content.board_slow_mode
       WHERE route=$1 AND board_id=$2 FOR UPDATE`,
      [board.route, board.id],
    );
    const mode = modeResult.rows[0];
    if (!mode) throw new BoardSlowAdmissionUnavailableError();
    const exemption = await check(client, time);
    if (exemption.allowed && exemption.explicit) return { kind: 'exempt' };

    await client.query(
      `INSERT INTO content.board_slow_actor(route,board_id,actor_key,posted_at,next_episode)
       VALUES ($1,$2,$3,NULL,0) ON CONFLICT (route,board_id,actor_key) DO NOTHING`,
      [board.route, board.id, key],
    );
    const legacyKey = legacyActorKey(deps.routeKey, boardId, actor);
    if (!legacyKey.equals(key)) {
      const legacy = await client.query<{ posted_at: string }>(
        `SELECT posted_at::text FROM content.board_slow_actor
         WHERE route=$1 AND board_id=$2 AND actor_key=$3 FOR UPDATE`,
        [board.route, board.id, legacyKey],
      );
      if (legacy.rows[0]) {
        await client.query(
          `UPDATE content.board_slow_actor SET posted_at=greatest(coalesce(posted_at,$4::timestamptz),$4::timestamptz)
           WHERE route=$1 AND board_id=$2 AND actor_key=$3`,
          [board.route, board.id, key, legacy.rows[0].posted_at],
        );
        await client.query(
          `DELETE FROM content.board_slow_actor WHERE route=$1 AND board_id=$2 AND actor_key=$3`,
          [board.route, board.id, legacyKey],
        );
      }
    }
    const actorResult = await client.query<{
      posted_at: string | null;
      next_episode: string;
    }>(
      `SELECT posted_at::text,next_episode::text FROM content.board_slow_actor
       WHERE route=$1 AND board_id=$2 AND actor_key=$3 FOR UPDATE`,
      [board.route, board.id, key],
    );
    const actorState = actorResult.rows[0];
    if (!actorState) throw new BoardSlowAdmissionUnavailableError();

    const ownResult = await client.query<Record<string, unknown>>(
      `SELECT route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,
              generation::text,security_episode::text,interval_seconds,state,updated_at::text,recovery_from_state
       FROM content.board_slow_permit
       WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4 FOR UPDATE`,
      [board.route, board.id, key, command],
    );
    const own = ownResult.rows[0] ? referenceFromRow(ownResult.rows[0]) : null;
    if (own) {
      if (!sameDigest(own.requestDigest, digest))
        return { kind: 'blocked', error: new BoardSlowAdmissionUnavailableError() };
      if (own.state === 'complete' || own.state === 'pruning')
        return { kind: 'permit', reference: own, bodyAllowed: false };
      if (own.state === 'reserved' && own.securityEpisode !== mode.security_episode)
        return { kind: 'stale', reference: own };
      if (own.state === 'cancelled') {
        // A canceled attempt is safe to re-arm at a new monotonic generation.
      } else if (own.state === 'reserved' || own.state === 'in_flight') {
        return { kind: 'permit', reference: own, bodyAllowed: true };
      } else {
        return { kind: 'blocked', error: new BoardSlowAdmissionUnavailableError() };
      }
    }

    const activeResult = await client.query<Record<string, unknown>>(
      `SELECT route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,
              generation::text,security_episode::text,interval_seconds,state,updated_at::text,recovery_from_state
       FROM content.board_slow_permit
       WHERE route=$1 AND board_id=$2 AND actor_key=$3
         AND state IN ('reserved','in_flight','reconciling')
       ORDER BY updated_at LIMIT 1 FOR UPDATE`,
      [board.route, board.id, key],
    );
    const active = activeResult.rows[0] ? referenceFromRow(activeResult.rows[0]) : null;
    if (active) {
      if (active.state === 'reserved' && active.securityEpisode !== mode.security_episode)
        return { kind: 'stale', reference: active };
      return { kind: 'blocked', error: new BoardSlowAdmissionUnavailableError() };
    }

    if (mode.interval_seconds > 0 && actorState.posted_at !== null) {
      const retryTime = Date.parse(actorState.posted_at) + mode.interval_seconds * 1000;
      if (retryTime > Date.parse(authoritativeTimeValue(time)))
        return {
          kind: 'blocked',
          error: new BoardSlowModeError(new Date(retryTime).toISOString(), mode.interval_seconds),
        };
    }

    const generationResult = await client.query<{ next_episode: string }>(
      `UPDATE content.board_slow_actor SET next_episode=next_episode+1
       WHERE route=$1 AND board_id=$2 AND actor_key=$3 RETURNING next_episode::text`,
      [board.route, board.id, key],
    );
    const generation = generationResult.rows[0]?.next_episode;
    if (!generation) throw new BoardSlowAdmissionUnavailableError();
    const reference = makePermitReference(
      deps,
      actor,
      boardId,
      threadRoute,
      receipt,
      generation,
      mode.security_episode,
      mode.interval_seconds,
    );
    const inserted = await client.query(
      `INSERT INTO content.board_slow_permit
        (route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,generation,
         security_episode,interval_seconds,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9::bigint,$10,'reserved')
       ON CONFLICT (route,board_id,actor_key,command_key) DO UPDATE SET
         request_digest=EXCLUDED.request_digest,thread_route=EXCLUDED.thread_route,
         command_kind=EXCLUDED.command_kind,generation=EXCLUDED.generation,
         security_episode=EXCLUDED.security_episode,interval_seconds=EXCLUDED.interval_seconds,
         state='reserved',recovery_from_state=NULL,created_at=clock_timestamp(),
         updated_at=clock_timestamp(),completed_at=NULL
       WHERE content.board_slow_permit.state='cancelled'
         AND content.board_slow_permit.request_digest=EXCLUDED.request_digest
       RETURNING command_key`,
      permitValues(reference),
    );
    if (!inserted.rowCount) throw new BoardSlowAdmissionUnavailableError();
    return { kind: 'permit', reference, bodyAllowed: true };
  });
}

async function prepareTargetTicket(
  pool: Pool,
  reference: PermitReference,
  deadline: number,
): Promise<TicketState | null> {
  return serializable(pool, deadline, async (client) => {
    const result = await client.query<{ state: TicketState }>(
      `INSERT INTO content.board_slow_ticket
        (route,command_key,generation,board_route,board_id,request_digest,command_kind,state)
       VALUES ($1,$2,$3::bigint,$4,$5,$6,$7,'reserved')
       ON CONFLICT (route,command_key) DO UPDATE SET
         generation=EXCLUDED.generation,board_route=EXCLUDED.board_route,board_id=EXCLUDED.board_id,
         request_digest=EXCLUDED.request_digest,command_kind=EXCLUDED.command_kind,
         state='reserved',target_post_id=NULL,revision_id=NULL,transaction_id=NULL,posted_at=NULL,
         updated_at=clock_timestamp()
       WHERE (content.board_slow_ticket.generation < EXCLUDED.generation
              AND content.board_slow_ticket.state IN ('cancelled','committed','replayed'))
          OR (content.board_slow_ticket.generation = EXCLUDED.generation
              AND content.board_slow_ticket.state = 'reserved'
              AND content.board_slow_ticket.request_digest = EXCLUDED.request_digest)
       RETURNING state`,
      [
        reference.threadRoute,
        reference.commandKey,
        reference.generation,
        reference.boardRoute,
        reference.boardId,
        reference.requestDigest,
        reference.commandKind,
      ],
    );
    if (result.rows[0]) return result.rows[0].state;
    const existing = await client.query<{ generation: string; state: TicketState }>(
      `SELECT generation::text,state FROM content.board_slow_ticket
       WHERE route=$1 AND command_key=$2`,
      [reference.threadRoute, reference.commandKey],
    );
    const ticket = existing.rows[0];
    if (!ticket || ticket.generation !== reference.generation) return null;
    return ticket.state;
  });
}

async function activatePermit(pool: Pool, reference: PermitReference, deadline: number): Promise<boolean> {
  return serializable(pool, deadline, async (client) => {
    const board = resource(reference.boardId);
    const modeResult = await client.query<{ security_episode: string }>(
      `SELECT security_episode::text FROM content.board_slow_mode
       WHERE route=$1 AND board_id=$2 FOR UPDATE`,
      [reference.boardRoute, reference.boardId],
    );
    const modeEpisode = modeResult.rows[0]?.security_episode;
    const permitResult = await client.query<{ state: PermitState; security_episode: string }>(
      `SELECT state,security_episode::text FROM content.board_slow_permit
       WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4 FOR UPDATE`,
      [board.route, board.id, reference.actorKey, reference.commandKey],
    );
    const permit = permitResult.rows[0];
    if (!permit || permit.security_episode !== modeEpisode) return false;
    if (permit.state === 'in_flight') return true;
    if (permit.state !== 'reserved') return false;
    await client.query(
      `UPDATE content.board_slow_permit SET state='in_flight',updated_at=clock_timestamp()
       WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4 AND state='reserved'`,
      [board.route, board.id, reference.actorKey, reference.commandKey],
    );
    await client.query(
      `UPDATE content.board_slow_mode SET in_flight_count=in_flight_count+1
       WHERE route=$1 AND board_id=$2`,
      [board.route, board.id],
    );
    return true;
  });
}

async function claimTicket(
  tx: CommandTransaction,
  plan: PermitPlan,
  details: Readonly<{
    targetPostId: string;
    revisionId: string;
    transactionId: string;
    postedAt: string;
  }>,
): Promise<void> {
  if (plan.kind === 'exempt') return;
  if (plan.kind === 'blocked') throw plan.error;
  if (!plan.bodyAllowed) throw new BoardSlowAdmissionUnavailableError();
  const reference = plan.reference;
  const claimed = await tx.query(
    `UPDATE content.board_slow_ticket SET state='committed',target_post_id=$5,revision_id=$6,
         transaction_id=$7,posted_at=$8::timestamptz,updated_at=clock_timestamp()
     WHERE route=$1 AND command_key=$2 AND generation=$3::bigint AND request_digest=$4
       AND state='reserved'
     RETURNING command_key`,
    [
      reference.threadRoute,
      reference.commandKey,
      reference.generation,
      reference.requestDigest,
      details.targetPostId,
      details.revisionId,
      details.transactionId,
      details.postedAt,
    ],
  );
  if (!claimed.rowCount) throw new BoardSlowAdmissionUnavailableError();
}

async function markReplayTicket(
  pool: Pool,
  reference: PermitReference,
  value: ContentCommandValue,
  deadline: number,
): Promise<void> {
  await serializable(pool, deadline, async (client) => {
    const evidence = await client.query(
      `SELECT 1 FROM content.revision
       WHERE route=$1 AND post_id=$2 AND revision_id=$3`,
      [reference.threadRoute, value.itemId, value.revisionId],
    );
    if (!evidence.rowCount) return;
    await client.query(
      `UPDATE content.board_slow_ticket SET state='replayed',target_post_id=$4,revision_id=$5,
           transaction_id=NULL,posted_at=NULL,updated_at=clock_timestamp()
       WHERE route=$1 AND command_key=$2 AND generation=$3::bigint
         AND state='reserved' AND request_digest=$6`,
      [
        reference.threadRoute,
        reference.commandKey,
        reference.generation,
        value.itemId,
        value.revisionId,
        reference.requestDigest,
      ],
    );
  });
}

async function ticketWitness(pool: Pool, reference: PermitReference, deadline: number): Promise<TicketRow | null> {
  return withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const result = await client.query<TicketRow>(
      `SELECT t.generation::text,t.state,t.board_route AS "boardRoute",t.board_id AS "boardId",
              t.request_digest AS "requestDigest",t.command_kind AS "commandKind",
              t.target_post_id::text AS "targetPostId",t.revision_id::text AS "revisionId",
              t.transaction_id::text AS "transactionId",t.posted_at::text AS "postedAt",
              r.recorded_transaction_id::text AS "witnessTransactionId"
       FROM content.board_slow_ticket t
       LEFT JOIN content.revision r ON r.route=t.route AND r.post_id=t.target_post_id AND r.revision_id=t.revision_id
       WHERE t.route=$1 AND t.command_key=$2 AND t.generation=$3::bigint`,
      [reference.threadRoute, reference.commandKey, reference.generation],
    );
    return result.rows[0] ?? null;
  });
}

async function finalizePermit(
  pool: Pool,
  reference: PermitReference,
  outcome: 'committed' | 'replayed' | 'cancelled',
  postedAt: string | null,
  deadline = defaultDeadline(),
): Promise<void> {
  await serializable(pool, deadline, async (client) => {
    await client.query(
      `SELECT 1 FROM content.board_slow_mode WHERE route=$1 AND board_id=$2 FOR UPDATE`,
      [reference.boardRoute, reference.boardId],
    );
    const result = await client.query<{ state: PermitState; recovery_from_state: string | null }>(
      `SELECT state,recovery_from_state FROM content.board_slow_permit
       WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4
       AND generation=$5::bigint FOR UPDATE`,
      [reference.boardRoute, reference.boardId, reference.actorKey, reference.commandKey, reference.generation],
    );
    const permit = result.rows[0];
    if (!permit || permit.state === 'complete' || permit.state === 'cancelled' || permit.state === 'pruning') return;
    const wasInFlight = permit.state === 'in_flight' || permit.recovery_from_state === 'in_flight';
    if (wasInFlight) {
      await client.query(
        `UPDATE content.board_slow_mode SET in_flight_count=greatest(in_flight_count-1,0)
         WHERE route=$1 AND board_id=$2`,
        [reference.boardRoute, reference.boardId],
      );
    }
    if (outcome === 'committed' && postedAt && reference.intervalSeconds > 0) {
      await client.query(
        `UPDATE content.board_slow_actor SET posted_at=greatest(coalesce(posted_at,$4::timestamptz),$4::timestamptz)
         WHERE route=$1 AND board_id=$2 AND actor_key=$3`,
        [reference.boardRoute, reference.boardId, reference.actorKey, postedAt],
      );
    }
    await client.query(
      `UPDATE content.board_slow_permit SET state=$6,recovery_from_state=NULL,
           completed_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4 AND generation=$5::bigint`,
      [
        reference.boardRoute,
        reference.boardId,
        reference.actorKey,
        reference.commandKey,
        reference.generation,
        outcome === 'cancelled' ? 'cancelled' : 'complete',
      ],
    );
  });
}

async function resolvePermit(
  pool: Pool,
  reference: PermitReference,
  deadline: number,
  allowFresh: boolean,
): Promise<'complete' | 'cancelled' | 'busy' | 'unknown' | 'stale'> {
  const claim = await serializable(pool, deadline, async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `SELECT route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,
              generation::text,security_episode::text,interval_seconds,state,updated_at::text,recovery_from_state
       FROM content.board_slow_permit
       WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4 FOR UPDATE`,
      [reference.boardRoute, reference.boardId, reference.actorKey, reference.commandKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    const current = referenceFromRow(row);
    if (current.generation !== reference.generation) return { kind: 'stale' as const, current };
    if (current.state === 'complete') return { kind: 'complete' as const, current };
    if (current.state === 'cancelled') return { kind: 'cancelled' as const, current };
    if (current.state === 'pruning') return { kind: 'stale' as const, current };
    if (!allowFresh && Date.parse(current.updatedAt) + RECOVERY_GRACE_MS > Date.now()) return null;
    const from = current.state === 'reconciling' ? current.recoveryFromState : current.state;
    if (from !== 'reserved' && from !== 'in_flight') return null;
    await client.query(
      `UPDATE content.board_slow_permit SET state='reconciling',recovery_from_state=$5,
           updated_at=clock_timestamp()
       WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4`,
      [reference.boardRoute, reference.boardId, reference.actorKey, reference.commandKey, from],
    );
    return { kind: 'claimed' as const, current, from };
  });
  if (!claim) return 'busy';
  if (claim.kind === 'stale') return 'stale';
  if (claim.kind === 'complete') return 'complete';
  if (claim.kind === 'cancelled') return 'cancelled';

  let ticket: TicketRow | null;
  try {
    ticket = await serializable(pool, deadline, async (client) => {
      const result = await client.query<TicketRow>(
        `SELECT t.generation::text,t.state,t.board_route AS "boardRoute",t.board_id AS "boardId",
                t.request_digest AS "requestDigest",t.command_kind AS "commandKind",
                t.target_post_id::text AS "targetPostId",t.revision_id::text AS "revisionId",
                t.transaction_id::text AS "transactionId",t.posted_at::text AS "postedAt",
                r.recorded_transaction_id::text AS "witnessTransactionId"
         FROM content.board_slow_ticket t
         LEFT JOIN content.revision r ON r.route=t.route AND r.post_id=t.target_post_id AND r.revision_id=t.revision_id
         WHERE t.route=$1 AND t.command_key=$2 FOR UPDATE OF t NOWAIT`,
        [reference.threadRoute, reference.commandKey],
      );
      const row = result.rows[0] ?? null;
      if (!row || row.generation !== reference.generation) {
        if (row && row.generation > reference.generation) return row;
        await client.query(
          `INSERT INTO content.board_slow_ticket
            (route,command_key,generation,board_route,board_id,request_digest,command_kind,state)
           VALUES ($1,$2,$3::bigint,$4,$5,$6,$7,'cancelled')
           ON CONFLICT (route,command_key) DO UPDATE SET generation=EXCLUDED.generation,
             board_route=EXCLUDED.board_route,board_id=EXCLUDED.board_id,
             request_digest=EXCLUDED.request_digest,command_kind=EXCLUDED.command_kind,
             state='cancelled',updated_at=clock_timestamp()
           WHERE content.board_slow_ticket.generation < EXCLUDED.generation`,
          [
            reference.threadRoute,
            reference.commandKey,
            reference.generation,
            reference.boardRoute,
            reference.boardId,
            reference.requestDigest,
            reference.commandKind,
          ],
        );
        return null;
      }
      if (
        row.boardRoute !== reference.boardRoute ||
        row.boardId !== reference.boardId ||
        row.commandKind !== reference.commandKind ||
        !sameDigest(row.requestDigest, reference.requestDigest)
      )
        throw new Error('Board slow ticket identity does not match its permit');
      if (row.state === 'committed' || row.state === 'replayed') {
        if (
          row.targetPostId &&
          row.revisionId &&
          row.postedAt &&
          row.transactionId &&
          row.witnessTransactionId === row.transactionId
        )
          return row;
        if (row.state === 'replayed' && row.targetPostId && row.revisionId) return row;
        throw new Error('Board slow ticket has no committed revision witness');
      }
      if (row.state === 'reserved') {
        await client.query(
          `UPDATE content.board_slow_ticket SET state='cancelled',updated_at=clock_timestamp()
           WHERE route=$1 AND command_key=$2 AND generation=$3::bigint AND state='reserved'`,
          [reference.threadRoute, reference.commandKey, reference.generation],
        );
        return { ...row, state: 'cancelled' as const };
      }
      return row;
    });
  } catch (error) {
    if (databaseCode(error) === '55P03' || databaseCode(error) === '40P01' || databaseCode(error) === '40001') {
      await serializable(pool, deadline, async (client) => {
        await client.query(
          `UPDATE content.board_slow_permit SET state=$6,recovery_from_state=NULL,updated_at=clock_timestamp()
           WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4 AND generation=$5::bigint
             AND state='reconciling'`,
          [
            reference.boardRoute,
            reference.boardId,
            reference.actorKey,
            reference.commandKey,
            reference.generation,
            claim.from,
          ],
        );
      });
      return 'busy';
    }
    throw error;
  }

  if (ticket && ticket.generation !== reference.generation) return 'stale';
  if (ticket?.state === 'committed' && ticket.postedAt && ticket.transactionId === ticket.witnessTransactionId) {
    await finalizePermit(pool, reference, 'committed', ticket.postedAt, deadline);
    return 'complete';
  }
  if (ticket?.state === 'replayed') {
    await finalizePermit(pool, reference, 'replayed', null, deadline);
    return 'complete';
  }
  if (ticket?.state === 'cancelled' || ticket === null) {
    await finalizePermit(pool, reference, 'cancelled', null, deadline);
    return 'cancelled';
  }
  // Unknown target evidence remains pending. The worker may retry after the data is available.
  await serializable(pool, deadline, async (client) => {
    await client.query(
      `UPDATE content.board_slow_permit SET state=$6,recovery_from_state=NULL,updated_at=clock_timestamp()
       WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4 AND generation=$5::bigint
         AND state='reconciling'`,
      [
        reference.boardRoute,
        reference.boardId,
        reference.actorKey,
        reference.commandKey,
        reference.generation,
        claim.from,
      ],
    );
  });
  return 'unknown';
}

function retryErrorForPlan(plan: PermitPlan): BoardSlowModeError | BoardSlowAdmissionUnavailableError | null {
  if (plan.kind === 'blocked') return plan.error;
  if (plan.kind === 'permit' && !plan.bodyAllowed) return new BoardSlowAdmissionUnavailableError();
  return null;
}

/**
 * The admission checkout and target ticket checkout both finish before runCommand
 * opens the thread-home transaction. The local ticket is the commit witness used
 * to recover uncertain delivery and close a permit after a process restart.
 */
export function boardSlowAdmission(
  deps: ContentCommandDependencies,
  actor: Actor,
  context: RequestContext,
  threadRoute: number,
  receipt: BoardSlowReceiptReference,
) {
  let latest: PermitPlan | undefined;
  let lastBoardId: string | undefined;

  return {
    async prepare(boardId: string, time: AuthoritativeTime) {
      lastBoardId = boardId;
      authoritativeTimeValue(time);
      const board = resource(boardId);
      const check = await accessExplicitCheck(deps.access, actor, 'moderation:takedown', board, {
        pool: deps.pool,
        deadline: context.deadline,
      });
      let reserved: Awaited<ReturnType<typeof reserveOnBoardHome>>;
      try {
        reserved = await reserveOnBoardHome(
          deps,
          actor,
          boardId,
          threadRoute,
          receipt,
          time,
          check,
          context.deadline,
        );
      } catch (error) {
        if (!admissionConflict(error)) throw error;
        latest = { kind: 'blocked', error: new BoardSlowAdmissionUnavailableError() };
        return;
      }
      if (reserved.kind === 'stale') {
        await resolvePermit(deps.pool, reserved.reference, context.deadline, true);
        latest = { kind: 'blocked', error: new BoardSlowAdmissionUnavailableError() };
        return;
      }
      if (reserved.kind === 'exempt' || reserved.kind === 'blocked') {
        latest = reserved;
        return;
      }
      if (!reserved.bodyAllowed) {
        latest = reserved;
        return;
      }

      const pendingPlan: PermitPlan = { kind: 'permit', reference: reserved.reference, bodyAllowed: true };
      latest = pendingPlan;

      try {
        const ticket = await prepareTargetTicket(deps.pool, reserved.reference, context.deadline);
        if (ticket === null || ticket === 'cancelled') throw new BoardSlowAdmissionUnavailableError();
        if (ticket === 'committed' || ticket === 'replayed') {
          latest = { kind: 'permit', reference: reserved.reference, bodyAllowed: false };
          return;
        }
        if (!(await activatePermit(deps.pool, reserved.reference, context.deadline)))
          throw new BoardSlowAdmissionUnavailableError();
      } catch (error) {
        if (!admissionConflict(error)) throw error;
        latest = { kind: 'blocked', error: new BoardSlowAdmissionUnavailableError() };
      }
    },

    async claim(
      tx: CommandTransaction,
      time: AuthoritativeTime,
      details: Readonly<{
        targetPostId: string;
        revisionId: string;
        transactionId: string;
        postedAt: string;
      }>,
    ) {
      authoritativeTimeValue(time);
      const plan = latest;
      if (!plan) throw new BoardSlowAdmissionUnavailableError();
      await claimTicket(tx, plan, details);
    },

    async finish(outcome: CommandOutcome<ContentCommandValue>) {
      const plan = latest;
      if (!plan || plan.kind !== 'permit') return;
      if (outcome.replayed) await markReplayTicket(deps.pool, plan.reference, outcome.value, context.deadline);
      const witness = await ticketWitness(deps.pool, plan.reference, context.deadline);
      if (!witness || !sameDigest(witness.requestDigest, plan.reference.requestDigest)) return;
      if (
        witness.state === 'committed' &&
        witness.postedAt &&
        witness.transactionId !== null &&
        witness.witnessTransactionId === witness.transactionId
      ) {
        await finalizePermit(deps.pool, plan.reference, 'committed', witness.postedAt, context.deadline);
      } else if (witness.state === 'replayed') {
        await finalizePermit(deps.pool, plan.reference, 'replayed', null, context.deadline);
      }
    },

    async recoverLatest() {
      let reference: PermitReference | undefined;
      const plan = latest;
      if (plan?.kind === 'permit') reference = plan.reference;
      else if (lastBoardId) {
        const permit = await readCommandPermit(
          deps,
          actor,
          lastBoardId,
          threadRoute,
          receipt,
          context.deadline,
        );
        if (permit && sameDigest(permit.requestDigest, receipt.digest)) reference = permit;
      }
      if (!reference) return;
      const outcome = await resolvePermit(deps.pool, reference, context.deadline, true);
      if (outcome === 'busy' || outcome === 'unknown' || outcome === 'stale')
        throw new BoardSlowAdmissionUnavailableError();
    },

    assertAllowed(time: AuthoritativeTime) {
      authoritativeTimeValue(time);
      const plan = latest;
      if (!plan) throw new BoardSlowAdmissionUnavailableError();
      const error = retryErrorForPlan(plan);
      if (error) throw error;
    },
  };
}

export async function setBoardSlowMode(
  deps: ContentCommandDependencies,
  actor: Actor,
  boardId: string,
  intervalSeconds: number,
  context: RequestContext,
) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 0 || intervalSeconds > 86400)
    throw new BoardSlowModeInputError();
  const board = resource(boardId);
  const identity = principalCommandIdentity(actor);
  const authorization = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'moderation:takedown',
    anchor: {
      resource: board,
      async validate(client) {
        const row = await client.query(
          "SELECT 1 FROM content.board WHERE route=$1 AND board_id=$2 AND visibility<>'taken_down'",
          [board.route, board.id],
        );
        return row.rowCount === 1;
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(board.route) },
  });
  return runCommand(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(board.route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: {
        kind: 'content.board.slow-mode.set',
        key: context.idempotencyKey,
        digest: createHash('sha256').update(canonicalize([boardId, intervalSeconds])!).digest(),
      },
    },
    async (tx) => {
      const current = await tx.query<{ interval_seconds: number; in_flight_count: number }>(
        `SELECT interval_seconds,in_flight_count FROM content.board_slow_mode
         WHERE route=$1 AND board_id=$2 FOR UPDATE`,
        [board.route, board.id],
      );
      const mode = current.rows[0];
      if (mode && mode.interval_seconds !== intervalSeconds && mode.in_flight_count > 0)
        throw new BoardSlowAdmissionUnavailableError();
      await tx.query(
        `INSERT INTO content.board_slow_mode(route,board_id,interval_seconds)
         VALUES ($1,$2,$3)
         ON CONFLICT (route,board_id) DO UPDATE SET
           security_episode=CASE WHEN content.board_slow_mode.interval_seconds<>EXCLUDED.interval_seconds
             THEN content.board_slow_mode.security_episode+1 ELSE content.board_slow_mode.security_episode END,
           interval_seconds=EXCLUDED.interval_seconds`,
        [board.route, board.id, intervalSeconds],
      );
      return {
        value: {
          intervalSeconds,
          retryAt: null,
          nextEligibleAt: null,
          canChange: true,
          exempt: true,
          admissionState: 'ready' as const,
          retryAfterSeconds: 0,
        },
        events: [
          {
            type: 'com.rezics.content.board.slow-mode.changed.v1',
            subject: boardId,
            data: { boardId, intervalSeconds },
          },
        ],
      };
    },
  );
}

export type BoardSlowModeRead = Readonly<{
  intervalSeconds: number;
  retryAt: string | null;
  /** Additive alias for the delivered Web slow-mode contract. */
  nextEligibleAt: string | null;
  canChange: boolean;
  exempt: boolean;
  admissionState: 'ready' | 'interval' | 'pending';
  retryAfterSeconds: number;
}>;

/** Caller must disclose the current board both before and after this bounded read. */
export async function readBoardSlowMode(
  deps: ContentCommandDependencies,
  actor: Actor,
  boardId: string,
  deadline: number,
): Promise<BoardSlowModeRead> {
  const board = resource(boardId);
  const now = deps.clock?.() ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError('Invalid board slow-mode read clock');
  const check =
    actor.kind === 'account'
      ? await accessExplicitCheck(deps.access, actor, 'moderation:takedown', board, { pool: deps.pool, deadline })
      : null;
  return withConnection(deps.pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const mode = await readMode(client, boardId);
    const exemption = check ? await check(client) : null;
    const exempt = exemption?.allowed === true && exemption.explicit;
    let retryAt: string | null = null;
    let pending = false;
    if (actor.kind === 'account' && !exempt) {
      const state = await client.query<{ posted_at: string | null; pending: boolean }>(
        `SELECT a.posted_at::text,
           EXISTS (SELECT 1 FROM content.board_slow_permit p
                   WHERE p.route=$1 AND p.board_id=$2 AND p.actor_key IN ($3,$4)
                     AND p.state IN ('reserved','in_flight','reconciling')) AS pending
         FROM content.board_slow_actor a WHERE a.route=$1 AND a.board_id=$2 AND a.actor_key IN ($3,$4)
         ORDER BY a.posted_at DESC NULLS LAST LIMIT 1`,
        [board.route, board.id, actorKey(deps, actor), legacyActorKey(deps.routeKey, boardId, actor)],
      );
      const row = state.rows[0];
      pending = row?.pending ?? false;
      if (pending) retryAt = new Date(nowMs + 1000).toISOString();
      else if (mode.interval_seconds > 0 && row?.posted_at) {
        const timestamp = Date.parse(row.posted_at) + mode.interval_seconds * 1000;
        if (timestamp > nowMs) retryAt = new Date(timestamp).toISOString();
      }
    }
    const admissionState = pending ? 'pending' : retryAt ? 'interval' : 'ready';
    const retryAfterSeconds =
      pending || !retryAt ? (pending ? 1 : 0) : Math.max(1, Math.ceil((Date.parse(retryAt) - nowMs) / 1000));
    return {
      intervalSeconds: mode.interval_seconds,
      retryAt,
      nextEligibleAt: retryAt,
      canChange: exempt,
      exempt,
      admissionState,
      retryAfterSeconds,
    };
  });
}

type RecoveryCandidate = Readonly<{
  route: number;
  board_id: string;
  actor_key: Buffer;
  command_key: Buffer;
  generation: string;
}>;

/** One bounded recovery page; board and thread checkouts never overlap. */
export async function recoverBoardSlowModePage(
  pool: Pool,
  pageSize = BOARD_SLOW_RECOVERY_PAGE_SIZE,
  now = new Date(),
  deadline = defaultDeadline(),
): Promise<number> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > BOARD_SLOW_RECOVERY_PAGE_SIZE)
    throw new RangeError('Invalid board slow-mode recovery page size');
  const cutoff = new Date(now.getTime() - RECOVERY_GRACE_MS).toISOString();
  const candidates = await withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const result = await client.query<RecoveryCandidate>(
      `SELECT route,board_id,actor_key,command_key,generation::text
       FROM content.board_slow_permit
       WHERE state IN ('reserved','in_flight','reconciling') AND updated_at<$1::timestamptz
       ORDER BY updated_at,route,board_id,actor_key,command_key LIMIT $2`,
      [cutoff, pageSize],
    );
    return result.rows;
  });
  let resolved = 0;
  for (const candidate of candidates) {
    const row = await withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const result = await client.query<Record<string, unknown>>(
        `SELECT route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,
                generation::text,security_episode::text,interval_seconds,state,updated_at::text,recovery_from_state
         FROM content.board_slow_permit
         WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4`,
        [candidate.route, candidate.board_id, candidate.actor_key, candidate.command_key],
      );
      return result.rows[0];
    });
    if (!row) continue;
    const reference = referenceFromRow(row);
    if (reference.generation !== candidate.generation) continue;
    const outcome = await resolvePermit(pool, reference, deadline, false);
    if (outcome === 'complete' || outcome === 'cancelled') resolved++;
  }
  return resolved;
}

type ErasurePermitCandidate = Readonly<{
  route: number;
  board_id: string;
  actor_key: Buffer;
  command_key: Buffer;
  generation: string;
}>;

/** Erase one bounded pseudonymous actor page after fencing in-flight commands. */
export async function eraseBoardSlowModeAccountPage(
  pool: Pool,
  routeKey: Uint8Array,
  accountId: string,
  pageSize = BOARD_SLOW_RECOVERY_PAGE_SIZE,
  deadline = defaultDeadline(),
): Promise<Readonly<{ removed: number; more: boolean; pending: boolean }>> {
  if (routeOf(accountId) === null) throw new TypeError('Invalid board slow-mode erasure account');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > BOARD_SLOW_RECOVERY_PAGE_SIZE)
    throw new RangeError('Invalid board slow-mode erasure page size');
  const key = actorKeyForAccount(routeKey, accountId);
  const selected = await withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const result = await client.query<ErasurePermitCandidate>(
      `SELECT route,board_id,actor_key,command_key,generation::text
       FROM content.board_slow_permit WHERE actor_key=$1
       ORDER BY route,board_id,command_key LIMIT $2`,
      [key, pageSize],
    );
    return result.rows;
  });
  let removed = 0;
  for (const candidate of selected) {
    const row = await withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const result = await client.query<Record<string, unknown>>(
        `SELECT route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,
                generation::text,security_episode::text,interval_seconds,state,updated_at::text,recovery_from_state
         FROM content.board_slow_permit
         WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4`,
        [candidate.route, candidate.board_id, candidate.actor_key, candidate.command_key],
      );
      return result.rows[0];
    });
    if (!row) continue;
    const reference = referenceFromRow(row);
    if (reference.generation !== candidate.generation) continue;
    if (reference.state === 'reserved' || reference.state === 'in_flight' || reference.state === 'reconciling') {
      const state = await resolvePermit(pool, reference, deadline, true);
      if (state === 'busy' || state === 'unknown')
        return { removed, more: true, pending: true };
      if (state === 'stale') continue;
    }
    await serializable(pool, deadline, async (client) => {
      await client.query(
        `DELETE FROM content.board_slow_ticket
         WHERE route=$1 AND command_key=$2 AND generation=$3::bigint`,
        [reference.threadRoute, reference.commandKey, reference.generation],
      );
    });
    const deleted = await serializable(pool, deadline, async (client) => {
      await client.query(
        `SELECT 1 FROM content.board_slow_mode WHERE route=$1 AND board_id=$2 FOR UPDATE`,
        [reference.boardRoute, reference.boardId],
      );
      await client.query(
        `SELECT 1 FROM content.board_slow_actor
         WHERE route=$1 AND board_id=$2 AND actor_key=$3 FOR UPDATE`,
        [reference.boardRoute, reference.boardId, reference.actorKey],
      );
      const result = await client.query(
        `DELETE FROM content.board_slow_permit
         WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4
           AND generation=$5::bigint AND state IN ('complete','cancelled','pruning')
         RETURNING command_key`,
        [reference.boardRoute, reference.boardId, reference.actorKey, reference.commandKey, reference.generation],
      );
      await client.query(
        `DELETE FROM content.board_slow_actor a
         WHERE route=$1 AND board_id=$2 AND actor_key=$3
           AND NOT EXISTS (SELECT 1 FROM content.board_slow_permit p
                           WHERE p.route=a.route AND p.board_id=a.board_id AND p.actor_key=a.actor_key)`,
        [reference.boardRoute, reference.boardId, reference.actorKey],
      );
      return result.rowCount ?? 0;
    });
    if (deleted) removed++;
  }
  if (selected.length === pageSize) return { removed, more: true, pending: false };

  const permitsRemain = await withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM content.board_slow_permit WHERE actor_key=$1) AS exists`,
      [key],
    );
    return result.rows[0]?.exists ?? false;
  });
  if (permitsRemain) return { removed, more: true, pending: false };

  const actors = await withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const result = await client.query<{ route: number; board_id: string }>(
      `SELECT a.route,a.board_id FROM content.board_slow_actor a
       WHERE a.actor_key=$1
         AND NOT EXISTS (SELECT 1 FROM content.board_slow_permit p
                         WHERE p.route=a.route AND p.board_id=a.board_id AND p.actor_key=a.actor_key)
       ORDER BY a.route,a.board_id LIMIT $2`,
      [key, pageSize],
    );
    return result.rows;
  });
  for (const actor of actors) {
    await serializable(pool, deadline, async (client) => {
      await client.query(
        `SELECT 1 FROM content.board_slow_mode WHERE route=$1 AND board_id=$2 FOR UPDATE`,
        [actor.route, actor.board_id],
      );
      await client.query(
        `DELETE FROM content.board_slow_actor a
         WHERE route=$1 AND board_id=$2 AND actor_key=$3
           AND NOT EXISTS (SELECT 1 FROM content.board_slow_permit p
                           WHERE p.route=a.route AND p.board_id=a.board_id AND p.actor_key=a.actor_key)`,
        [actor.route, actor.board_id, key],
      );
    });
  }
  return { removed, more: actors.length === pageSize, pending: false };
}

/** Delete one bounded page of expired command history and its thread-home witnesses. */
export async function pruneBoardSlowModeHistoryPage(
  pool: Pool,
  pageSize = BOARD_SLOW_RECOVERY_PAGE_SIZE,
  cutoff = new Date(Date.now() - BOARD_SLOW_RETENTION_MS).toISOString(),
  deadline = defaultDeadline(),
): Promise<number> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > BOARD_SLOW_RECOVERY_PAGE_SIZE)
    throw new RangeError('Invalid board slow-mode retention page size');
  const selected = await serializable(pool, deadline, async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `SELECT route,board_id,actor_key,command_key,request_digest,thread_route,command_kind,
              generation::text,security_episode::text,interval_seconds,state,updated_at::text,recovery_from_state
       FROM content.board_slow_permit
       WHERE state IN ('complete','cancelled','pruning') AND completed_at<$1::timestamptz
       ORDER BY completed_at,route,board_id,actor_key,command_key LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [cutoff, pageSize],
    );
    for (const row of result.rows) {
      await client.query(
        `UPDATE content.board_slow_permit SET state='pruning',updated_at=clock_timestamp()
         WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4`,
        [row.route, row.board_id, row.actor_key, row.command_key],
      );
    }
    return result.rows.map(referenceFromRow);
  });
  let removed = 0;
  for (const reference of selected) {
    await serializable(pool, deadline, async (client) => {
      await client.query(
        `DELETE FROM content.board_slow_ticket
         WHERE route=$1 AND command_key=$2 AND generation=$3::bigint AND state IN ('committed','replayed','cancelled')`,
        [reference.threadRoute, reference.commandKey, reference.generation],
      );
    });
    const deleted = await serializable(pool, deadline, async (client) =>
      client.query(
        `DELETE FROM content.board_slow_permit
         WHERE route=$1 AND board_id=$2 AND actor_key=$3 AND command_key=$4
           AND generation=$5::bigint AND state='pruning' RETURNING command_key`,
        [reference.boardRoute, reference.boardId, reference.actorKey, reference.commandKey, reference.generation],
      ),
    );
    if (deleted.rowCount) removed++;
  }
  const actors = await withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const empty = await client.query<{ route: number; board_id: string; actor_key: Buffer }>(
      `SELECT route,board_id,actor_key FROM content.board_slow_actor
       WHERE posted_at IS NULL ORDER BY route,board_id,actor_key LIMIT $1`,
      [pageSize],
    );
    if (empty.rows.length === pageSize) return empty.rows;
    const expired = await client.query<{ route: number; board_id: string; actor_key: Buffer }>(
      `SELECT route,board_id,actor_key FROM content.board_slow_actor
       WHERE posted_at<$1::timestamptz ORDER BY posted_at,route,board_id,actor_key LIMIT $2`,
      [cutoff, pageSize - empty.rows.length],
    );
    return [...empty.rows, ...expired.rows];
  });
  for (const actor of actors) {
    await serializable(pool, deadline, async (client) => {
      await client.query(
        `SELECT 1 FROM content.board_slow_mode WHERE route=$1 AND board_id=$2 FOR UPDATE`,
        [actor.route, actor.board_id],
      );
      await client.query(
        `DELETE FROM content.board_slow_actor a
         WHERE route=$1 AND board_id=$2 AND actor_key=$3
           AND (posted_at IS NULL OR posted_at<$4::timestamptz)
           AND NOT EXISTS (SELECT 1 FROM content.board_slow_permit p
                           WHERE p.route=a.route AND p.board_id=a.board_id AND p.actor_key=a.actor_key)`,
        [actor.route, actor.board_id, actor.actor_key, cutoff],
      );
    });
  }
  return Math.max(removed, selected.length, actors.length);
}
