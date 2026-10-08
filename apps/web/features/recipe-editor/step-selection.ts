/**
 * The ingredients a step's checkboxes show while that step may already have a write in flight.
 * The newest local selection wins over the references Main has saved; there is no queue behind it.
 */
export function selectionWhilePending(saved: readonly string[], pending: readonly string[] | null): readonly string[] {
  return pending ?? saved;
}

/** One ingredient added to or removed from the selection the checkboxes are showing. */
export function toggleIngredient(selection: readonly string[], occurrence: string, on: boolean): string[] {
  if (!on) return selection.filter(id => id !== occurrence);
  return selection.includes(occurrence) ? [...selection] : [...selection, occurrence];
}
