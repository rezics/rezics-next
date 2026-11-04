import type {
  PersonalEntry,
  PersonalEntryAnnotationWrite,
  PersonalEntryFieldChange,
  PersonalEntryGuard,
} from '@rezics/client';

export const PRIVATE_NOTE_BYTES = 4096;
export const PERSONAL_PRIORITY_MIN = 1;
export const PERSONAL_PRIORITY_MAX = 100;

export type AnnotationDraft = { note: string; priority: string };
export type AnnotationField = keyof AnnotationDraft;
export type AnnotationIssues = { note?: 'bytes'; priority?: 'rank' };

/** Both correction feedback and the native operand builder use these exact bounds. */
export function annotationIssues(draft: AnnotationDraft): AnnotationIssues {
  const issues: AnnotationIssues = {};
  if (annotationNoteBytes(draft.note) > PRIVATE_NOTE_BYTES) issues.note = 'bytes';
  const priority = draft.priority.trim();
  if (
    priority !== '' &&
    (!/^[0-9]{1,3}$/.test(priority) ||
      Number(priority) < PERSONAL_PRIORITY_MIN ||
      Number(priority) > PERSONAL_PRIORITY_MAX)
  )
    issues.priority = 'rank';
  return issues;
}

export function annotationNoteBytes(note: string): number {
  return new TextEncoder().encode(note).byteLength;
}

export function annotationDraftChanged(entry: PersonalEntry, draft: AnnotationDraft): boolean {
  // Invalid input is still an unsent draft and needs deliberate discard on departure.
  return draft.note !== (entry.note ?? '') || draft.priority !== draftOf(entry).priority;
}

export function annotationVersion(entry: PersonalEntry, guard: PersonalEntryGuard | null): string {
  return JSON.stringify([entry.annotationRevision, guard?.incarnationId, guard?.currentRevision]);
}

/** A local confirmation is data only; it has no request key and cannot execute a command. */
export type AnnotationConfirmation = {
  entry: PersonalEntry;
  draft: AnnotationDraft;
  body: PersonalEntryAnnotationWrite & { entryGuard: PersonalEntryGuard };
  viewer: string;
  csrfToken: string;
  credential: string;
};

export function annotationConfirmation(
  entry: PersonalEntry,
  draft: AnnotationDraft,
  guard: PersonalEntryGuard,
  identity: Pick<AnnotationConfirmation, 'viewer' | 'csrfToken' | 'credential'>,
): AnnotationConfirmation | null {
  const body = annotationWrite(entry, draft, guard);
  if (!body) return null;
  // Capture field operands and guard independently of subsequent received values and edits.
  const captured = {
    ...body,
    entryGuard: Object.freeze({ ...guard }),
    note: Object.freeze({ ...body.note }),
    priority: Object.freeze({ ...body.priority }),
  };
  return Object.freeze({
    entry: Object.freeze({ ...entry }),
    draft: Object.freeze({ ...draft }),
    body: Object.freeze(captured),
    ...identity,
  });
}

export function draftOf(entry: PersonalEntry): AnnotationDraft {
  return { note: entry.note ?? '', priority: entry.priority === null ? '' : String(entry.priority) };
}

function fieldChange<T>(unchanged: boolean, cleared: boolean, value: T): PersonalEntryFieldChange<T> {
  if (unchanged) return { op: 'unchanged' };
  if (cleared) return { op: 'clear' };
  return { op: 'set', value };
}

/** Build field-local operations so changing a note cannot erase a priority or provider observation. */
export function annotationWrite(
  entry: PersonalEntry,
  draft: AnnotationDraft,
  entryGuard: PersonalEntryGuard | null,
): PersonalEntryAnnotationWrite | null {
  if (!entryGuard) return null;
  const issues = annotationIssues(draft);
  if (issues.note || issues.priority) return null;
  const note = fieldChange(draft.note === (entry.note ?? ''), draft.note === '', draft.note);
  const priorityText = draft.priority.trim();
  let priorityValue: number | null = null;
  if (priorityText !== '') {
    if (!/^[0-9]{1,3}$/.test(priorityText)) return null;
    priorityValue = Number(priorityText);
    if (
      !Number.isSafeInteger(priorityValue) ||
      priorityValue < PERSONAL_PRIORITY_MIN ||
      priorityValue > PERSONAL_PRIORITY_MAX
    )
      return null;
  }
  const priority = fieldChange(
    (entry.priority === null && priorityValue === null) || entry.priority === priorityValue,
    priorityValue === null,
    priorityValue ?? PERSONAL_PRIORITY_MIN,
  );
  if (note.op === 'unchanged' && priority.op === 'unchanged') return null;
  return { revision: entry.annotationRevision, note, priority, entryGuard };
}

/** Adopt fresh received values only for fields that the draft left unchanged. */
export function renewAnnotationDraft(
  before: PersonalEntry,
  latest: PersonalEntry,
  draft: AnnotationDraft,
  guard: PersonalEntryGuard,
): AnnotationDraft {
  const received = draftOf(before);
  const noteOnly = { note: draft.note, priority: received.priority };
  const priorityOnly = { note: received.note, priority: draft.priority };
  const noteUnchanged = !annotationIssues(noteOnly).note && !annotationWrite(before, noteOnly, guard);
  const priorityUnchanged = !annotationIssues(priorityOnly).priority && !annotationWrite(before, priorityOnly, guard);
  return {
    note: noteUnchanged ? (latest.note ?? '') : draft.note,
    priority: priorityUnchanged ? draftOf(latest).priority : draft.priority,
  };
}
