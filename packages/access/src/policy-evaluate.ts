import {
  MAX_POLICY_EXPLANATION_BYTES,
  MAX_POLICY_EXPLANATION_NODES,
  MAX_POLICY_TEMPORAL_INTERVALS,
  MAX_POLICY_TEMPORAL_INTEGER_CHARS,
  type PolicyCatalogue,
  type PolicyDecision,
  type PolicyFact,
  type PolicyFacts,
  type PolicyOperand,
  type PolicyOperandName,
  type PolicyRequest,
  type PolicySubjectFacts,
  type RequiredPolicyOperand,
  type TemporalEvidence,
} from './policy-contract.ts';

type Truth = 'true' | 'false' | 'unknown';

function truth(value: PolicyFact | undefined): Truth {
  return value === true ? 'true' : value === false ? 'false' : 'unknown';
}

function and(values: readonly Truth[]): Truth {
  if (values.includes('false')) return 'false';
  if (values.includes('unknown')) return 'unknown';
  return 'true';
}

function or(values: readonly Truth[]): Truth {
  if (values.includes('true')) return 'true';
  if (values.includes('unknown')) return 'unknown';
  return 'false';
}

function not(value: Truth): Truth {
  return value === 'true' ? 'false' : value === 'false' ? 'true' : 'unknown';
}

function validRequest(request: unknown): request is PolicyRequest {
  try {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return false;
    const prototype = Object.getPrototypeOf(request);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(request);
    if (keys.some((key) => typeof key !== 'string' || !['action', 'resourceType', 'mode', 'anonymous', 'hasPrincipal', 'authenticatedBenefit'].includes(key)))
      return false;
    const value: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(request, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
      value[key as string] = descriptor.value;
    }
    return (
      typeof value.action === 'string' &&
      typeof value.resourceType === 'string' &&
      (value.mode === 'ordinary' || value.mode === 'explicit') &&
      typeof value.anonymous === 'boolean' &&
      typeof value.hasPrincipal === 'boolean' &&
      (value.authenticatedBenefit === undefined || typeof value.authenticatedBenefit === 'boolean')
    );
  } catch {
    return false;
  }
}

function unavailable(): PolicyDecision {
  return result('unavailable', 'evidence', []);
}

function subjectGrant(
  facts: PolicySubjectFacts | undefined,
  mode: PolicyRequest['mode'],
  ownAccountAuthority: boolean,
  benefitAuthority: boolean,
): Truth {
  const direct = truth(facts?.actionGrant);
  const role = mode === 'explicit' ? 'false' : truth(facts?.resourceRoleGrant);
  const ownAccount = ownAccountAuthority ? truth(facts?.ownAccount) : 'false';
  const benefit = mode === 'explicit' || !benefitAuthority ? 'false' : truth(facts?.authenticatedBenefit);
  return or([direct, role, ownAccount, benefit]);
}

function addOperand(
  operands: PolicyOperand[],
  name: PolicyOperandName,
  value: Truth | 'not-required',
  decisive = false,
): void {
  if (operands.length >= MAX_POLICY_EXPLANATION_NODES) return;
  operands.push(Object.freeze({ name, value, decisive }));
}

function result(
  decision: PolicyDecision['decision'],
  reason: PolicyDecision['reason'],
  operands: PolicyOperand[],
): PolicyDecision {
  const explanation = Object.freeze(operands.slice(0, MAX_POLICY_EXPLANATION_NODES));
  const encoded = JSON.stringify(explanation);
  if (encoded.length > MAX_POLICY_EXPLANATION_BYTES) {
    return Object.freeze({
      decision: 'unavailable',
      reason: 'evidence',
      explanation: Object.freeze([]),
    });
  }
  return Object.freeze({ decision, reason, explanation });
}

function invalid(): PolicyDecision {
  return result('invalid', 'invalid-request', []);
}

/** Describe the fixed operand set before the caller acquires any evidence. */
export function describeRequiredOperands(
  catalogue: PolicyCatalogue,
  request: PolicyRequest,
): readonly RequiredPolicyOperand[] {
  if (!validRequest(request)) return Object.freeze([]);
  const action = catalogue.actionByName[request.action];
  if (
    !action ||
    !action.resourceTypes.includes(request.resourceType) ||
    (request.anonymous && !action.anonymous)
  )
    return Object.freeze([]);

  const required: RequiredPolicyOperand[] = [
    { name: 'standing', required: true },
    { name: 'assignment', required: true },
    { name: 'deadline', required: true },
    { name: 'scope', required: true },
    { name: 'actor.action-grant', required: true },
    { name: 'actor.resource-role-grant', required: request.mode === 'ordinary' },
  ];
  if (action.authority === 'own-account') required.push({ name: 'actor.own-account', required: true });
  if (request.authenticatedBenefit === true && request.mode === 'ordinary')
    required.push({ name: 'actor.authenticated-benefit', required: true });
  if (request.hasPrincipal) {
    required.push({ name: 'principal.action-grant', required: true });
    required.push({ name: 'principal.resource-role-grant', required: request.mode === 'ordinary' });
    if (action.authority === 'own-account') required.push({ name: 'principal.own-account', required: true });
    if (request.authenticatedBenefit === true && request.mode === 'ordinary')
      required.push({ name: 'principal.authenticated-benefit', required: true });
  }
  required.push({ name: 'local.denial', required: true });
  if (action.anonymous && request.mode === 'ordinary')
    required.push({ name: 'public.floor', required: true, independentOfScope: true });
  if (action.globalReach) {
    required.push({ name: 'global.denial', required: true });
    required.push({ name: 'global.actor-action-grant', required: true });
    required.push({ name: 'global.actor-resource-role-grant', required: request.mode === 'ordinary' });
    if (action.authority === 'own-account') required.push({ name: 'global.actor.own-account', required: true });
    if (request.authenticatedBenefit === true && request.mode === 'ordinary')
      required.push({ name: 'global.actor.authenticated-benefit', required: true });
    if (request.hasPrincipal) {
      required.push({ name: 'global.principal-action-grant', required: true });
      required.push({ name: 'global.principal-resource-role-grant', required: request.mode === 'ordinary' });
      if (action.authority === 'own-account') required.push({ name: 'global.principal.own-account', required: true });
      if (request.authenticatedBenefit === true && request.mode === 'ordinary')
        required.push({ name: 'global.principal.authenticated-benefit', required: true });
    }
  }
  return Object.freeze(required.map((item) => Object.freeze(item)));
}

/** Pure, bounded decision over qualified primitive facts. */
export function decidePolicy(
  catalogue: PolicyCatalogue,
  request: PolicyRequest,
  facts: PolicyFacts,
): PolicyDecision {
  if (!validRequest(request)) return invalid();
  const action = catalogue.actionByName[request.action];
  if (
    !action ||
    !catalogue.resourceTypeByName[request.resourceType] ||
    !action.resourceTypes.includes(request.resourceType) ||
    (request.anonymous && !action.anonymous)
  )
    return invalid();
  if (!facts || typeof facts !== 'object') return unavailable();

  const isExplicit = request.mode === 'explicit';
  const canUseFloor = action.anonymous && !isExplicit;
  const useBenefit = request.authenticatedBenefit === true;
  const actorGrant = subjectGrant(facts.actor, request.mode, action.authority === 'own-account', useBenefit);
  const principalGrant = request.hasPrincipal
    ? subjectGrant(facts.principal, request.mode, action.authority === 'own-account', useBenefit)
    : 'true';
  const localDenial = truth(facts.localDenial);
  const localGrant = and([truth(facts.scope), actorGrant, principalGrant]);
  const floor = canUseFloor ? truth(facts.publicFloor) : 'false';
  const localDecision = and([not(localDenial), or([floor, localGrant])]);
  const standing = truth(facts.standing);
  const assignment = truth(facts.assignment);
  const deadline = truth(facts.deadlineLive);
  const ceiling = and([standing, assignment, deadline]);

  let globalDecision: Truth = 'false';
  let globalDenial: Truth = 'false';
  let globalActor: Truth = 'false';
  let globalPrincipal: Truth = 'true';
  if (action.globalReach) {
    globalDenial = truth(facts.global?.denial);
    globalActor = subjectGrant(facts.global?.actor, request.mode, action.authority === 'own-account', useBenefit);
    globalPrincipal = request.hasPrincipal
      ? subjectGrant(facts.global?.principal, request.mode, action.authority === 'own-account', useBenefit)
      : 'true';
    globalDecision = and([not(globalDenial), truth(facts.scope), globalActor, globalPrincipal]);
  }
  const decision = and([ceiling, action.globalReach ? or([localDecision, globalDecision]) : localDecision]);
  const localGrantActive =
    decision === 'true' &&
    truth(facts.scope) === 'true' &&
    localDenial === 'false' &&
    actorGrant === 'true' &&
    principalGrant === 'true';
  const globalGrantActive = decision === 'true' && globalDecision === 'true';

  const operands: PolicyOperand[] = [];
  addOperand(operands, 'standing', standing, decision === 'false' && standing === 'false');
  addOperand(operands, 'assignment', assignment, decision === 'false' && assignment === 'false');
  addOperand(operands, 'deadline', deadline, decision === 'false' && deadline === 'false');
  addOperand(
    operands,
    'scope',
    truth(facts.scope),
    localGrantActive || globalGrantActive || (!canUseFloor && decision === 'false' && truth(facts.scope) === 'false'),
  );
  addOperand(
    operands,
    'actor.action-grant',
    truth(facts.actor?.actionGrant),
    (localGrantActive && facts.actor?.actionGrant === true) || (decision === 'false' && actorGrant === 'false'),
  );
  addOperand(
    operands,
    'actor.resource-role-grant',
    isExplicit ? 'not-required' : truth(facts.actor?.resourceRoleGrant),
    localGrantActive && facts.actor?.resourceRoleGrant === true,
  );
  if (action.authority === 'own-account')
    addOperand(
      operands,
      'actor.own-account',
      truth(facts.actor?.ownAccount),
      (localGrantActive && facts.actor?.ownAccount === true) || (decision === 'false' && actorGrant === 'false'),
    );
  if (useBenefit)
    addOperand(
      operands,
      'actor.authenticated-benefit',
      isExplicit ? 'not-required' : truth(facts.actor?.authenticatedBenefit),
      localGrantActive && facts.actor?.authenticatedBenefit === true,
    );
  if (request.hasPrincipal) {
    addOperand(
      operands,
      'principal.action-grant',
      truth(facts.principal?.actionGrant),
      (localGrantActive && facts.principal?.actionGrant === true) || (decision === 'false' && principalGrant === 'false'),
    );
    addOperand(
      operands,
      'principal.resource-role-grant',
      isExplicit ? 'not-required' : truth(facts.principal?.resourceRoleGrant),
      localGrantActive && facts.principal?.resourceRoleGrant === true,
    );
    if (action.authority === 'own-account')
      addOperand(
        operands,
        'principal.own-account',
        truth(facts.principal?.ownAccount),
        (localGrantActive && facts.principal?.ownAccount === true) || (decision === 'false' && principalGrant === 'false'),
      );
    if (useBenefit)
      addOperand(
        operands,
        'principal.authenticated-benefit',
        isExplicit ? 'not-required' : truth(facts.principal?.authenticatedBenefit),
        localGrantActive && facts.principal?.authenticatedBenefit === true,
      );
  }
  addOperand(operands, 'local.denial', localDenial, decision === 'false' && localDenial === 'true');
    addOperand(
      operands,
      'public.floor',
      canUseFloor ? floor : 'not-required',
      decision === 'true' && floor === 'true' && localDecision === 'true',
    );
  if (action.globalReach) {
    addOperand(operands, 'global.denial', globalDenial, decision === 'false' && globalDenial === 'true');
    addOperand(
      operands,
      'global.actor-action-grant',
      truth(facts.global?.actor?.actionGrant),
      globalGrantActive && facts.global?.actor?.actionGrant === true,
    );
    addOperand(
      operands,
      'global.actor-resource-role-grant',
      isExplicit ? 'not-required' : truth(facts.global?.actor?.resourceRoleGrant),
      globalGrantActive && !isExplicit && facts.global?.actor?.resourceRoleGrant === true,
    );
    if (action.authority === 'own-account')
      addOperand(
        operands,
        'global.actor.own-account',
        truth(facts.global?.actor?.ownAccount),
        globalGrantActive && facts.global?.actor?.ownAccount === true,
      );
    if (useBenefit)
      addOperand(
        operands,
        'global.actor.authenticated-benefit',
        isExplicit ? 'not-required' : truth(facts.global?.actor?.authenticatedBenefit),
        globalGrantActive && !isExplicit && facts.global?.actor?.authenticatedBenefit === true,
      );
    if (request.hasPrincipal) {
      addOperand(
        operands,
        'global.principal-action-grant',
        truth(facts.global?.principal?.actionGrant),
        globalGrantActive && facts.global?.principal?.actionGrant === true,
      );
      addOperand(
        operands,
        'global.principal-resource-role-grant',
        isExplicit ? 'not-required' : truth(facts.global?.principal?.resourceRoleGrant),
        globalGrantActive && !isExplicit && facts.global?.principal?.resourceRoleGrant === true,
      );
      if (action.authority === 'own-account')
        addOperand(
          operands,
          'global.principal.own-account',
          truth(facts.global?.principal?.ownAccount),
          globalGrantActive && facts.global?.principal?.ownAccount === true,
        );
      if (useBenefit)
        addOperand(
          operands,
          'global.principal.authenticated-benefit',
          isExplicit ? 'not-required' : truth(facts.global?.principal?.authenticatedBenefit),
          globalGrantActive && !isExplicit && facts.global?.principal?.authenticatedBenefit === true,
        );
    }
  }

  let reason: PolicyDecision['reason'] = 'grant';
  if (decision === 'unknown') reason = 'evidence';
  else if (standing === 'false') reason = 'standing';
  else if (assignment === 'false') reason = 'assignment';
  else if (deadline === 'false') reason = 'deadline';
  else if (decision === 'true' && action.globalReach && localDecision !== 'true') reason = 'global-reach';
  else if (decision === 'true' && floor === 'true') reason = 'local-floor';
  else if (decision === 'true') reason = 'local-grant';
  else if (localDenial === 'true' || (action.globalReach && globalDenial === 'true')) reason = 'denial';
  else if (truth(facts.scope) === 'false' && floor !== 'true') reason = 'scope';
  return result(decision === 'true' ? 'allow' : decision === 'false' ? 'deny' : 'unavailable', reason, operands);
}

const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

function temporalInteger(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= MAX_POLICY_TEMPORAL_INTEGER_CHARS &&
    INTEGER.test(value);
}

/** Qualify complete temporal evidence using exact integer microseconds and [from, until). */
export function qualifyTemporalEvidence(evidence: TemporalEvidence | undefined, atMicros: string): PolicyFact {
  try {
    if (!evidence || typeof evidence !== 'object') return null;
    const evidencePrototype = Object.getPrototypeOf(evidence);
    if (evidencePrototype !== Object.prototype && evidencePrototype !== null) return null;
    const evidenceFields = Reflect.ownKeys(evidence);
    if (evidenceFields.some((field) => field !== 'complete' && field !== 'intervals')) return null;
    const complete = Object.getOwnPropertyDescriptor(evidence, 'complete');
    const intervalField = Object.getOwnPropertyDescriptor(evidence, 'intervals');
    if (
      !complete || !('value' in complete) || !complete.enumerable || complete.value !== true ||
      !intervalField || !('value' in intervalField) || !intervalField.enumerable || !Array.isArray(intervalField.value)
    ) return null;
    const intervals: unknown[] = intervalField.value;
    if (Object.getPrototypeOf(intervals) !== Array.prototype) return null;
    const intervalKeys = Reflect.ownKeys(intervals);
    if (
      intervals.length > MAX_POLICY_TEMPORAL_INTERVALS ||
      intervalKeys.length !== intervals.length + 1 ||
      intervalKeys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key))) ||
      !temporalInteger(atMicros)
    ) return null;
    const at = BigInt(atMicros);
    for (let index = 0; index < intervals.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(intervals, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      const interval = descriptor.value;
      if (!interval || typeof interval !== 'object' || Array.isArray(interval)) return null;
      const prototype = Object.getPrototypeOf(interval);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const fields = Reflect.ownKeys(interval);
      if (fields.some((field) => field !== 'fromMicros' && field !== 'untilMicros')) return null;
      const fromField = Object.getOwnPropertyDescriptor(interval, 'fromMicros');
      const untilField = Object.getOwnPropertyDescriptor(interval, 'untilMicros');
      if (
        !fromField || !('value' in fromField) || !fromField.enumerable ||
        !untilField || !('value' in untilField) || !untilField.enumerable
      )
        return null;
      const fromText: unknown = fromField.value;
      const untilText: unknown = untilField.value;
      if ((fromText !== null && !temporalInteger(fromText)) || (untilText !== null && !temporalInteger(untilText)))
        return null;
      const from = fromText === null ? undefined : BigInt(fromText);
      const until = untilText === null ? undefined : BigInt(untilText);
      if (from !== undefined && until !== undefined && from >= until) return null;
      if ((from === undefined || from <= at) && (until === undefined || at < until)) return true;
    }
    return false;
  } catch {
    return null;
  }
}
