import type { JournalDraft } from '@rezics/progress';
import type { ReactNode } from 'react';
import {
  PublicationNoteDraftNavigation,
  usePublicationNoteDraftNavigation,
} from '../publication-note-draft-navigation';

/** Field selection is intent: a deliberate Clear, empty reflection or incomplete date is still a draft. */
function hasJournalDraft(draft: JournalDraft) {
  return (
    draft.startDate.kind !== 'untouched' ||
    draft.finishDate.kind !== 'untouched' ||
    draft.reflection.kind !== 'untouched' ||
    draft.assessment.kind !== 'untouched'
  );
}

/** Reuse the Progress page's decision; isolated occurrence callers get the same boundary. */
export function PrivateJournalDraftNavigation({ children }: { children: ReactNode }) {
  return <PublicationNoteDraftNavigation messages="progress">{children}</PublicationNoteDraftNavigation>;
}

export function usePrivateJournalDraftNavigation(options: {
  identity: object;
  isCurrent: () => boolean;
  draft: JournalDraft;
  command: 'pending' | 'uncertain' | 'acknowledged' | null;
  discard: () => void;
}) {
  const dirty = hasJournalDraft(options.draft);
  const state = () => ({
    active: options.isCurrent(),
    dirty: dirty || options.command !== null,
    locked: options.command === 'pending',
    journal: dirty || options.command ? (options.command ?? ('draft' as const)) : undefined,
  });
  usePublicationNoteDraftNavigation({
    identity: options.identity,
    state: state(),
    getState: state,
    // This callback owns only the caller's unsent fields. It never settles a native command.
    discard: options.discard,
  });
}
