import { type AdmittedFacet, resolveFacet } from './registry.ts';

// Conditions and Filters over admitted Facets (docs/contracts/queries.md). This is the
// admission check a Query runs before any template: shape, Facet placement and
// operator/value applicability. Graph facts such as a value's class, a role's relation
// or a rating Context's policies remain the template owner's reads.

/** A Resource IRI, a literal's lexical form, or a source identity without a native IRI. */
export type FacetValue = string | { provider: string; namespace: string; key: string };

export interface Condition {
  /** A Facet name, read as its current version, or an exact Facet DefinitionRef. */
  facet: string;
  any?: FacetValue[];
  all?: FacetValue[];
  none?: FacetValue[];
  /** Inclusive lexical bounds. */
  range?: { min?: string; max?: string };
  /** The Facet's parameters, such as a rating Context or a relation revision and role. */
  bind?: Record<string, string>;
  /** An exact interpretation DefinitionRef, or an explicit Context and its semantic revision. */
  interpretation?: { definition: string } | { context: string; semanticRevision: string };
  /** Exact release, canon and valid-time references; none means unqualified. */
  applicability?: string[];
  /** Conditions bound to one occurrence/co-participant, or one declared related node. */
  where?: FilterGroup;
}

export type FilterGroup = { all: FilterNode[] } | { any: FilterNode[] };
export type FilterNode = Condition | FilterGroup;

export const FILTER_LIMITS = { nodes: 32, depth: 4, applicability: 8, externalKey: 200 } as const;

export type FilterRefusal = 'invalid_filter' | 'unknown_facet' | 'misplaced_facet' | 'operator_not_admitted'
  | 'invalid_value' | 'invalid_binding' | 'qualifier_not_admitted' | 'filter_too_large';

/** A typed refusal: a Filter the Facets cannot express is never read as an empty result. */
export class InvalidFilter extends Error {
  constructor(readonly refusal: FilterRefusal, message: string) { super(message); }
}

type Domain = AdmittedFacet['values'][number];
const iri = /^(?:https?:\/\/|urn:)[^\s<>"{}|\\^`]{1,2040}$/u;
const decimal = /^-?\d+(?:\.\d+)?$/u;
const numeric = new Set(['http://www.w3.org/2001/XMLSchema#decimal', 'http://www.w3.org/2001/XMLSchema#integer']);
const operators = ['any', 'all', 'none', 'range'] as const;
const conditionKeys = new Set(['facet', ...operators, 'bind', 'interpretation', 'applicability', 'where']);
const patterns = new Map<string, RegExp>();
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function lexical(domain: Extract<Domain, { kind: 'datatype' }>, value: string): boolean {
  if (domain.pattern !== undefined) {
    const pattern = patterns.get(domain.pattern) ?? new RegExp(domain.pattern, 'u');
    patterns.set(domain.pattern, pattern);
    if (!pattern.test(value)) return false;
  }
  if (!numeric.has(domain.datatype)) return value.length > 0 && value.length <= 2048;
  return decimal.test(value) && (!domain.datatype.endsWith('#integer') || !value.includes('.'))
    && (domain.min === undefined || Number(value) >= Number(domain.min))
    && (domain.max === undefined || Number(value) <= Number(domain.max));
}

function matches(domain: Domain, value: unknown): boolean {
  if (domain.kind === 'external') {
    return record(value) && Object.keys(value).sort().join() === 'key,namespace,provider'
      && value.provider === domain.provider && value.namespace === domain.namespace
      && typeof value.key === 'string' && value.key.length > 0 && value.key.length <= FILTER_LIMITS.externalKey;
  }
  if (typeof value !== 'string') return false;
  return domain.kind === 'datatype' ? lexical(domain, value) : iri.test(value);
}

function refuse(refusal: FilterRefusal, message: string): never {
  throw new InvalidFilter(refusal, message);
}

function checkValues(facet: AdmittedFacet, operator: string, values: unknown): void {
  if (operator === 'range') {
    if (!record(values) || !Object.keys(values).length || Object.keys(values).some(key => key !== 'min' && key !== 'max')
      || Object.values(values).some(bound => !facet.values.some(domain => matches(domain, bound)))
      || (values.min !== undefined && values.max !== undefined && Number(values.min) > Number(values.max))) {
      refuse('invalid_value', `${facet.name} range is invalid`);
    }
    return;
  }
  if (!Array.isArray(values) || !values.length || values.length > facet.cost.maxValues
    || new Set(values.map(value => JSON.stringify(value))).size !== values.length) {
    refuse('invalid_value', `${facet.name} needs 1 to ${facet.cost.maxValues} distinct values`);
  }
  for (const value of values) {
    if (!facet.values.some(domain => matches(domain, value))) refuse('invalid_value', `${facet.name} value is outside its domain`);
  }
}

function checkQualifiers(facet: AdmittedFacet, condition: Record<string, unknown>): void {
  const { bind = {}, interpretation, applicability } = condition;
  const keys = facet.parameters.map(parameter => parameter.key);
  if (!record(bind) || Object.keys(bind).sort().join() !== [...keys].sort().join()
    || facet.parameters.some(parameter => !matches(parameter.value, bind[parameter.key]))) {
    refuse('invalid_binding', `${facet.name} binds exactly ${keys.join(', ') || 'nothing'}`);
  }
  if (interpretation !== undefined) {
    if (!facet.qualifiers.includes('interpretation')) refuse('qualifier_not_admitted', `${facet.name} has no interpretation`);
    const shape = record(interpretation) ? Object.keys(interpretation).sort().join() : '';
    if ((shape !== 'definition' && shape !== 'context,semanticRevision')
      || Object.values(interpretation as object).some(value => typeof value !== 'string' || !iri.test(value))) {
      refuse('invalid_value', `${facet.name} interpretation is invalid`);
    }
  }
  if (applicability !== undefined) {
    if (!facet.qualifiers.includes('applicability')) refuse('qualifier_not_admitted', `${facet.name} has no applicability`);
    if (!Array.isArray(applicability) || applicability.length > FILTER_LIMITS.applicability
      || new Set(applicability).size !== applicability.length
      || applicability.some(value => typeof value !== 'string' || !iri.test(value))) {
      refuse('invalid_value', `${facet.name} applicability is invalid`);
    }
  }
}

/**
 * Admit a Filter before execution. Top-level Conditions describe the queried Resource; an
 * grouping Facet's `where` describes its one co-participant/role or its declared related node.
 * Returns the exact DefinitionRefs used, which a Saved Filter retains.
 * Cost: O(nodes) with nodes ≤ 32 and no graph read.
 */
export function checkedFilter(filter: FilterGroup): string[] {
  const used = new Set<string>();
  let nodes = 0;
  const group = (node: unknown, depth: number, occurrence: { facet: AdmittedFacet; conditions: number } | null) => {
    const keys = record(node) ? Object.keys(node) : [];
    const members = keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')
      ? (node as Record<string, unknown>)[keys[0]] : null;
    if (!Array.isArray(members) || !members.length) refuse('invalid_filter', 'A group needs all or any Conditions');
    if (depth > FILTER_LIMITS.depth) refuse('filter_too_large', 'Filter nests too deeply');
    for (const member of members) {
      if (++nodes > FILTER_LIMITS.nodes) refuse('filter_too_large', 'Filter has too many nodes');
      if (record(member) && 'facet' in member) condition(member, depth, occurrence);
      else group(member, depth + 1, occurrence);
    }
  };
  const condition = (node: Record<string, unknown>, depth: number,
    occurrence: { facet: AdmittedFacet; conditions: number } | null) => {
    if (Object.keys(node).some(key => !conditionKeys.has(key)) || typeof node.facet !== 'string') {
      refuse('invalid_filter', 'Condition has unknown fields');
    }
    const facet = resolveFacet(node.facet) ?? refuse('unknown_facet', `No admitted Facet ${node.facet}`);
    if (occurrence ? facet.appliesTo === 'resource' : facet.appliesTo !== 'resource') {
      refuse('misplaced_facet', `${facet.name} ${occurrence ? 'cannot describe a co-participant' : 'needs an occurrence'}`);
    }
    const related = occurrence?.facet.path.at(-1);
    if (facet.within && facet.within !== occurrence?.facet.id
      || related?.kind === 'related' && (facet.within !== occurrence!.facet.id
        || !related.types.includes(facet.subject))) {
      refuse('misplaced_facet', `${facet.name} needs its declared related-node group`);
    }
    if (occurrence && ++occurrence.conditions > occurrence.facet.cost.nested!) {
      refuse('filter_too_large', `${occurrence.facet.name} groups too many Conditions`);
    }
    const present = operators.filter(operator => node[operator] !== undefined);
    if (node.where !== undefined && !facet.occurrence) refuse('misplaced_facet', `${facet.name} binds no occurrence`);
    if (present.length > 1 || (!present.length && node.where === undefined)) {
      refuse('invalid_filter', `${facet.name} Condition needs exactly one operator`);
    }
    for (const operator of present) {
      if (!(facet.operators as readonly string[]).includes(operator)) {
        refuse('operator_not_admitted', `${facet.name} does not admit ${operator}`);
      }
      checkValues(facet, operator, node[operator]);
    }
    checkQualifiers(facet, node);
    used.add(facet.id);
    if (node.where !== undefined) group(node.where, depth + 1, { facet, conditions: 0 });
  };
  group(filter, 1, null);
  return [...used].sort();
}
