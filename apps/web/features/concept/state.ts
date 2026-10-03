import { resourceHref, type AddressTarget } from '../address/path.ts';
import { idOf, iriOf, isUuid, type SearchParams, single, withQuery } from '../discover/scope.ts';
import type { ResourceQuery } from '../../../../model/definitions/filter-document-v1.ts';

// `/concepts/{id}?scope&realm&include&exclude&match`: a Concept page and its
// Condition bar as the URL gives them. Pure functions shared by the route, its
// components and tests.

/** Whose accepted values the page lists: everyone's, or one public community's. */
export type ConceptScope = { kind: 'global' } | { kind: 'realm'; realm: string };

export interface ConceptState {
  /** The page's Concept, a UUID; always the first included value. */
  concept: string;
  /** Main's canonical form, retained while conditions change. */
  address?: AddressTarget;
  scope: ConceptScope;
  /** More Concepts, as UUIDs in the order they were added. */
  include: string[];
  exclude: string[];
  /** Whether added Concepts must all be carried, or any of them, beside this page's Concept. */
  match: 'all' | 'any';
}

/** Values per operator when Main's Concept Facet cannot be read; Main still refuses more. */
export const DEFAULT_MAX_VALUES = 8;

const list = (raw: string | undefined) => raw === undefined || raw === '' ? [] : raw.split(',');

/**
 * The page's state, or null when a value is malformed, repeated, both included
 * and excluded, or more than the Concept Facet admits (`maxValues` per
 * operator, the page's Concept counting as included): a filtered view never
 * silently widens.
 */
export function parseConceptState(concept: string, params: SearchParams,
  maxValues = DEFAULT_MAX_VALUES): ConceptState | null {
  if (!isUuid(concept)) return null;
  if ([params.scope, params.realm, params.include, params.exclude, params.match].some(Array.isArray)) return null;
  const scope = single(params.scope), realm = single(params.realm), match = single(params.match) ?? 'all';
  const parsedScope: ConceptScope | null = (scope === undefined || scope === 'global') && realm === undefined
    ? { kind: 'global' } : scope === 'realm' && isUuid(realm) ? { kind: 'realm', realm } : null;
  const include = list(single(params.include)), exclude = list(single(params.exclude));
  const values = [concept, ...include, ...exclude];
  if (!parsedScope || (match !== 'all' && match !== 'any') || !values.every(isUuid)
    || new Set(values).size !== values.length || include.length + 1 > maxValues || exclude.length > maxValues) {
    return null;
  }
  return { concept, scope: parsedScope, include, exclude, match };
}

/** The page for a state; defaults (everyone, no more values, all) add nothing. */
export function conceptHref(state: ConceptState): string {
  return withQuery(resourceHref('/concepts/', state.address ?? state.concept), {
    ...(state.scope.kind === 'realm' ? { scope: 'realm', realm: state.scope.realm } : {}),
    include: state.include.join(','), exclude: state.exclude.join(','),
    match: state.include.length && state.match === 'any' ? 'any' : null });
}

/** A Concept's page, from its IRI or UUID, in a scope. */
export function conceptPath(concept: string, scope: ConceptScope = { kind: 'global' }): string {
  return conceptHref({ concept: idOf(concept) ?? concept, scope, include: [], exclude: [], match: 'all' });
}

/** The state with `value` included or excluded, and taken out of the other operator. */
export function withValue(state: ConceptState, value: string, operator: 'include' | 'exclude'): ConceptState {
  const rest = withoutValue(state, value);
  return operator === 'include' ? { ...rest, include: [...rest.include, value] }
    : { ...rest, exclude: [...rest.exclude, value] };
}

export function withoutValue(state: ConceptState, value: string): ConceptState {
  return { ...state, include: state.include.filter(item => item !== value),
    exclude: state.exclude.filter(item => item !== value) };
}

/** Whether another value may be added under `operator`. */
export function hasRoom(state: ConceptState, operator: 'include' | 'exclude', maxValues = DEFAULT_MAX_VALUES) {
  return operator === 'include' ? state.include.length + 1 < maxValues : state.exclude.length < maxValues;
}

/**
 * Main's Query for the Concept page's Conditions and newest Works. The page
 * Concept stays required. Match any is that Concept, then any of the additions.
 */
export function conceptQuery(state: ConceptState, cursor?: string): ResourceQuery {
  const concept = iriOf(state.concept);
  const included = state.match === 'any' && state.include.length
    ? [{ facet: 'concept', all: [concept] }, { facet: 'concept', any: state.include.map(iriOf) }]
    : [{ facet: 'concept', all: [concept, ...state.include.map(iriOf)] }];
  const filter: NonNullable<ResourceQuery['filter']> = { all: [
    ...included,
    ...(state.exclude.length ? [{ facet: 'concept', none: state.exclude.map(iriOf) }] : []),
  ] };
  return { context: state.scope.kind === 'realm' ? { realm: iriOf(state.scope.realm) } : 'global',
    scope: { kind: 'all' }, filter, sort: 'newest', page: { size: 20,
      ...(cursor ? { continuation: cursor } : {}) } };
}
