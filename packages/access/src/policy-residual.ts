import {
  MAX_POLICY_EXPLANATION_BYTES,
  MAX_POLICY_EXPLANATION_NODES,
  MAX_POLICY_RESIDUAL_BYTES,
  MAX_POLICY_RESIDUAL_NODES,
  type PolicyCatalogue,
  type PolicyFacts,
  type PolicyOperand,
  type PolicyOperandName,
  type PolicyRequest,
  type PolicyResourceOperandName,
  type PolicyResidual,
  type PolicyResidualDecision,
  type PolicyResidualNode,
  type PolicySpecializationResult,
} from './policy-contract.ts';
import {
  describeRequiredOperands as describeOperands,
  policyFactEvidence,
  policyFormulaProfile,
  type PolicyFormulaNode,
} from './policy-evaluate.ts';

type Truth = 'true' | 'false' | 'unknown';
type UnknownNode = Readonly<{
  op: 'unknown';
  name: PolicyOperandName;
  reason: 'missing-evidence' | 'unknown-evidence' | 'malformed-evidence';
}>;
type SpecialNode = PolicyResidualNode | UnknownNode;

const constant = (value: boolean): PolicyResidualNode => Object.freeze({ op: 'constant', value });
const resourceOperands = new Set<PolicyResourceOperandName>(['public.floor']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownData(
  value: Record<string, unknown>,
  key: string,
): { present: false } | { present: true; value: unknown } | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { present: false };
    if (!('value' in descriptor) || !descriptor.enumerable) return null;
    return { present: true, value: descriptor.value };
  } catch {
    return null;
  }
}

function children(node: SpecialNode): readonly SpecialNode[] {
  if (node.op === 'not') return [node.value as SpecialNode];
  if (node.op === 'and' || node.op === 'or') return node.values as readonly SpecialNode[];
  return [];
}

function simplify(node: SpecialNode): SpecialNode {
  if (node.op === 'unknown' || node.op === 'constant' || node.op === 'operand') return node;
  if (node.op === 'not') {
    const value = simplify(node.value as SpecialNode);
    if (value.op === 'constant') return constant(!value.value);
    if (value.op === 'not') return simplify(value.value as SpecialNode);
    return Object.freeze({ op: 'not', value: value as PolicyResidualNode });
  }

  const terms = node.values
    .map((item) => simplify(item as SpecialNode))
    .flatMap((item) => (item.op === node.op ? (item.values as readonly SpecialNode[]) : [item]));
  const decisive = node.op === 'and' ? false : true;
  if (terms.some((item) => item.op === 'constant' && item.value === decisive)) return constant(decisive);
  const neutral = !decisive;
  const remaining = terms.filter((item) => item.op !== 'constant' || item.value !== neutral);
  if (remaining.length === 0) return constant(neutral);
  if (remaining.length === 1) return remaining[0]!;
  return Object.freeze({ op: node.op, values: Object.freeze(remaining as PolicyResidualNode[]) });
}

function factNode(
  node: Extract<PolicyFormulaNode, { op: 'operand' }>,
  facts: unknown,
  requested: ReadonlySet<PolicyResourceOperandName>,
): SpecialNode {
  const evidence = policyFactEvidence(facts, node.name);
  if (evidence.status === 'present') {
    if (evidence.value === null) return Object.freeze({ op: 'unknown', name: node.name, reason: 'unknown-evidence' });
    return constant(evidence.value);
  }
  if (evidence.status === 'malformed')
    return Object.freeze({ op: 'unknown', name: node.name, reason: 'malformed-evidence' });
  if (
    requested.has(node.name as PolicyResourceOperandName) &&
    resourceOperands.has(node.name as PolicyResourceOperandName)
  )
    return Object.freeze({ op: 'operand', name: node.name as PolicyResourceOperandName });
  return Object.freeze({ op: 'unknown', name: node.name, reason: 'missing-evidence' });
}

function specializeNode(
  node: PolicyFormulaNode,
  facts: unknown,
  requested: ReadonlySet<PolicyResourceOperandName>,
): SpecialNode {
  switch (node.op) {
    case 'constant':
      return constant(node.value);
    case 'operand':
      return factNode(node, facts, requested);
    case 'not':
      return Object.freeze({ op: 'not', value: specializeNode(node.value, facts, requested) as PolicyResidualNode });
    case 'and':
    case 'or':
      return Object.freeze({
        op: node.op,
        values: Object.freeze(
          node.values.map((value) => specializeNode(value, facts, requested) as PolicyResidualNode),
        ),
      });
  }
}

function findUnknown(node: SpecialNode): UnknownNode | null {
  if (node.op === 'unknown') return node;
  for (const child of children(node)) {
    const unknown = findUnknown(child);
    if (unknown) return unknown;
  }
  return null;
}

function residualNodeCount(node: PolicyResidualNode, depth = 0): number {
  if (depth > MAX_POLICY_RESIDUAL_NODES) return MAX_POLICY_RESIDUAL_NODES + 1;
  if (node.op === 'not') return 1 + residualNodeCount(node.value, depth + 1);
  if (node.op === 'and' || node.op === 'or')
    return 1 + node.values.reduce((total, item) => total + residualNodeCount(item, depth + 1), 0);
  return 1;
}

function unavailable(
  reason: 'missing-evidence' | 'unknown-evidence' | 'malformed-evidence' | 'residual-too-large',
  operand: PolicyOperandName,
): PolicySpecializationResult {
  return Object.freeze({ status: 'unavailable', reason, operand });
}

function resourceOperandList(value: unknown): readonly PolicyResourceOperandName[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 8) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)))
    )
      return null;
    const result: PolicyResourceOperandName[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string')
        return null;
      if (descriptor.value !== 'public.floor' || result.includes(descriptor.value)) return null;
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

/** Bind qualified request facts and retain only explicitly selected resource operands. */
export function specializePolicy(
  catalogue: PolicyCatalogue,
  request: PolicyRequest,
  facts: PolicyFacts,
  resourceOperandNames: readonly PolicyResourceOperandName[] = [],
): PolicySpecializationResult {
  try {
    const profile = policyFormulaProfile(catalogue, request);
    if (!profile) return Object.freeze({ status: 'invalid', reason: 'invalid-request' });
    const requested = resourceOperandList(resourceOperandNames);
    if (!requested) return Object.freeze({ status: 'invalid', reason: 'unsupported-resource-operand' });
    const required = new Map(describeOperands(catalogue, request).map((item) => [item.name, item]));
    if (requested.some((name) => !required.get(name)?.residualizable))
      return Object.freeze({ status: 'invalid', reason: 'unsupported-resource-operand' });

    const root = simplify(specializeNode(profile.root, facts, new Set(requested)));
    const unresolved = findUnknown(root);
    if (unresolved) return unavailable(unresolved.reason, unresolved.name);
    const residual = Object.freeze({ format: 'rezics-access-residual/1' as const, root: root as PolicyResidualNode });
    const encoded = JSON.stringify(residual);
    const nodes = residualNodeCount(residual.root);
    if (nodes > MAX_POLICY_RESIDUAL_NODES || encoded.length > MAX_POLICY_RESIDUAL_BYTES)
      return unavailable('residual-too-large', requested[0] ?? 'public.floor');
    return Object.freeze({ status: 'ready', residual });
  } catch {
    return Object.freeze({ status: 'unavailable', reason: 'malformed-evidence', operand: 'standing' });
  }
}

function truth(value: unknown): Truth {
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

function evaluateNode(
  node: PolicyResidualNode,
  facts: unknown,
  explanations: Map<PolicyResourceOperandName, PolicyOperand>,
): Truth {
  switch (node.op) {
    case 'constant':
      return node.value ? 'true' : 'false';
    case 'operand': {
      const raw = isPlainObject(facts) ? ownData(facts, node.name) : { present: false as const };
      if (!raw || (raw.present && raw.value !== true && raw.value !== false && raw.value !== null)) {
        explanations.set(node.name, Object.freeze({ name: node.name, value: 'unknown', decisive: false }));
        return 'unknown';
      }
      if (!raw.present) {
        explanations.set(node.name, Object.freeze({ name: node.name, value: 'unknown', decisive: false }));
        return 'unknown';
      }
      const value = truth(raw.value);
      explanations.set(
        node.name,
        Object.freeze({ name: node.name, value: value === 'unknown' ? 'unknown' : value, decisive: false }),
      );
      return value;
    }
    case 'not':
      return negateTruth(evaluateNode(node.value, facts, explanations));
    case 'and':
      return and(node.values.map((item) => evaluateNode(item, facts, explanations)));
    case 'or':
      return or(node.values.map((item) => evaluateNode(item, facts, explanations)));
  }
}

function negateTruth(value: Truth): Truth {
  return value === 'true' ? 'false' : value === 'false' ? 'true' : 'unknown';
}

type ValidationBudget = { nodes: number; seen: Set<object> };

function normalizeNode(value: unknown, budget: ValidationBudget, depth: number): PolicyResidualNode | null {
  if (!isPlainObject(value) || depth > MAX_POLICY_RESIDUAL_NODES || budget.nodes >= MAX_POLICY_RESIDUAL_NODES)
    return null;
  if (budget.seen.has(value)) return null;
  budget.seen.add(value);
  budget.nodes += 1;
  const op = ownData(value, 'op');
  if (!op || !op.present || typeof op.value !== 'string') return null;
  const keys = Reflect.ownKeys(value);
  if (op.value === 'constant') {
    const flag = ownData(value, 'value');
    if (keys.length !== 2 || !keys.includes('value') || !flag?.present || typeof flag.value !== 'boolean') return null;
    return constant(flag.value);
  }
  if (op.value === 'operand') {
    const name = ownData(value, 'name');
    if (keys.length !== 2 || !keys.includes('name') || !name?.present || name.value !== 'public.floor') return null;
    return Object.freeze({ op: 'operand', name: name.value });
  }
  if (op.value === 'not') {
    const child = ownData(value, 'value');
    if (keys.length !== 2 || !keys.includes('value') || !child?.present) return null;
    const normalized = normalizeNode(child.value, budget, depth + 1);
    return normalized ? Object.freeze({ op: 'not', value: normalized }) : null;
  }
  if (op.value === 'and' || op.value === 'or') {
    const items = ownData(value, 'values');
    if (
      keys.length !== 2 ||
      !keys.includes('values') ||
      !items?.present ||
      !Array.isArray(items.value) ||
      Object.getPrototypeOf(items.value) !== Array.prototype ||
      items.value.length < 2 ||
      items.value.length > MAX_POLICY_RESIDUAL_NODES
    )
      return null;
    const arrayKeys = Reflect.ownKeys(items.value);
    if (
      arrayKeys.length !== items.value.length + 1 ||
      arrayKeys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)))
    )
      return null;
    const values: PolicyResidualNode[] = [];
    for (let index = 0; index < items.value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(items.value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      const normalized = normalizeNode(descriptor.value, budget, depth + 1);
      if (!normalized) return null;
      values.push(normalized);
    }
    return Object.freeze({ op: op.value, values: Object.freeze(values) });
  }
  return null;
}

function normalizeResidual(value: unknown): PolicyResidual | null {
  try {
    if (!isPlainObject(value)) return null;
    const format = ownData(value, 'format');
    const rootField = ownData(value, 'root');
    if (
      Reflect.ownKeys(value).length !== 2 ||
      !format?.present ||
      format.value !== 'rezics-access-residual/1' ||
      !rootField?.present
    )
      return null;
    const budget: ValidationBudget = { nodes: 0, seen: new Set() };
    const root = normalizeNode(rootField.value, budget, 0);
    if (!root) return null;
    const normalized = Object.freeze({ format: 'rezics-access-residual/1' as const, root });
    return JSON.stringify(normalized).length <= MAX_POLICY_RESIDUAL_BYTES ? normalized : null;
  } catch {
    return null;
  }
}

function explanationWithinBound(values: readonly PolicyOperand[]): readonly PolicyOperand[] {
  const explanation = Object.freeze(values.slice(0, MAX_POLICY_EXPLANATION_NODES));
  return JSON.stringify(explanation).length <= MAX_POLICY_EXPLANATION_BYTES ? explanation : Object.freeze([]);
}

function residualOperandNames(
  node: PolicyResidualNode,
  names = new Set<PolicyResourceOperandName>(),
): readonly PolicyResourceOperandName[] {
  if (node.op === 'operand') names.add(node.name);
  else if (node.op === 'not') residualOperandNames(node.value, names);
  else if (node.op === 'and' || node.op === 'or') for (const item of node.values) residualOperandNames(item, names);
  return [...names];
}

/** Evaluate only the closed residual data; absent, unknown and malformed row facts remain unavailable. */
export function evaluatePolicyResidual(
  residual: PolicyResidual,
  resourceFacts: Partial<Readonly<Record<PolicyResourceOperandName, boolean | null>>>,
): PolicyResidualDecision {
  const normalized = normalizeResidual(residual);
  if (!normalized)
    return Object.freeze({ decision: 'invalid', reason: 'malformed-residual', explanation: Object.freeze([]) });
  const explanations = new Map<PolicyResourceOperandName, PolicyOperand>();
  const value = evaluateNode(normalized.root, resourceFacts, explanations);
  const explanation = explanationWithinBound([...explanations.values()]);
  if (value === 'true' || value === 'false')
    return Object.freeze({ decision: value === 'true' ? 'allow' : 'deny', reason: 'residual', explanation });
  const names = residualOperandNames(normalized.root);
  const unknownName = names.find((name) => {
    const fact = isPlainObject(resourceFacts) ? ownData(resourceFacts, name) : { present: false as const };
    return (
      !fact ||
      !fact.present ||
      fact.value === null ||
      (fact.value !== true && fact.value !== false && fact.value !== null)
    );
  });
  const fact = unknownName && isPlainObject(resourceFacts) ? ownData(resourceFacts, unknownName) : null;
  const reason =
    !fact || !fact.present ? 'missing-evidence' : fact.value === null ? 'unknown-evidence' : 'malformed-evidence';
  return Object.freeze({ decision: 'unavailable', reason, explanation });
}
