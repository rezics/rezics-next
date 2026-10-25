import type { Pool } from 'pg';
import type { CommandOutcome } from '../command/command.ts';
import type { Access, Resource } from '../request/access.ts';
import { grantSubject, type PublicGrantSubject } from './grant-subject.ts';
import { resourceRoleCatalogue } from './resource-roles.ts';
import roleStatement from './role-grant-mutate.sql';
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
export type GrantRecipient =
  | { subject: PublicGrantSubject; subjectId?: never; subjectRole?: never }
  | { subject?: never; subjectId: string; subjectRole: '' | 'owner' | 'member' };
export type GrantInput = GrantRecipient & {
  resource: Resource;
  actions: readonly string[];
  valid: string;
  key: string;
};
type GrantValue<Input extends GrantInput> = {
  resource: Resource;
  actions: string[];
  valid: string;
} & (Input extends { subject: infer Subject extends PublicGrantSubject }
  ? { subject: Subject }
  : { subjectId: string; subjectRole: '' | 'owner' | 'member' });
export type GrantChangeInput = GrantInput & { previous: { actions: readonly string[]; valid: string } };
export type RoleGrantInput = {
  resource: Resource;
  subject: PublicGrantSubject;
  role: string;
  valid: string;
  key: string;
};
export type RoleGrantChangeInput = RoleGrantInput & { previous: { role: string; valid: string } };
function recipient(input: GrantRecipient) {
  if (input.subject !== undefined) {
    if (input.subjectId !== undefined || input.subjectRole !== undefined) return null;
    return grantSubject(input.subject);
  }
  return grantSubject(
    input.subjectRole === ''
      ? { kind: 'account', id: input.subjectId }
      : { kind: 'organization', id: input.subjectId, role: input.subjectRole },
  );
}

/** The composition root supplies the mounted catalogue's colon-form management
 * action. There is no privileged management or caller-supplied grantor path.
 */
export function createGrantCommands(config: {
  pool: Pool;
  access: Access;
  managementAction: string;
  clock?: (() => Date) | undefined;
}) {
  async function execute(
    context: GrantCommandContext,
    operation: 'create' | 'change' | 'revoke',
    body: GrantChangeInput | GrantInput,
  ) {
    const input = structuredClone(body);
    const previous = 'previous' in input ? input.previous : null;
    const subject = recipient(input);
    if (
      !validResource(input.resource) ||
      !subject ||
      !validActions(input.actions) ||
      typeof input.valid !== 'string' ||
      (operation === 'change' && (!previous || !validActions(previous.actions) || typeof previous.valid !== 'string'))
    )
      throw new GrantDeniedError();
    const actions = [...new Set(input.actions)].sort();
    const oldActions = previous ? [...new Set(previous.actions)].sort() : [];
    if (new Set([...actions, ...oldActions]).size > 1000) throw new GrantDeniedError();
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
          subject_kind: subject.kind,
          subject_id: subject.id,
          subject_role: subject.role,
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
        const value: {
          resource: Resource;
          subject?: PublicGrantSubject;
          subjectId?: string;
          subjectRole?: '' | 'owner' | 'member';
          actions: string[];
          valid: string;
        } = {
          resource: input.resource,
          ...(input.subject === undefined
            ? { subjectId: input.subjectId, subjectRole: input.subjectRole }
            : { subject: input.subject }),
          actions,
          valid: input.valid,
        };
        return value;
      },
    );
  }
  async function executeRole(
    context: GrantCommandContext,
    operation: 'create' | 'change' | 'revoke',
    body: RoleGrantInput | RoleGrantChangeInput,
  ) {
    const input = structuredClone(body);
    const subject = grantSubject(input.subject);
    const catalogue = resourceRoleCatalogue(config.access);
    const actions = catalogue?.roles.get(input.role);
    const previous = 'previous' in input ? input.previous : null;
    const oldActions = previous ? catalogue?.roles.get(previous.role) : undefined;
    if (
      !subject ||
      !validResource(input.resource) ||
      !actions ||
      !validActions(actions) ||
      typeof input.valid !== 'string' ||
      (operation === 'change' && (!previous || !oldActions || typeof previous.valid !== 'string')) ||
      (oldActions !== undefined && !validActions(oldActions)) ||
      new Set([...actions, ...(oldActions ?? [])]).size > 1000
    )
      throw new GrantDeniedError();
    return grantCommand(
      config,
      context,
      {
        resource: input.resource,
        actions: [config.managementAction, ...actions, ...(oldActions ?? [])],
        kind: `access.role-grant.${operation}`,
        key: input.key,
        input,
        denied: () => new GrantDeniedError(),
      },
      async (tx, transactionId) => {
        const rows = await roleStatement.run(tx, {
          route: input.resource.route,
          resource_id: input.resource.id,
          subject_kind: subject.kind,
          subject_id: subject.id,
          subject_role: subject.role,
          grant_role: input.role,
          valid: input.valid,
          operation,
          previous_role: previous?.role ?? input.role,
          previous_valid: previous?.valid ?? input.valid,
          transaction_id: transactionId,
        });
        if (rows.length !== 1) throw new GrantDeniedError();
        return { resource: input.resource, subject: input.subject, role: input.role, valid: input.valid };
      },
    );
  }
  return {
    createRole: (context: GrantCommandContext, input: RoleGrantInput) => executeRole(context, 'create', input),
    changeRole: (context: GrantCommandContext, input: RoleGrantChangeInput) => executeRole(context, 'change', input),
    revokeRole: (context: GrantCommandContext, input: RoleGrantInput) => executeRole(context, 'revoke', input),
    create: <Input extends GrantInput>(context: GrantCommandContext, input: Input) =>
      execute(context, 'create', input) as Promise<CommandOutcome<GrantValue<Input>>>,
    change: <Input extends GrantChangeInput>(context: GrantCommandContext, input: Input) =>
      execute(context, 'change', input) as Promise<CommandOutcome<GrantValue<Input>>>,
    revoke: <Input extends GrantInput>(context: GrantCommandContext, input: Input) =>
      execute(context, 'revoke', input) as Promise<CommandOutcome<GrantValue<Input>>>,
  };
}
