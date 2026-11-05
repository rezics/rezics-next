import type { FilterDocument } from '@rezics/filter';

export type FilterDraftBaseline = {
  condition?: FilterDocument | undefined;
  languages?: string[] | undefined;
};

export type FilterDraftState = FilterDraftBaseline & {
  key: string;
  attempted: boolean;
};

export function createFilterDraft(key: string, baseline: FilterDraftBaseline): FilterDraftState {
  return { key, condition: baseline.condition, languages: baseline.languages, attempted: false };
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
