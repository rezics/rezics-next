/**
 * The ingredients a step's checkboxes show while that step may already have a write in flight.
 * The newest local selection wins over the references Main has saved; there is no queue behind it.
 */
export function selectionWhilePending(saved: readonly string[], pending: readonly string[] | null): readonly string[] {
  return pending ?? saved;
}

/**
 * Step text kept beside a pending ingredient selection.
 * The field wins when it shows that pending text or something newer. A response that
 * puts the saved text back yields the pending text, so the checkbox does not resubmit the older save.
 */
export function textWhilePending(saved: string, pending: string | null, field: string): string {
  if (pending === null || field === pending || field !== saved) return field;
  return pending;
}

/** One ingredient added to or removed from the selection the checkboxes are showing. */
export function toggleIngredient(selection: readonly string[], occurrence: string, on: boolean): string[] {
  if (!on) return selection.filter(id => id !== occurrence);
  return selection.includes(occurrence) ? [...selection] : [...selection, occurrence];
}
