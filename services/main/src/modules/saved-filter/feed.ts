import type { FilterCondition, FilterDocument } from '../../../../../model/definitions/filter-document-v1.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { ControlInvalid } from '../access/topology-control.ts';
import type { FeedQuery } from '../feed/contract.ts';
import { resolveFacet } from '../facets/registry.ts';
import { checkedFilter, InvalidFilter } from '../facets/schema.ts';
import { QueryRejected } from '../query/compile.ts';
import { interpretationForConcept } from '../query/concept.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { SavedFilterStore } from './store.ts';

/**
 * What Home's feed executes in full for a pinned filter: posts about Works
 * carrying any of at most three Concepts, or a match-any Concept page (that
 * page's Concept, any of its additions, and none of its exclusions) inside
 * the same bound, in any of the chosen content languages, from any of the
 * chosen communities. Each Concept resolves to its one active interpretation
 * as the Query does, at most three graph reads.
 */
export const HOME_FILTER_COST = { concepts: 3, languages: 8, realms: 8, graphReads: 3 } as const;

export interface HomeFilterConditions {
  /** Additions, or the only Concept list when the filter is not an anchored page. Matched as any. */
  concepts: string[];
  languages: string[];
  realms: string[];
  /** The page Concept a match-any filter requires beside any of `concepts`. */
  requiredConcept?: string;
  /** Concepts a match-any filter excludes. */
  excludedConcepts?: string[];
}

const fail = (message: string): never => { throw new QueryRejected('unsupported_query_shape', message); };
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

function values(condition: FilterCondition, facet: string, limit: number, supplied?: FilterCondition['any']): string[] {
  const chosen = supplied ?? condition.any ?? (condition.all?.length === 1 ? condition.all : undefined);
  if (!chosen || condition.range || condition.bind || condition.interpretation || condition.applicability
    || condition.where) fail(`${facet} has no Home feed template for this operator`);
  if (chosen!.some(value => typeof value !== 'string' || facet !== 'language' && !nativeId.test(value))) {
    fail(`${facet} needs native REZICS values in Home`);
  }
  if (chosen!.length > limit) throw new QueryRejected('query_budget_exceeded', `${facet} exceeds the Home feed's ${limit} values`);
  return chosen as string[];
}

type ConceptClause = { operator: 'any' | 'all' | 'none'; values: string[] };

function conceptClause(condition: FilterCondition): ConceptClause {
  const present = (['any', 'all', 'none'] as const).filter(operator => condition[operator] !== undefined);
  if (present.length !== 1) fail('concept has no Home feed template for this operator');
  const operator = present[0]!;
  return { operator, values: values(condition, 'concept', HOME_FILTER_COST.concepts, condition[operator]) };
}

/**
 * One Concept Condition is any of its values, or all of exactly one. A
 * match-any Concept page is the page Concept, any of the additions, and
 * optionally one exclusion, still inside the three-Concept bound.
 */
function homeConcepts(clauses: ConceptClause[]): Pick<HomeFilterConditions, 'concepts' | 'requiredConcept' | 'excludedConcepts'> {
  if (clauses.length <= 1) {
    const only = clauses[0];
    if (only && (only.operator === 'none' || only.operator === 'all' && only.values.length !== 1)) {
      fail('concept has no Home feed template for this operator');
    }
    return { concepts: only?.values ?? [] };
  }
  const anchors = clauses.filter(clause => clause.operator === 'all' && clause.values.length === 1);
  const additions = clauses.filter(clause => clause.operator === 'any');
  const excluded = clauses.filter(clause => clause.operator === 'none');
  if (anchors.length + additions.length + excluded.length !== clauses.length
    || anchors.length !== 1 || additions.length !== 1 || excluded.length > 1) {
    fail('Several concept Conditions have no Home feed template');
  }
  const requiredConcept = anchors[0]!.values[0]!;
  const concepts = additions[0]!.values;
  const excludedConcepts = excluded[0]?.values ?? [];
  const every = [requiredConcept, ...concepts, ...excludedConcepts];
  if (new Set(every).size !== every.length) fail('Several concept Conditions have no Home feed template');
  if (every.length > HOME_FILTER_COST.concepts) {
    throw new QueryRejected('query_budget_exceeded', `concept exceeds the Home feed's ${HOME_FILTER_COST.concepts} values`);
  }
  return { concepts, requiredConcept, ...(excludedConcepts.length ? { excludedConcepts } : {}) };
}

/**
 * The Home feed template: a conjunction of Concept, language and community
 * Conditions. Concept is one any-list, or a match-any Concept page. Any other
 * shape is a typed refusal before a read, never an empty feed.
 */
export function homeFeedConditions(document: FilterDocument): HomeFilterConditions {
  try { checkedFilter(document); }
  catch (error) {
    if (error instanceof InvalidFilter) throw new QueryRejected('invalid_query', `${error.refusal}: ${error.message}`);
    throw error;
  }
  if (!('all' in document)) fail('Home has no template for a top-level any');
  const clauses: ConceptClause[] = [];
  const found: { languages?: string[]; realms?: string[] } = {};
  for (const node of (document as { all: FilterDocument[] }).all as unknown[]) {
    if (!node || typeof node !== 'object' || !('facet' in node)) fail('Home has no template for nested groups');
    const condition = node as FilterCondition;
    const facet = resolveFacet(condition.facet)!;
    if (facet.name === 'concept') { clauses.push(conceptClause(condition)); continue; }
    const slot = facet.name === 'language' ? 'languages' : facet.name === 'realm' ? 'realms'
      : fail(`${facet.name} has no Home feed template`);
    if (found[slot]) fail(`Several ${facet.name} Conditions have no Home feed template`);
    found[slot] = values(condition, facet.name, HOME_FILTER_COST[slot]);
  }
  return { ...homeConcepts(clauses), languages: found.languages ?? [], realms: found.realms ?? [] };
}

/** Whether Home can show a stored document's posts. */
export function homeAvailable(document: FilterDocument): boolean {
  try { homeFeedConditions(document); return true; }
  catch (error) { if (error instanceof QueryRejected) return false; throw error; }
}

/**
 * `GET /v1/feed?savedFilter=`: the reader's own filter, compiled onto the
 * feed's Conditions. The tab reads All; the filter carries every Condition, so
 * the request names none of its own.
 */
export async function savedFilterFeedQuery(env: WorkActivationEnvironment, store: SavedFilterStore | undefined,
  principal: VerifiedPrincipal | null, query: FeedQuery, id: string): Promise<FeedQuery> {
  if (!store) throw new ControlInvalid('Saved Filters are unavailable');
  if (!principal || !query.actingSubject) throw new ControlInvalid('A Saved Filter is read by its reader');
  if (query.scope !== 'all') throw new ControlInvalid('A Saved Filter tab reads All');
  if (query.concepts || query.requiredConcept || query.excludedConcepts || query.contentLanguages || query.realms
    || query.kinds || query.interests) {
    throw new ControlInvalid('A Saved Filter carries its own Conditions');
  }
  const saved = await store.read(principal, query.actingSubject, id);
  const conditions = homeFeedConditions(saved.document);
  const sense = async (concept: string) => (await interpretationForConcept(env, { value: concept })).sense;
  const senses: string[] = [];
  for (const concept of conditions.concepts) senses.push(await sense(concept));
  const required = conditions.requiredConcept ? await sense(conditions.requiredConcept) : undefined;
  const excluded: string[] = [];
  for (const concept of conditions.excludedConcepts ?? []) excluded.push(await sense(concept));
  return { ...query, ...(senses.length ? { concepts: senses } : {}),
    ...(required ? { requiredConcept: required } : {}),
    ...(excluded.length ? { excludedConcepts: excluded } : {}),
    ...(conditions.languages.length ? { contentLanguages: conditions.languages } : {}),
    ...(conditions.realms.length ? { realms: conditions.realms } : {}) };
}
