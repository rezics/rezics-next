import { m } from '../paraglide/messages.js';
import type { AuthoringLocation } from '../threads/authoring-departure';
import type { ProgressIndex, ProgressMode } from './progress-reads';

export type ProgressStartDraft = {
  subjectId: string;
  versionSubjectId: string;
  mode: ProgressMode | undefined;
  unit: string;
  total: string;
};

export function progressStartDraftFromPage(page: ProgressIndex): ProgressStartDraft {
  const firstChoice = page.progressChoices?.[0];
  return {
    subjectId: page.selectedSubject?.id ?? '',
    versionSubjectId: '',
    mode: firstChoice?.mode,
    unit: firstChoice?.units[0]?.id ?? '',
    total: '',
  };
}

export function progressStartDraftChanged(initial: ProgressStartDraft, current: ProgressStartDraft): boolean {
  return (
    initial.subjectId !== current.subjectId ||
    initial.versionSubjectId !== current.versionSubjectId ||
    initial.mode !== current.mode ||
    initial.unit !== current.unit ||
    initial.total !== current.total
  );
}

export function progressStartDraftNavigationContext(location: AuthoringLocation): string {
  const search = Object.entries(location.search).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([location.pathname, search]);
}

export function progressStartDraftNavigationMessages() {
  const title = m.library_progress_start_draft_navigation_title();
  const unsaved = m.library_progress_start_draft_navigation_unsaved();
  const pending = m.library_progress_start_draft_navigation_pending();
  return {
    title,
    unsaved,
    pending,
    discardTitle: title,
    discardUnsaved: unsaved,
    discardPending: pending,
    discardAction: m.library_progress_start_draft_navigation_discard(),
  };
}
