import type { PersonalEntry, PersonalEntryAnnotationWrite, PersonalEntryFieldChange } from '@rezics/client';

export const PRIVATE_NOTE_BYTES = 4096;
export const PERSONAL_PRIORITY_MIN = 1;
export const PERSONAL_PRIORITY_MAX = 100;

export type AnnotationDraft = { note: string; priority: string };

export function draftOf(entry: PersonalEntry): AnnotationDraft {
  return { note: entry.note ?? '', priority: entry.priority === null ? '' : String(entry.priority) };
}

function fieldChange<T>(unchanged: boolean, cleared: boolean, value: T): PersonalEntryFieldChange<T> {
  if (unchanged) return { op: 'unchanged' };
  if (cleared) return { op: 'clear' };
  return { op: 'set', value };
}

/** Build field-local operations so changing a note cannot erase a priority or provider observation. */
export function annotationWrite(entry: PersonalEntry, draft: AnnotationDraft): PersonalEntryAnnotationWrite | null {
  const noteBytes = new TextEncoder().encode(draft.note).byteLength;
  if (noteBytes > PRIVATE_NOTE_BYTES) return null;
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
  return { revision: entry.annotationRevision, note, priority };
}
