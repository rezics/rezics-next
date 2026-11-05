import { requireAccessDeadline } from '../request/unavailable.ts';
import { accessEvidence } from './evidence.ts';
import { createHash } from 'node:crypto';
import { runCommand, authoritativeTimeValue, type CommandAuthorization } from '../command/command.ts';
import { accessCheck, type Access, type AccessCheck } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import { GrantDeniedError } from './grant-commands.ts';
import { validActions, validResource, type GrantCommandContext } from './grant-command.ts';
import type { ParentAnchor } from './parent-creation.ts';
import install from './standing-parent-install.sql';

/** Narrow, one-time trusted setup. The owning module supplies the real parent
 * port and an already validated, parent-bound command authority from its initial
 * setup workflow. These are service capabilities, never request JSON/env flags.
 * Delegated actions are additionally checked through Access; normal owner
 * administration uses createGrantCommands, including subsequent revocation.
 * The durable marker prevents reinstall even after grants are removed. The fixed
 * receipt replays setup atomically without acquiring continuing bootstrap power.
 */
export async function installStandingParentGrant(input: {
  access: Access;
  parent: ParentAnchor;
  authority: CommandAuthorization;
  context: GrantCommandContext;
  actions: readonly string[];
}) {
  const { access, authority, context } = input;
  const parent = Object.freeze({ ...input.parent.resource });
  const actions = [...new Set(input.actions)].sort();
  const { actor, pool, deadline } = context;
  if (
    actor.kind !== 'account' ||
    !validResource(parent) ||
    !validActions(actions) ||
    authority.resource.route !== parent.route ||
    authority.resource.id !== parent.id
  )
    throw new GrantDeniedError();
  const checks: AccessCheck[] = [];
  for (const action of actions) checks.push(await accessCheck(access, actor, action, parent, context));
  const validate = input.parent.validate.bind(input.parent);
  const authorization: CommandAuthorization = {
    action: authority.action,
    resource: parent,
    denied: () => new GrantDeniedError(),
    ...(authority.prepare ? { prepare: authority.prepare.bind(authority) } : {}),
    async authorize(tx, attempt, evidence) {
      requireAccessDeadline(deadline);
      if (
        (await authority.authorize(tx, attempt, evidence)) !== 'execute' ||
        !(await accessEvidence(
          () => validate(tx, attempt.time),
          () => new GrantDeniedError(),
          deadline,
        ))
      )
        throw new GrantDeniedError();
      for (const check of checks) if (!(await check(tx, attempt.time))) throw new GrantDeniedError();
      return 'execute';
    },
  };
  return runCommand(
    pool,
    {
      partition: partitionOf(parent.route),
      deadline,
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization,
      receipt: {
        actorAccountId: actor.accountId,
        kind: 'access.standing-parent.install',
        key: parent.id,
        digest: createHash('sha256')
          .update(JSON.stringify([parent, actions]))
          .digest(),
      },
    },
    async (tx, command) => {
      const rows = await install.run(tx, {
        route: parent.route,
        resource_id: parent.id,
        actions,
        at: authoritativeTimeValue(command.time),
        transaction_id: command.transactionId,
      });
      if (rows.length !== actions.length) throw new GrantDeniedError();
      const value = { resource: parent, actions };
      return {
        value,
        events: [{ type: 'com.rezics.access.standing-parent.installed.v1', subject: parent.id, data: value }],
      };
    },
  );
}
