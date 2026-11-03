import type { ProgressSessionJournal, ProgressSessionJournalDate, ProgressSessionJournalPatch, ProgressSessionJournalWrite } from './progress-model.ts';
import type { ProgressSessionJournalAdmission } from './sessions.ts';

export const IMPORT_CONSUMPTION_LIMITS = {
  requestBytes: 16 * 1024,
  rows: 20,
  fields: 2,
  resultBytes: 64 * 1024,
} as const;

export type ImportDateField = 'startDate' | 'finishDate';
export type ImportDateAction = 'adopt' | 'clear';
export type ImportDateSourceState = 'missing' | 'unknown' | 'invalid' | 'unsupported' | 'value';
export type ImportDateSource = Readonly<{
  state: ImportDateSourceState;
  date: ProgressSessionJournalDate | null;
  precision: 'year' | 'month' | 'day' | null;
}>;
export type ImportDateFieldReview = Readonly<{
  field: ImportDateField;
  sourceState: ImportDateSourceState;
  precision: ImportDateSource['precision'];
  action: ImportDateAction | null;
  current: ProgressSessionJournalDate | null;
  proposed: ProgressSessionJournalDate | null;
  status: 'not-selected' | 'ready' | 'clear' | 'already-equal' | 'missing' | 'unknown' | 'invalid' | 'unsupported';
}>;
export type ImportDateSessionIdentity = Readonly<{
  sessionId: string;
  subjectId: string;
  versionSubjectId: string | null;
  startedAt: string;
  transactionId: string;
}>;
export type ImportConsumptionDateReview = Readonly<{
  version: string;
  sourceReviewToken: string;
  sourceFingerprint: string;
  matchFingerprint: string;
  subjectId: string;
  profileDigest: string;
  profileBinding: unknown;
  occurrenceProfileBinding: unknown;
  occurrence: ImportDateSessionIdentity;
  journalRevision: number;
  current: Readonly<{ startDate: ProgressSessionJournalDate | null; finishDate: ProgressSessionJournalDate | null }>;
  actions: Readonly<Partial<Record<ImportDateField, ImportDateAction>>>;
  fields: Readonly<Record<ImportDateField, ImportDateFieldReview>>;
}>;

export type ImportDateFieldOutcome = Readonly<{
  field: ImportDateField;
  status:
    | 'applied'
    | 'cleared'
    | 'already-equal'
    | 'not-selected'
    | 'missing'
    | 'unknown'
    | 'invalid'
    | 'unsupported'
    | 'stale'
    | 'failed'
    | 'unattempted';
}>;
export type ImportConsumptionDateOutcome = Readonly<{
  version: string;
  status: 'applied' | 'skipped' | 'unsupported' | 'stale' | 'failed' | 'unattempted';
  fields: readonly ImportDateFieldOutcome[];
  receipt: ProgressSessionJournalWrite | null;
}>;
export type ImportConsumptionDateIntent = {
  version: string;
  fields: ImportDateField[];
  nativeRequestKey: string;
  patch: ProgressSessionJournalPatch | null;
  admissionIdentity: unknown;
  outcome?: ImportConsumptionDateOutcome;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function journalDate(year: number, month?: number, day?: number): ImportDateSource {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9_999)
    return { state: 'unsupported', date: null, precision: null };
  if (month === undefined) {
    if (day !== undefined) return { state: 'invalid', date: null, precision: null };
    return { state: 'value', date: { year }, precision: 'year' };
  }
  if (!Number.isSafeInteger(month) || month < 1 || month > 12)
    return { state: 'invalid', date: null, precision: null };
  if (day === undefined) return { state: 'value', date: { year, month }, precision: 'month' };
  if (!Number.isSafeInteger(day) || day < 1)
    return { state: 'invalid', date: null, precision: null };
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day > days) return { state: 'invalid', date: null, precision: null };
  return { state: 'value', date: { year, month, day }, precision: 'day' };
}

function component(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return value;
  return Number.isSafeInteger(value) ? (value as number) : Number.NaN;
}

/** Admit only the native Gregorian journal shape; parser-level validity is intentionally ignored. */
export function aniListDateSource(evidence: Record<string, unknown>, field: 'startedAt' | 'completedAt'): ImportDateSource {
  if (!Object.hasOwn(evidence, field)) return { state: 'missing', date: null, precision: null };
  const value = evidence[field];
  if (value === null) return { state: 'unknown', date: null, precision: null };
  if (!record(value) || Object.keys(value).some((key) => !['year', 'month', 'day'].includes(key)))
    return { state: 'invalid', date: null, precision: null };
  if (
    typeof value.year === 'number' &&
    Number.isInteger(value.year) &&
    (value.year < 1 || value.year > 9_999)
  )
    return { state: 'unsupported', date: null, precision: null };
  const year = component(value.year),
    month = component(value.month),
    day = component(value.day);
  if ([year, month, day].some((part) => typeof part === 'number' && !Number.isSafeInteger(part)))
    return { state: 'invalid', date: null, precision: null };
  const parts = [year, month, day];
  if (parts.every((part) => part === undefined || part === null))
    return { state: 'unknown', date: null, precision: null };
  if (year === undefined || year === null || (month === undefined || month === null) && day !== undefined && day !== null)
    return { state: 'invalid', date: null, precision: null };
  return journalDate(year, month == null ? undefined : month, day == null ? undefined : day);
}

/** VNDB's YYYY-00 and YYYY-MM-00 forms preserve the trailing unknown precision. */
export function vndbDateSource(value: { kind: string; raw: unknown } | undefined): ImportDateSource {
  if (!value || value.kind === 'missing') return { state: 'missing', date: null, precision: null };
  if (value.kind === 'unknown') return { state: 'unknown', date: null, precision: null };
  if (typeof value.raw !== 'string')
    return { state: 'invalid', date: null, precision: null };
  const rawYear = /^(\d+)/.exec(value.raw)?.[1];
  if (rawYear !== undefined) {
    const year = Number(rawYear);
    if (rawYear.length >= 4 && (!Number.isSafeInteger(year) || year < 1 || year > 9_999))
      return { state: 'unsupported', date: null, precision: null };
  }
  if (value.kind !== 'value') return { state: 'invalid', date: null, precision: null };
  const match = /^(\d{4,})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value.raw);
  if (!match) return { state: 'invalid', date: null, precision: null };
  const year = Number(match[1]),
    monthText = match[2],
    dayText = match[3];
  if (monthText === undefined || monthText === '00') {
    if (dayText !== undefined && dayText !== '00') return { state: 'invalid', date: null, precision: null };
    return journalDate(year);
  }
  const month = Number(monthText);
  if (dayText === undefined || dayText === '00') return journalDate(year, month);
  return journalDate(year, month, Number(dayText));
}

function sameDate(left: ProgressSessionJournalDate | null, right: ProgressSessionJournalDate | null): boolean {
  return (
    (left === null && right === null) ||
    (left !== null && right !== null && left.year === right.year && left.month === right.month && left.day === right.day)
  );
}

function fieldReview(
  field: ImportDateField,
  source: ImportDateSource,
  current: ProgressSessionJournalDate | null,
  action: ImportDateAction | undefined,
  profileCurrent: boolean,
): ImportDateFieldReview {
  let status: ImportDateFieldReview['status'];
  if (action === undefined) status = 'not-selected';
  else if (!profileCurrent) status = 'unsupported';
  else if (action === 'clear') status = current === null ? 'already-equal' : 'clear';
  else if (source.state !== 'value') status = source.state;
  else if (source.date === null) status = 'unsupported';
  else status = sameDate(source.date, current) ? 'already-equal' : 'ready';
  return {
    field,
    sourceState: source.state,
    precision: source.precision,
    action: action ?? null,
    current,
    proposed: source.date,
    status,
  };
}

export function reviewImportConsumptionDates(input: {
  version: string;
  sourceReviewToken: string;
  sourceFingerprint: string;
  matchFingerprint: string;
  subjectId: string;
  profileDigest: string;
  profileBinding: unknown;
  occurrenceProfileBinding: unknown;
  occurrence: ImportDateSessionIdentity;
  journal: ProgressSessionJournal;
  start: ImportDateSource;
  finish: ImportDateSource;
  actions: Readonly<Partial<Record<ImportDateField, ImportDateAction>>>;
  profileCurrent: boolean;
}): ImportConsumptionDateReview {
  const current = { startDate: input.journal.startDate, finishDate: input.journal.finishDate };
  return {
    version: input.version,
    sourceReviewToken: input.sourceReviewToken,
    sourceFingerprint: input.sourceFingerprint,
    matchFingerprint: input.matchFingerprint,
    subjectId: input.subjectId,
    profileDigest: input.profileDigest,
    profileBinding: input.profileBinding,
    occurrenceProfileBinding: input.occurrenceProfileBinding,
    occurrence: input.occurrence,
    journalRevision: input.journal.revision,
    current,
    actions: input.actions,
    fields: {
      startDate: fieldReview('startDate', input.start, current.startDate, input.actions.startDate, input.profileCurrent),
      finishDate: fieldReview(
        'finishDate',
        input.finish,
        current.finishDate,
        input.actions.finishDate,
        input.profileCurrent,
      ),
    },
  };
}

export function publicImportConsumptionDateReview(review: ImportConsumptionDateReview) {
  const {
    sourceFingerprint: _sourceFingerprint,
    matchFingerprint: _matchFingerprint,
    profileDigest: _profileDigest,
    profileBinding: _profileBinding,
    occurrenceProfileBinding: _occurrenceProfileBinding,
    ...result
  } = review;
  return result;
}

function selectedFieldOutcomes(review: ImportConsumptionDateReview, fields: readonly ImportDateField[]) {
  const patch: { revision: number } & Partial<Record<ImportDateField, ProgressSessionJournalDate | null>> = {
    revision: review.journalRevision,
  };
  const outcomes: ImportDateFieldOutcome[] = [];
  for (const field of fields) {
    const decision = review.fields[field];
    if (decision.status === 'ready' && decision.proposed) {
      patch[field] = decision.proposed;
      outcomes.push({ field, status: 'applied' });
    } else if (decision.status === 'clear') {
      patch[field] = null;
      outcomes.push({ field, status: 'cleared' });
    } else {
      outcomes.push({ field, status: decision.status });
    }
  }
  return { patch: Object.keys(patch).length === 1 ? null : patch, outcomes };
}

function terminalFieldOutcomes(
  review: ImportConsumptionDateReview,
  fields: readonly ImportDateField[],
  status: 'stale' | 'failed' | 'unattempted',
) {
  return selectedFieldOutcomes(review, fields).outcomes.map((field) =>
    field.status === 'applied' || field.status === 'cleared' ? { field: field.field, status } : field,
  );
}

export async function executeImportConsumptionDateIntent(input: {
  review: ImportConsumptionDateReview;
  fields: ImportDateField[];
  existing?: ImportConsumptionDateIntent;
  nativeRequestKey: string;
  admissionIdentity: unknown;
  admission: ProgressSessionJournalAdmission;
  isCurrent: () => Promise<boolean>;
  persist: (intent: ImportConsumptionDateIntent) => Promise<boolean>;
  patch: (
    sessionId: string,
    patch: ProgressSessionJournalPatch,
    requestKey: string,
    admission: ProgressSessionJournalAdmission,
  ) => Promise<{ value: ProgressSessionJournalWrite }>;
  record?: (value: unknown) => void;
  signal?: AbortSignal;
  isStaleError: (error: unknown) => boolean;
  rethrowError?: (error: unknown) => boolean;
}): Promise<ImportConsumptionDateIntent> {
  const { review, fields } = input;
  if (
    fields.length < 1 ||
    fields.length > IMPORT_CONSUMPTION_LIMITS.fields ||
    new Set(fields).size !== fields.length ||
    fields.some((field) => field !== 'startDate' && field !== 'finishDate')
  )
    throw new Error('invalid-import-consumption-fields');
  let intent = input.existing;
  if (intent && (intent.version !== review.version || intent.fields.join(',') !== fields.join(',')))
    throw new Error('import-consumption-idempotency-conflict');
  if (intent?.outcome && intent.outcome.status !== 'failed' && intent.outcome.status !== 'unattempted') return intent;

  if (!intent) {
    if (!(await input.isCurrent())) {
      const outcome: ImportConsumptionDateOutcome = {
        version: review.version,
        status: 'stale',
        fields: terminalFieldOutcomes(review, fields, 'stale'),
        receipt: null,
      };
      intent = {
        version: review.version,
        fields: [...fields],
        nativeRequestKey: input.nativeRequestKey,
        patch: null,
        admissionIdentity: input.admissionIdentity,
        outcome,
      };
      await input.persist(intent);
      return intent;
    }
    const prepared = selectedFieldOutcomes(review, fields),
      hasPatch = prepared.patch !== null,
      unsupported = prepared.outcomes.some((field) => ['missing', 'unknown', 'invalid', 'unsupported'].includes(field.status));
    const noPatchOutcome: ImportConsumptionDateOutcome | undefined = hasPatch
      ? undefined
      : {
          version: review.version,
          status: unsupported ? 'unsupported' : 'skipped',
          fields: prepared.outcomes,
          receipt: null,
        };
    intent = {
      version: review.version,
      fields: [...fields],
      nativeRequestKey: input.nativeRequestKey,
      patch: prepared.patch,
      admissionIdentity: input.admissionIdentity,
      ...(noPatchOutcome ? { outcome: noPatchOutcome } : {}),
    };
    if (!(await input.persist(intent))) {
      return {
        ...intent,
        patch: null,
        outcome: {
          version: review.version,
          status: 'stale',
          fields: terminalFieldOutcomes(review, fields, 'stale'),
          receipt: null,
        },
      };
    }
    if (intent.outcome) return intent;
  }

  if (!intent.patch || !intent.outcome && input.signal?.aborted)
    return {
      ...intent,
      outcome: {
        version: review.version,
        status: 'unattempted',
        fields: terminalFieldOutcomes(review, intent.fields, 'unattempted'),
        receipt: null,
      },
    };

  try {
    const command = await input.patch(
      review.occurrence.sessionId,
      intent.patch,
      intent.nativeRequestKey,
      input.admission,
    );
    input.record?.(command);
    const receipt = command.value;
    const fieldsOut = selectedFieldOutcomes(review, intent.fields).outcomes.map((field) =>
      !receipt.changed && (field.status === 'applied' || field.status === 'cleared')
        ? { field: field.field, status: 'already-equal' as const }
        : field,
    );
    intent = {
      ...intent,
      outcome: {
        version: review.version,
        status: receipt.changed ? 'applied' : 'skipped',
        fields: fieldsOut,
        receipt,
      },
    };
  } catch (error) {
    if (input.rethrowError?.(error)) throw error;
    intent = {
      ...intent,
      outcome: {
        version: review.version,
        status: input.isStaleError(error) ? 'stale' : 'failed',
        fields: terminalFieldOutcomes(review, intent.fields, input.isStaleError(error) ? 'stale' : 'failed'),
        receipt: null,
      },
    };
  }
  await input.persist(intent);
  return intent;
}

export async function applyImportConsumptionDateRows<T>(
  rows: readonly T[],
  signal: AbortSignal | undefined,
  apply: (row: T) => Promise<ImportConsumptionDateOutcome>,
  unattempted: (row: T) => ImportConsumptionDateOutcome,
  shouldStop: () => boolean = () => false,
): Promise<{ outcomes: ImportConsumptionDateOutcome[]; complete: boolean }> {
  const outcomes: ImportConsumptionDateOutcome[] = [];
  for (let index = 0; index < rows.length; index++) {
    if (signal?.aborted || shouldStop()) {
      outcomes.push(...rows.slice(index).map(unattempted));
      break;
    }
    outcomes.push(await apply(rows[index]!));
  }
  return { outcomes, complete: outcomes.length === rows.length && !signal?.aborted && !shouldStop() };
}
