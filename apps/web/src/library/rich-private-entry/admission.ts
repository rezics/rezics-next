import type {
  PersonalEntryPrivacyValue,
  PersonalEntrySourceAdmission,
  PersonalEntryTimestampInput,
} from '@rezics/client';

export const SOURCE_PROVIDER_MAX = 64;
export const SOURCE_RECORD_BYTES = 192;
export const SOURCE_PRIVACY_BYTES = 192;
export const SOURCE_TIMESTAMP_BYTES = 64;

export type SourceAdmissionStatus = 'admitted' | 'unsupported' | 'conflict' | 'failed';
export type SourceAdmissionOutcome = { status: SourceAdmissionStatus; reason?: string };

export type ReadyPrivacy = { kind: 'ready'; value: PersonalEntryPrivacyValue };
export type ReadyTimestamp = { kind: 'ready'; value: PersonalEntryTimestampInput };
export type UnsupportedSourceField = { kind: 'unsupported'; reason: string };
export type SourcePrivacyField = ReadyPrivacy | UnsupportedSourceField;
export type SourceTimestampField = ReadyTimestamp | UnsupportedSourceField;

export type SourceAdmissionPreview = {
  provider: string;
  recordId: string;
  privacy: SourcePrivacyField;
  sourceCreated: SourceTimestampField;
  sourceUpdated: SourceTimestampField;
};

const providerKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedToken(value: string, maxBytes: number): string | null {
  if (value.length === 0 || utf8Bytes(value) > maxBytes || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export function validProviderKey(value: string): boolean {
  return providerKey.test(value) && value.length <= SOURCE_PROVIDER_MAX;
}

export function validRecordId(value: string): boolean {
  return value.length > 0 && utf8Bytes(value) <= SOURCE_RECORD_BYTES && !/[\u0000-\u001f\u007f]/.test(value);
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

/** True when the original string is an admitted native timestamp. Never uses Date or a host zone. */
export function isKnownSourceTimestamp(value: string): boolean {
  if (value.length < 4 || value.length > SOURCE_TIMESTAMP_BYTES) return false;
  let match = /^(\d{4})$/.exec(value);
  if (match) return Number(match[1]) >= 1;
  match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match) return validDate(Number(match[1]), Number(match[2]), 1);
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,18}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (!validDate(Number(yearText), Number(monthText), Number(dayText)) || hour > 23 || minute > 59 || second > 59)
    return false;
  if (offset && offset !== 'Z') {
    const hours = Number(offset.slice(1, 3));
    const minutes = Number(offset.slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return false;
  }
  return true;
}

export function absentPrivacy(): ReadyPrivacy {
  return { kind: 'ready', value: { status: 'absent' } };
}

export function absentTimestamp(): ReadyTimestamp {
  return { kind: 'ready', value: { status: 'absent' } };
}

export function booleanPrivacy(value: boolean): ReadyPrivacy {
  return { kind: 'ready', value: { status: 'known', meaning: value ? 'private' : 'source_visible' } };
}

export function unknownPrivacy(sourceValue?: string): SourcePrivacyField {
  if (sourceValue === undefined) return { kind: 'ready', value: { status: 'unknown' } };
  const token = boundedToken(sourceValue, SOURCE_PRIVACY_BYTES);
  return token
    ? { kind: 'ready', value: { status: 'unknown', sourceValue: token } }
    : { kind: 'unsupported', reason: 'The retained privacy token cannot fit native evidence.' };
}

export function privacyFromToken(raw: string): SourcePrivacyField {
  const token = raw.trim().toLowerCase();
  if (token === 'private' || token === 'true' || token === '1') return booleanPrivacy(true);
  if (token === 'public' || token === 'false' || token === '0') return booleanPrivacy(false);
  return unknownPrivacy(raw);
}

export function timestampFromText(raw: string, mode: 'parse' | 'unknown'): SourceTimestampField {
  if (raw.length === 0) return { kind: 'unsupported', reason: 'An empty timestamp is not an absent timestamp.' };
  if (mode === 'parse' && isKnownSourceTimestamp(raw)) return { kind: 'ready', value: { status: 'known', value: raw } };
  const token = boundedToken(raw, SOURCE_TIMESTAMP_BYTES);
  if (token && (mode === 'unknown' || !/^\d{4}(?:-\d{2})?(?:-\d{2})?(?:T|$)/.test(raw)))
    return { kind: 'ready', value: { status: 'unknown', sourceValue: token } };
  return { kind: 'unsupported', reason: 'The retained timestamp cannot keep its original precision.' };
}

export function timestampFromUnix(value: number): SourceTimestampField {
  if (!Number.isSafeInteger(value) || value < 0)
    return { kind: 'unsupported', reason: 'The retained timestamp cannot keep its original precision.' };
  return timestampFromText(String(value), 'unknown');
}

export function unsupportedField(reason: string): UnsupportedSourceField {
  return { kind: 'unsupported', reason };
}

export function sourceAdmissionBody(preview: SourceAdmissionPreview): PersonalEntrySourceAdmission | null {
  if (!validProviderKey(preview.provider) || !validRecordId(preview.recordId)) return null;
  if (
    preview.privacy.kind !== 'ready' ||
    preview.sourceCreated.kind !== 'ready' ||
    preview.sourceUpdated.kind !== 'ready'
  )
    return null;
  return {
    provider: preview.provider,
    recordId: preview.recordId,
    confirmReviewed: true,
    privacy: preview.privacy.value,
    sourceCreated: preview.sourceCreated.value,
    sourceUpdated: preview.sourceUpdated.value,
  };
}

export function sourceAdmissionBlock(preview: SourceAdmissionPreview): string | null {
  if (!validProviderKey(preview.provider) || !validRecordId(preview.recordId))
    return 'This provider record has no stable identity.';
  if (preview.privacy.kind === 'unsupported') return preview.privacy.reason;
  if (preview.sourceCreated.kind === 'unsupported') return preview.sourceCreated.reason;
  if (preview.sourceUpdated.kind === 'unsupported') return preview.sourceUpdated.reason;
  return null;
}

export type SourceAdmissionPortResult<C> =
  | { kind: 'admitted' }
  | { kind: 'conflict' }
  | { kind: 'denied' }
  | { kind: 'not-found' }
  | { kind: 'unavailable' }
  | { kind: 'unknown'; command: C };

export function mapSourceAdmissionPort<C>(result: { kind: string }, command: C): SourceAdmissionPortResult<C> {
  if (result.kind === 'admitted') return { kind: 'admitted' };
  if (result.kind === 'conflict') return { kind: 'conflict' };
  if (result.kind === 'denied') return { kind: 'denied' };
  if (result.kind === 'missing') return { kind: 'not-found' };
  if (result.kind === 'signed-out' || result.kind === 'retired' || result.kind === 'uncertain')
    return { kind: 'unknown', command };
  return { kind: 'unavailable' };
}
