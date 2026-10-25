import {
  authoritativeTimeValue,
  currentCommand,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { type Access, type AccessClient, type AccessContext, type Actor, type Resource } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import { deadlineClient, within } from './authenticate.ts';
import { validResource } from './grant-command.ts';
import { GrantDeniedError } from './grant-commands.ts';
import { permissionEvidenceDeadline } from './permission.ts';

/** The owning module supplies this port in service code after binding the actual
 * parent storage/identity. validate reads only that parent anchor, and must check
 * actual existence and any module-specific creation prerequisites at T. It is
 * never a public type flag or request-supplied callback. Semantic supplies its
 * seeded Global Context here; Access creates no competing parent identity.
 */
export type ParentAnchor = Readonly<{
  resource: Readonly<Resource>;
  validate(client: AccessClient, time: AuthoritativeTime): Promise<boolean>;
}>;
/** The owning child module proves its unique resource INSERT belongs to this
 * live transaction. Its implementation reads only the child anchor and checks
 * immutable creation provenance (not just existence or a caller boolean). An
 * existing row, UPDATE or upsert cannot stand in for a new resource INSERT.
 */
export type ResourceCreationPort = Readonly<{
  validate(tx: CommandTransaction, resource: Readonly<Resource>, time: AuthoritativeTime): Promise<boolean>;
}>;
/** resource is the exact NEW resource bound by the owning create command, never
 * a replacement supplied by request JSON after authorization. The owning module
 * inserts its unique resource row before initializeResourceGrants and supplies
 * its trusted creation port here. Both writes use the same command transaction.
 */
export type ParentCreationContext = AccessContext & { resource: Readonly<Resource>; creation: ResourceCreationPort };
type Creation = {
  access: Access;
  actorId: string;
  resource: Readonly<Resource>;
  attempt: CommandAttempt;
  initialized: boolean;
  parent: Readonly<Resource>;
  action: string;
  deadline: number;
  validateCreation: ResourceCreationPort['validate'];
};
const creations = new WeakMap<CommandTransaction, Creation>();

/** Internal capability lookup also requires the command executor's live opaque
 * time/context; retained clients, manual transactions and copied authorizations
 * cannot turn this into an existing-resource owner-grant API.
 */
export async function creationCapability(
  tx: CommandTransaction,
  resource: Resource,
  creator: string,
): Promise<Readonly<{ access: Access; time: AuthoritativeTime }>> {
  const command = currentCommand(tx);
  const creation = creations.get(tx);
  if (
    !creation ||
    creation.attempt.time !== command.time ||
    command.authorization?.mode !== 'execute' ||
    command.authorization.action !== creation.action ||
    command.authorization.resource.route !== creation.parent.route ||
    command.authorization.resource.id !== creation.parent.id ||
    command.basis !== creation.attempt.basis ||
    command.partition !== creation.attempt.partition ||
    Date.now() >= creation.deadline ||
    creation.initialized ||
    creator !== creation.actorId ||
    resource.route !== creation.resource.route ||
    resource.id !== creation.resource.id
  )
    throw new GrantDeniedError();
  authoritativeTimeValue(command.time);
  creation.initialized = true;
  if (!(await creation.validateCreation(tx, creation.resource, command.time))) throw new GrantDeniedError();
  return Object.freeze({ access: creation.access, time: command.time });
}

/** Prepare independently anchored identity/org evidence before checking out the
 * parent. The sole resource formula then runs on the parent at the attempt's T;
 * the connection is released before runCommand checks out the child partition.
 * Both preparation and proof minting repeat on every serialization/fence retry.
 */
export function parentCreationAuthorization(input: {
  access: Access;
  actor: Actor;
  action: string;
  parent: ParentAnchor;
  context: ParentCreationContext;
}): CommandAuthorization {
  const { access, actor, action } = input;
  const parent = Object.freeze({ ...input.parent.resource });
  const resource = Object.freeze({ ...input.context.resource });
  const { pool, deadline } = input.context;
  const validate = input.parent.validate.bind(input.parent);
  if (typeof input.context.creation?.validate !== 'function') throw new GrantDeniedError();
  const validateCreation = input.context.creation.validate.bind(input.context.creation);
  const basis =
    actor.kind === 'account'
      ? { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy }
      : null;
  const proofs = new WeakMap<object, { attempt: CommandAttempt; deadline: number }>();
  const denied = () => new GrantDeniedError();
  function bound(attempt: CommandAttempt): boolean {
    return (
      basis !== null &&
      attempt.basis?.actorAccountId === basis.actorAccountId &&
      attempt.basis.clientId === basis.clientId &&
      attempt.basis.requestedBy === basis.requestedBy &&
      validResource(parent) &&
      validResource(resource) &&
      parent.id !== resource.id &&
      attempt.partition === partitionOf(resource.route) &&
      Date.now() < deadline
    );
  }
  return {
    action,
    resource: parent,
    denied,
    async prepare(attempt) {
      if (!bound(attempt)) throw denied();
      const evidence = await access.prepare?.(actor, action, parent, { pool, deadline });
      const proofDeadline = Math.min(deadline, permissionEvidenceDeadline(evidence) ?? -Infinity);
      if (Date.now() >= proofDeadline) throw denied();
      await within(proofDeadline, () =>
        withConnection(pool, async (client) => {
          const bounded = deadlineClient(client, proofDeadline);
          if (
            !(await validate(bounded, attempt.time)) ||
            !(await access.authorize(bounded, actor, action, parent, evidence, attempt.time))
          )
            throw denied();
        }),
      );
      if (!bound(attempt)) throw denied();
      const proof = Object.freeze({});
      proofs.set(proof, { attempt, deadline: proofDeadline });
      return proof;
    },
    async authorize(tx, attempt, proof) {
      const prepared = typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
      if (
        !bound(attempt) ||
        !prepared ||
        prepared.attempt.time !== attempt.time ||
        prepared.attempt.basis !== attempt.basis ||
        prepared.attempt.partition !== attempt.partition ||
        Date.now() >= prepared.deadline
      )
        throw denied();
      proofs.delete(proof as object);
      creations.set(tx, {
        access,
        actorId: basis!.actorAccountId,
        resource,
        attempt,
        initialized: false,
        parent,
        action,
        deadline: prepared.deadline,
        validateCreation,
      });
      return 'execute';
    },
  };
}
