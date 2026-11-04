import type {
  PersonalEntryFieldChange,
  PersonalEntryObservation,
  PersonalEntryPrivacyValue,
  PersonalEntrySourceCorrection,
  PersonalEntryTimestampInput,
} from '@rezics/client';

export type CorrectionOperation = 'preserve' | 'clear' | 'set';
export type TimestampChoice = 'known' | 'unknown' | 'absent';
export type PrivacyChoice = 'private' | 'source_visible' | 'unknown' | 'absent';

export type PrivacyCorrectionDraft = Readonly<{
  operation: CorrectionOperation;
  choice: PrivacyChoice;
  sourceValue: string;
}>;

export type TimestampCorrectionDraft = Readonly<{
  operation: CorrectionOperation;
  choice: TimestampChoice;
  value: string;
  sourceValue: string;
}>;

export type SourceCorrectionDraft = Readonly<{
  privacy: PrivacyCorrectionDraft;
  sourceCreated: TimestampCorrectionDraft;
  sourceUpdated: TimestampCorrectionDraft;
}>;

export type SourceCorrectionIssue =
  | 'malformed'
  | 'unsupported-calendar'
  | 'invalid-calendar-date'
  | 'invalid-time'
  | 'invalid-offset'
  | 'native-limit'
  | 'privacy-invalid'
  | 'privacy-limit';

export type TimestampShape = Readonly<{
  precision: 'year' | 'month' | 'day' | 'minute' | 'second' | 'fraction';
  zone: 'utc' | 'offset' | 'unknown';
}>;

export type SourceCorrectionBuild =
  | Readonly<{ kind: 'ready'; body: PersonalEntrySourceCorrection }>
  | Readonly<{ kind: 'invalid'; issues: Partial<Record<'privacy' | 'sourceCreated' | 'sourceUpdated', SourceCorrectionIssue>> }>;

const MAX_SOURCE_TIMESTAMP_LENGTH = 64;
const MAX_SOURCE_PRIVACY_LENGTH = 192;
const MAX_SOURCE_FRACTION_DIGITS = 18;

function initialPrivacyChoice(value: PersonalEntryObservation['privacy']): PrivacyChoice {
  if (value.status === 'known') return value.meaning;
  return value.status === 'absent' ? 'absent' : 'unknown';
}

function initialTimestampChoice(value: PersonalEntryObservation['sourceCreated']): TimestampChoice {
  if (value.status === 'known') return 'known';
  return value.status === 'absent' ? 'absent' : 'unknown';
}

function initialTimestampText(value: PersonalEntryObservation['sourceCreated']): string {
  if (value.status === 'known') return value.value;
  return value.status === 'unknown' ? (value.sourceValue ?? '') : '';
}

export function sourceCorrectionDraftOf(observation: PersonalEntryObservation): SourceCorrectionDraft {
  return {
    privacy: {
      operation: 'preserve',
      choice: initialPrivacyChoice(observation.privacy),
      sourceValue: observation.privacy.status === 'unknown' ? (observation.privacy.sourceValue ?? '') : '',
    },
    sourceCreated: {
      operation: 'preserve',
      choice: initialTimestampChoice(observation.sourceCreated),
      value: initialTimestampText(observation.sourceCreated),
      sourceValue: initialTimestampText(observation.sourceCreated),
    },
    sourceUpdated: {
      operation: 'preserve',
      choice: initialTimestampChoice(observation.sourceUpdated),
      value: initialTimestampText(observation.sourceUpdated),
      sourceValue: initialTimestampText(observation.sourceUpdated),
    },
  };
}

function leapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validDate(year: number, month: number, day: number) {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function dateIssue(year: number, month?: number, day?: number): SourceCorrectionIssue | null {
  if (year === 0) return 'unsupported-calendar';
  if (month === undefined) return year >= 1 && year <= 9999 ? null : 'unsupported-calendar';
  if (month < 1 || month > 12) return 'invalid-calendar-date';
  if (day === undefined) return null;
  return validDate(year, month, day) ? null : 'invalid-calendar-date';
}

function offsetIssue(offset: string | undefined): SourceCorrectionIssue | null {
  if (!offset || offset === 'Z') return null;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  return hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0) ? 'invalid-offset' : null;
}

function timestampZone(offset: string | undefined): TimestampShape['zone'] {
  if (offset === 'Z') return 'utc';
  if (offset && offset !== '-00:00') return 'offset';
  return 'unknown';
}

function fractionLimit(value: string) {
  const fraction = /\.(\d+)/.exec(value)?.[1];
  return fraction !== undefined && fraction.length > MAX_SOURCE_FRACTION_DIGITS;
}

function malformedOffset(value: string) {
  return value.includes('T') && /[+-][^T]*$/.test(value) && !/[+-]\d{2}:\d{2}$/.test(value);
}

/** Mirrors the native timestamp grammar for immediate, field-specific editing feedback. */
export function inspectSourceTimestamp(value: string): TimestampShape | SourceCorrectionIssue {
  if (value.length > MAX_SOURCE_TIMESTAMP_LENGTH || fractionLimit(value)) return 'native-limit';
  if (value.length < 4) return 'malformed';

  let match = /^(\d{4})$/.exec(value);
  if (match) {
    const issue = dateIssue(Number(match[1]));
    return issue ?? { precision: 'year', zone: 'unknown' };
  }

  match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match) {
    const issue = dateIssue(Number(match[1]), Number(match[2]));
    return issue ?? { precision: 'month', zone: 'unknown' };
  }

  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    const issue = dateIssue(Number(match[1]), Number(match[2]), Number(match[3]));
    return issue ?? { precision: 'day', zone: 'unknown' };
  }

  match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,18}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(
    value,
  );
  if (!match) return malformedOffset(value) ? 'invalid-offset' : 'malformed';

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, offset] = match;
  const issue = dateIssue(Number(yearText), Number(monthText), Number(dayText));
  if (issue) return issue;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return 'invalid-time';
  if (fraction && fraction.length > MAX_SOURCE_FRACTION_DIGITS) return 'native-limit';
  const badOffset = offsetIssue(offset);
  if (badOffset) return badOffset;
  return {
    precision: fraction ? 'fraction' : secondText === undefined ? 'minute' : 'second',
    zone: timestampZone(offset),
  };
}

function timestampInput(field: TimestampCorrectionDraft): PersonalEntryTimestampInput | SourceCorrectionIssue {
  if (field.choice === 'absent') return { status: 'absent' };
  if (field.choice === 'unknown') {
    if (new TextEncoder().encode(field.sourceValue).byteLength > MAX_SOURCE_TIMESTAMP_LENGTH) return 'native-limit';
    if (/[\u0000-\u001f\u007f]/.test(field.sourceValue)) return 'malformed';
    if (/^\d{4}(?:-\d{2}(?:-\d{2})?)?(?:T.*)?$/.test(field.sourceValue)) {
      const check = inspectSourceTimestamp(field.sourceValue);
      if (typeof check === 'string') return check;
    }
    return field.sourceValue ? { status: 'unknown', sourceValue: field.sourceValue } : { status: 'unknown' };
  }
  const check = inspectSourceTimestamp(field.value);
  return typeof check === 'string' ? check : { status: 'known', value: field.value };
}

function privacyInput(field: PrivacyCorrectionDraft): PersonalEntryPrivacyValue | SourceCorrectionIssue {
  if (field.choice === 'absent') return { status: 'absent' };
  if (field.choice === 'unknown') {
    if (new TextEncoder().encode(field.sourceValue).byteLength > MAX_SOURCE_PRIVACY_LENGTH) return 'privacy-limit';
    if (/[\u0000-\u001f\u007f]/.test(field.sourceValue)) return 'privacy-invalid';
    return field.sourceValue ? { status: 'unknown', sourceValue: field.sourceValue } : { status: 'unknown' };
  }
  return { status: 'known', meaning: field.choice };
}

function fieldChange<T>(operation: CorrectionOperation, value: T | SourceCorrectionIssue): PersonalEntryFieldChange<T> | SourceCorrectionIssue {
  if (operation === 'preserve') return { op: 'unchanged' };
  if (operation === 'clear') return { op: 'clear' };
  if (typeof value === 'string') return value;
  return { op: 'set', value };
}

function changed(change: PersonalEntryFieldChange<unknown>) {
  return change.op !== 'unchanged';
}

function isIssue(value: unknown): value is SourceCorrectionIssue {
  return (
    value === 'malformed' ||
    value === 'unsupported-calendar' ||
    value === 'invalid-calendar-date' ||
    value === 'invalid-time' ||
    value === 'invalid-offset' ||
    value === 'native-limit' ||
    value === 'privacy-invalid' ||
    value === 'privacy-limit'
  );
}

export function buildSourceCorrection(
  observation: PersonalEntryObservation,
  draft: SourceCorrectionDraft,
): SourceCorrectionBuild {
  const privacyValue = draft.privacy.operation === 'set' ? privacyInput(draft.privacy) : { status: 'unknown' as const };
  const createdValue = draft.sourceCreated.operation === 'set' ? timestampInput(draft.sourceCreated) : { status: 'unknown' as const };
  const updatedValue = draft.sourceUpdated.operation === 'set' ? timestampInput(draft.sourceUpdated) : { status: 'unknown' as const };
  const privacy = fieldChange(draft.privacy.operation, privacyValue);
  const sourceCreated = fieldChange(draft.sourceCreated.operation, createdValue);
  const sourceUpdated = fieldChange(draft.sourceUpdated.operation, updatedValue);
  const issues: Partial<Record<'privacy' | 'sourceCreated' | 'sourceUpdated', SourceCorrectionIssue>> = {};
  if (isIssue(privacy)) issues.privacy = privacy;
  if (isIssue(sourceCreated)) issues.sourceCreated = sourceCreated;
  if (isIssue(sourceUpdated)) issues.sourceUpdated = sourceUpdated;
  if (Object.keys(issues).length) return { kind: 'invalid', issues };
  if (!changed(privacy) && !changed(sourceCreated) && !changed(sourceUpdated))
    return { kind: 'invalid', issues: {} };
  return {
    kind: 'ready',
    body: {
      provider: observation.provider,
      recordId: observation.recordId,
      revision: observation.revision,
      confirmReviewed: true,
      privacy: privacy as PersonalEntryFieldChange<PersonalEntryPrivacyValue>,
      sourceCreated: sourceCreated as PersonalEntryFieldChange<PersonalEntryTimestampInput>,
      sourceUpdated: sourceUpdated as PersonalEntryFieldChange<PersonalEntryTimestampInput>,
    },
  };
}

export function sourceCorrectionHasChanges(draft: SourceCorrectionDraft) {
  return draft.privacy.operation !== 'preserve' ||
    draft.sourceCreated.operation !== 'preserve' ||
    draft.sourceUpdated.operation !== 'preserve';
}

