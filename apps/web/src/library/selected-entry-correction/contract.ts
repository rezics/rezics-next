import type { EntryAnnotationCorrectionSelection, EntryAnnotationCorrectionOperation } from '@rezics/client';
import { annotationIssues, annotationNoteBytes } from '../rich-private-entry/contract';
import type { PersonalLibraryEntry } from '../entries-read';

export type SelectedEntry = Pick<EntryAnnotationCorrectionSelection, 'subjectId' | 'incarnationId' | 'currentRevision'>;
export type CorrectionDraft = {
  note: 'preserve' | 'set' | 'clear';
  priority: 'preserve' | 'set' | 'clear';
  noteValue: string;
  priorityValue: string;
};
export const initialDraft = (): CorrectionDraft => ({
  note: 'preserve',
  priority: 'preserve',
  noteValue: '',
  priorityValue: '',
});

/** Capture identities from the admitted loaded page, never from titles or query offsets. */
export function captureSelection(
  entries: readonly PersonalLibraryEntry[],
  selected: readonly string[],
): SelectedEntry[] {
  return entries
    .filter((entry) => selected.includes(entry.subjectId) && entry.incarnationId != null)
    .slice(0, 16)
    .map((entry) => ({
      subjectId: entry.subjectId,
      incarnationId: entry.incarnationId!,
      currentRevision: entry.revision,
    }));
}

export function correctionIssues(draft: CorrectionDraft) {
  const issues = annotationIssues({
    note: draft.note === 'set' ? draft.noteValue : '',
    priority: draft.priority === 'set' ? draft.priorityValue : '',
  });
  return {
    note: draft.note === 'set' && (draft.noteValue.length === 0 || !!issues.note),
    priority: draft.priority === 'set' && (draft.priorityValue.trim() === '' || !!issues.priority),
  };
}

export function correctionInput(
  selection: readonly SelectedEntry[],
  draft: CorrectionDraft,
): EntryAnnotationCorrectionSelection[] {
  return selection.map((entry) => ({
    ...entry,
    note: draft.note === 'set' ? { op: 'set', value: draft.noteValue } : { op: draft.note },
    priority:
      draft.priority === 'set' ? { op: 'set', value: Number(draft.priorityValue.trim()) } : { op: draft.priority },
  }));
}
export function intended<T>(current: T | null, operation: EntryAnnotationCorrectionOperation<T>): T | null {
  return operation.op === 'preserve' ? current : operation.op === 'clear' ? null : operation.value;
}
export { annotationNoteBytes };
