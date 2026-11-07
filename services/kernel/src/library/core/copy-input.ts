import { COPY_CONDITION_CHOICES, CopyInvalidError } from '../contract/index.ts';
import type {
  CopyConditionValue,
  CopyConditionField,
  CopyConditionPatch,
  CopyInput,
  CopyPatch,
} from '../contract/index.ts';
import { routeOf } from './route.ts';
type TextField = 'location' | 'source' | 'note';
type DateField = 'acquiredOn' | 'disposedOn';

const CREATE_FIELDS = [
  'subjectId',
  'kind',
  'status',
  'location',
  'source',
  'acquiredOn',
  'disposedOn',
  'note',
  'mediaCondition',
  'packagingCondition',
] as const;
const UPDATE_FIELDS = [
  'revision',
  'status',
  'location',
  'source',
  'acquiredOn',
  'disposedOn',
  'note',
  'mediaCondition',
  'packagingCondition',
] as const;
const TEXT_LIMITS = { location: 200, source: 200, note: 1000 } as const;

export class CopyConditionInvalidError extends Error {
  constructor(readonly field: CopyConditionField) {
    super(`Invalid copy field: ${field}`);
    this.name = 'CopyConditionInvalidError';
  }
}

export function isCopyConditionValue(value: unknown): value is CopyConditionValue {
  return COPY_CONDITION_CHOICES.some((choice) => choice.id === value);
}

/** Merge this result into the existing complete command input before hashing it.
 * Missing fields stay missing, so old receipts retain their original operands.
 */
export function parseCopyConditionFields(input: Readonly<Record<string, unknown>>): CopyConditionPatch {
  const patch: { mediaCondition?: CopyConditionValue | null; packagingCondition?: CopyConditionValue | null } = {};
  for (const field of ['mediaCondition', 'packagingCondition'] as const) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (value !== null && !isCopyConditionValue(value)) throw new CopyConditionInvalidError(field);
    patch[field] = value;
  }
  return patch;
}

function conditionPatch(input: Readonly<Record<string, unknown>>): CopyConditionPatch {
  try {
    return parseCopyConditionFields(input);
  } catch (error) {
    if (error instanceof CopyConditionInvalidError) throw new CopyInvalidError(error.field);
    throw error;
  }
}

export function plain(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CopyInvalidError('copy');
  return value as Record<string, unknown>;
}

export function unexpected(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const permit = new Set<string>(allowed);
  let found: string | null = null;
  for (const key of Object.keys(value)) {
    if (permit.has(key)) continue;
    if (found === null || key < found) found = key;
  }
  return found;
}

function within(value: string, max: number): boolean {
  if (value.length <= max) return true;
  if (value.length > max * 2) return false;
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > max) return false;
  }
  return true;
}

/** Calendar date `YYYY-MM-DD`. PostgreSQL `char_length` and date checks reject the same bounds. */
function isoDate(value: string): boolean {
  if (value.length !== 10) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

export function subjectId(value: unknown): string {
  if (typeof value !== 'string' || routeOf(value) === null) throw new CopyInvalidError('subjectId');
  return value;
}

export function vocabularyValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}(?![\s\S])/.test(value)) throw new CopyInvalidError(field);
  return value;
}

function textValue(value: unknown, field: TextField): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !within(value, TEXT_LIMITS[field])) throw new CopyInvalidError(field);
  return value;
}

function dateValue(value: unknown, field: DateField): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !isoDate(value)) throw new CopyInvalidError(field);
  return value;
}

export function revisionValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= 2_147_483_647) {
    throw new CopyInvalidError('revision');
  }
  return value;
}

export function parseCreate(input: unknown): CopyInput {
  const value = plain(input);
  const foreign = unexpected(value, CREATE_FIELDS);
  if (foreign !== null) throw new CopyInvalidError(foreign);
  return {
    subjectId: subjectId(value.subjectId),
    ...(Object.hasOwn(value, 'kind') ? { kind: vocabularyValue(value.kind, 'kind') } : {}),
    ...(Object.hasOwn(value, 'status') ? { status: vocabularyValue(value.status, 'status') } : {}),
    location: textValue(Object.hasOwn(value, 'location') ? value.location : null, 'location'),
    source: textValue(Object.hasOwn(value, 'source') ? value.source : null, 'source'),
    acquiredOn: dateValue(Object.hasOwn(value, 'acquiredOn') ? value.acquiredOn : null, 'acquiredOn'),
    disposedOn: dateValue(Object.hasOwn(value, 'disposedOn') ? value.disposedOn : null, 'disposedOn'),
    note: textValue(Object.hasOwn(value, 'note') ? value.note : null, 'note'),
    ...conditionPatch(value),
  };
}

export function parseUpdate(input: unknown): CopyPatch {
  const value = plain(input);
  const foreign = unexpected(value, UPDATE_FIELDS);
  if (foreign !== null) throw new CopyInvalidError(foreign);
  const patch: CopyPatch = { revision: revisionValue(value.revision) };
  if (Object.hasOwn(value, 'status')) patch.status = vocabularyValue(value.status, 'status');
  if (Object.hasOwn(value, 'location')) patch.location = textValue(value.location, 'location');
  if (Object.hasOwn(value, 'source')) patch.source = textValue(value.source, 'source');
  if (Object.hasOwn(value, 'acquiredOn')) patch.acquiredOn = dateValue(value.acquiredOn, 'acquiredOn');
  if (Object.hasOwn(value, 'disposedOn')) patch.disposedOn = dateValue(value.disposedOn, 'disposedOn');
  if (Object.hasOwn(value, 'note')) patch.note = textValue(value.note, 'note');
  Object.assign(patch, conditionPatch(value));
  return patch;
}

export function parseCopyRestore(copyId: string, input: unknown) {
  const value = plain(input);
  const foreign = unexpected(value, ['deletionId', 'revision']);
  if (foreign !== null) throw new CopyInvalidError(foreign);
  if (
    typeof value.deletionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.deletionId)
  )
    throw new CopyInvalidError('deletionId');
  return { copyId, deletionId: value.deletionId, revision: revisionValue(value.revision) };
}
