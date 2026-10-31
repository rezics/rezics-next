import { libraryEntryStateWrite, type LibraryChangeInput, type PersonalLibraryEntry } from './entries-read';
import type { LibraryStateChoice } from './profiles';

export const shelfSelectionLimit = 100;
export type ShelfStateIntent = LibraryChangeInput & { revision: number };
export type ShelfOutcome = {
  subjectId: string;
  title: string;
  status: 'changed' | 'unchanged' | 'conflicted' | 'failed' | 'unknown' | 'not-attempted';
};

export function selectableEntry(entry: PersonalLibraryEntry): boolean {
  return entry.subject !== null && !!entry.stateOptions?.some((option) => libraryEntryStateWrite(option.id));
}

/** Exact IDs and visible meanings must agree across every selected current profile. */
export function commonShelfStates(entries: PersonalLibraryEntry[]): LibraryStateChoice[] {
  if (!entries.length || entries.some((entry) => !selectableEntry(entry))) return [];
  return (entries[0]!.stateOptions ?? []).filter(
    (choice, index, choices) =>
      !!libraryEntryStateWrite(choice.id) &&
      choices.findIndex((option) => option.id === choice.id) === index &&
      entries.every((entry) => {
        const matches = entry.stateOptions?.filter((option) => option.id === choice.id) ?? [];
        return (
          matches.length > 0 &&
          matches.every((option) => option.label.text === choice.label.text && option.label.lang === choice.label.lang)
        );
      }),
  );
}

export function shelfStateIntent(entry: PersonalLibraryEntry, state: string): ShelfStateIntent | undefined {
  const writable = libraryEntryStateWrite(state);
  if (!writable || !selectableEntry(entry) || !entry.stateOptions?.some((option) => option.id === writable))
    return undefined;
  return {
    subjectId: entry.subjectId,
    state: writable,
    revision: entry.revision,
    ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
    idempotencyKey: entry.changeKey,
  };
}

/** A retained unknown command belongs only to the exact row from which it was captured. */
export function matchesShelfIntent(entry: PersonalLibraryEntry, intent: ShelfStateIntent): boolean {
  return (
    entry.subjectId === intent.subjectId &&
    entry.revision === intent.revision &&
    entry.incarnationId === intent.incarnationId &&
    entry.changeKey === intent.idempotencyKey
  );
}
