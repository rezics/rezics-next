import type { CollectionDestination } from './collection-read';

type LoadedSubject = Readonly<{ subjectId?: string; subject: Readonly<{ id: string }> | null }>;
export type BulkAddSelection = Readonly<{ ok: true; subjects: readonly string[] }>;
export type BulkAddCapture = Readonly<{
  subjects: readonly string[];
  destination: Readonly<CollectionDestination>;
}>;

/** Only the selected loaded rows belong to this capture, regardless of the list's filters or next page. */
export function captureBulkAddSelection(
  loaded: readonly LoadedSubject[],
): BulkAddSelection | Readonly<{ ok: false; reason: 'empty' | 'unavailable' | 'limit' }> {
  if (!loaded.length) return { ok: false, reason: 'empty' };
  const subjects: string[] = [];
  const seen = new Set<string>();
  for (const row of loaded) {
    const id = row.subject?.id;
    if (!id || (row.subjectId !== undefined && row.subjectId !== id)) return { ok: false, reason: 'unavailable' };
    // Canonical Subjects are unique in the native manifest. This is not destination membership deduplication.
    if (!seen.has(id)) {
      seen.add(id);
      subjects.push(id);
      if (subjects.length > 1_000) return { ok: false, reason: 'limit' };
    }
  }
  return Object.freeze({ ok: true, subjects: Object.freeze(subjects) });
}

/** The chooser supplies a current private destination read. Native preview still owns admission and expectations. */
export function captureBulkAddDestination(
  selection: BulkAddSelection,
  destination: CollectionDestination,
): BulkAddCapture {
  return Object.freeze({
    subjects: Object.freeze([...selection.subjects]),
    destination: Object.freeze({
      id: destination.id,
      title: destination.title,
      revision: destination.revision,
    }),
  });
}
