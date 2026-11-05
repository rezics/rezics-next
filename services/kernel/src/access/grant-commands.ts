import type { Pool } from 'pg';
import { authoritativeTimeValue, currentCommand, type CommandOutcome } from '../command/command.ts';
import type { Access, Resource } from '../request/access.ts';
import { accessRoot } from './derived-access.ts';
import { grantSubject, type PublicGrantSubject } from './grant-subject.ts';
import { resourceRoleCatalogue } from './resource-roles.ts';
import roleStatement from './role-grant-mutate.sql';
import { grantCommand, validActions, validResource, type GrantCommandContext } from './grant-command.ts';
import createStatement from './grant-create.sql';
import changeStatement from './grant-change.sql';
import revokeStatement from './grant-revoke.sql';
import {
  assertRealmOwnerMayLeave,
  lockRealmOwnership,
  REALM_OWNER_ROLE,
  RealmLastOwnerError,
} from './realm-ownership.ts';
import realmMutation from './realm-ownership-mutation.sql';
import realmRecipient from './realm-ownership-recipient.sql';
import { ResourceAccessWriteDeniedError } from './resource-denials.ts';
import { GrantDeniedError } from './resource-access-errors.ts';
export { GrantDeniedError } from './resource-access-errors.ts';

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
export type RealmOwnerTransferInput = {
  resource: Resource;
  fromAccountId: string;
  toAccountId: string;
  previousValid: string;
  key: string;
};
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

// Only the actual native command object can open Realm mutation presentation.
// Keep its pool and Access root bound; copied methods and caller flags convey nothing.
const nativeRealmCommands = new WeakMap<object, { pool: Pool; access: Access }>();
export function hasNativeRealmGrantCommands(value: unknown, pool: Pool, access: Access): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const native = nativeRealmCommands.get(value);
  return native?.pool === pool && native.access === accessRoot(access);
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
    const selfRenunciation =
      operation === 'revoke' &&
      context.actor.kind === 'account' &&
      subject.kind === 'identity' &&
      subject.role === '' &&
      subject.id === context.actor.accountId;
    return grantCommand(
      config,
      context,
      {
        resource: input.resource,
        actions: [...(selfRenunciation ? [] : [config.managementAction]), ...actions, ...oldActions],
        zoneGrantTarget: {
          ...(subject.kind === 'identity' && subject.role === '' ? { subjectAccountId: subject.id } : {}),
          addsGrant: operation !== 'revoke',
        },
        ...(selfRenunciation ? { consentedActions: actions } : {}),
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
        if (rows.length !== actions.length) {
          console.error('[dbg-grant] rows mismatch', operation, rows.length, actions.length);
          throw new GrantDeniedError();
        }
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
        zoneGrantTarget: {
          ...(subject.kind === 'identity' && subject.role === '' ? { subjectAccountId: subject.id } : {}),
          addsGrant: operation !== 'revoke',
        },
        kind: `access.role-grant.${operation}`,
        key: input.key,
        input,
        denied: () => new GrantDeniedError(),
      },
      async (tx, transactionId) => {
        await tx.query("SELECT set_config('access.role_native_transaction',$1,true)", [transactionId]);
        if ((previous?.role ?? input.role) === REALM_OWNER_ROLE && subject.kind === 'identity' && subject.role === '') {
          const at = currentCommand(tx).time;
          const ownership = { resource: input.resource, accountId: subject.id, at };
          const effect = await realmMutation.run(tx, {
            route: input.resource.route,
            resource_id: input.resource.id,
            account_id: subject.id,
            previous_valid: previous?.valid ?? input.valid,
            valid: input.valid,
            retains_owner: operation !== 'revoke' && input.role === REALM_OWNER_ROLE,
            at: authoritativeTimeValue(at),
          });
          if (effect.realm) {
            try {
              await lockRealmOwnership(tx, ownership);
              if (operation !== 'create' && effect.current && !effect.retained)
                await assertRealmOwnerMayLeave(tx, ownership);
            } catch (error) {
              if (error instanceof RealmLastOwnerError) throw error;
              if (error instanceof ResourceAccessWriteDeniedError) throw new GrantDeniedError();
              throw error;
            }
          }
        }
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
  async function transferRealmOwner(context: GrantCommandContext, body: RealmOwnerTransferInput) {
    const input = structuredClone(body);
    const from = grantSubject({ kind: 'account', id: input.fromAccountId });
    const to = grantSubject({ kind: 'account', id: input.toAccountId });
    const actions = resourceRoleCatalogue(config.access)?.roles.get(REALM_OWNER_ROLE);
    if (
      !validResource(input.resource) ||
      !from ||
      !to ||
      from.id === to.id ||
      !actions ||
      typeof input.previousValid !== 'string'
    )
      throw new GrantDeniedError();
    return grantCommand(
      config,
      context,
      {
        resource: input.resource,
        actions: [config.managementAction, ...actions],
        recipientAccountId: to.id,
        zoneGrantTarget: { subjectAccountId: to.id, addsGrant: true },
        // The existing change event identifies the resulting explicit holder.
        // The receipt digest also binds the former holder and exact old interval.
        kind: 'access.role-grant.change',
        key: input.key,
        input,
        denied: () => new GrantDeniedError(),
      },
      async (tx, transactionId) => {
        const at = currentCommand(tx).time;
        const ownership = { resource: input.resource, accountId: from.id, at };
        try {
          await lockRealmOwnership(tx, ownership);
        } catch (error) {
          if (error instanceof ResourceAccessWriteDeniedError) throw new GrantDeniedError();
          throw error;
        }
        // The exact interval being transferred must be the former holder's live
        // owner grant. Removing a historical interval must not mint a new holder
        // while silently retaining the former holder's actual current grant.
        const source = await realmMutation.run(tx, {
          route: input.resource.route,
          resource_id: input.resource.id,
          account_id: from.id,
          previous_valid: input.previousValid,
          valid: input.previousValid,
          retains_owner: false,
          at: authoritativeTimeValue(at),
        });
        if (!source.realm || !source.current) throw new GrantDeniedError();
        // A recipient already holding an open-ended explicit owner grant needs no
        // replacement interval. Preserve its real scope and original service time.
        const recipient = await realmRecipient.run(tx, {
          route: input.resource.route,
          resource_id: input.resource.id,
          account_id: to.id,
          at: authoritativeTimeValue(at),
        });
        const valid = recipient?.valid ?? `[${authoritativeTimeValue(at)},)`;
        const parameters = {
          route: input.resource.route,
          resource_id: input.resource.id,
          subject_kind: 'identity',
          subject_role: '',
          grant_role: REALM_OWNER_ROLE,
          previous_role: REALM_OWNER_ROLE,
          previous_valid: input.previousValid,
          transaction_id: transactionId,
        };
        if (!recipient) {
          const inserted = await roleStatement.run(tx, {
            ...parameters,
            subject_id: to.id,
            valid,
            operation: 'create',
          });
          if (inserted.length !== 1) throw new GrantDeniedError();
        }
        try {
          await assertRealmOwnerMayLeave(tx, ownership);
        } catch (error) {
          if (error instanceof RealmLastOwnerError) throw error;
          if (error instanceof ResourceAccessWriteDeniedError) throw new GrantDeniedError();
          throw error;
        }
        const removed = await roleStatement.run(tx, {
          ...parameters,
          subject_id: from.id,
          valid: input.previousValid,
          operation: 'revoke',
        });
        if (removed.length !== 1) throw new GrantDeniedError();
        return {
          resource: input.resource,
          subject: { kind: 'account' as const, id: to.id },
          role: REALM_OWNER_ROLE,
          valid,
        };
      },
    );
  }
  const commands = {
    transferRealmOwner,
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
  if (config.managementAction === 'access:grant')
    nativeRealmCommands.set(commands, { pool: config.pool, access: accessRoot(config.access) });
  return commands;
}
