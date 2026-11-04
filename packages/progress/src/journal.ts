import type { ProgressSessionJournalDate, ProgressSessionJournalPatch } from './values.ts';

export const MAX_JOURNAL_REFLECTION_CHARACTERS = 2_000;
export const MAX_JOURNAL_REFLECTION_BYTES = 4_096;
export const OCCURRENCE_ASSESSMENT_MEANING_REVISION = 1 as const;

export type JournalPatchOutcome = { ok: true; value: ProgressSessionJournalPatch } | { ok: false; field: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseJournalDate(value: unknown): ProgressSessionJournalDate | null {
  const source = record(value);
  if (!source || Object.keys(source).some((key) => !['year', 'month', 'day'].includes(key))) return null;
  const { year, month, day } = source;
  if (!Number.isInteger(year) || (year as number) < 1 || (year as number) > 9_999) return null;
  if (month !== undefined && (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12)) return null;
  if (day !== undefined && (month === undefined || !Number.isInteger(day) || (day as number) < 1)) return null;
  if (day !== undefined) {
    const leap = (year as number) % 400 === 0 || ((year as number) % 4 === 0 && (year as number) % 100 !== 0);
    const days = month === 2 ? (leap ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
    if ((day as number) > days) return null;
  }
  return {
    year: year as number,
    ...(month === undefined ? {} : { month: month as number }),
    ...(day === undefined ? {} : { day: day as number }),
  };
}

/** Validates without filling unknown date components or trimming private text. */
export function parseProgressSessionJournalPatch(input: unknown): JournalPatchOutcome {
  const source = record(input);
  if (!source) return { ok: false, field: 'journal' };
  const allowed = new Set(['revision', 'startDate', 'finishDate', 'reflection', 'assessment']);
  const unexpected = Object.keys(source)
    .filter((key) => !allowed.has(key))
    .sort()[0];
  if (unexpected) return { ok: false, field: unexpected };
  const revision = source.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 || (revision as number) >= 2_147_483_647)
    return { ok: false, field: 'revision' };

  const patch: {
    revision: number;
    startDate?: ProgressSessionJournalDate | null;
    finishDate?: ProgressSessionJournalDate | null;
    reflection?: string | null;
    assessment?: Readonly<{ units: number }> | null;
  } = { revision: revision as number };
  for (const field of ['startDate', 'finishDate'] as const) {
    if (!Object.hasOwn(source, field)) continue;
    const value = source[field];
    if (value === null) patch[field] = null;
    else {
      const date = parseJournalDate(value);
      if (!date) return { ok: false, field };
      patch[field] = date;
    }
  }
  if (Object.hasOwn(source, 'reflection')) {
    const reflection = source.reflection;
    if (reflection === null) patch.reflection = null;
    else if (typeof reflection === 'string') {
      if (!reflection.isWellFormed() || reflection.includes('\u0000')) return { ok: false, field: 'reflection' };
      if (Array.from(reflection).length > MAX_JOURNAL_REFLECTION_CHARACTERS) return { ok: false, field: 'reflection' };
      if (new TextEncoder().encode(reflection).byteLength > MAX_JOURNAL_REFLECTION_BYTES)
        return { ok: false, field: 'reflection' };
      patch.reflection = reflection;
    } else return { ok: false, field: 'reflection' };
  }
  if (Object.hasOwn(source, 'assessment')) {
    const assessment = source.assessment;
    if (assessment === null) patch.assessment = null;
    else {
      const value = record(assessment);
      if (
        !value ||
        Object.keys(value).some((key) => key !== 'units') ||
        !Number.isInteger(value.units) ||
        (value.units as number) < 0 ||
        (value.units as number) > 20
      )
        return { ok: false, field: 'assessment' };
      patch.assessment = { units: value.units as number };
    }
  }
  return { ok: true, value: patch };
}
