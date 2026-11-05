export type RangeDraft = {
  lower: string;
  upper: string;
  unit: string;
  invalid: boolean;
};

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
