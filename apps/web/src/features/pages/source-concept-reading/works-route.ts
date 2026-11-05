import type { ConceptWorksRoutePatch, ConceptWorksRouteState } from '../../catalogue/concept-works/view';
import {
  conceptVisitPosition,
  encodeConceptHierarchyAddress,
  type ConceptVisitDescriptor,
} from './navigation';

/** URL selections override the saved visit; an absent selection resumes the original operand. */
export function conceptWorksRouteFor(
  route: ConceptWorksRouteState,
  visit: ConceptVisitDescriptor | undefined,
): ConceptWorksRouteState {
  const saved = visit?.works;
  return {
    ...route,
    property: route.property ?? saved?.property,
    scheme: route.scheme ?? saved?.scheme,
    type: route.type ?? saved?.type,
    sort: route.sort ?? saved?.sort,
    includeChildren: route.includeChildren ?? saved?.includeChildren,
    spoilerThreshold: route.spoilerThreshold ?? saved?.spoilerThreshold,
    conditionText: route.conditionText ?? saved?.conditionText,
    tagQualifiersText: route.tagQualifiersText ?? saved?.tagQualifiersText,
  };
}

/** Materialize one complete selection before retiring saved works, so cleared controls stay cleared. */
export function patchConceptWorksSearch<Search extends Record<string, unknown>>(
  previous: Search & ConceptWorksRouteState,
  patch: ConceptWorksRoutePatch,
  visit: ConceptVisitDescriptor | undefined,
): Search {
  const next: Record<string, unknown> = { ...previous };
  const route = conceptWorksRouteFor(previous, visit);
  for (const key of [
    'conditionText',
    'tagQualifiersText',
    'includeChildren',
    'spoilerThreshold',
    'invalid',
    'pinUnsupported',
    'conceptVisitDescriptor',
    'hierarchyAddress',
    'invalidConceptVisit',
    'invalidHierarchy',
  ])
    delete next[key];

  // The hierarchy receipt and exact page survive editing, independently of the old works selection.
  if (visit) delete next.conceptVisit;
  if (visit && !next.hierarchy) next.hierarchy = encodeConceptHierarchyAddress(conceptVisitPosition(visit));
  if (visit?.role && !next.role) next.role = visit.role;
  const set = (key: string, value: string | undefined) => {
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
  };
  for (const key of ['property', 'scheme', 'type', 'sort'] as const)
    set(key, key in patch ? patch[key] : route[key]);
  const children = 'includeChildren' in patch ? patch.includeChildren : route.includeChildren;
  const spoiler = 'spoilerThreshold' in patch ? patch.spoilerThreshold : route.spoilerThreshold;
  set('children', children ? 'true' : undefined);
  set('spoiler', spoiler ? String(spoiler) : undefined);
  set('condition', 'condition' in patch ? (patch.condition ? JSON.stringify(patch.condition) : undefined) : route.conditionText);
  set('tagQualifiers', 'tagQualifiersText' in patch ? patch.tagQualifiersText : route.tagQualifiersText);
  if ('cursor' in patch) set('cursor', patch.cursor);
  return next as Search;
}
