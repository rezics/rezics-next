type LoadedOccurrence = Readonly<{
  id: string;
  subjectId?: string;
  subject: Readonly<{ id: string }> | null;
}>;

export type BulkOccurrenceRemoveCapture = Readonly<{
  ok: true;
  source: Readonly<{ id: string; title: string }>;
  targets: readonly Readonly<{ memberId: string; subjectId: string }>[];
}>;

export type BulkOccurrenceRemoveSelection =
  | BulkOccurrenceRemoveCapture
  | Readonly<{ ok: false; reason: 'empty' | 'limit' | 'unavailable' }>;

/** Capture loaded selection only. Native preview owns persistence, expectations and admission. */
export function captureBulkOccurrenceRemove(
  source: Readonly<{ id: string; title: string }>,
  loaded: readonly LoadedOccurrence[],
  selectedIds: ReadonlySet<string>,
): BulkOccurrenceRemoveSelection {
  if (!selectedIds.size) return { ok: false, reason: 'empty' };
  if (selectedIds.size > 1_000) return { ok: false, reason: 'limit' };

  // Index only selected occurrences. An unavailable unselected row cannot broaden this capture.
  const selected = new Map<string, LoadedOccurrence>();
  for (const member of loaded) {
    if (!selectedIds.has(member.id)) continue;
    if (selected.has(member.id)) return { ok: false, reason: 'unavailable' };
    selected.set(member.id, member);
  }
  const targets: { readonly memberId: string; readonly subjectId: string }[] = [];
  for (const memberId of selectedIds) {
    const member = selected.get(memberId);
    const subjectId = member?.subject?.id;
    if (!member || !subjectId || (member.subjectId !== undefined && member.subjectId !== subjectId))
      return { ok: false, reason: 'unavailable' };
    // Distinct member IDs remain distinct even when their Subject is the same.
    targets.push(Object.freeze({ memberId, subjectId }));
  }
  return Object.freeze({
    ok: true,
    source: Object.freeze({ id: source.id, title: source.title }),
    targets: Object.freeze(targets),
  });
}
