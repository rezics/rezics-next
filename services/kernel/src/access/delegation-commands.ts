import { systemClock, type KernelClock } from '../clock.ts';
import { throwAccessUnavailable } from '../request/unavailable.ts';
import type { Pool } from 'pg';
import { authoritativeTimeValue, currentCommand } from '../command/command.ts';
import type { Access, AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { grantCommand, type GrantCommandContext } from './grant-command.ts';
import createStatement from './delegation-create.sql';
import revokeStatement from './delegation-revoke.sql';
import readStatement from './delegation-read.sql';
import { accessNativeWork, type AccessWorkAccounting } from '../work/access-work.ts';

export class DelegationDeniedError extends Error {
  constructor() {
    super('Principal assignment denied');
    this.name = 'DelegationDeniedError';
  }
}
export type AssignmentInput = {
  principalId: string;
  assignedActorId: string;
  requestId: string;
  valid: string;
  key: string;
};
export type AssignmentRevokeInput = Pick<AssignmentInput, 'principalId' | 'requestId' | 'key'>;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const referencePattern = new RegExp(`^urn:rezics:request:(${uuid}):(${uuid})$`);
export type AssignmentEvidence =
  | { kind: 'none' }
  | { kind: 'unresolved' }
  | { kind: 'resolved'; principalId: string; assignedActorId: string; requestId: string; valid: string };

/** Separately anchored point read for trusted Auth issuance and other Access
 * consumers. A present but unresolvable principal never becomes absence.
 */
export async function readAssignment(
  client: AccessClient,
  requestedBy: string | null,
  assignedActorId: string,
  clock: KernelClock = systemClock,
  work?: AccessWorkAccounting,
): Promise<AssignmentEvidence> {
  if (requestedBy === null) return { kind: 'none' };
  const match = typeof requestedBy === 'string' ? referencePattern.exec(requestedBy) : null;
  if (!match || match[0] !== requestedBy || routeOf(assignedActorId) === null) return { kind: 'unresolved' };
  try {
    const input = {
      route: routeOf(match[1]!)!,
      principal_id: match[1]!,
      request_id: match[2]!,
      actor_id: assignedActorId,
      at: clock().toISOString(),
    };
    const row = await accessNativeWork(work, 'assignment', input, {}, () => readStatement.run(client, input));
    if (!row) return { kind: 'unresolved' };
    return { kind: 'resolved', principalId: match[1]!, assignedActorId, requestId: match[2]!, valid: row.valid };
  } catch (error) {
    throwAccessUnavailable(error);
    return { kind: 'unresolved' };
  }
}

/** The principal is the authenticated actor and the account anchor. The body
 * cannot supply a creator; immutable request identity survives revocation.
 */
export function createDelegationCommands(config: { pool: Pool; access: Access; action: string }) {
  async function execute(
    context: GrantCommandContext,
    operation: 'create' | 'revoke',
    body: AssignmentInput | AssignmentRevokeInput,
  ) {
    const input = structuredClone(body);
    if (
      context.actor.kind !== 'account' ||
      context.actor.accountId !== input.principalId ||
      Object.hasOwn(input, 'createdBy') ||
      routeOf(input.principalId) === null ||
      routeOf(input.requestId) === null ||
      (operation === 'create' &&
        (!('assignedActorId' in input) || routeOf(input.assignedActorId) === null || typeof input.valid !== 'string'))
    )
      throw new DelegationDeniedError();
    const actor = context.actor;
    return grantCommand(
      config,
      context,
      {
        resource: { route: routeOf(input.principalId)!, id: input.principalId },
        actions: [config.action],
        kind: `access.assignment.${operation}`,
        key: input.key,
        input,
        denied: () => new DelegationDeniedError(),
      },
      async (tx, transactionId) => {
        const parameters = {
          route: routeOf(input.principalId)!,
          principal_id: actor.accountId,
          request_id: input.requestId,
          authn_epoch: actor.authnEpoch,
          transaction_id: transactionId,
        };
        const row =
          operation === 'create' && 'assignedActorId' in input
            ? await createStatement.run(tx, { ...parameters, actor_id: input.assignedActorId, valid: input.valid })
            : await revokeStatement.run(tx, { ...parameters, at: authoritativeTimeValue(currentCommand(tx).time) });
        if (row.length !== 1) throw new DelegationDeniedError();
        return { requestedBy: `urn:rezics:request:${input.principalId}:${input.requestId}` };
      },
    );
  }
  return {
    create: (context: GrantCommandContext, input: AssignmentInput) => execute(context, 'create', input),
    revoke: (context: GrantCommandContext, input: AssignmentRevokeInput) => execute(context, 'revoke', input),
  };
}
