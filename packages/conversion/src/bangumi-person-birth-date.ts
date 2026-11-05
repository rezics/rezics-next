import type { ConversionDiagnostic } from './index.ts';
import { gregorianMonthDays, type PublicationTime } from './bangumi-subject-profile.ts';

const gregorian = 'http://www.wikidata.org/entity/Q1985727';

export type BangumiPersonBirthDate = {
  readonly time: PublicationTime;
};

export type BangumiPersonBirthDateProjection = {
  readonly fact?: BangumiPersonBirthDate;
  readonly diagnostic?: ConversionDiagnostic;
};

function yearToken(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return;
  const token = String(value);
  if (token.length > 16) return;
  return token.padStart(4, '0');
}

function monthDay(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return;
  return value;
}

function missingPointer(year: unknown, month: unknown, day: unknown): string {
  if (year === undefined || year === null || year === 0) return '/birth_year';
  if (month === undefined || month === null || month === 0) return '/birth_mon';
  return '/birth_day';
}

/** Day-precision Gregorian birth date from actual PersonDetail integer components. */
export function bangumiPersonBirthTime(year: unknown, month: unknown, day: unknown): PublicationTime | undefined {
  const yearText = yearToken(year);
  const monthValue = monthDay(month);
  const dayValue = monthDay(day);
  if (!yearText || monthValue === undefined || dayValue === undefined) return;
  if (monthValue > 12 || dayValue > gregorianMonthDays(Number(yearText), monthValue)) return;
  return {
    time: `+${yearText}-${String(monthValue).padStart(2, '0')}-${String(dayValue).padStart(2, '0')}T00:00:00Z`,
    precision: 11,
    calendarmodel: gregorian,
  };
}

/** Type-1 Person only. Partial, zero, string and invalid components withhold this fact. */
export function projectBangumiPersonBirthDate(input: {
  readonly profile: string;
  readonly birth_year: unknown;
  readonly birth_mon: unknown;
  readonly birth_day: unknown;
}): BangumiPersonBirthDateProjection {
  const { birth_year: year, birth_mon: month, birth_day: day } = input;
  if (year === undefined && month === undefined && day === undefined) return {};
  if (input.profile !== 'schema:Person')
    return { diagnostic: { pointer: '/type', code: 'unadmitted_person_birth_date' } };
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    year === null ||
    month === null ||
    day === null ||
    year === 0 ||
    month === 0 ||
    day === 0
  )
    return {
      diagnostic: { pointer: missingPointer(year, month, day), code: 'omitted_partial_person_birth_date' },
    };
  const time = bangumiPersonBirthTime(year, month, day);
  if (!time) return { diagnostic: { pointer: '/birth_day', code: 'invalid_person_birth_date' } };
  return { fact: { time } };
}
