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
 * carrying any of at most three Concepts (the feed's own Concept bound), in
 * any of the chosen content languages, from any of the chosen communities.
 * Each Concept resolves to its one active interpretation as the Query does,
 * at most three graph reads.
 */
export const HOME_FILTER_COST = { concepts: 3, languages: 8, realms: 8, graphReads: 3 } as const;

export interface HomeFilterConditions { concepts: string[]; languages: string[]; realms: string[] }

const fail = (message: string): never => { throw new QueryRejected('unsupported_query_shape', message); };
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

function values(condition: FilterCondition, facet: string, limit: number): string[] {
  const chosen = condition.any ?? (condition.all?.length === 1 ? condition.all : undefined);
  if (!chosen || condition.range || condition.bind || condition.interpretation || condition.applicability
    || condition.where) fail(`${facet} has no Home feed template for this operator`);
  if (chosen!.some(value => typeof value !== 'string' || facet !== 'language' && !nativeId.test(value))) {
    fail(`${facet} needs native REZICS values in Home`);
  }
  if (chosen!.length > limit) throw new QueryRejected('query_budget_exceeded', `${facet} exceeds the Home feed's ${limit} values`);
  return chosen as string[];
}

/**
 * The Home feed template: a conjunction of one Concept, one language and one
 * community Condition, each matching any of its values. Any other shape is a
 * typed refusal before a read, never an empty feed.
 */
export function homeFeedConditions(document: FilterDocument): HomeFilterConditions {
  try { checkedFilter(document); }
  catch (error) {
    if (error instanceof InvalidFilter) throw new QueryRejected('invalid_query', `${error.refusal}: ${error.message}`);
    throw error;
  }
  if (!('all' in document)) fail('Home has no template for a top-level any');
  const found: Partial<HomeFilterConditions> = {};
  for (const node of (document as { all: FilterDocument[] }).all as unknown[]) {
    if (!node || typeof node !== 'object' || !('facet' in node)) fail('Home has no template for nested groups');
    const condition = node as FilterCondition;
    const facet = resolveFacet(condition.facet)!;
    const slot = facet.name === 'concept' ? 'concepts' : facet.name === 'language' ? 'languages'
      : facet.name === 'realm' ? 'realms' : fail(`${facet.name} has no Home feed template`);
    if (found[slot]) fail(`Several ${facet.name} Conditions have no Home feed template`);
    found[slot] = values(condition, facet.name, HOME_FILTER_COST[slot]);
  }
  return { concepts: found.concepts ?? [], languages: found.languages ?? [], realms: found.realms ?? [] };
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
  if (query.concepts || query.contentLanguages || query.realms || query.kinds || query.interests) {
    throw new ControlInvalid('A Saved Filter carries its own Conditions');
  }
  const saved = await store.read(principal, query.actingSubject, id);
  const conditions = homeFeedConditions(saved.document);
  const senses: string[] = [];
  for (const concept of conditions.concepts) senses.push((await interpretationForConcept(env, { value: concept })).sense);
  return { ...query, ...(senses.length ? { concepts: senses } : {}),
    ...(conditions.languages.length ? { contentLanguages: conditions.languages } : {}),
    ...(conditions.realms.length ? { realms: conditions.realms } : {}) };
}
