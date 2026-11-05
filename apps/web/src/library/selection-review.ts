export type SelectionReviewIdentity = Readonly<{
  subjectId: string;
  revision: number;
  incarnationId?: string | null;
  changeKey: string;
  removeKey: string;
  state?: string | null;
}>;

export function selectionReviewSignature(entries: readonly SelectionReviewIdentity[]): string {
  return JSON.stringify(
    entries.map(({ subjectId, revision, incarnationId, changeKey, removeKey, state }) => [
      subjectId,
      revision,
      incarnationId ?? null,
      changeKey,
      removeKey,
      state ?? null,
    ]),
  );
}

export function appendSelectionWithinLimit(
  selected: readonly string[],
  subjectId: string,
  limit: number,
): Readonly<{ selected: readonly string[]; overflow: boolean }> {
  if (selected.includes(subjectId)) return { selected, overflow: false };
  if (selected.length >= limit) return { selected, overflow: true };
  return { selected: [...selected, subjectId], overflow: false };
}

export type SelectionResultState =
  | 'applied'
  | 'no_effect'
  | 'conflict'
  | 'denied'
  | 'cancelled'
  | 'failed'
  | 'pending'
  | 'uncertain';

export type SelectionResultItem = Readonly<{
  key: string;
  subjectId: string;
  title: string;
  state: SelectionResultState;
  detail?: string;
  source?: 'bulk-status' | 'bulk-removal' | 'entry-state' | 'label';
  sourceState?: string;
}>;

export const selectionResultStates: readonly SelectionResultState[] = [
  'applied',
  'no_effect',
  'conflict',
  'denied',
  'cancelled',
  'failed',
  'pending',
  'uncertain',
];

export function selectionResultState(value: string): SelectionResultState {
  if (value === 'applied' || value === 'changed' || value === 'assigned' || value === 'removed') return 'applied';
  if (value === 'no_effect' || value === 'unchanged') return 'no_effect';
  if (value === 'conflict' || value === 'conflicted') return 'conflict';
  if (value === 'denied') return 'denied';
  if (value === 'cancelled' || value === 'not-attempted') return 'cancelled';
  if (value === 'failed') return 'failed';
  if (value === 'pending') return 'pending';
  if (value === 'reconciling' || value === 'unknown') return 'uncertain';
  return 'uncertain';
}

export function groupSelectionResults(
  results: readonly SelectionResultItem[],
): Readonly<Record<SelectionResultState, readonly SelectionResultItem[]>> {
  const groups: Record<SelectionResultState, SelectionResultItem[]> = {
    applied: [],
    no_effect: [],
    conflict: [],
    denied: [],
    cancelled: [],
    failed: [],
    pending: [],
    uncertain: [],
  };
  for (const result of results) groups[result.state].push(result);
  return groups;
}
