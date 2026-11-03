export const MAX_PERSONAL_NOTE_BYTES = 4096;
export const MAX_PERSONAL_PRIORITY = 100;
export const MAX_SOURCE_OBSERVATIONS = 32;
export const MAX_SOURCE_TIMESTAMP_LENGTH = 64;
export const MAX_SOURCE_PRIVACY_VALUE_BYTES = 192;

export type FieldChange<T> =
  | Readonly<{ op: 'unchanged' }>
  | Readonly<{ op: 'clear' }>
  | Readonly<{ op: 'set'; value: T }>;

export type PrivacyValue =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unknown'; sourceValue?: string }>
  | Readonly<{ status: 'known'; meaning: 'private' | 'source_visible' }>;
export type TimestampPrecision = 'year' | 'month' | 'day' | 'minute' | 'second' | 'fraction';
export type TimestampZone = 'utc' | 'offset' | 'unknown';
export type TimestampInput =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unknown'; sourceValue?: string }>
  | Readonly<{ status: 'known'; value: string }>;
export type TimestampValue =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unknown'; sourceValue?: string }>
  | Readonly<{
      status: 'known';
      value: string;
      precision: TimestampPrecision;
      zone: TimestampZone;
    }>;
export type PrivacyFact = PrivacyValue | Readonly<{ status: 'cleared' }>;
export type TimestampFact = TimestampValue | Readonly<{ status: 'cleared' }>;

export type PersonalEntryObservation = Readonly<{
  provider: string;
  recordId: string;
  revision: number;
  privacy: PrivacyFact;
  sourceCreated: TimestampFact;
  sourceUpdated: TimestampFact;
  recordedAt: string;
}>;

export type PersonalEntry = Readonly<{
  subjectId: string;
  annotationRevision: number;
  note: string | null;
  priority: number | null;
  annotationUpdatedAt: string | null;
  sourceObservations: readonly PersonalEntryObservation[];
}>;
export type PersonalEntryFieldChange<T> = FieldChange<T>;
export type PersonalEntryPrivacyValue = PrivacyValue;
export type PersonalEntryPrivacy = PrivacyFact;
export type PersonalEntryTimestampValue = TimestampValue;
export type PersonalEntryTimestamp = TimestampFact;
export type PersonalEntryTimestampInput = TimestampInput;
export type PersonalEntryAnnotationWrite = Readonly<{
  revision: number;
  note: FieldChange<string>;
  priority: FieldChange<number>;
}>;
export type PersonalEntrySourceAdmission = Readonly<{
  provider: string;
  recordId: string;
  confirmReviewed: true;
  privacy: PrivacyValue;
  sourceCreated: TimestampInput;
  sourceUpdated: TimestampInput;
}>;
export type PersonalEntrySourceCorrection = Readonly<{
  provider: string;
  recordId: string;
  revision: number;
  confirmReviewed: true;
  privacy: FieldChange<PrivacyValue>;
  sourceCreated: FieldChange<TimestampInput>;
  sourceUpdated: FieldChange<TimestampInput>;
}>;

export function parsePersonalRevision(value: unknown, allowInitial = true): number {
  const minimum = allowInitial ? 0 : 1;
  if (!Number.isInteger(value) || typeof value !== 'number' || value < minimum || value >= 2_147_483_647)
    throw new TypeError('Invalid personal entry revision');
  return value;
}

export function parsePersonalNote(value: unknown): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.includes('\u0000') ||
    new TextEncoder().encode(value).byteLength > MAX_PERSONAL_NOTE_BYTES
  )
    throw new TypeError('Invalid personal note');
  return value;
}

export function parsePersonalPriority(value: unknown): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1 || value > MAX_PERSONAL_PRIORITY)
    throw new TypeError('Invalid personal priority');
  return value;
}

function closedObject(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`Invalid ${name}`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key))) throw new TypeError(`Invalid ${name}`);
  return record;
}

export function parseFieldChange<T>(value: unknown, parse: (input: unknown) => T): FieldChange<T> {
  const record = closedObject(value, ['op', 'value'], 'field change');
  if (record.op === 'unchanged' && Object.keys(record).length === 1) return { op: 'unchanged' };
  if (record.op === 'clear' && Object.keys(record).length === 1) return { op: 'clear' };
  if (record.op === 'set' && Object.keys(record).length === 2) return { op: 'set', value: parse(record.value) };
  throw new TypeError('Invalid field change');
}

export function applyFieldChange<T>(current: T | null, change: FieldChange<T>): T | null {
  if (change.op === 'unchanged') return current;
  return change.op === 'clear' ? null : change.value;
}

export function parseProviderKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  )
    throw new TypeError('Invalid provider key');
  return value;
}

export function parseProviderRecordId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > 192 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new TypeError('Invalid provider record id');
  return value;
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

/** Preserve provider precision and offset exactly. Never parse through Date or normalize a source value. */
export function parseSourceTimestamp(value: unknown): Extract<TimestampValue, { status: 'known' }> {
  if (typeof value !== 'string' || value.length < 4 || value.length > MAX_SOURCE_TIMESTAMP_LENGTH)
    throw new TypeError('Invalid source timestamp');
  let match = /^(\d{4})$/.exec(value);
  if (match) {
    if (Number(match[1]) < 1) throw new TypeError('Invalid source timestamp');
    return { status: 'known', value, precision: 'year', zone: 'unknown' };
  }
  match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match) {
    if (!validDate(Number(match[1]), Number(match[2]), 1)) throw new TypeError('Invalid source timestamp');
    return { status: 'known', value, precision: 'month', zone: 'unknown' };
  }
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    if (!validDate(Number(match[1]), Number(match[2]), Number(match[3]))) throw new TypeError('Invalid source timestamp');
    return { status: 'known', value, precision: 'day', zone: 'unknown' };
  }
  match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,18}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) throw new TypeError('Invalid source timestamp');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59)
    throw new TypeError('Invalid source timestamp');
  if (offset && offset !== 'Z') {
    const hours = Number(offset.slice(1, 3));
    const minutes = Number(offset.slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0))
      throw new TypeError('Invalid source timestamp');
  }
  return {
    status: 'known',
    value,
    precision: fraction ? 'fraction' : secondText === undefined ? 'minute' : 'second',
    zone: offset === 'Z' ? 'utc' : offset && offset !== '-00:00' ? 'offset' : 'unknown',
  };
}

export function parsePrivacyValue(value: unknown): PrivacyValue {
  const record = closedObject(value, ['status', 'meaning', 'sourceValue'], 'privacy value');
  if (record.status === 'absent' && Object.keys(record).length === 1) return { status: 'absent' };
  if (record.status === 'unknown' && Object.keys(record).length === 1) return { status: 'unknown' };
  if (record.status === 'unknown' && Object.keys(record).length === 2 && 'sourceValue' in record)
    return { status: 'unknown', sourceValue: parseSourceValue(record.sourceValue, MAX_SOURCE_PRIVACY_VALUE_BYTES, 'source privacy value') };
  if (
    record.status === 'known' &&
    Object.keys(record).length === 2 &&
    (record.meaning === 'private' || record.meaning === 'source_visible')
  )
    return { status: 'known', meaning: record.meaning };
  throw new TypeError('Invalid source privacy value');
}

export function parseTimestampValue(value: unknown): TimestampValue {
  const record = closedObject(value, ['status', 'value', 'sourceValue'], 'timestamp value');
  if (record.status === 'absent' && Object.keys(record).length === 1) return { status: 'absent' };
  if (record.status === 'unknown' && Object.keys(record).length === 1) return { status: 'unknown' };
  if (record.status === 'unknown' && Object.keys(record).length === 2 && 'sourceValue' in record) {
    const sourceValue = parseSourceValue(record.sourceValue, MAX_SOURCE_TIMESTAMP_LENGTH, 'source timestamp');
    if (/^\d{4}(?:-\d{2}(?:-\d{2})?)?(?:T.*)?$/.test(sourceValue)) parseSourceTimestamp(sourceValue);
    return { status: 'unknown', sourceValue };
  }
  if (record.status === 'known' && Object.keys(record).length === 2) return parseSourceTimestamp(record.value);
  throw new TypeError('Invalid source timestamp value');
}

function parseSourceValue(value: unknown, maximumBytes: number, name: string): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximumBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) throw new TypeError(`Invalid ${name}`);
  return value;
}

export function parsePrivacyChange(value: unknown): FieldChange<PrivacyValue> {
  return parseFieldChange(value, parsePrivacyValue);
}

export function parseTimestampChange(value: unknown): FieldChange<TimestampValue> {
  return parseFieldChange(value, parseTimestampValue);
}

export function parseConfirmation(value: unknown): true {
  if (value !== true) throw new TypeError('Source record requires explicit review confirmation');
  return true;
}

export function factStatus<T extends { status: string }>(
  value: T | null,
): T | Readonly<{ status: 'cleared' }> {
  return value ?? { status: 'cleared' };
}
