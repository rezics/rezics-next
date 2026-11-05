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
    if (
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !['action', 'resourceType', 'mode', 'anonymous', 'hasPrincipal', 'authenticatedBenefit'].includes(key),
      )
    )
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

export type PolicyFormulaNode =
  | Readonly<{ op: 'constant'; value: boolean }>
  | Readonly<{ op: 'operand'; name: PolicyOperandName }>
  | Readonly<{ op: 'not'; value: PolicyFormulaNode }>
  | Readonly<{ op: 'and' | 'or'; values: readonly PolicyFormulaNode[] }>;

export type PolicyFormulaProfile = Readonly<{
  action: NonNullable<PolicyCatalogue['actionByName'][string]>;
  root: PolicyFormulaNode;
  local: PolicyFormulaNode;
  localGrant: PolicyFormulaNode;
  actorGrant: PolicyFormulaNode;
  principalGrant: PolicyFormulaNode;
  global?: PolicyFormulaNode;
  globalActorGrant?: PolicyFormulaNode;
  globalPrincipalGrant?: PolicyFormulaNode;
}>;

const constant = (value: boolean): PolicyFormulaNode => Object.freeze({ op: 'constant', value });
const operand = (name: PolicyOperandName): PolicyFormulaNode => Object.freeze({ op: 'operand', name });
const negate = (value: PolicyFormulaNode): PolicyFormulaNode => Object.freeze({ op: 'not', value });
const conjunction = (values: readonly PolicyFormulaNode[]): PolicyFormulaNode =>
  values.length === 1 ? values[0]! : Object.freeze({ op: 'and', values: Object.freeze([...values]) });
const disjunction = (values: readonly PolicyFormulaNode[]): PolicyFormulaNode =>
  values.length === 1 ? values[0]! : Object.freeze({ op: 'or', values: Object.freeze([...values]) });

type GrantSide = 'actor' | 'principal' | 'global-actor' | 'global-principal';

function grantOperand(side: GrantSide, field: 'action' | 'role' | 'own-account' | 'benefit'): PolicyOperandName {
  if (side === 'actor') {
    if (field === 'action') return 'actor.action-grant';
    if (field === 'role') return 'actor.resource-role-grant';
    if (field === 'own-account') return 'actor.own-account';
    return 'actor.authenticated-benefit';
  }
  if (side === 'principal') {
    if (field === 'action') return 'principal.action-grant';
    if (field === 'role') return 'principal.resource-role-grant';
    if (field === 'own-account') return 'principal.own-account';
    return 'principal.authenticated-benefit';
  }
  if (side === 'global-actor') {
    if (field === 'action') return 'global.actor-action-grant';
    if (field === 'role') return 'global.actor-resource-role-grant';
    if (field === 'own-account') return 'global.actor.own-account';
    return 'global.actor.authenticated-benefit';
  }
  if (field === 'action') return 'global.principal-action-grant';
  if (field === 'role') return 'global.principal-resource-role-grant';
  if (field === 'own-account') return 'global.principal.own-account';
  return 'global.principal.authenticated-benefit';
}

function grantFormula(
  side: GrantSide,
  request: PolicyRequest,
  action: PolicyFormulaProfile['action'],
): PolicyFormulaNode {
  const terms = [operand(grantOperand(side, 'action'))];
  if (request.mode === 'ordinary') terms.push(operand(grantOperand(side, 'role')));
  if (action.authority === 'own-account') terms.push(operand(grantOperand(side, 'own-account')));
  if (request.authenticatedBenefit === true && request.mode === 'ordinary')
    terms.push(operand(grantOperand(side, 'benefit')));
  return disjunction(terms);
}

/** The one fixed policy formula used by scalar evaluation and specialization. */
export function policyFormulaProfile(catalogue: PolicyCatalogue, request: PolicyRequest): PolicyFormulaProfile | null {
  if (!validRequest(request)) return null;
  const action = catalogue.actionByName[request.action];
  if (
    !action ||
    !catalogue.resourceTypeByName[request.resourceType] ||
    !action.resourceTypes.includes(request.resourceType) ||
    (request.anonymous && !action.anonymous)
  )
    return null;

  const actorGrant = grantFormula('actor', request, action);
  const principalGrant = request.hasPrincipal ? grantFormula('principal', request, action) : constant(true);
  const localGrant = conjunction([operand('scope'), actorGrant, principalGrant]);
  const floor = action.anonymous && request.mode === 'ordinary' ? operand('public.floor') : constant(false);
  const local = conjunction([negate(operand('local.denial')), disjunction([floor, localGrant])]);
  let global: PolicyFormulaNode | undefined;
  let globalActorGrant: PolicyFormulaNode | undefined;
  let globalPrincipalGrant: PolicyFormulaNode | undefined;
  let granting: PolicyFormulaNode = local;
  if (action.globalReach) {
    globalActorGrant = grantFormula('global-actor', request, action);
    globalPrincipalGrant = request.hasPrincipal ? grantFormula('global-principal', request, action) : constant(true);
    global = conjunction([negate(operand('global.denial')), operand('scope'), globalActorGrant, globalPrincipalGrant]);
    granting = disjunction([local, global]);
  }
  return Object.freeze({
    action,
    root: conjunction([operand('standing'), operand('assignment'), operand('deadline'), granting]),
    local,
    localGrant,
    actorGrant,
    principalGrant,
    ...(global ? { global } : {}),
    ...(globalActorGrant ? { globalActorGrant } : {}),
    ...(globalPrincipalGrant ? { globalPrincipalGrant } : {}),
  });
}

export function evaluatePolicyFormula(node: PolicyFormulaNode, resolve: (name: PolicyOperandName) => Truth): Truth {
  switch (node.op) {
    case 'constant':
      return node.value ? 'true' : 'false';
    case 'operand':
      return resolve(node.name);
    case 'not':
      return not(evaluatePolicyFormula(node.value, resolve));
    case 'and':
      return and(node.values.map((value) => evaluatePolicyFormula(value, resolve)));
    case 'or':
      return or(node.values.map((value) => evaluatePolicyFormula(value, resolve)));
  }
}

const FACT_PATHS: Readonly<Record<PolicyOperandName, readonly string[]>> = Object.freeze({
  standing: ['standing'],
  assignment: ['assignment'],
  deadline: ['deadlineLive'],
  scope: ['scope'],
  'actor.action-grant': ['actor', 'actionGrant'],
  'actor.resource-role-grant': ['actor', 'resourceRoleGrant'],
  'actor.own-account': ['actor', 'ownAccount'],
  'actor.authenticated-benefit': ['actor', 'authenticatedBenefit'],
  'principal.action-grant': ['principal', 'actionGrant'],
  'principal.resource-role-grant': ['principal', 'resourceRoleGrant'],
  'principal.own-account': ['principal', 'ownAccount'],
  'principal.authenticated-benefit': ['principal', 'authenticatedBenefit'],
  'local.denial': ['localDenial'],
  'public.floor': ['publicFloor'],
  'global.denial': ['global', 'denial'],
  'global.actor-action-grant': ['global', 'actor', 'actionGrant'],
  'global.actor-resource-role-grant': ['global', 'actor', 'resourceRoleGrant'],
  'global.actor.own-account': ['global', 'actor', 'ownAccount'],
  'global.actor.authenticated-benefit': ['global', 'actor', 'authenticatedBenefit'],
  'global.principal-action-grant': ['global', 'principal', 'actionGrant'],
  'global.principal-resource-role-grant': ['global', 'principal', 'resourceRoleGrant'],
  'global.principal.own-account': ['global', 'principal', 'ownAccount'],
  'global.principal.authenticated-benefit': ['global', 'principal', 'authenticatedBenefit'],
});

export type PolicyFactEvidence =
  | Readonly<{ status: 'present'; value: PolicyFact }>
  | Readonly<{ status: 'missing' | 'malformed' }>;

/** Read data-only facts without invoking getters; absence and explicit unknown stay distinct. */
export function policyFactEvidence(facts: unknown, name: PolicyOperandName): PolicyFactEvidence {
  let current: unknown = facts;
  for (const key of FACT_PATHS[name]) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return { status: 'missing' };
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      return { status: 'malformed' };
    }
    if (!descriptor) return { status: 'missing' };
    if (!('value' in descriptor) || !descriptor.enumerable) return { status: 'malformed' };
    current = descriptor.value;
  }
  if (current === true || current === false || current === null) return { status: 'present', value: current };
  return { status: 'malformed' };
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
  if (!action || !action.resourceTypes.includes(request.resourceType) || (request.anonymous && !action.anonymous))
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
    required.push({ name: 'public.floor', required: true, independentOfScope: true, residualizable: true });
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
export function decidePolicy(catalogue: PolicyCatalogue, request: PolicyRequest, facts: PolicyFacts): PolicyDecision {
  const profile = policyFormulaProfile(catalogue, request);
  if (!profile) return invalid();
  if (!facts || typeof facts !== 'object') return unavailable();

  const action = profile.action;
  const isExplicit = request.mode === 'explicit';
  const canUseFloor = action.anonymous && !isExplicit;
  const useBenefit = request.authenticatedBenefit === true;
  const factTruth = (name: PolicyOperandName): Truth => {
    const evidence = policyFactEvidence(facts, name);
    return evidence.status === 'present' ? truth(evidence.value) : 'unknown';
  };
  const evaluate = (node: PolicyFormulaNode | undefined): Truth =>
    node ? evaluatePolicyFormula(node, factTruth) : 'false';
  const actorGrant = evaluate(profile.actorGrant);
  const principalGrant = evaluate(profile.principalGrant);
  const localDenial = factTruth('local.denial');
  const localGrant = evaluate(profile.localGrant);
  const floor = canUseFloor ? factTruth('public.floor') : 'false';
  const localDecision = evaluate(profile.local);
  const standing = factTruth('standing');
  const assignment = factTruth('assignment');
  const deadline = factTruth('deadline');
  const globalDecision = evaluate(profile.global);
  const globalDenial = action.globalReach ? factTruth('global.denial') : 'false';
  const globalActor = evaluate(profile.globalActorGrant);
  const globalPrincipal = profile.globalPrincipalGrant ? evaluate(profile.globalPrincipalGrant) : 'true';
  const decision = evaluate(profile.root);
  const localGrantActive =
    decision === 'true' &&
    factTruth('scope') === 'true' &&
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
    factTruth('scope'),
    localGrantActive || globalGrantActive || (!canUseFloor && decision === 'false' && factTruth('scope') === 'false'),
  );
  addOperand(
    operands,
    'actor.action-grant',
    factTruth('actor.action-grant'),
    (localGrantActive && factTruth('actor.action-grant') === 'true') ||
      (decision === 'false' && actorGrant === 'false'),
  );
  addOperand(
    operands,
    'actor.resource-role-grant',
    isExplicit ? 'not-required' : factTruth('actor.resource-role-grant'),
    localGrantActive && factTruth('actor.resource-role-grant') === 'true',
  );
  if (action.authority === 'own-account')
    addOperand(
      operands,
      'actor.own-account',
      factTruth('actor.own-account'),
      (localGrantActive && factTruth('actor.own-account') === 'true') ||
        (decision === 'false' && actorGrant === 'false'),
    );
  if (useBenefit)
    addOperand(
      operands,
      'actor.authenticated-benefit',
      isExplicit ? 'not-required' : factTruth('actor.authenticated-benefit'),
      localGrantActive && factTruth('actor.authenticated-benefit') === 'true',
    );
  if (request.hasPrincipal) {
    addOperand(
      operands,
      'principal.action-grant',
      factTruth('principal.action-grant'),
      (localGrantActive && factTruth('principal.action-grant') === 'true') ||
        (decision === 'false' && principalGrant === 'false'),
    );
    addOperand(
      operands,
      'principal.resource-role-grant',
      isExplicit ? 'not-required' : factTruth('principal.resource-role-grant'),
      localGrantActive && factTruth('principal.resource-role-grant') === 'true',
    );
    if (action.authority === 'own-account')
      addOperand(
        operands,
        'principal.own-account',
        factTruth('principal.own-account'),
        (localGrantActive && factTruth('principal.own-account') === 'true') ||
          (decision === 'false' && principalGrant === 'false'),
      );
    if (useBenefit)
      addOperand(
        operands,
        'principal.authenticated-benefit',
        isExplicit ? 'not-required' : factTruth('principal.authenticated-benefit'),
        localGrantActive && factTruth('principal.authenticated-benefit') === 'true',
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
      factTruth('global.actor-action-grant'),
      globalGrantActive && factTruth('global.actor-action-grant') === 'true',
    );
    addOperand(
      operands,
      'global.actor-resource-role-grant',
      isExplicit ? 'not-required' : factTruth('global.actor-resource-role-grant'),
      globalGrantActive && !isExplicit && factTruth('global.actor-resource-role-grant') === 'true',
    );
    if (action.authority === 'own-account')
      addOperand(
        operands,
        'global.actor.own-account',
        factTruth('global.actor.own-account'),
        globalGrantActive && factTruth('global.actor.own-account') === 'true',
      );
    if (useBenefit)
      addOperand(
        operands,
        'global.actor.authenticated-benefit',
        isExplicit ? 'not-required' : factTruth('global.actor.authenticated-benefit'),
        globalGrantActive && !isExplicit && factTruth('global.actor.authenticated-benefit') === 'true',
      );
    if (request.hasPrincipal) {
      addOperand(
        operands,
        'global.principal-action-grant',
        factTruth('global.principal-action-grant'),
        globalGrantActive && factTruth('global.principal-action-grant') === 'true',
      );
      addOperand(
        operands,
        'global.principal-resource-role-grant',
        isExplicit ? 'not-required' : factTruth('global.principal-resource-role-grant'),
        globalGrantActive && !isExplicit && factTruth('global.principal-resource-role-grant') === 'true',
      );
      if (action.authority === 'own-account')
        addOperand(
          operands,
          'global.principal.own-account',
          factTruth('global.principal.own-account'),
          globalGrantActive && factTruth('global.principal.own-account') === 'true',
        );
      if (useBenefit)
        addOperand(
          operands,
          'global.principal.authenticated-benefit',
          isExplicit ? 'not-required' : factTruth('global.principal.authenticated-benefit'),
          globalGrantActive && !isExplicit && factTruth('global.principal.authenticated-benefit') === 'true',
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
  else if (factTruth('scope') === 'false' && floor !== 'true') reason = 'scope';
  return result(decision === 'true' ? 'allow' : decision === 'false' ? 'deny' : 'unavailable', reason, operands);
}

const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

function temporalInteger(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_POLICY_TEMPORAL_INTEGER_CHARS && INTEGER.test(value);
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
      !complete ||
      !('value' in complete) ||
      !complete.enumerable ||
      complete.value !== true ||
      !intervalField ||
      !('value' in intervalField) ||
      !intervalField.enumerable ||
      !Array.isArray(intervalField.value)
    )
      return null;
    const intervals: unknown[] = intervalField.value;
    if (Object.getPrototypeOf(intervals) !== Array.prototype) return null;
    const intervalKeys = Reflect.ownKeys(intervals);
    if (
      intervals.length > MAX_POLICY_TEMPORAL_INTERVALS ||
      intervalKeys.length !== intervals.length + 1 ||
      intervalKeys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key))) ||
      !temporalInteger(atMicros)
    )
      return null;
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
        !fromField ||
        !('value' in fromField) ||
        !fromField.enumerable ||
        !untilField ||
        !('value' in untilField) ||
        !untilField.enumerable
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
