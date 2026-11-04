import { managementOperationProfile } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import {
  authoritativeTimeValue,
  mintReadTime,
  releaseOperationalTime,
  type AuthoritativeTime,
} from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessClient, type AccountActor, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readAccount, type Account } from './account-data.ts';
import { deadlineClient, within } from './authenticate.ts';
import assignmentRead from './delegation-read.sql';
import { deriveAccess } from './derived-access.ts';
import { accessClock } from './access-clock.ts';
import {
  ManagementSourceRefusedError,
  readOperatorTransferState,
  type OperatorTransferState,
} from './management-source.ts';
import { managedAuthWorkflowDescriptor } from './workflow-approvals.ts';
import { permissionEvidenceDeadline } from './permission.ts';
import { classifyUnavailability, CommandUnavailableError, requireAccessDeadline } from './unavailable.ts';

export type OperatorTransferHandoff = OperatorTransferState & {
  version: 1;
  operatorAccountId: string;
  sourceOperationKey: string;
};
export type OperatorTransferPageReview =
  | { kind: 'readiness' }
  | { kind: 'source'; subjectAccountId: string }
  | { kind: 'destination'; request: OperatorTransferHandoff };
export type OperatorTransferPageRead =
  | { kind: 'source'; relation: OperatorTransferState; action: 'allowed' }
  | { kind: 'destination'; destinationAccountId: string; action: 'allowed' | 'denied' }
  | { kind: 'missing' | 'refused' | 'changed' | 'unavailable' };
export interface OperatorTransferPageAccess {
  readOperatorTransferPage(
    token: string,
    input: Exclude<OperatorTransferPageReview, { kind: 'readiness' }>,
    context: { deadline: number },
  ): Promise<OperatorTransferPageRead>;
}

type Dependencies = { pool: Pool; access: Access };
class EntryUnavailable extends Error {}
const active = (account: Account | null): account is Account =>
  !!account && account.state === 'active' && !account.fenced;
const asHuman = (account: Account | null): account is Account =>
  active(account) && account.kind === 'actor' && account.operatorAccountId === null;
const destinationOperator = (account: Account | null): account is Account =>
  active(account) &&
  account.operatorAccountId === null &&
  (account.kind === 'actor' || account.kind === 'organization');
const stable = (value: unknown) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item));

function validHandoff(value: OperatorTransferHandoff): boolean {
  const id = (candidate: unknown) => typeof candidate === 'string' && routeOf(candidate) !== null;
  return (
    !!value &&
    Object.keys(value).sort().join(',') === 'expectedVersion,operatorAccountId,previous,sourceOperationKey,version' &&
    value.version === 1 &&
    !!value.previous &&
    Object.keys(value.previous).sort().join(',') === 'operatorAccountId,reservationId,subjectAccountId' &&
    id(value.previous.subjectAccountId) &&
    id(value.previous.operatorAccountId) &&
    id(value.previous.reservationId) &&
    id(value.operatorAccountId) &&
    value.operatorAccountId !== value.previous.operatorAccountId &&
    value.operatorAccountId !== value.previous.subjectAccountId &&
    typeof value.expectedVersion === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(value.expectedVersion) &&
    typeof value.sourceOperationKey === 'string' &&
    value.sourceOperationKey.length > 0 &&
    value.sourceOperationKey.length <= 128 &&
    !/[\u0000-\u0020\u007f]/.test(value.sourceOperationKey)
  );
}

function transferActor(actor: Actor): actor is AccountActor {
  const profile = managementOperationProfile('transfer');
  return (
    actor.kind === 'account' &&
    actor.clientId === profile.client_id &&
    actor.scopes.length === 1 &&
    actor.scopes[0] === profile.scope[0]
  );
}

async function destinationAdvice(
  deps: Dependencies,
  actor: AccountActor,
  destinationAccountId: string,
  deadline: number,
): Promise<OperatorTransferPageRead> {
  const targetRoute = routeOf(destinationAccountId);
  const actorRoute = routeOf(actor.accountId);
  if (targetRoute === null || actorRoute === null || !deps.access.prepare) return { kind: 'unavailable' };
  const profile = managementOperationProfile('transfer');
  if (actor.clientId !== profile.client_id || actor.scopes.length !== 1 || actor.scopes[0] !== profile.scope[0])
    return { kind: 'refused' };

  const time = await withConnection(deps.pool, (client) =>
    mintReadTime(deadlineClient(client, deadline), accessClock(deps.access)),
  );
  const snapshot = <T>(read: (client: AccessClient) => Promise<T>) =>
    within(deadline, () =>
      withConnection(deps.pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const value = await read(client);
          requireAccessDeadline(deadline);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          try {
            await connection.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(connection, rollbackError as Error);
          }
          throw error;
        }
      }),
    );

  const observe = async (client: AccessClient) => {
    const homes = new Map<number, readonly [string, number]>();
    async function home(route: number) {
      const partition = partitionOf(route);
      if (homes.has(partition)) return;
      const row = await readPartition(client, partition);
      if (!row) throw new CommandUnavailableError('contention', partition);
      if (row.writeState !== 'active') throw new CommandUnavailableError(row.writeState, partition, row.movedTo);
      homes.set(partition, [row.node, row.epoch]);
    }
    await home(actorRoute);
    await home(targetRoute);
    const caller = await readAccount(client, actorRoute, actor.accountId);
    const target = await readAccount(client, targetRoute, destinationAccountId);
    let principal: Account | null = null;
    let assignment: unknown = null;
    if (actor.requestedBy !== null) {
      const reference = /^urn:rezics:request:([^:]+):([^:]+)$/.exec(actor.requestedBy);
      const principalRoute = reference ? routeOf(reference[1]!) : null;
      const requestRoute = reference ? routeOf(reference[2]!) : null;
      if (!reference || principalRoute === null || requestRoute === null)
        return { admitted: false, homes, identity: '' };
      await home(principalRoute);
      principal = await readAccount(client, principalRoute, reference[1]!);
      assignment = await assignmentRead.run(client, {
        route: principalRoute,
        principal_id: reference[1]!,
        request_id: reference[2]!,
        actor_id: actor.accountId,
        at: authoritativeTimeValue(time),
      });
    }
    const callerAllowed =
      asHuman(caller) &&
      Number.isSafeInteger(actor.authnEpoch) &&
      actor.authnEpoch >= 1 &&
      BigInt(actor.authnEpoch) >= caller.minimumAuthnEpoch;
    const principalAllowed =
      actor.requestedBy === null || (asHuman(principal) && assignment !== null && assignment !== undefined);
    const identity = stable({
      caller: caller && [caller.kind, caller.state, caller.fenced, caller.operatorAccountId, caller.minimumAuthnEpoch],
      target: target && [target.accountId, target.kind, target.state, target.fenced, target.operatorAccountId],
      principal: principal && [
        principal.kind,
        principal.state,
        principal.fenced,
        principal.operatorAccountId,
        principal.minimumAuthnEpoch,
      ],
      assignment,
      callerAllowed,
      principalAllowed,
    });
    return {
      admitted: callerAllowed && principalAllowed && destinationOperator(target),
      homes,
      identity,
    };
  };

  try {
    requireAccessDeadline(deadline);
    const before = await snapshot(observe);
    if (!before.admitted) return { kind: 'refused' };
    const descriptor = managedAuthWorkflowDescriptor('transfer', destinationAccountId);
    const prepared = deriveAccess(deps.access, {
      async prepare(...args) {
        const evidence = await deps.access.prepare!(...args);
        if (permissionEvidenceDeadline(evidence) === undefined) throw new EntryUnavailable();
        return evidence;
      },
    });
    const check = await accessCheck(
      prepared,
      actor,
      descriptor.action,
      { route: targetRoute, id: destinationAccountId },
      { pool: deps.pool, deadline, time },
    );
    return await snapshot(async (client) => {
      const current = await observe(client);
      if (stable([...current.homes]) !== stable([...before.homes]) || current.identity !== before.identity)
        return { kind: 'changed' } as const;
      const allowed = await check(client, time);
      requireAccessDeadline(deadline);
      return { kind: 'destination', destinationAccountId, action: allowed ? 'allowed' : 'denied' } as const;
    });
  } catch (error) {
    if (error instanceof EntryUnavailable || classifyUnavailability(error)) return { kind: 'unavailable' };
    return { kind: 'unavailable' };
  } finally {
    releaseOperationalTime(time);
  }
}

export async function readOperatorTransferPage(
  deps: Dependencies,
  actor: Actor,
  input: Exclude<OperatorTransferPageReview, { kind: 'readiness' }>,
  { deadline }: { deadline: number },
): Promise<OperatorTransferPageRead> {
  if (!transferActor(actor)) return { kind: 'refused' };
  if (input.kind === 'source') {
    if (Object.keys(input).sort().join(',') !== 'kind,subjectAccountId' || routeOf(input.subjectAccountId) === null)
      return { kind: 'refused' };
    try {
      const relation = await readOperatorTransferState(
        deps,
        actor,
        { subjectAccountId: input.subjectAccountId },
        { deadline },
      );
      return relation ? { kind: 'source', relation, action: 'allowed' } : { kind: 'missing' };
    } catch (error) {
      if (error instanceof ManagementSourceRefusedError)
        return { kind: error.reason === 'stale' ? 'changed' : 'refused' };
      return { kind: 'unavailable' };
    }
  }
  if (Object.keys(input).sort().join(',') !== 'kind,request' || !validHandoff(input.request))
    return { kind: 'refused' };
  return destinationAdvice(deps, actor, input.request.operatorAccountId, deadline);
}

export function createOperatorTransferPageAccess(deps: Dependencies): OperatorTransferPageAccess {
  return {
    async readOperatorTransferPage(token, input, context) {
      const actor = await deps.access.authenticate(token, { pool: deps.pool, deadline: context.deadline });
      return readOperatorTransferPage(deps, actor, input, context);
    },
  };
}
