import { libraryEntryStateWrite, type LibraryChangeInput, type PersonalLibraryEntry } from './entries-read';
import type { LibraryStateChoice } from './profiles';
import type { SubjectLabelMutationInput } from './subject-labels.ts';

export const shelfSelectionLimit = 100;
export type ShelfStateIntent = LibraryChangeInput & { revision: number };
export type ShelfSelectionCandidate = Pick<PersonalLibraryEntry, 'subjectId' | 'stateOptions'> & {
  subject: { id: string } | null;
};
export type ShelfRemovalIdentity = Pick<
  PersonalLibraryEntry,
  'subjectId' | 'revision' | 'incarnationId' | 'removeKey'
>;
export type ShelfOutcome = {
  subjectId: string;
  title: string;
  status: 'changed' | 'unchanged' | 'conflicted' | 'failed' | 'unknown' | 'not-attempted';
};

/** A label command retains its original input and the entry identity, independently of entry-state keys. */
export type ShelfLabelIntent = {
  input: Extract<SubjectLabelMutationInput, { intent: 'assign' | 'unassign' | 'restore' }> & {
    intent: 'assign' | 'unassign';
  };
  operationId: string;
  labelName: string;
  entry: Pick<PersonalLibraryEntry, 'subjectId' | 'revision' | 'incarnationId' | 'changeKey' | 'removeKey'>;
};
export type ShelfLabelOutcome = {
  subjectId: string;
  title: string;
  status: 'assigned' | 'removed' | 'unchanged' | 'conflicted' | 'failed' | 'unknown' | 'not-attempted';
  reason?: 'capacity' | 'closed' | 'signed-out' | 'unavailable';
};

export function matchesShelfLabelIntent(
  entry: ShelfLabelIntent['entry'],
  intent: Pick<ShelfLabelIntent, 'input' | 'entry'>,
): boolean {
  return (
    entry.subjectId === intent.input.subjectId &&
    entry.subjectId === intent.entry.subjectId &&
    entry.revision === intent.entry.revision &&
    entry.incarnationId === intent.entry.incarnationId &&
    entry.changeKey === intent.entry.changeKey &&
    entry.removeKey === intent.entry.removeKey
  );
}

/** A removal review is bound to the exact loaded entry, including a recreated incarnation. */
export function shelfRemovalSelectionSignature(entries: readonly ShelfRemovalIdentity[]): string {
  return JSON.stringify(
    entries.map(({ subjectId, revision, incarnationId, removeKey }) => [
      subjectId,
      revision,
      incarnationId ?? null,
      removeKey,
    ]),
  );
}

export function selectableEntry(entry: ShelfSelectionCandidate): boolean {
  return entry.subject !== null && !!entry.stateOptions?.some((option) => libraryEntryStateWrite(option.id));
}

/** Exact IDs and visible meanings must agree across every selected current profile. */
export function commonShelfStates(entries: readonly ShelfSelectionCandidate[]): LibraryStateChoice[] {
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
