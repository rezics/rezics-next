import { accessEvidence, throwEvidenceFailure } from './evidence.ts';
import { requireAccessDeadline, throwAccessUnavailable } from '../request/unavailable.ts';
import { commandAccessContext } from './command-admission.ts';
import {
  ANONYMOUS_PRINCIPAL_ID,
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
import { permissionEvidenceDeadline, permissionHistoryAccounts } from './permission.ts';
import { bindCommandHistoryEvidence } from '../history/record.ts';
import type { AccountReference } from '../history/locator.ts';
import type { ResourceEligibility } from './eligibility.ts';
import {
  resourcePage,
  type ResourcePage,
  type Access,
  type AccessClient,
  type AccessContext,
  type Actor,
  type Resource,
} from '../request/access.ts';
import { governanceReachUse, recordGovernanceReachUse, type GovernanceReachUse } from './governance-reach.ts';

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

/** Trusted whole-page existence/domain validation, in one owning-module statement. */
export type AuthorizationAnchorPage = ResourcePage &
  Readonly<{
    validate(client: AccessClient, time: AuthoritativeTime): Promise<boolean>;
  }>;

export type ResourceAuthorizationPageInput = Omit<ResourceAuthorizationInput, 'anchor'> & {
  anchor: AuthorizationAnchorPage;
};

/** One attempt, exact immutable id set, one formula, all resources required. */
export function resourceAuthorizationPage(input: ResourceAuthorizationPageInput): CommandAuthorization {
  const page = resourcePage(input.anchor);
  return authorizeResource(
    {
      ...input,
      anchor: {
        resource: { route: page.route, id: page.ids[0]! },
        validate: input.anchor.validate.bind(input.anchor),
      },
    },
    page,
  );
}

/** Anonymous commands require exact principal attribution and opaque domain eligibility. */
export type AnonymousResourceAuthorizationInput = Omit<ResourceAuthorizationInput, 'actor' | 'anchor'> & {
  actor: Extract<Actor, { kind: 'anonymous' }>;
  anchor: AuthorizationAnchor & {
    resource: Readonly<Resource & { eligibility: ResourceEligibility }>;
  };
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
 * Anonymous admission requires action-bound domain eligibility and the installed
 * catalogue, checked by that same formula. Receipt replay supplies no authority.
 *
 * Cost includes the owning module's exact existence/revision validation seek:
 * bounded actor inverses and matched group anchors, then one authority anchor,
 * O((1 + K) log G + L log R), K <= 1000 per account. Anonymous K=0 adds
 * bounded O(H) container evidence and one domain seek. No target read or ACL scan.
 */
export function resourceAuthorization(input: AnonymousResourceAuthorizationInput): CommandAuthorization;
export function resourceAuthorization(input: ResourceAuthorizationInput): CommandAuthorization;
export function resourceAuthorization(input: ResourceAuthorizationInput): CommandAuthorization {
  return authorizeResource(input);
}

function authorizeResource(input: ResourceAuthorizationInput, page?: ResourcePage): CommandAuthorization {
  const { access, actor, action } = input;
  const resource = Object.freeze({ ...input.anchor.resource });
  const { pool, deadline, partition } = input.context;
  const validate = input.anchor.validate.bind(input.anchor);
  const preparePage = access.preparePage?.bind(access);
  const authorizePage = access.authorizePage?.bind(access);
  const prepare = page
    ? preparePage &&
      ((actor: Actor, action: string, _resource: Resource, context: AccessContext) =>
        preparePage(actor, action, page, context))
    : access.prepare?.bind(access);
  const authorize = page
    ? (
        client: AccessClient,
        actor: Actor,
        action: string,
        _resource: Resource,
        evidence: unknown,
        time: AuthoritativeTime,
      ) => authorizePage?.(client, actor, action, page, evidence, time) ?? Promise.resolve(false)
    : access.authorize.bind(access);
  // Keep the verified actor object: production Access binds identity by reference.
  const identity = JSON.stringify(actor);
  const anonymous = actor.kind === 'anonymous';
  const basis =
    actor.kind === 'account'
      ? { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy }
      : null;
  const proofs = new WeakMap<
    object,
    {
      attempt: CommandAttempt;
      deadline: number;
      governanceReach: GovernanceReachUse | undefined;
      historyAccounts: readonly AccountReference[] | undefined;
    }
  >();
  const denied = () => new GrantDeniedError();
  function bound(attempt: CommandAttempt): boolean {
    try {
      authoritativeTimeValue(attempt.time);
    } catch {
      return false;
    }
    return (
      JSON.stringify(actor) === identity &&
      (anonymous
        ? !!attempt.basis &&
          'principal' in attempt.basis &&
          attempt.basis.principal?.kind === 'anonymous' &&
          attempt.basis.principal.id === ANONYMOUS_PRINCIPAL_ID &&
          attempt.basis.actorAccountId === null &&
          attempt.basis.clientId === null &&
          attempt.basis.requestedBy === null &&
          resource.eligibility !== undefined &&
          (resource.anonymousEligibility === undefined || resource.anonymousEligibility === resource.eligibility)
        : basis !== null &&
          basis.actorAccountId !== ANONYMOUS_PRINCIPAL_ID &&
          !!attempt.basis &&
          !('principal' in attempt.basis) &&
          attempt.basis.actorAccountId === basis.actorAccountId &&
          attempt.basis.clientId === basis.clientId &&
          attempt.basis.requestedBy === basis.requestedBy) &&
      validResource(resource) &&
      Number.isInteger(partition) &&
      partition >= 0 &&
      partition < 4096 &&
      attempt.partition === partition &&
      Number.isFinite(deadline)
    );
  }
  return Object.freeze<CommandAuthorization>({
    action,
    resource,
    denied,
    async prepare(attempt) {
      requireAccessDeadline(deadline);
      if (!bound(attempt) || !prepare) throw denied();
      try {
        const evidence = await within(deadline, () =>
          prepare(actor, action, resource, commandAccessContext({ pool, deadline }, attempt)),
        );
        const proofDeadline = Math.min(deadline, permissionEvidenceDeadline(evidence) ?? -Infinity);
        if (permissionEvidenceDeadline(evidence) === undefined) throw denied();
        requireAccessDeadline(proofDeadline);
        let governanceReach: GovernanceReachUse | undefined;
        await within(proofDeadline, () =>
          withConnection(pool, async (client) => {
            const bounded = deadlineClient(client, proofDeadline);
            if (!(await accessEvidence(() => validate(bounded, attempt.time), denied, proofDeadline))) throw denied();
            if (!(await authorize(bounded, actor, action, resource, evidence, attempt.time))) throw denied();
            governanceReach = governanceReachUse(evidence, actor, action, resource);
          }),
        );
        requireAccessDeadline(proofDeadline);
        if (!bound(attempt)) throw denied();
        const proof = Object.freeze({});
        proofs.set(proof, {
          attempt,
          deadline: proofDeadline,
          governanceReach,
          historyAccounts: permissionHistoryAccounts(evidence, actor, action, resource, page),
        });
        return proof;
      } catch (error) {
        throwAccessUnavailable(error, deadline);
        throwEvidenceFailure(error);
        // Domain unavailability must not expose a receipt or reach target checkout.
        if (anonymous) throw denied();
        throw error;
      }
    },
    async authorize(tx, attempt, proof) {
      const prepared = typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
      if (prepared) proofs.delete(proof as object);
      requireAccessDeadline(deadline);
      if (prepared) requireAccessDeadline(prepared.deadline);
      if (
        !bound(attempt) ||
        !prepared ||
        prepared.attempt !== attempt ||
        commandTime(tx) !== attempt.time ||
        prepared.attempt.time !== attempt.time ||
        prepared.attempt.basis !== attempt.basis ||
        prepared.attempt.partition !== attempt.partition
      )
        throw denied();
      if (prepared.governanceReach && !recordGovernanceReachUse(tx, prepared.governanceReach)) throw denied();
      if (prepared.historyAccounts) bindCommandHistoryEvidence(tx, prepared.historyAccounts);
      return 'execute';
    },
  });
}
