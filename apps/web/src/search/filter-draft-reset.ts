import type { FilterDocument } from '@rezics/filter';
import type { SearchResourceScope } from './advanced-scope';

export type FilterScopeDraft = { kind: SearchResourceScope['kind'] | ''; id: string };

export type FilterDraftBaseline = {
  condition?: FilterDocument | undefined;
  languages?: string[] | undefined;
  type?: string | undefined;
  kinds?: string[] | undefined;
  facets?: Record<string, string[]> | undefined;
  scope?: FilterScopeDraft | undefined;
};

export type FilterDraftState = FilterDraftBaseline & {
  key: string;
  attempted: boolean;
};

export function createFilterDraft(key: string, baseline: FilterDraftBaseline): FilterDraftState {
  return { ...baseline, key, condition: baseline.condition, languages: baseline.languages, attempted: false };
}

export function resetFilterDraft(
  draft: FilterDraftState,
  expectedKey: string,
  currentKey: string,
  baseline: FilterDraftBaseline,
): FilterDraftState {
  if (expectedKey !== currentKey || draft.key !== expectedKey) return draft;
  return createFilterDraft(expectedKey, baseline);
}
