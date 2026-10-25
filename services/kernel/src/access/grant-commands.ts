import type { Pool } from 'pg';
import type { Access, Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { grantCommand, validActions, validResource, type GrantCommandContext } from './grant-command.ts';
import createStatement from './grant-create.sql';
import changeStatement from './grant-change.sql';
import revokeStatement from './grant-revoke.sql';

export class GrantDeniedError extends Error {
  constructor() {
    super('Access grant administration denied');
    this.name = 'GrantDeniedError';
  }
}
export type GrantInput = {
  resource: Resource;
  subjectId: string;
  subjectRole: '' | 'owner' | 'member';
  actions: readonly string[];
  valid: string;
  key: string;
};
export type GrantChangeInput = GrantInput & { previous: { actions: readonly string[]; valid: string } };

/** The composition root supplies the mounted catalogue's colon-form management
 * action. There is no privileged management or caller-supplied grantor path.
 */
export function createGrantCommands(config: { pool: Pool; access: Access; managementAction: string }) {
  async function execute(
    context: GrantCommandContext,
    operation: 'create' | 'change' | 'revoke',
    body: GrantChangeInput | GrantInput,
  ) {
    const input = structuredClone(body);
    const previous = 'previous' in input ? input.previous : null;
    if (
      !validResource(input.resource) ||
      routeOf(input.subjectId) === null ||
      !['', 'owner', 'member'].includes(input.subjectRole) ||
      !validActions(input.actions) ||
      typeof input.valid !== 'string' ||
      (operation === 'change' && (!previous || !validActions(previous.actions) || typeof previous.valid !== 'string'))
    )
      throw new GrantDeniedError();
    const actions = [...new Set(input.actions)].sort();
    const oldActions = previous ? [...new Set(previous.actions)].sort() : [];
    return grantCommand(
      config,
      context,
      {
        resource: input.resource,
        actions: [config.managementAction, ...actions, ...oldActions],
        kind: `access.grant.${operation}`,
        key: input.key,
        input,
        denied: () => new GrantDeniedError(),
      },
      async (tx, transactionId) => {
        const parameters = {
          route: input.resource.route,
          resource_id: input.resource.id,
          subject_id: input.subjectId,
          subject_role: input.subjectRole,
          actions,
          valid: input.valid,
          transaction_id: transactionId,
        };
        const rows =
          operation === 'create'
            ? await createStatement.run(tx, parameters)
            : operation === 'change'
              ? await changeStatement.run(tx, {
                  ...parameters,
                  previous_actions: oldActions,
                  previous_valid: previous!.valid,
                })
              : await revokeStatement.run(tx, parameters);
        if (rows.length !== actions.length) throw new GrantDeniedError();
        return {
          resource: input.resource,
          subjectId: input.subjectId,
          subjectRole: input.subjectRole,
          actions,
          valid: input.valid,
        };
      },
    );
  }
  return {
    create: (context: GrantCommandContext, input: GrantInput) => execute(context, 'create', input),
    change: (context: GrantCommandContext, input: GrantChangeInput) => execute(context, 'change', input),
    revoke: (context: GrantCommandContext, input: GrantInput) => execute(context, 'revoke', input),
  };
}
