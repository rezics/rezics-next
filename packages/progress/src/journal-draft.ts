import { parseJournalDate, parseProgressSessionJournalPatch } from './journal.ts';
import type { ProgressSessionJournal, ProgressSessionJournalDate, ProgressSessionJournalPatch } from './values.ts';

/** Calendar text has exactly the precision the reader supplied. It is never an instant. */
export function formatJournalDate(value: ProgressSessionJournalDate | null): string {
  if (value === null) return '';
  const year = String(value.year).padStart(4, '0');
  if (value.month === undefined) return year;
  const month = String(value.month).padStart(2, '0');
  return value.day === undefined ? `${year}-${month}` : `${year}-${month}-${String(value.day).padStart(2, '0')}`;
}

/** Empty text is incomplete input. Only an explicit clear intent produces null. */
export function parseJournalDateText(value: string): ProgressSessionJournalDate | null {
  const match = /^([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?$/.exec(value);
  if (!match || match[0] !== value) return null;
  return parseJournalDate({
    year: Number(match[1]),
    ...(match[2] === undefined ? {} : { month: Number(match[2]) }),
    ...(match[3] === undefined ? {} : { day: Number(match[3]) }),
  });
}

export type JournalField = 'startDate' | 'finishDate' | 'reflection' | 'assessment';
export const JOURNAL_FIELDS: readonly JournalField[] = ['startDate', 'finishDate', 'reflection', 'assessment'];
export type JournalFieldDraft =
  | Readonly<{ kind: 'untouched' }>
  | Readonly<{ kind: 'set'; text: string }>
  | Readonly<{ kind: 'clear' }>;
export type JournalDraft = Readonly<Record<JournalField, JournalFieldDraft>>;

/** New edits name only chosen fields, so a concurrent read cannot turn omission into a clear. */
export function emptyJournalDraft(): JournalDraft {
  return {
    startDate: { kind: 'untouched' },
    finishDate: { kind: 'untouched' },
    reflection: { kind: 'untouched' },
    assessment: { kind: 'untouched' },
  };
}

export function journalDraftText(journal: ProgressSessionJournal, draft: JournalDraft, field: JournalField): string {
  const selected = draft[field];
  if (selected.kind === 'clear') return '';
  if (selected.kind === 'set') return selected.text;
  if (field === 'startDate' || field === 'finishDate') return formatJournalDate(journal[field]);
  if (field === 'reflection') return journal.reflection ?? '';
  return journal.assessment.units === null ? '' : formatJournalAssessment(journal.assessment.units);
}

/** The displayed private score is exact half-units; no general floating-point conversion is accepted. */
export function parseJournalAssessmentText(text: string): number | null {
  const match = /^(?:([0-9])(?:\.(0|5))?|(10)(?:\.0)?)$/.exec(text);
  if (!match || match[0] !== text) return null;
  return match[3] === '10' ? 20 : Number(match[1]) * 2 + (match[2] === '5' ? 1 : 0);
}

export function formatJournalAssessment(units: number): string {
  return units % 2 === 0 ? String(units / 2) : `${Math.floor(units / 2)}.5`;
}

export type JournalDraftOutcome =
  | Readonly<{ ok: true; patch: ProgressSessionJournalPatch; changedFields: readonly JournalField[] }>
  | Readonly<{ ok: false; field: JournalField | 'revision' }>;

/** Build a patch without diffing against a moving read. The user's field selection is the intent. */
export function buildJournalDraftPatch(revision: number, draft: JournalDraft): JournalDraftOutcome {
  const patch: {
    revision: number;
    startDate?: ProgressSessionJournalDate | null;
    finishDate?: ProgressSessionJournalDate | null;
    reflection?: string | null;
    assessment?: { units: number } | null;
  } = { revision };
  const changedFields: JournalField[] = [];
  for (const field of JOURNAL_FIELDS) {
    const selection = draft[field];
    if (selection.kind === 'untouched') continue;
    changedFields.push(field);
    if (selection.kind === 'clear') {
      patch[field] = null;
      continue;
    }
    if (field === 'startDate' || field === 'finishDate') {
      const date = parseJournalDateText(selection.text);
      if (date === null) return { ok: false, field };
      patch[field] = date;
    } else if (field === 'reflection') {
      patch.reflection = selection.text;
    } else {
      const units = parseJournalAssessmentText(selection.text);
      if (units === null) return { ok: false, field };
      patch.assessment = { units };
    }
  }
  const parsed = parseProgressSessionJournalPatch(patch);
  if (!parsed.ok) {
    const field = JOURNAL_FIELDS.find((candidate) => candidate === parsed.field) ?? 'revision';
    return { ok: false, field };
  }
  return { ok: true, patch: parsed.value, changedFields };
}

export function sameJournalDate(
  left: ProgressSessionJournalDate | null,
  right: ProgressSessionJournalDate | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.year === right.year && left.month === right.month && left.day === right.day;
}

/** Values only. CAS, original receipts and admission remain the native writer's responsibility. */
export function applyJournalPatch(
  current: ProgressSessionJournal,
  patch: ProgressSessionJournalPatch,
): ProgressSessionJournal {
  return {
    sessionId: current.sessionId,
    revision: current.revision,
    startDate: Object.hasOwn(patch, 'startDate') ? patch.startDate! : current.startDate,
    finishDate: Object.hasOwn(patch, 'finishDate') ? patch.finishDate! : current.finishDate,
    reflection: Object.hasOwn(patch, 'reflection') ? patch.reflection! : current.reflection,
    assessment: Object.hasOwn(patch, 'assessment')
      ? { meaningRevision: current.assessment.meaningRevision, units: patch.assessment?.units ?? null }
      : current.assessment,
  };
}

export function sameJournalValues(left: ProgressSessionJournal, right: ProgressSessionJournal): boolean {
  return (
    sameJournalDate(left.startDate, right.startDate) &&
    sameJournalDate(left.finishDate, right.finishDate) &&
    left.reflection === right.reflection &&
    left.assessment.meaningRevision === right.assessment.meaningRevision &&
    left.assessment.units === right.assessment.units
  );
}

export type JournalFieldReview = Readonly<{
  field: JournalField;
  kind: JournalFieldDraft['kind'];
  before: string | null;
  after: string | null;
}>;

/** A private, local review; callers must retire it with the originating reader. */
export function reviewJournalDraft(
  current: ProgressSessionJournal,
  draft: JournalDraft,
): readonly JournalFieldReview[] {
  return JOURNAL_FIELDS.map((field) => {
    const before =
      field === 'startDate' || field === 'finishDate'
        ? current[field] === null
          ? null
          : formatJournalDate(current[field])
        : field === 'reflection'
          ? current.reflection
          : current.assessment.units === null
            ? null
            : formatJournalAssessment(current.assessment.units);
    const selection = draft[field];
    return {
      field,
      kind: selection.kind,
      before,
      after: selection.kind === 'untouched' ? before : selection.kind === 'clear' ? null : selection.text,
    };
  });
}
