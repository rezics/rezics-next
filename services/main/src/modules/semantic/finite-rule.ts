import { IDENTITY_AXIOMS } from './schema.ts';
import type { ActiveModelGeneration } from './generation-guard.ts';
import { reasonSemanticFacts, SEMANTIC_REASONING_PROFILE, type ReasoningFact } from './reasoning.ts';

/** Explicit product rules run over selected facts; the RDF model still uses NoEntailment. */
export const FINITE_RULE_PROFILE = 'finite-positive-rule-v1' as const;
export const FINITE_RULE_LIMITS = { rules: 16, atoms: 4, variables: 8, facts: 10_000,
  rounds: 8, inferences: 2048, inspections: 50_000 } as const;
export const finiteRuleCostContract = {
  variables: ['selectedRules', 'selectedFacts', 'atoms', 'rounds'],
  bound: 'Each join inspects at most 50,000 fact/atom pairs and emits at most 2,048 distinct inferred triples; Contexts never share a fact set.',
  limits: FINITE_RULE_LIMITS,
  retry: 'Resume only from the same exact rule, Context, model and source generations; a partial closure never proves absence.',
} as const;

export interface RuleAtom { subject: string; predicate: string; object: string }
export interface FinitePositiveRule {
  profile: typeof FINITE_RULE_PROFILE;
  inputPredicates: string[];
  outputPredicate: string;
  body: RuleAtom[];
  head: { subject: string; object: string };
  budget: { rounds: number; inferences: number; inspections: number };
}
export interface SelectedFiniteRule {
  context: string; contextRevision: string; realm: string; revision: string;
  rule: FinitePositiveRule;
}
export interface FiniteRuleFact extends ReasoningFact {
  definition: string;
  context: string;
  contextRevision: string;
  realm: string;
}
export interface DerivedFiniteFact {
  subject: string; predicate: string; object: string; context: string; contextRevision: string;
  realm: string; ruleRevision: string; inputIds: string[]; definitions: string[];
}
export type FiniteRulePlan =
  | { state: 'rejected'; reason: 'conflicting-rules'; conflictingRevisions: string[];
    inferences: []; accepted: false; authorizes: false }
  | { state: 'complete' | 'partial'; inferences: DerivedFiniteFact[]; exactCount: number | null;
    accepted: false; authorizes: false; modelGeneration: string; inspected: number };

export class FiniteRuleRejected extends Error {}

const iri = /^https?:\/\/[^\s<>"{}|\\^`]{1,2040}$/;
const variable = /^\?[a-z][a-z0-9]{0,15}$/;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const authority = /(accept|member|grant|payment|publish|publication|authority)/i;
const validTerm = (term: string) => variable.test(term) || iri.test(term);
const values = (items: readonly string[]) => [...new Set(items)].sort();

/** A range-restricted positive conjunctive rule cannot create identities or authority facts. */
export function checkedFiniteRule(input: unknown): FinitePositiveRule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FiniteRuleRejected('rule is invalid');
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some(key => !['profile', 'inputPredicates', 'outputPredicate', 'body', 'head', 'budget'].includes(key))
    || row.profile !== FINITE_RULE_PROFILE || !Array.isArray(row.body) || row.body.length < 1
    || row.body.length > FINITE_RULE_LIMITS.atoms || !Array.isArray(row.inputPredicates)
    || typeof row.outputPredicate !== 'string' || !row.head || typeof row.head !== 'object'
    || !row.budget || typeof row.budget !== 'object') throw new FiniteRuleRejected('rule profile is invalid');
  const body = row.body.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new FiniteRuleRejected('atom is invalid');
    const atom = item as Record<string, unknown>;
    if (Object.keys(atom).some(key => !['subject', 'predicate', 'object'].includes(key))
      || typeof atom.subject !== 'string' || typeof atom.predicate !== 'string'
      || typeof atom.object !== 'string' || !validTerm(atom.subject) || !validTerm(atom.object)
      || !iri.test(atom.predicate) || IDENTITY_AXIOMS.has(atom.predicate)) {
      throw new FiniteRuleRejected('atom is not admitted');
    }
    return { subject: atom.subject, predicate: atom.predicate, object: atom.object };
  });
  const head = row.head as Record<string, unknown>;
  if (Object.keys(head).some(key => !['subject', 'object'].includes(key))
    || typeof head.subject !== 'string' || typeof head.object !== 'string'
    || !validTerm(head.subject) || !validTerm(head.object)) throw new FiniteRuleRejected('head is invalid');
  const bound = new Set(body.flatMap(atom => [atom.subject, atom.object]).filter(term => variable.test(term)));
  if ([head.subject, head.object].some(term => variable.test(term) && !bound.has(term))
    || bound.size > FINITE_RULE_LIMITS.variables) throw new FiniteRuleRejected('head has an unbound variable');
  const inputs = values(body.map(atom => atom.predicate));
  if (row.inputPredicates.length !== inputs.length
    || row.inputPredicates.some((term, index) => term !== inputs[index])) {
    throw new FiniteRuleRejected('declared inputs differ from body predicates');
  }
  // A dedicated projection namespace keeps executable output away from owner commands.
  if (!row.outputPredicate.startsWith('https://rezics.com/derived/')
    || !iri.test(row.outputPredicate) || authority.test(row.outputPredicate)
    || IDENTITY_AXIOMS.has(row.outputPredicate)) throw new FiniteRuleRejected('rule output is not a projection');
  const budget = row.budget as Record<string, unknown>;
  const bounded = (key: keyof typeof FINITE_RULE_LIMITS) => Number.isSafeInteger(budget[key])
    && (budget[key] as number) >= 1 && (budget[key] as number) <= FINITE_RULE_LIMITS[key];
  if (Object.keys(budget).some(key => !['rounds', 'inferences', 'inspections'].includes(key))
    || !bounded('rounds') || !bounded('inferences') || !bounded('inspections')) {
    throw new FiniteRuleRejected('rule budget is invalid');
  }
  return { profile: FINITE_RULE_PROFILE, inputPredicates: inputs,
    outputPredicate: row.outputPredicate, body,
    head: { subject: head.subject, object: head.object },
    budget: { rounds: budget.rounds as number, inferences: budget.inferences as number,
      inspections: budget.inspections as number } };
}

function tripleKey(fact: Pick<ReasoningFact, 'subject' | 'predicate' | 'object'>): string {
  return JSON.stringify([fact.subject, fact.predicate, fact.object]);
}

/** Reject a conflicting selected union before any closure or candidate is emitted. */
export function planFiniteRules(selected: readonly SelectedFiniteRule[], facts: readonly FiniteRuleFact[],
  generation: ActiveModelGeneration): FiniteRulePlan {
  if (!selected.length || selected.length > FINITE_RULE_LIMITS.rules || facts.length > FINITE_RULE_LIMITS.facts
    || generation.entailmentProfile !== SEMANTIC_REASONING_PROFILE) throw new FiniteRuleRejected('plan exceeds its profile');
  const rules = selected.map(item => ({ ...item, rule: checkedFiniteRule(item.rule) }));
  if (rules.some(item => !native.test(item.revision) || !native.test(item.contextRevision)
    || !native.test(item.realm) || !item.context || !item.rule)) throw new FiniteRuleRejected('rule selection is invalid');
  const byOutput = new Map<string, SelectedFiniteRule[]>();
  for (const item of rules) byOutput.set(item.rule.outputPredicate,
    [...byOutput.get(item.rule.outputPredicate) ?? [], item]);
  const conflicts = [...byOutput.values()].filter(group =>
    new Set(group.map(item => JSON.stringify(item.rule))).size > 1);
  if (conflicts.length) return { state: 'rejected', reason: 'conflicting-rules',
    conflictingRevisions: values(conflicts.flatMap(group => group.map(item => item.revision))),
    inferences: [], accepted: false, authorizes: false };
  if (facts.some(fact => !iri.test(fact.definition) || !native.test(fact.contextRevision)
    || !native.test(fact.realm) || fact.scope.kind !== 'realm' || fact.scope.id !== fact.realm
    || !rules.some(rule => rule.context === fact.context
      && rule.contextRevision === fact.contextRevision && rule.realm === fact.realm))) {
    throw new FiniteRuleRejected('fact has no selected exact Context or DefinitionRef');
  }
  const derived: DerivedFiniteFact[] = [];
  let inspected = 0;
  let partial = false;
  for (const selectedRule of rules) {
    const { rule, context, contextRevision, realm, revision } = selectedRule;
    const scoped = facts.filter(fact => fact.context === context && fact.contextRevision === contextRevision
      && fact.realm === realm);
    reasonSemanticFacts({ profile: SEMANTIC_REASONING_PROFILE, modelGeneration: generation,
      selectedScopes: [{ kind: 'realm', id: realm }], facts: scoped });
    const known = new Map(scoped.map(fact => [tripleKey(fact), { ...fact,
      inputIds: [fact.id], definitions: [fact.definition] }]));
    const budget = rule.budget;
    let closed = false;
    for (let round = 0; round < budget.rounds; round++) {
      let added = 0;
      const candidates = [...known.values()];
      type Match = { bindings: Map<string, string>; inputIds: string[]; definitions: string[] };
      let matches: Match[] = [{ bindings: new Map(), inputIds: [], definitions: [] }];
      for (const atom of rule.body) {
        const next: Match[] = [];
        for (const match of matches) for (const fact of candidates) {
          if (++inspected > budget.inspections || inspected > FINITE_RULE_LIMITS.inspections) {
            partial = true; break;
          }
          if (fact.predicate !== atom.predicate) continue;
          const bindings = new Map(match.bindings);
          const bind = (term: string, value: string) => {
            if (!variable.test(term)) return term === value;
            const prior = bindings.get(term);
            if (prior && prior !== value) return false;
            bindings.set(term, value);
            return true;
          };
          if (!bind(atom.subject, fact.subject) || !bind(atom.object, fact.object)) continue;
          next.push({ bindings, inputIds: values([...match.inputIds, ...fact.inputIds]),
            definitions: values([...match.definitions, ...fact.definitions]) });
        }
        if (partial) break;
        matches = next;
      }
      if (partial) break;
      for (const match of matches) {
        const subject = match.bindings.get(rule.head.subject) ?? rule.head.subject;
        const object = match.bindings.get(rule.head.object) ?? rule.head.object;
        if (!iri.test(subject) || !iri.test(object)) throw new FiniteRuleRejected('rule produced an invalid IRI');
        const fact = { subject, predicate: rule.outputPredicate, object };
        const key = tripleKey(fact);
        if (known.has(key)) continue;
        if (derived.length >= budget.inferences || derived.length >= FINITE_RULE_LIMITS.inferences) {
          partial = true; break;
        }
        known.set(key, { ...fact, id: key, scope: { kind: 'realm', id: realm }, definition: match.definitions[0]!,
          context, contextRevision, realm, inputIds: match.inputIds, definitions: match.definitions });
        derived.push({ ...fact, context, contextRevision, realm, ruleRevision: revision,
          inputIds: match.inputIds, definitions: match.definitions });
        added++;
      }
      if (partial) break;
      if (!added) { closed = true; break; }
    }
    if (!closed) partial = true;
  }
  return { state: partial ? 'partial' : 'complete', inferences: derived,
    exactCount: partial ? null : derived.length, accepted: false, authorizes: false,
    modelGeneration: generation.generation, inspected };
}
