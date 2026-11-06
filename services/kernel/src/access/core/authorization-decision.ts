import { ACCESS_ANONYMOUS_PRINCIPAL_ID, ACCESS_PARTITION_COUNT } from '../contract/bounds.ts';
import { accessActorIdentity, type AccessDecision } from '../contract/index.ts';
import type { ResourceAuthorizationFacts } from '../contract/index.ts';

function validResource(resource: ResourceAuthorizationFacts['resource']): boolean {
  return (
    Number.isInteger(resource.route) &&
    resource.route >= 0 &&
    resource.route <= 65_535 &&
    typeof resource.id === 'string' &&
    resource.id.length > 0
  );
}

function attemptTimeValid(time: unknown): boolean {
  if (time === null || time === undefined) return false;
  if (typeof time === 'string') return time.length > 0;
  if (typeof time === 'object' && time !== null && 'toISOString' in time) return true;
  return true;
}

export function decideResourceAuthorization(facts: ResourceAuthorizationFacts): AccessDecision {
  const { actor, action, resource, partition, deadline, attempt } = facts;
  if (typeof action !== 'string' || action.length < 1) return { outcome: 'invalid', explicit: true };
  if (!Number.isFinite(deadline)) return { outcome: 'unavailable', explicit: true };
  if (!attemptTimeValid(attempt.time)) return { outcome: 'unavailable', explicit: true };
  if (!Number.isInteger(partition) || partition < 0 || partition >= ACCESS_PARTITION_COUNT) {
    return { outcome: 'invalid', explicit: true };
  }
  if (attempt.partition !== partition) return { outcome: 'deny', explicit: true };
  if (accessActorIdentity(actor) !== accessActorIdentity(facts.actor)) return { outcome: 'deny', explicit: true };
  if (!validResource(resource)) return { outcome: 'invalid', explicit: true };

  if (actor.kind === 'anonymous') {
    if (
      !attempt.basis ||
      !('principal' in attempt.basis) ||
      attempt.basis.principal?.kind !== 'anonymous' ||
      attempt.basis.principal.id !== ACCESS_ANONYMOUS_PRINCIPAL_ID ||
      attempt.basis.actorAccountId !== null ||
      attempt.basis.clientId !== null ||
      attempt.basis.requestedBy !== null ||
      resource.eligibility === undefined
    ) {
      return { outcome: 'deny', explicit: true };
    }
    return { outcome: 'allow', explicit: true };
  }

  if (
    actor.accountId === ACCESS_ANONYMOUS_PRINCIPAL_ID ||
    !attempt.basis ||
    'principal' in attempt.basis ||
    attempt.basis.actorAccountId !== actor.accountId ||
    attempt.basis.clientId !== actor.clientId ||
    attempt.basis.requestedBy !== actor.requestedBy
  ) {
    return { outcome: 'deny', explicit: true };
  }
  return { outcome: 'allow', explicit: false };
}

export function authorizationAllows(decision: AccessDecision): boolean {
  return decision.outcome === 'allow';
}
