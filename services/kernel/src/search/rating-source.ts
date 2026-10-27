import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { routeOf } from '../route/route.ts';

export type PublicRatingFigure = {
  questionId: string;
  populationId: string;
  subjectId: string;
  count: number;
  mean: number | null;
  score: number | null;
  priorEpoch: number | null;
  revision: string;
  asOf: string;
};

export type PublicRatingEpoch = {
  questionId: string;
  populationId: string;
  priorEpoch: number | null;
};

export type PublicRatingSnapshot = {
  partition: number;
  /**
   * The authoritative core.partition.position read in the same repeatable-read snapshot as `figures`. A later source
   * decorator compares this with the semantic snapshot position; it must not combine the figures with another
   * partition position.
   */
  position: bigint;
  figures: ReadonlyMap<string, PublicRatingFigure>;
};

export interface PublicRatingSource {
  /**
   * Read public figures for the standard question and Global population fixed by this source. Each call accepts at
   * most 256 subject ids, requires `partition` to be an integer from 0 through 4095, validates that every id is
   * routable and anchored to `partition`, and reads the figures together with the authoritative partition position
   * in one repeatable-read snapshot. An absent map entry means the native figure is unscored. A missing or unavailable
   * capability, denied read, or failed native read rejects; those conditions must never be represented as an empty
   * map.
   */
  read(partition: number, subjectIds: readonly string[]): Promise<PublicRatingSnapshot>;
  /**
   * Return the current native prior eligibility epoch for this source's standard question and Global population.
   * The epoch is null below 50 counted votes, is not a cached last nonnull epoch, and is never reused.
   */
  epoch(): Promise<PublicRatingEpoch>;
}

const FIGURE_FIELDS = [
  'questionId',
  'populationId',
  'subjectId',
  'count',
  'mean',
  'score',
  'priorEpoch',
  'revision',
  'asOf',
] as const;
const BINDING_FIELDS = ['questionId', 'populationId', 'subjectId'] as const;
const MIN_SIGNED_BIGINT = -9_223_372_036_854_775_808n;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const RFC3339 =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?([Zz]|[+-][0-9]{2}:[0-9]{2})$/;

function invalidFigure(): never {
  throw new TypeError('Invalid public rating figure');
}

/** Read only own data properties from a plain object and reject any unlisted property. */
function exactDataProperties(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidFigure();

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidFigure();

  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key)))
    return invalidFigure();

  const properties: Record<string, unknown> = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalidFigure();
    properties[key] = descriptor.value;
  }
  return properties;
}

function isRoutableId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && routeOf(value) !== null;
}

function isRatingValue(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10);
}

function isPriorEpoch(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && typeof value === 'number' && value > 0);
}

function isRevision(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !CANONICAL_INTEGER.test(value)) return false;
  const revision = BigInt(value);
  return revision >= MIN_SIGNED_BIGINT && revision <= MAX_SIGNED_BIGINT;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isRfc3339(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const match = RFC3339.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]!;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;

  if (second === 60) {
    let utcMinute = hour * 60 + minute;
    if (zone !== 'Z' && zone !== 'z') {
      const offsetHours = Number(zone.slice(1, 3));
      const offsetMinutes = Number(zone.slice(4, 6));
      if (offsetHours > 23 || offsetMinutes > 59) return false;
      const offset = (offsetHours * 60 + offsetMinutes) * (zone[0] === '+' ? 1 : -1);
      utcMinute -= offset;
    }
    utcMinute = ((utcMinute % 1440) + 1440) % 1440;
    if (utcMinute !== 1439) return false;
  } else if (zone !== 'Z' && zone !== 'z') {
    if (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59) return false;
  }

  return true;
}

/**
 * Pure, bounded validation and copying for an untrusted public Global figure. It performs no I/O and preserves no
 * unlisted data.
 */
export function normalizePublicRatingFigure(
  value: unknown,
  binding: { questionId: string; populationId: string; subjectId: string },
): PublicRatingFigure {
  const fields = exactDataProperties(value, FIGURE_FIELDS);
  const expected = exactDataProperties(binding, BINDING_FIELDS);

  if (
    !isRoutableId(fields.questionId) ||
    !isRoutableId(fields.populationId) ||
    !isRoutableId(fields.subjectId) ||
    !isRoutableId(expected.questionId) ||
    !isRoutableId(expected.populationId) ||
    !isRoutableId(expected.subjectId) ||
    expected.populationId !== GLOBAL_CONTEXT.id ||
    fields.questionId !== expected.questionId ||
    fields.populationId !== GLOBAL_CONTEXT.id ||
    fields.populationId !== expected.populationId ||
    fields.subjectId !== expected.subjectId
  )
    return invalidFigure();

  const count = fields.count;
  const mean = fields.mean;
  const score = fields.score;
  const priorEpoch = fields.priorEpoch;
  if (!Number.isSafeInteger(count) || typeof count !== 'number' || count < 0) return invalidFigure();
  if (!isRatingValue(mean) || !isRatingValue(score) || !isPriorEpoch(priorEpoch)) return invalidFigure();
  if (count === 0 && (mean !== null || score !== null)) return invalidFigure();
  if (score !== null && (mean === null || count < 5 || priorEpoch === null)) return invalidFigure();
  if (!isRevision(fields.revision) || !isRfc3339(fields.asOf)) return invalidFigure();

  return {
    questionId: fields.questionId,
    populationId: fields.populationId,
    subjectId: fields.subjectId,
    count,
    mean,
    score,
    priorEpoch,
    revision: fields.revision,
    asOf: fields.asOf,
  };
}
