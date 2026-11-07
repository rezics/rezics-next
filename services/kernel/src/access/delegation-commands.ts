export { readAssignment, type AssignmentEvidence } from './delegation-read.ts';
import type { Pool } from 'pg';
import { authoritativeTimeValue, currentCommand } from '../command/command.ts';
import type { Access } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { grantCommand, type GrantCommandContext } from './grant-command.ts';
import createStatement from './delegation-create.sql';
import revokeStatement from './delegation-revoke.sql';

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
