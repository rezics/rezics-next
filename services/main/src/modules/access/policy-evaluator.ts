// Store-independent policy compiler and first-applicable evaluator (access-policy-v1).
// Conditions use Kleene three-valued logic: unresolved evidence stays `unknown`,
// so `not(unknown)` is never proof of non-membership and never a later allow.
import type { DecisionTraceEntry } from './decision-snapshot-schema.ts';
import { agentPattern, PolicyInvalid, uuidPattern } from './policy-errors.ts';
import {
  MEMBERSHIP_BASES, POLICY_LIMITS, type MembershipBasis, type PolicyRuleEffect,
  type PolicyRuleTier,
} from './policy-schema.ts';

export type Condition =
  | { op: 'authenticated' } | { op: 'represents' }
  | { op: 'subject-is'; subject: string } | { op: 'has-grant'; action: string }
  | { op: 'member-of'; admission: string; basis: MembershipBasis }
  | { op: 'time-window'; notBefore?: string; notAfter?: string }
  | { op: 'all' | 'any'; args: Condition[] } | { op: 'not'; arg: Condition };

export type Truth = boolean | 'unknown';

export interface PolicyRule {
  tier: PolicyRuleTier; position: number; ruleId: string; effect: PolicyRuleEffect;
  actions: string[]; condition: Condition;
}
export interface RuleInput { ruleId: string; actions: string[]; effect?: 'allow' | 'deny'; condition: unknown }
export interface SetReference {
  ruleId: string; admission: string; basis: MembershipBasis; polarity: 'exclude' | 'include';
}
export interface PolicyLimits { maxStates: number; maxInputRows: number; deadlineMs: number }

export const DEFAULT_POLICY_LIMITS: PolicyLimits = { maxStates: 2048, maxInputRows: 4096, deadlineMs: 1000 };
const actionPattern = /^[a-z][a-z0-9.-]{0,127}$/;
const MAX_CONDITION_DEPTH = 8;
const MAX_CONDITION_NODES = 32;

function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new PolicyInvalid('unknown condition field');
}

/** Validates the closed registry; the database keeps only a top-level guard. */
export function parseCondition(value: unknown, depth = 0, nodes = { count: 0 }): Condition {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || depth > MAX_CONDITION_DEPTH || ++nodes.count > MAX_CONDITION_NODES) {
    throw new PolicyInvalid('condition is outside the supported profile');
  }
  const node = value as Record<string, unknown>;
  switch (node.op) {
  case 'authenticated': case 'represents':
    exact(node, ['op']);
    return { op: node.op };
  case 'subject-is':
    exact(node, ['op', 'subject']);
    if (typeof node.subject !== 'string' || !agentPattern.test(node.subject)) break;
    return { op: 'subject-is', subject: node.subject };
  case 'has-grant':
    exact(node, ['op', 'action']);
    if (typeof node.action !== 'string' || !actionPattern.test(node.action)) break;
    return { op: 'has-grant', action: node.action };
  case 'member-of':
    exact(node, ['op', 'admission', 'basis']);
    if (typeof node.admission !== 'string' || !uuidPattern.test(node.admission)
      || !MEMBERSHIP_BASES.includes(node.basis as MembershipBasis)) break;
    return { op: 'member-of', admission: node.admission, basis: node.basis as MembershipBasis };
  case 'time-window': {
    exact(node, ['op', 'notBefore', 'notAfter']);
    const bounds = [node.notBefore, node.notAfter];
    if (bounds.every(bound => bound === undefined) || bounds.some(bound => bound !== undefined
      && (typeof bound !== 'string' || Number.isNaN(Date.parse(bound))))) break;
    return { op: 'time-window', ...(node.notBefore ? { notBefore: String(node.notBefore) } : {}),
      ...(node.notAfter ? { notAfter: String(node.notAfter) } : {}) };
  }
  case 'all': case 'any':
    exact(node, ['op', 'args']);
    if (!Array.isArray(node.args) || node.args.length < 1 || node.args.length > 8) break;
    return { op: node.op, args: node.args.map(arg => parseCondition(arg, depth + 1, nodes)) };
  case 'not':
    exact(node, ['op', 'arg']);
    return { op: 'not', arg: parseCondition(node.arg, depth + 1, nodes) };
  default:
  }
  throw new PolicyInvalid('condition is outside the supported profile');
}

function memberOfUses(condition: Condition, negated: boolean,
  found: { admission: string; basis: MembershipBasis; negated: boolean }[]) {
  if (condition.op === 'member-of') found.push({ admission: condition.admission, basis: condition.basis, negated });
  else if (condition.op === 'not') memberOfUses(condition.arg, !negated, found);
  else if (condition.op === 'all' || condition.op === 'any') {
    for (const arg of condition.args) memberOfUses(arg, negated, found);
  }
  return found;
}

/** Compiles one revision and derives each purpose-bound set reference. A deny on
 * membership, or an allow/require on its absence, uses the set to exclude. */
export function compilePolicyRules(mandatory: RuleInput[], ordered: RuleInput[]):
  { rules: PolicyRule[]; references: SetReference[] } {
  if (mandatory.length > POLICY_LIMITS.mandatoryRules || ordered.length > POLICY_LIMITS.orderedRules) {
    throw new PolicyInvalid('policy has too many rules');
  }
  const rules: PolicyRule[] = [];
  const references = new Map<string, SetReference>();
  for (const [tier, inputs] of [['mandatory', mandatory], ['ordered', ordered]] as const) {
    inputs.forEach((input, index) => {
      if (!uuidPattern.test(input.ruleId) || !Array.isArray(input.actions)
        || input.actions.length < 1 || input.actions.length > POLICY_LIMITS.actionsPerRule
        || input.actions.some(action => typeof action !== 'string' || !actionPattern.test(action))
        || new Set(input.actions).size !== input.actions.length
        || (tier === 'mandatory') !== (input.effect === undefined)) {
        throw new PolicyInvalid('policy rule is outside the supported profile');
      }
      const condition = parseCondition(input.condition);
      if (Buffer.byteLength(JSON.stringify(condition)) > POLICY_LIMITS.conditionBytes) {
        throw new PolicyInvalid('policy condition is too large');
      }
      const effect = input.effect ?? 'require';
      rules.push({ tier, position: index + 1, ruleId: input.ruleId, effect,
        actions: input.actions, condition });
      for (const use of memberOfUses(condition, false, [])) {
        const polarity = (effect === 'deny') !== use.negated ? 'exclude' : 'include';
        const key = `${input.ruleId}\0${use.admission}`;
        const prior = references.get(key);
        if (prior && (prior.polarity !== polarity || prior.basis !== use.basis)) {
          throw new PolicyInvalid('a rule uses one set with two meanings');
        }
        references.set(key, { ruleId: input.ruleId, admission: use.admission, basis: use.basis, polarity });
      }
    });
  }
  if (new Set(rules.map(rule => rule.ruleId)).size !== rules.length
    || references.size > POLICY_LIMITS.setReferences) {
    throw new PolicyInvalid('policy rule identities or references are invalid');
  }
  return { rules, references: [...references.values()] };
}

export class BudgetExhausted extends Error {}

/** Counts evaluated condition states and loaded input rows inside execution. */
export class EvaluationBudget {
  states = 0;
  rows = 0;
  private readonly started = performance.now();
  constructor(private readonly limits: PolicyLimits) {}
  spendState(): void {
    if (++this.states > this.limits.maxStates
      || performance.now() - this.started > this.limits.deadlineMs) {
      throw new BudgetExhausted('policy evaluation budget is exhausted');
    }
  }
  spendRows(count: number): void {
    this.rows += count;
    if (this.rows > this.limits.maxInputRows) throw new BudgetExhausted('policy input budget is exhausted');
  }
}

/** Evidence for one principal, optional acting subject and requested action. */
export interface PolicyFacts {
  actingSubject: string | null;
  now: Date;
  authenticated(): Promise<boolean>;
  represents(): Promise<boolean>;
  hasGrant(action: string): Promise<boolean>;
  /** `unknown` when the set admission is unavailable for this reference. */
  memberOf(admission: string, basis: MembershipBasis): Promise<Truth>;
}

export async function evaluateCondition(condition: Condition, facts: PolicyFacts,
  budget: EvaluationBudget): Promise<Truth> {
  budget.spendState();
  switch (condition.op) {
  case 'authenticated': return facts.authenticated();
  case 'represents': return facts.represents();
  case 'subject-is': return facts.actingSubject === condition.subject;
  case 'has-grant': return facts.hasGrant(condition.action);
  case 'member-of': return facts.memberOf(condition.admission, condition.basis);
  case 'time-window':
    return (!condition.notBefore || facts.now >= new Date(condition.notBefore))
      && (!condition.notAfter || facts.now < new Date(condition.notAfter));
  case 'not': {
    const value = await evaluateCondition(condition.arg, facts, budget);
    return value === 'unknown' ? 'unknown' : !value;
  }
  case 'all': case 'any': {
    // false dominates all(); true dominates any(); unknown otherwise survives.
    const dominant = condition.op === 'any';
    let unknown = false;
    for (const arg of condition.args) {
      const value = await evaluateCondition(arg, facts, budget);
      if (value === dominant) return dominant;
      if (value === 'unknown') unknown = true;
    }
    return unknown ? 'unknown' : !dominant;
  }
  default: return 'unknown';
  }
}

export interface PolicyOutcome {
  outcome: 'allow' | 'deny' | 'not-applicable' | 'indeterminate';
  reason: 'rule-allow' | 'rule-deny' | 'mandatory-guard-failed' | 'no-applicable-rule'
    | 'evidence-unavailable' | 'set-admission-unavailable' | 'budget-exhausted';
  deciding: { tier: PolicyRuleTier; position: number; ruleId: string } | null;
  trace: DecisionTraceEntry[];
}

/** Every mandatory guard for the action must be true, then the first ordered rule
 * whose condition is true decides. An unresolved rule stops evaluation. */
export async function decidePolicy(rules: PolicyRule[], action: string, facts: PolicyFacts,
  budget: EvaluationBudget, unavailableSets: () => number): Promise<PolicyOutcome> {
  const trace: DecisionTraceEntry[] = [];
  for (const rule of rules) {
    const applies = rule.actions.includes(action);
    const before = unavailableSets();
    let value: Truth;
    try {
      value = applies ? await evaluateCondition(rule.condition, facts, budget) : false;
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      trace.push({ tier: rule.tier, position: rule.position, outcome: 'unknown' } as DecisionTraceEntry);
      return { outcome: 'indeterminate', reason: 'budget-exhausted', trace,
        deciding: { tier: rule.tier, position: rule.position, ruleId: rule.ruleId } };
    }
    const deciding = { tier: rule.tier, position: rule.position, ruleId: rule.ruleId };
    if (value === 'unknown') {
      trace.push({ tier: rule.tier, position: rule.position, outcome: 'unknown' } as DecisionTraceEntry);
      return { outcome: 'indeterminate', deciding, trace,
        reason: unavailableSets() > before ? 'set-admission-unavailable' : 'evidence-unavailable' };
    }
    if (rule.tier === 'mandatory') {
      // A guard that does not apply to this action is not required for it.
      trace.push({ tier: 'mandatory', position: rule.position, outcome: !applies || value ? 'pass' : 'fail' });
      if (applies && !value) return { outcome: 'deny', reason: 'mandatory-guard-failed', deciding, trace };
      continue;
    }
    trace.push({ tier: 'ordered', position: rule.position, outcome: value ? 'match' : 'no-match' });
    if (value) {
      return rule.effect === 'allow' ? { outcome: 'allow', reason: 'rule-allow', deciding, trace }
        : { outcome: 'deny', reason: 'rule-deny', deciding, trace };
    }
  }
  return { outcome: 'not-applicable', reason: 'no-applicable-rule', deciding: null, trace };
}
