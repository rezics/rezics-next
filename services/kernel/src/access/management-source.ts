import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  releaseOperationalTime,
  type AuthoritativeTime,
} from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessClient, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { accessClock } from './access-clock.ts';
import { readAccount } from './account-data.ts';
import { deadlineClient, within } from './authenticate.ts';
import assignmentRead from './delegation-read.sql';
import { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable } from '../request/unavailable.ts';
import operatorRead from './management-source-operator.sql';

/** Private native point read. This is neither an approval nor a transfer receipt. */
export type OperatorTransferState = {
  previous: { operatorAccountId: string; subjectAccountId: string; reservationId: string };
  expectedVersion: string;
};
export type OperatorTransferStateInput = { subjectAccountId: string };
export class ManagementSourceRefusedError extends Error {
  readonly status: number;
  constructor(readonly reason: 'invalid' | 'denied' | 'terminal' | 'fenced' | 'stale') {
    super(`Account management source refused: ${reason}`);
    this.name = 'ManagementSourceRefusedError';
    this.status = reason === 'invalid' ? 400 : reason === 'stale' ? 409 : 403;
  }
}

type Dependencies = { pool: Pool; access: Access; clock?: KernelClock };
type SourceRow = NonNullable<Awaited<ReturnType<typeof operatorRead.run>>>;
async function home(client: AccessClient, route: number) {
  const partition = partitionOf(route);
  const source = await readPartition(client, partition);
  if (!source) throw new CommandUnavailableError('contention', partition);
  if (source.writeState !== 'active') throw new CommandUnavailableError(source.writeState, partition, source.movedTo);
  return source.epoch;
}
function relation(row: SourceRow | null, subjectAccountId: string): OperatorTransferState | null {
  if (!row) return null;
  if (row.fenced) throw new ManagementSourceRefusedError('fenced');
  if (row.kind !== 'actor' || row.state !== 'active') throw new ManagementSourceRefusedError('denied');
  if (row.operatorAccountId === null && row.reservationId === null) return null;
  if (row.terminal) throw new ManagementSourceRefusedError('terminal');
  if (
    !row.operatorAccountId ||
    !row.reservationId ||
    routeOf(row.operatorAccountId) === null ||
    row.operatorAccountId === subjectAccountId ||
    row.slotOperatorAccountId !== row.operatorAccountId ||
    row.terminal !== false ||
    !/^(0|[1-9][0-9]*)$/.test(row.version)
  )
    throw new CommandUnavailableError('contention', partitionOf(routeOf(subjectAccountId)!));
  return {
    previous: { operatorAccountId: row.operatorAccountId, subjectAccountId, reservationId: row.reservationId },
    expectedVersion: row.version,
  };
}

/** The original slot/lifecycle interpretation, shared by native entry observations. */
export async function readNativeOperatorTransferRelation(client: AccessClient, subjectAccountId: string) {
  return relation(
    await operatorRead.run(client, { route: routeOf(subjectAccountId)!, subject_id: subjectAccountId }),
    subjectAccountId,
  );
}

/** Preparation releases the subject source before any foreign authority read.
 * Final disclosure rechecks the exact native slot/version and ordinary Access
 * formula in one bounded snapshot. Caller tuples, scopes and profiles are never
 * evidence of permission. Missing source differs from unavailable source.
 */
export async function readOperatorTransferState(
  deps: Dependencies,
  actor: Actor,
  input: OperatorTransferStateInput,
  { deadline }: { deadline: number },
): Promise<OperatorTransferState | null> {
  const subjectAccountId = input?.subjectAccountId;
  const route = routeOf(subjectAccountId);
  if (route === null || Object.keys(input).join(',') !== 'subjectAccountId' || !Number.isFinite(deadline))
    throw new ManagementSourceRefusedError('invalid');
  if (actor.kind !== 'account' || !deps.access.prepare) throw new ManagementSourceRefusedError('denied');
  let time: AuthoritativeTime | undefined;
  const snapshot = <T>(read: (client: AccessClient) => Promise<T>) =>
    within(deadline, () =>
      withConnection(deps.pool, async (client) => {
        const bounded = deadlineClient(client, deadline);
        await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const result = await read(bounded);
          requireAccessDeadline(deadline);
          await bounded.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(client, rollbackError as Error);
          }
          throw error;
        }
      }),
    );
  try {
    const source = await snapshot(async (client) => {
      const epoch = await home(client, route);
      time = await mintReadTime(client, deps.clock ?? accessClock(deps.access));
      return {
        epoch,
        state: await readNativeOperatorTransferRelation(client, subjectAccountId),
      };
    });
    if (!source.state) return null;
    const state = source.state;
    const operatorId = state.previous.operatorAccountId;
    const operatorRoute = routeOf(operatorId)!;
    const context = { pool: deps.pool, deadline, time: time! };
    const check = await accessCheck(
      deps.access,
      actor,
      'account:manage',
      { route: operatorRoute, id: operatorId },
      context,
    );
    return await snapshot(async (client) => {
      const epoch = await home(client, route);
      await home(client, operatorRoute);
      const operator = await readAccount(client, operatorRoute, operatorId);
      if (!operator || operator.state !== 'active' || operator.fenced || operator.operatorAccountId !== null)
        throw new ManagementSourceRefusedError('denied');
      if (!(await check(client, time!))) throw new ManagementSourceRefusedError('denied');
      // Authentication's earlier observation is insufficient after preparation.
      const actorRoute = routeOf(actor.accountId);
      if (actorRoute === null) throw new ManagementSourceRefusedError('denied');
      await home(client, actorRoute);
      const human = await readAccount(client, actorRoute, actor.accountId);
      if (
        !human ||
        human.kind !== 'actor' ||
        human.state !== 'active' ||
        human.fenced ||
        !Number.isSafeInteger(actor.authnEpoch) ||
        actor.authnEpoch < 1 ||
        BigInt(actor.authnEpoch) < human.minimumAuthnEpoch
      )
        throw new ManagementSourceRefusedError('denied');
      if (actor.requestedBy !== null) {
        const reference = /^urn:rezics:request:([^:]+):([^:]+)$/.exec(actor.requestedBy);
        const principalRoute = reference ? routeOf(reference[1]!) : null;
        if (!reference || principalRoute === null || routeOf(reference[2]!) === null)
          throw new ManagementSourceRefusedError('denied');
        await home(client, principalRoute);
        const assignment = await assignmentRead.run(client, {
          route: principalRoute,
          principal_id: reference[1]!,
          request_id: reference[2]!,
          actor_id: actor.accountId,
          at: authoritativeTimeValue(time!),
        });
        if (!assignment) throw new ManagementSourceRefusedError('denied');
      }
      // Only an authorized current caller learns that its source changed.
      const row = await operatorRead.run(client, { route, subject_id: subjectAccountId });
      if (
        epoch !== source.epoch ||
        !row ||
        row.version !== state.expectedVersion ||
        row.operatorAccountId !== operatorId ||
        row.reservationId !== state.previous.reservationId
      )
        throw new ManagementSourceRefusedError('stale');
      const current = relation(row, subjectAccountId);
      return current;
    });
  } catch (error) {
    throwAccessUnavailable(error, deadline);
    throw error;
  } finally {
    if (time) releaseOperationalTime(time);
  }
}

/** Trusted Auth transport adapter: only native authenticate can produce Actor. */
export function createAccountManagementReadAccess(deps: Dependencies) {
  return {
    context: () => ({ pool: deps.pool, deadline: deadlineFor(10_000) }),
    async readOperatorTransferState(token: string, input: OperatorTransferStateInput, context: { deadline: number }) {
      const actor = await deps.access.authenticate(token, { pool: deps.pool, deadline: context.deadline });
      return readOperatorTransferState(deps, actor, input, context);
    },
  };
}
