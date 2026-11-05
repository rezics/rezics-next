import { FILTER_LIMITS } from '@rezics/filter';
import type { RefinementProperty } from './refinement/model';
import type { FacetState } from './refinement/request';
import type { SearchLoaderDeps } from './search-params';

export const RESOURCE_LANGUAGE_PROPERTY = 'schema:inLanguage';
export const RESOURCE_LANGUAGE_PAGE_SIZE = 10;
export const RESOURCE_LANGUAGE_SELECTION_LIMIT = FILTER_LIMITS.in;

/** Match the display-language route contract and return its BCP 47 canonical spelling. */
export function canonicalLanguageTag(value: string): string | undefined {
  if (!value || value.length > 35) return undefined;
  try {
    const canonical = Intl.getCanonicalLocales(value)[0];
    return canonical && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalResourceLanguageValues(values: readonly string[]): string[] {
  const canonical = values.map((value) => canonicalLanguageTag(value) ?? value);
  return [...new Set(canonical)];
}

/** Keep the ordinary facet selection out of its own option population. */
export function withoutResourceLanguageSelection(state: SearchLoaderDeps): SearchLoaderDeps {
  const facets = Object.fromEntries(
    Object.entries(state.facets).filter(([property]) => property !== RESOURCE_LANGUAGE_PROPERTY),
  );
  return { ...state, facets, cursor: undefined };
}

export type ResourceLanguageSelection = {
  value: string;
  canonical: string | undefined;
  present: boolean;
  needsRepair: boolean;
};

export type ResourceLanguageOption = {
  value: string;
  selected: boolean;
  current: boolean;
  needsRepair: boolean;
};

export type ResourceLanguageRefinement = {
  property: typeof RESOURCE_LANGUAGE_PROPERTY;
  applicability: 'applicable' | 'partial' | 'not-applicable' | 'unknown';
  readiness:
    | 'not-applicable'
    | 'not-requested'
    | 'ready'
    | 'preparing'
    | 'unavailable'
    | 'refused'
    | 'withheld'
    | 'invalid'
    | 'restart';
  selected: ResourceLanguageSelection[];
  options: ResourceLanguageOption[];
  asOf?: string;
  actions: {
    select: boolean;
    remove: boolean;
    clear: boolean;
    continue: boolean;
    retry: boolean;
  };
};

/**
 * Join the released property declaration with one bounded count-free facet page and URL selections.
 * Selections outside the current page remain explicit repair/removal entries.
 */
export function resourceLanguageRefinement(
  properties: readonly RefinementProperty[],
  selectedValues: readonly string[],
  state: FacetState | undefined,
  releaseAvailable = true,
  sourceApplicability?: 'all' | 'partial' | 'none' | 'unknown',
): ResourceLanguageRefinement {
  const declared = properties.some(
    (entry) => entry.property === RESOURCE_LANGUAGE_PROPERTY && entry.mode === 'values',
  );
  const applicability =
    sourceApplicability === 'partial'
      ? declared ? 'partial' : 'not-applicable'
      : sourceApplicability === 'all'
        ? declared ? 'applicable' : 'not-applicable'
        : sourceApplicability === 'none'
          ? 'not-applicable'
          : sourceApplicability === 'unknown'
            ? 'unknown'
            : declared
              ? 'applicable'
              : releaseAvailable
                ? 'not-applicable'
                : 'unknown';
  const facet =
    state?.status === 'ready'
      ? state.page.facets.find((entry) => entry.property === RESOURCE_LANGUAGE_PROPERTY)
      : undefined;
  const supported = applicability === 'applicable' || applicability === 'partial';
  const readiness =
    !supported
      ? applicability === 'not-applicable'
        ? 'not-applicable'
        : (state?.status ?? 'unavailable')
      : !state
        ? 'not-requested'
        : state.status === 'ready'
          ? facet
            ? 'ready'
            : 'invalid'
          : state.status;
  const current = facet?.values ?? [];
  const canonicalCurrent = current
    .slice(0, RESOURCE_LANGUAGE_PAGE_SIZE)
    .map((entry) => ({ ...entry, value: canonicalLanguageTag(entry.value) ?? entry.value }));
  const currentValues = new Set(canonicalCurrent.map((entry) => entry.value));
  const selectedInput = [...new Set(canonicalResourceLanguageValues(selectedValues))];
  const selected: ResourceLanguageSelection[] = selectedInput.map((value) => {
    const canonical = canonicalLanguageTag(value);
    return {
      value: canonical ?? value,
      canonical,
      present: currentValues.has(canonical ?? value),
      needsRepair: canonical === undefined,
    };
  });
  const selectedValuesSet = new Set(selected.map((entry) => entry.value));
  const options: ResourceLanguageOption[] = canonicalCurrent.map((entry) => ({
    value: entry.value,
    selected: selectedValuesSet.has(entry.value),
    current: true,
    needsRepair: canonicalLanguageTag(entry.value) === undefined,
  }));
  for (const entry of selected) {
    if (currentValues.has(entry.value)) continue;
    options.push({
      value: entry.value,
      selected: true,
      current: false,
      needsRepair: entry.needsRepair,
    });
  }
  const retry =
    readiness === 'preparing' || readiness === 'unavailable' || readiness === 'invalid' || readiness === 'restart';
  return {
    property: RESOURCE_LANGUAGE_PROPERTY,
    applicability,
    readiness,
    selected,
    options,
    ...(state?.status === 'ready' ? { asOf: state.page.as_of } : {}),
    actions: {
      select: (applicability === 'applicable' || applicability === 'partial') && readiness === 'ready',
      remove: selected.length > 0,
      clear: selected.length > 0,
      continue: (applicability === 'applicable' || applicability === 'partial') && readiness === 'ready' && facet?.next != null,
      retry: applicability !== 'not-applicable' && retry,
    },
  };
}
