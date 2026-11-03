import {
  RECOVERY_ID,
  RECOVERY_SELECTED_OCCURRENCES,
  type RecoveryOccurrence,
  type RecoveryReviewBody,
} from './contract';

export type SelectedOccurrence = RecoveryOccurrence;
export type OccurrenceSelection = ReadonlyMap<string, SelectedOccurrence>;

export function canSelectOccurrence(occurrence: RecoveryOccurrence): boolean {
  return !occurrence.notePresent || occurrence.noteValid;
}

export function toggleOccurrence(
  selected: OccurrenceSelection,
  occurrence: RecoveryOccurrence,
): OccurrenceSelection {
  const next = new Map(selected);
  if (next.has(occurrence.sourceOccurrenceId)) {
    next.delete(occurrence.sourceOccurrenceId);
    return next;
  }
  if (next.size >= RECOVERY_SELECTED_OCCURRENCES || !canSelectOccurrence(occurrence)) return selected;
  next.set(occurrence.sourceOccurrenceId, structuredClone(occurrence));
  return next;
}

export function togglePage(
  selected: OccurrenceSelection,
  page: readonly RecoveryOccurrence[],
): OccurrenceSelection {
  const available = page.filter(canSelectOccurrence);
  const allSelected = available.every((row) => selected.has(row.sourceOccurrenceId));
  const next = new Map(selected);
  if (allSelected) {
    for (const row of available) next.delete(row.sourceOccurrenceId);
    return next;
  }
  for (const row of available) {
    if (next.size >= RECOVERY_SELECTED_OCCURRENCES) break;
    next.set(row.sourceOccurrenceId, structuredClone(row));
  }
  return next;
}

export function makeReviewBody(input: {
  collectionId: string;
  selected: OccurrenceSelection;
  targets: ReadonlyMap<string, string | null>;
}): RecoveryReviewBody {
  const occurrences = [...input.selected.values()];
  const subjectIds = new Set(
    occurrences.flatMap((row) =>
      row.sourceSubjectId && RECOVERY_ID.test(row.sourceSubjectId)
        ? [row.sourceSubjectId]
        : [],
    ),
  );
  return {
    collectionId: input.collectionId,
    selectedOccurrenceIds: occurrences.map((row) => row.sourceOccurrenceId),
    mappings: [...subjectIds]
      .sort()
      .map((sourceSubjectId) => ({
        sourceSubjectId,
        targetSubjectId: input.targets.get(sourceSubjectId) ?? null,
      })),
  };
}

export function selectionLimitReached(selected: OccurrenceSelection): boolean {
  return selected.size >= RECOVERY_SELECTED_OCCURRENCES;
}
