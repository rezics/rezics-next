import {
  authoritativeTimeValue,
  commandTime,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandAuthorization,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { deadlineClient, within } from './authenticate.ts';
import { validResource } from './grant-command.ts';
import { GrantDeniedError } from './grant-commands.ts';
import { permissionEvidenceDeadline } from './permission.ts';
import type { Access, AccessClient, AccessContext, Actor, Resource } from '../request/access.ts';

/** Trusted server binding to the authorization resource. validate checks THAT
 * anchor's existence and domain prerequisites at command T on its supplied client;
 * it is never a request-supplied callback or an authorization formula.
 */
export type AuthorizationAnchor = Readonly<{
  resource: Readonly<Resource>;
  validate(client: AccessClient, time: AuthoritativeTime): Promise<boolean>;
}>;

export type ResourceAuthorizationContext = AccessContext & {
  /** Actual target command partition, independent of the authority anchor's partition. */
  partition: number;
};

export type ResourceAuthorizationInput = {
  access: Access;
  actor: Actor;
  action: string;
  anchor: AuthorizationAnchor;
  context: ResourceAuthorizationContext;
};

export class ResourceAuthorizationUnavailableError extends Error {
  constructor() {
    super('Resource authorization is unavailable');
    this.name = 'ResourceAuthorizationUnavailableError';
  }
}

/** Prepare bounded actor/principal/group evidence for every attempt, then validate
 * the trusted authority anchor and run the sole Access formula at that attempt's
 * T. Release that connection before the executor checks out the target partition.
 * The opaque, single-use proof permits execution only for the prepared basis,
 * authority, action, target partition, live attempt and evidence deadline.
 *
 * Stable tuple/upsert targets need no resource UUID or unique INSERT. This helper
 * never mints creationCapability; parentCreationAuthorization adds that proof.
 * Protected platform commands supply the seeded Global Context anchor (route 0,
 * id 00000000-0000-8000-8000-000000000000) and require real account grants/scopes.
 * Neither anonymous eligibility nor receipt-only replay grants authority here.
 *
 * Cost includes the owning module's exact existence/revision validation seek:
 * bounded actor inverses and matched group anchors, then one authority anchor,
 * O((1 + K) log G + L log R), K <= 1000 per account. No target read or ACL scan.
 */
export function resourceAuthorization(input: ResourceAuthorizationInput): CommandAuthorization {
  const { access, actor, action } = input;
  const resource = Object.freeze({ ...input.anchor.resource });
  const { pool, deadline, partition } = input.context;
  const validate = input.anchor.validate.bind(input.anchor);
  const prepare = access.prepare?.bind(access);
  const authorize = access.authorize.bind(access);
  // Keep the verified actor object: production Access binds identity by reference.
  const identity = JSON.stringify(actor);
  const basis =
    actor.kind === 'account'
      ? { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy }
      : null;
  const proofs = new WeakMap<object, { attempt: CommandAttempt; deadline: number }>();
  const denied = () => new GrantDeniedError();
  function bound(attempt: CommandAttempt): boolean {
    try {
      authoritativeTimeValue(attempt.time);
    } catch {
      return false;
    }
    return (
      basis !== null &&
      JSON.stringify(actor) === identity &&
      attempt.basis?.actorAccountId === basis.actorAccountId &&
      attempt.basis.clientId === basis.clientId &&
      attempt.basis.requestedBy === basis.requestedBy &&
      validResource(resource) &&
      Number.isInteger(partition) &&
      partition >= 0 &&
      partition < 4096 &&
      attempt.partition === partition &&
      Number.isFinite(deadline) &&
      Date.now() < deadline
    );
  }
  return Object.freeze<CommandAuthorization>({
    action,
    resource,
    denied,
    async prepare(attempt) {
      if (!bound(attempt) || !prepare) throw denied();
      const evidence = await within(deadline, () => prepare(actor, action, resource, { pool, deadline }));
      const proofDeadline = Math.min(deadline, permissionEvidenceDeadline(evidence) ?? -Infinity);
      if (Date.now() >= proofDeadline) throw denied();
      await within(proofDeadline, () =>
        withConnection(pool, async (client) => {
          const bounded = deadlineClient(client, proofDeadline);
          if (
            !(await validate(bounded, attempt.time)) ||
            !(await authorize(bounded, actor, action, resource, evidence, attempt.time))
          )
            throw denied();
        }),
      );
      if (!bound(attempt) || Date.now() >= proofDeadline) throw denied();
      const proof = Object.freeze({});
      proofs.set(proof, { attempt, deadline: proofDeadline });
      return proof;
    },
    async authorize(tx, attempt, proof) {
      const prepared = typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
      if (
        !bound(attempt) ||
        !prepared ||
        commandTime(tx) !== attempt.time ||
        prepared.attempt.time !== attempt.time ||
        prepared.attempt.basis !== attempt.basis ||
        prepared.attempt.partition !== attempt.partition ||
        Date.now() >= prepared.deadline
      )
        throw denied();
      proofs.delete(proof as object);
      return 'execute';
    },
  });
}
