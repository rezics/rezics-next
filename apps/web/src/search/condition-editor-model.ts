import {
  createFilterConstruction,
  FilterError,
  parseFilter,
  type FilterAdmissionOptions,
  type FilterDocument,
  type FilterRelease,
} from '@rezics/filter';
import { discoveryRequest } from './search-request';
import type { SearchLoaderDeps } from './search-params';
import { facetProblem } from './refinement/request';

export type ConditionMetadata = Omit<FilterRelease, 'filters'> & {
  types: Record<string, FilterRelease['types'][string] & { labels?: Record<string, string> }>;
  properties: Record<string, FilterRelease['properties'][string] & { labels?: Record<string, string> }>;
  filters?: Record<string, { filter: FilterDocument }>;
};
export type ConditionIssue = { pointer: string; code: string };
export type SearchProblem = NonNullable<ReturnType<typeof facetProblem>>;
export const CONDITION_POINTER = '/filter/and/0';

/** Distinguish colliding display labels within one selector, preserving native values and metadata order. */
export function conditionChoiceLabels(choices: readonly { value: string; label: string }[]) {
  const counts = new Map<string, number>();
  for (const { value, label } of choices) {
    const text = label || value;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return choices.map(({ value, label }) => ({
    value,
    label: label && counts.get(label)! > 1 ? `${label} (${value})` : label || value,
  }));
}

/** Only released public grammar metadata crosses the BFF; no Library profiles or owner fields. */
export function conditionMetadata(
  release: FilterRelease & Pick<ConditionMetadata, 'types' | 'properties'>,
): ConditionMetadata {
  const filters: NonNullable<ConditionMetadata['filters']> = {};
  for (const [id, definition] of Object.entries(release.filters ?? {})) {
    try {
      filters[id] = { filter: parseFilter(definition.filter) };
    } catch {
      // A malformed released reference stays unsupported; it never becomes an empty filter.
    }
  }
  return {
    types: Object.fromEntries(
      Object.entries(release.types).map(([id, definition]) => [
        id,
        {
          labels: definition.labels ?? {},
          bases: definition.bases ?? [],
          facets: definition.facets ?? [],
        },
      ]),
    ),
    properties: Object.fromEntries(
      Object.entries(release.properties).map(([id, definition]) => [
        id,
        {
          labels: definition.labels ?? {},
          datatype: definition.datatype,
          ...(definition.relation ? { relation: { group: definition.relation.group } } : {}),
          ...(definition.qualifiers ? { qualifiers: definition.qualifiers } : {}),
          ...(definition.units ? { units: definition.units } : {}),
          ...(definition.value ? { value: definition.value } : {}),
        },
      ]),
    ),
    ...(release.filters ? { filters } : {}),
  };
}

/** Apply released-filter expansion and grammar limits to the complete edited tree. */
export function conditionTreeAdmission(metadata: ConditionMetadata, options?: FilterAdmissionOptions) {
  const construction = createFilterConstruction(metadata);
  return (condition: FilterDocument): boolean =>
    construction.validateFilter({ and: [condition] }, options).length === 0;
}

/** Retain the authored tree, rather than persisting saved-filter expansion or interpreting Boolean truth. */
export function conditionAdmission(metadata: ConditionMetadata) {
  const construction = createFilterConstruction(metadata);
  return (condition: FilterDocument | undefined, state: SearchLoaderDeps): ConditionIssue[] => {
    if (condition) {
      // The request has the same outer AND even when this is its only condition.
      const errors = construction.validateFilter({ and: [condition] });
      if (errors.length) return errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code }));
    }
    try {
      const request = discoveryRequest({ ...state, condition }, []);
      if (request.filter) parseFilter(request.filter);
    } catch (error) {
      if (error instanceof FilterError) {
        // Kind/resource request operands have native admission. Never erase or rewrite them to pass this parser.
        if (error.errors.some(({ code }) => code === 'unknown_field')) return [];
        return error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code }));
      }
      // An existing opaque filter must still reach native admission unchanged.
    }
    return [];
  };
}

/** Every form edit resets hit continuation while retaining all other current URL predicates. */
export function conditionSearchState(
  state: SearchLoaderDeps,
  condition: FilterDocument | undefined,
  languages = state.languages,
): SearchLoaderDeps {
  return { ...state, condition, languages: languages?.length ? languages : undefined, cursor: undefined };
}

/** JSON Pointer ancestry, including a root group error, without matching sibling indices by prefix. */
export function conditionFieldIssues(issues: readonly ConditionIssue[], pointer: string): ConditionIssue[] {
  return issues.filter(
    (issue) =>
      issue.pointer === pointer || issue.pointer.startsWith(`${pointer}/`) || pointer.startsWith(`${issue.pointer}/`),
  );
}
