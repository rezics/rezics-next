import type { FilterRange } from '@rezics/filter';
import type { RefinementProperty } from './model';

export type RangeDraft = {
  lower: string;
  upper: string;
  unit: string;
  invalid: boolean;
  removed?: boolean;
};

/** The parent Apply and standalone range action use the same numeric and exact-unit admission. */
export function rangeFromDraft(
  draft: RangeDraft,
  definition: Pick<RefinementProperty, 'datatype' | 'units'>,
): FilterRange | undefined {
  const time = definition.datatype === 'time';
  const gte = draft.lower === '' ? undefined : Number(draft.lower);
  const lte = draft.upper === '' ? undefined : Number(draft.upper);
  if (
    (gte === undefined && lte === undefined) ||
    [gte, lte].some(
      (value) => value !== undefined && (!Number.isFinite(value) || (time && !Number.isSafeInteger(value))),
    ) ||
    (gte !== undefined && lte !== undefined && gte > lte) ||
    (!time && (!draft.unit || !definition.units.includes(draft.unit)))
  )
    return undefined;
  return {
    ...(gte !== undefined ? { gte } : {}),
    ...(lte !== undefined ? { lte } : {}),
    ...(!time ? { unit: draft.unit } : {}),
  };
}

export type RangeDraftState = {
  key: string;
  properties: Record<string, RangeDraft>;
};

export function createRangeDraftState(key: string): RangeDraftState {
  return { key, properties: {} };
}

export function getRangeDraft(
  state: RangeDraftState,
  key: string,
  property: string,
  committed: RangeDraft,
): RangeDraft {
  return state.key === key ? (state.properties[property] ?? committed) : committed;
}

export function updateRangeDraft(
  state: RangeDraftState,
  key: string,
  property: string,
  draft: RangeDraft,
): RangeDraftState {
  if (state.key !== key) return state;
  return { ...state, properties: { ...state.properties, [property]: draft } };
}
