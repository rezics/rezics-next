import type { LibraryProgressUnitDescriptor } from './profile.ts';
import { acceptsProfileDecimal } from './profile-decimal.ts';
import { routeOf } from '../route/route.ts';

/**
 * Pure rules for progress sessions. Commands own the account and the stored rows.
 * A reread is a new session; nothing here rewrites another one.
 */
export const MAX_COMPLETED_UNITS = 20_000;
export const MAX_PROGRESS_MEASURES = 8;

const MAX_UNIT_IDS = 100;
const MAX_LOCATOR_LENGTH = 256;
const MAX_INTEGER_DIGITS = 12;
const MAX_FRACTION_DIGITS = 6;
const MAX_DECIMAL_LENGTH = MAX_INTEGER_DIGITS + 1 + MAX_FRACTION_DIGITS;

const MODES = new Set<string>(['scalar_amount', 'cursor_position', 'completed_units']);
const UNITS = new Set<string>(['page', 'chapter', 'episode', 'volume', 'minute', 'percent']);
const STATES = new Set<string>(['active', 'completed', 'abandoned']);
const CREATE_FIELDS = ['subjectId', 'versionSubjectId', 'mode', 'unit', 'total', 'additionalMeasures'];

export type ProgressMode = 'scalar_amount' | 'cursor_position' | 'completed_units';
export type ProgressUnit = string;
export type ProgressState = 'active' | 'completed' | 'abandoned';
export type ProgressAction = 'complete' | 'abandon';

export type ProgressSessionCreate = {
  subjectId: string;
  versionSubjectId: string | null;
  mode: ProgressMode;
  unit: ProgressUnit;
  total: string | null;
  additionalMeasures?: ProgressMeasureCreate[];
};

export type ProgressMeasureCreate = { unit: ProgressUnit; total: string | null };

export type ScalarRecord = { amount: string };
export type CursorRecord = { locator: string; position: string };
export type CompletedUnitsRecord =
  | { add: readonly string[] }
  | { remove: readonly string[] }
  | { add: readonly string[]; remove: readonly string[] };
export type ProgressRecord = ScalarRecord | CursorRecord | CompletedUnitsRecord;

/** History payload. Unit ids are the ones given, sorted by code unit, never a filled range. */
export type ProgressIntent =
  | { clear: true }
  | { measureId: string; clear: true }
  | { amount: string }
  | { measureId: string; amount: string }
  | { locator: string; position: string }
  | { add: string[] }
  | { remove: string[] }
  | { add: string[]; remove: string[] };

export type ProgressInvalid = { ok: false; field: string };
export type ProgressOutcome<T> = { ok: true; value: T } | ProgressInvalid;

/** Facts from the session a record is checked against. */
export type ProgressRecordContext = { unit: ProgressUnit; state: ProgressState };

type Decimal = { text: string; whole: string; fraction: string };

function invalid(field: string): ProgressInvalid {
  return { ok: false, field };
}

function isMode(value: unknown): value is ProgressMode {
  return typeof value === 'string' && MODES.has(value);
}

function isVocabularyId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.exec(value)?.[0] === value;
}

function isUnit(value: unknown): value is string {
  return typeof value === 'string' && UNITS.has(value);
}

function isState(value: unknown): value is ProgressState {
  return typeof value === 'string' && STATES.has(value);
}

function isSubjectId(value: unknown): value is string {
  return typeof value === 'string' && routeOf(value) !== null;
}

function plain(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstUnexpected(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const permit = new Set<string>(allowed);
  let found: string | null = null;
  for (const key of Object.keys(value)) {
    if (permit.has(key)) continue;
    if (found === null || key < found) found = key;
  }
  return found;
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Non-negative decimal text: at most 12 integer digits and 6 fractional digits, with no leading zero. */
function decimalParts(value: unknown): Decimal | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DECIMAL_LENGTH) return null;
  let dot = -1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 46) {
      if (dot !== -1) return null;
      dot = index;
      continue;
    }
    if (code < 48 || code > 57) return null;
  }
  const whole = dot === -1 ? value : value.slice(0, dot);
  const fraction = dot === -1 ? '' : value.slice(dot + 1);
  if (whole.length === 0 || whole.length > MAX_INTEGER_DIGITS) return null;
  if (dot !== -1 && (fraction.length === 0 || fraction.length > MAX_FRACTION_DIGITS)) return null;
  if (whole.length > 1 && whole.charCodeAt(0) === 48) return null;
  return { text: value, whole, fraction };
}

/** Digit-wise comparison with 100. Equal-length digit strings order numerically. */
function aboveHundred(value: Decimal): boolean {
  if (value.whole.length > 3) return true;
  if (value.whole.length < 3) return false;
  if (value.whole > '100') return true;
  if (value.whole < '100') return false;
  for (let index = 0; index < value.fraction.length; index += 1) {
    if (value.fraction.charCodeAt(index) !== 48) return true;
  }
  return false;
}

function boundedDecimal(value: unknown, percent: boolean): string | null {
  const parsed = decimalParts(value);
  if (parsed === null || (percent && aboveHundred(parsed))) return null;
  return parsed.text;
}

/** A descriptor is trusted compiled data; absence is the temporary legacy adapter only. */
function numeric(
  value: unknown,
  legacyPercent: boolean,
  descriptor?: LibraryProgressUnitDescriptor | 'syntax',
): string | null {
  if (descriptor === undefined) return boundedDecimal(value, legacyPercent);
  return typeof value === 'string' && acceptsProfileDecimal(descriptor === 'syntax' ? {} : descriptor, value)
    ? value
    : null;
}

function isUnitId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const digit = code >= 48 && code <= 57;
    const upper = code >= 65 && code <= 90;
    const lower = code >= 97 && code <= 122;
    const mark = code === 45 || code === 46 || code === 58 || code === 95 || code === 126;
    if (!digit && !upper && !lower && !mark) return false;
  }
  return true;
}

function unitList(value: unknown, field: 'add' | 'remove'): ProgressOutcome<string[] | null> {
  if (value === undefined) return { ok: true, value: null };
  if (!Array.isArray(value) || value.length > MAX_UNIT_IDS) return invalid(field);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isUnitId(entry) || seen.has(entry)) return invalid(field);
    seen.add(entry);
    ids.push(entry);
  }
  return { ok: true, value: ids };
}

function nonempty(ids: string[] | null): string[] | null {
  return ids !== null && ids.length > 0 ? ids : null;
}

function completedUnits(value: Record<string, unknown>): ProgressOutcome<CompletedUnitsRecord> {
  const foreign = firstUnexpected(value, ['add', 'remove']);
  if (foreign !== null) return invalid(foreign);
  const add = unitList(value.add, 'add');
  if (!add.ok) return add;
  const remove = unitList(value.remove, 'remove');
  if (!remove.ok) return remove;
  // One request holds at most 100 ids, counting add and remove together.
  if ((add.value?.length ?? 0) + (remove.value?.length ?? 0) > MAX_UNIT_IDS) {
    return invalid(remove.value === null ? 'add' : 'remove');
  }
  if (add.value !== null && remove.value !== null) {
    const added = new Set(add.value);
    for (const id of remove.value) {
      if (added.has(id)) return invalid('remove');
    }
  }
  const addIds = nonempty(add.value);
  const removeIds = nonempty(remove.value);
  if (addIds !== null && removeIds !== null) return { ok: true, value: { add: addIds, remove: removeIds } };
  if (addIds !== null) return { ok: true, value: { add: addIds } };
  if (removeIds !== null) return { ok: true, value: { remove: removeIds } };
  return invalid('add');
}

function scalar(
  value: Record<string, unknown>,
  unit: ProgressUnit,
  descriptor?: LibraryProgressUnitDescriptor | 'syntax',
): ProgressOutcome<ScalarRecord> {
  const foreign = firstUnexpected(value, ['amount']);
  if (foreign !== null) return invalid(foreign);
  const amount = numeric(value.amount, unit === 'percent', descriptor);
  if (amount === null) return invalid('amount');
  return { ok: true, value: { amount } };
}

function cursor(
  value: Record<string, unknown>,
  descriptor?: LibraryProgressUnitDescriptor | 'syntax',
): ProgressOutcome<CursorRecord> {
  const foreign = firstUnexpected(value, ['locator', 'position']);
  if (foreign !== null) return invalid(foreign);
  if (typeof value.locator !== 'string' || value.locator.length < 1 || value.locator.length > MAX_LOCATOR_LENGTH) {
    return invalid('locator');
  }
  const position = numeric(value.position, false, descriptor);
  if (position === null) return invalid('position');
  return { ok: true, value: { locator: value.locator, position } };
}

/** Validate one new session. `total` belongs only to `scalar_amount` and is null when unknown. */
export function parseSessionCreate(
  input: unknown,
  descriptor?: LibraryProgressUnitDescriptor | 'syntax',
): ProgressOutcome<ProgressSessionCreate> {
  const value = plain(input);
  if (value === null) return invalid('session');
  const foreign = firstUnexpected(value, CREATE_FIELDS);
  if (foreign !== null) return invalid(foreign);
  if (!isSubjectId(value.subjectId)) return invalid('subjectId');
  let versionSubjectId: string | null = null;
  if (Object.hasOwn(value, 'versionSubjectId') && value.versionSubjectId !== null) {
    if (!isSubjectId(value.versionSubjectId)) return invalid('versionSubjectId');
    versionSubjectId = value.versionSubjectId;
  }
  if (!isMode(value.mode)) return invalid('mode');
  if (typeof value.unit !== 'string' || (descriptor === undefined ? !isUnit(value.unit) : !isVocabularyId(value.unit)))
    return invalid('unit');
  let total: string | null = null;
  if (Object.hasOwn(value, 'total') && value.total !== null) {
    if (value.mode !== 'scalar_amount') return invalid('total');
    const parsed = numeric(value.total, value.unit === 'percent', descriptor);
    if (parsed === null) return invalid('total');
    total = parsed;
  }
  if (descriptor !== undefined && descriptor !== 'syntax') {
    if (descriptor.totalPolicy === 'required' && total === null) return invalid('total');
    if (descriptor.totalPolicy === 'forbidden' && total !== null) return invalid('total');
  }
  let additionalMeasures: ProgressMeasureCreate[] | undefined;
  if (Object.hasOwn(value, 'additionalMeasures')) {
    if (value.mode !== 'scalar_amount' || !Array.isArray(value.additionalMeasures))
      return invalid('additionalMeasures');
    if (value.additionalMeasures.length < 1 || value.additionalMeasures.length >= MAX_PROGRESS_MEASURES)
      return invalid('additionalMeasures');
    const seen = new Set<string>([value.unit]);
    additionalMeasures = [];
    for (const inputMeasure of value.additionalMeasures) {
      const measure = parseProgressMeasureCreate(inputMeasure, descriptor === undefined ? undefined : 'syntax');
      if (!measure.ok) return invalid(`additionalMeasures.${measure.field}`);
      if (seen.has(measure.value.unit)) return invalid('additionalMeasures');
      seen.add(measure.value.unit);
      additionalMeasures.push(measure.value);
    }
    additionalMeasures.sort((left, right) => byCodeUnit(left.unit, right.unit));
  }
  return {
    ok: true,
    value: {
      subjectId: value.subjectId,
      versionSubjectId,
      mode: value.mode,
      unit: value.unit,
      total,
      ...(additionalMeasures === undefined ? {} : { additionalMeasures }),
    },
  };
}

/** Validate an additional independent scalar unit using the same profile decimal and total rules. */
export function parseProgressMeasureCreate(
  input: unknown,
  descriptor?: LibraryProgressUnitDescriptor | 'syntax',
): ProgressOutcome<ProgressMeasureCreate> {
  const value = plain(input);
  if (value === null) return invalid('measure');
  const foreign = firstUnexpected(value, ['unit', 'total']);
  if (foreign !== null) return invalid(foreign);
  if (typeof value.unit !== 'string' || (descriptor === undefined ? !isUnit(value.unit) : !isVocabularyId(value.unit)))
    return invalid('unit');
  let total: string | null = null;
  if (Object.hasOwn(value, 'total') && value.total !== null) {
    total = numeric(value.total, value.unit === 'percent', descriptor);
    if (total === null) return invalid('total');
  }
  if (descriptor !== undefined && descriptor !== 'syntax') {
    if (descriptor.totalPolicy === 'required' && total === null) return invalid('total');
    if (descriptor.totalPolicy === 'forbidden' && total !== null) return invalid('total');
  }
  return { ok: true, value: { unit: value.unit, total } };
}

/**
 * Validate one record for `mode`. Only an active session records.
 * Legacy percent amounts stay within 0 to 100; profiled amounts use only declared bounds.
 */
export function parseRecord(
  mode: ProgressMode,
  input: unknown,
  context: ProgressRecordContext,
  descriptor?: LibraryProgressUnitDescriptor | 'syntax',
): ProgressOutcome<ProgressRecord> {
  if (!isMode(mode)) return invalid('mode');
  if (typeof context !== 'object' || context === null || !isState(context.state)) return invalid('state');
  if (context.state !== 'active') return invalid('state');
  if (descriptor === undefined ? !isUnit(context.unit) : !isVocabularyId(context.unit)) return invalid('unit');
  const value = plain(input);
  if (value === null) return invalid('record');
  if (mode === 'scalar_amount') return scalar(value, context.unit, descriptor);
  if (mode === 'cursor_position') return cursor(value, descriptor);
  return completedUnits(value);
}

/** Complete or abandon an active session. An amount, position, or unit count is not an action. */
export function transition(state: ProgressState, action: ProgressAction): ProgressOutcome<ProgressState> {
  if (!isState(state)) return invalid('state');
  if (action !== 'complete' && action !== 'abandon') return invalid('action');
  if (state !== 'active') return invalid('state');
  return { ok: true, value: action === 'complete' ? 'completed' : 'abandoned' };
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort(byCodeUnit);
}

/** The history row for a validated record. Unit ids stay the given ids, in code-unit order. */
export function changeIntent(record: ProgressRecord, measureId?: string): ProgressIntent {
  if ('amount' in record)
    return measureId === undefined ? { amount: record.amount } : { measureId, amount: record.amount };
  if ('locator' in record) return { locator: record.locator, position: record.position };
  if ('add' in record && 'remove' in record) return { add: sortedIds(record.add), remove: sortedIds(record.remove) };
  if ('add' in record) return { add: sortedIds(record.add) };
  return { remove: sortedIds(record.remove) };
}

/**
 * Next sparse-set size. `added` is how many submitted ids were new.
 * `removed` is how many submitted ids already existed.
 */
export function nextUnitCount(current: number, added: number, removed: number): ProgressOutcome<number> {
  if (!Number.isSafeInteger(current) || current < 0) return invalid('current');
  if (!Number.isSafeInteger(added) || added < 0) return invalid('added');
  if (!Number.isSafeInteger(removed) || removed < 0 || removed > current) return invalid('removed');
  const kept = current - removed;
  if (kept > MAX_COMPLETED_UNITS || added > MAX_COMPLETED_UNITS - kept) return invalid('completedUnitCount');
  return { ok: true, value: kept + added };
}
