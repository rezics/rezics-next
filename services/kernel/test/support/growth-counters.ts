import {
  checkedAdd,
  checkedDivide,
  checkedMultiply,
  checkedSubtract,
  requireDenseArray,
  requireNonNegativeFiniteNumber,
} from './growth-numeric.ts';
import type { Bound, Slack } from './growth-bound.ts';

export type CountedValues = Readonly<Record<string, number>>;
export type CountedCheck<T = unknown> = {
  readonly read: (value: T, scale: number) => CountedValues;
  readonly limits?: Readonly<Record<string, number>>;
  readonly bounds?: Readonly<Record<string, Bound>>;
  readonly slack?: Readonly<Record<string, Slack>>;
};

export type CountedSample = Readonly<
  Record<string, { readonly value: number; readonly repetitions: readonly number[] }>
>;
type CountedViolationDetails = {
  readonly unit: string;
  readonly scale: number;
  readonly value: number;
};
export type CountedViolation =
  | (CountedViolationDetails & { readonly limit: number; readonly kind: 'limit'; readonly repetition: number })
  | (CountedViolationDetails & { readonly limit: Bound; readonly kind: 'bound' });

/** Capacities covering current producers (seven units, 25-byte names) with headroom. */
export const COUNTED_UNIT_LIMITS = {
  units: 32,
  nameBytes: 80,
  nameWork: 32 * 80,
} as const;

export type CountedNameIndex = {
  readonly names: readonly string[];
  readonly sorted: readonly string[];
  readonly declared: ReadonlySet<string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countedNameBytes(name: string): number {
  return Buffer.byteLength(name, 'utf8');
}

function admitCountedName(name: string, seen: Set<string>, work: { bytes: number }, context: string): void {
  const bytes = countedNameBytes(name);
  if (name && bytes > COUNTED_UNIT_LIMITS.nameBytes)
    throw new TypeError(`Counted unit name ${context} exceeds the ${COUNTED_UNIT_LIMITS.nameBytes} byte name limit`);
  if (name && !seen.has(name)) {
    const nextWork = work.bytes + bytes;
    if (nextWork > COUNTED_UNIT_LIMITS.nameWork)
      throw new TypeError(`Counted unit names exceed the ${COUNTED_UNIT_LIMITS.nameWork} byte work limit`);
    if (seen.size >= COUNTED_UNIT_LIMITS.units)
      throw new TypeError(`Counted checks exceed the ${COUNTED_UNIT_LIMITS.units} unit capacity`);
    work.bytes = nextWork;
    seen.add(name);
  }
}

function freezeNameIndex(seen: Set<string>): CountedNameIndex {
  const names = Object.freeze([...seen]);
  return { names, sorted: Object.freeze([...names].sort()), declared: seen };
}

function admitOwnKeys(value: object, seen: Set<string>, work: { bytes: number }, context: string): string[] {
  const keys = Object.keys(value);
  for (const name of keys) admitCountedName(name, seen, work, context);
  return keys;
}

export function countedNameIndex(check: CountedCheck): CountedNameIndex {
  const seen = new Set<string>();
  const work = { bytes: 0 };
  admitOwnKeys(check.limits ?? {}, seen, work, 'in limits');
  admitOwnKeys(check.bounds ?? {}, seen, work, 'in bounds');
  return freezeNameIndex(seen);
}

export function countedNames(check: CountedCheck): string[] {
  return [...countedNameIndex(check).sorted];
}

export function validateCountedConfig(check: CountedCheck): CountedNameIndex {
  if (typeof check.read !== 'function') throw new TypeError('Counted checks require a read function');
  const seen = new Set<string>();
  const work = { bytes: 0 };
  for (const [name, limit] of Object.entries(check.limits ?? {})) {
    admitCountedName(name, seen, work, `in limits`);
    if (!name || !Number.isSafeInteger(limit) || limit < 0)
      throw new TypeError(`Counted limit for ${name || '<empty>'} must be a non-negative safe integer`);
  }
  for (const [name, bound] of Object.entries(check.bounds ?? {})) {
    admitCountedName(name, seen, work, `in bounds`);
    if (!name || !['constant', 'logarithmic', 'linear'].includes(bound))
      throw new TypeError(`Unknown counted growth bound for ${name || '<empty>'}`);
  }
  const index = freezeNameIndex(seen);
  for (const [name, slack] of Object.entries(check.slack ?? {})) {
    const bytes = countedNameBytes(name);
    if (name && bytes > COUNTED_UNIT_LIMITS.nameBytes)
      throw new TypeError(`Counted unit name in slack exceeds the ${COUNTED_UNIT_LIMITS.nameBytes} byte name limit`);
    if (
      !Number.isFinite(slack.absolute) ||
      slack.absolute < 0 ||
      !Number.isFinite(slack.relative) ||
      slack.relative < 0
    )
      throw new TypeError(`Slack for counted unit ${name} must be finite and non-negative`);
    if (!index.declared.has(name)) throw new TypeError(`Slack configured for undeclared counted unit ${name}`);
  }
  return index;
}

function validateScale(scale: number, context: string): void {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4096)
    throw new TypeError(`${context} must be finite, positive and no greater than 4096`);
}

export function validateCountedRun(
  check: CountedCheck,
  values: CountedValues,
  scale: number,
  names?: CountedNameIndex,
): CountedValues {
  const index = names ?? validateCountedConfig(check);
  validateScale(scale, 'Counted scale');
  if (!isRecord(values)) throw new TypeError(`Counted values at scale ${scale} must be an object`);
  for (const name of index.sorted)
    if (!Object.hasOwn(values, name)) throw new Error(`Counted unit ${name} was not reported at scale ${scale}`);
  const seen = new Set(index.declared);
  const work = { bytes: index.names.reduce((total, name) => total + countedNameBytes(name), 0) };
  const keys = admitOwnKeys(values, seen, work, `at scale ${scale}`);
  const admitted: Record<string, number> = {};
  for (const name of keys) {
    const value = values[name];
    if (!name || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new TypeError(`Counted unit ${name || '<empty>'} at scale ${scale} must be a non-negative safe integer`);
    admitted[name] = value;
  }
  return admitted;
}

function rawMedian(values: readonly number[], name: string): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) throw new TypeError(`Counted unit ${name} requires at least one repetition`);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle]!;
  const lower = sorted[middle - 1]!;
  const upper = sorted[middle]!;
  const result = lower + (upper - lower) / 2;
  if (!Number.isFinite(result)) throw new TypeError(`Median for counted unit ${name} is not finite`);
  if ((BigInt(lower) + BigInt(upper)) % 2n !== 0n && Number.isInteger(result))
    throw new TypeError(`Fractional median for counted unit ${name} is not exactly representable`);
  return result;
}

export function medianCounted(repetitions: readonly CountedValues[]): CountedValues {
  requireDenseArray(repetitions, 'Counted repetitions');
  if (repetitions.length === 0) return {};
  const first = repetitions[0];
  if (!isRecord(first)) throw new TypeError('Counted repetition 1 must be an object');
  const seen = new Set<string>();
  const names = admitOwnKeys(first, seen, { bytes: 0 }, 'at repetition 1');
  if (names.some((name) => !name)) throw new TypeError('Counted unit names must not be empty');
  const expected = seen;
  for (let index = 0; index < repetitions.length; index += 1) {
    const run = repetitions[index];
    if (!isRecord(run)) throw new TypeError(`Counted repetition ${index + 1} must be an object`);
    const current = Object.keys(run);
    if (current.length !== expected.size || current.some((name) => !expected.has(name)))
      throw new TypeError(`Counted repetition ${index + 1} has missing or mismatched unit names`);
    for (const [name, value] of Object.entries(run))
      if (!name || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new TypeError(
          `Counted unit ${name || '<empty>'} at repetition ${index + 1} must be a non-negative safe integer`,
        );
  }
  return Object.fromEntries(
    names.map((name) => [
      name,
      rawMedian(
        repetitions.map((run) => run[name]!),
        name,
      ),
    ]),
  );
}

export function countedSample(repetitions: readonly CountedValues[]): CountedSample {
  const medians = medianCounted(repetitions);
  return Object.fromEntries(
    Object.entries(medians).map(([name, value]) => [
      name,
      { value, repetitions: repetitions.map((run) => run[name]!) },
    ]),
  );
}

function validateCountedScaleSeries(scales: readonly number[]): void {
  if (scales.length < 3 || scales.length > 5) throw new TypeError('Counted growth checks require three to five scales');
  if (
    scales.some(
      (scale, index) =>
        !Number.isFinite(scale) || scale <= 0 || scale > 4096 || (index > 0 && scale <= scales[index - 1]!),
    )
  )
    throw new TypeError('Counted scales must be finite, positive, increasing and no greater than 4096');
  const firstRatio = checkedDivide(scales[1]!, scales[0]!, 'Counted scale ratio');
  if (firstRatio < 4) throw new TypeError('Counted scales must have equal ratios of at least four');
  for (let index = 2; index < scales.length; index += 1) {
    const ratio = checkedDivide(scales[index]!, scales[index - 1]!, 'Counted scale ratio');
    const difference = Math.abs(checkedSubtract(firstRatio, ratio, 'Counted scale ratio difference'));
    if (checkedDivide(difference, Math.max(firstRatio, ratio), 'Relative counted scale ratio difference') >= 1e-9)
      throw new TypeError('Counted scales must have equal ratios of at least four');
  }
}

export function countedViolations(
  check: CountedCheck,
  samples: readonly { readonly scale: number; readonly counted: CountedSample }[],
): CountedViolation[] {
  const index = validateCountedConfig(check);
  const names = index.sorted;
  if (names.length === 0) return [];
  if (!Array.isArray(samples)) throw new TypeError('Counted samples must be an array');
  requireDenseArray(samples, 'Counted samples');
  validateCountedScaleSeries(samples.map(({ scale }) => scale));

  let repetitionCount: number | undefined;
  for (const sample of samples) {
    if (!isRecord(sample.counted)) throw new TypeError(`Counted evidence at scale ${sample.scale} must be an object`);
    const seen = new Set(index.declared);
    const work = { bytes: index.names.reduce((total, name) => total + countedNameBytes(name), 0) };
    admitOwnKeys(sample.counted, seen, work, `at scale ${sample.scale}`);
    for (const name of names)
      if (!Object.hasOwn(sample.counted, name))
        throw new TypeError(`Counted unit ${name} is missing at scale ${sample.scale}`);
    for (const [name, entry] of Object.entries(sample.counted)) {
      if (!name || !isRecord(entry))
        throw new TypeError(`Counted unit ${name || '<empty>'} at scale ${sample.scale} is malformed`);
      requireNonNegativeFiniteNumber(entry.value, `Counted unit ${name} median at scale ${sample.scale}`);
      if (!Array.isArray(entry.repetitions) || entry.repetitions.length === 0)
        throw new TypeError(`Counted unit ${name} at scale ${sample.scale} requires repetitions`);
      if (repetitionCount === undefined) repetitionCount = entry.repetitions.length;
      else if (entry.repetitions.length !== repetitionCount)
        throw new TypeError(`Counted repetitions are incoherent at scale ${sample.scale}`);
      for (const [index, value] of entry.repetitions.entries())
        if (!Number.isSafeInteger(value) || value < 0)
          throw new TypeError(
            `Counted unit ${name} repetition ${index + 1} at scale ${sample.scale} must be a non-negative safe integer`,
          );
      const median = rawMedian(entry.repetitions, name);
      if (entry.value !== median)
        throw new TypeError(`Counted unit ${name} median at scale ${sample.scale} does not match its repetitions`);
    }
  }

  const violations: CountedViolation[] = [];
  for (const name of names) {
    const limit = check.limits?.[name];
    if (limit !== undefined)
      for (const sample of samples) {
        for (const [index, value] of sample.counted[name]!.repetitions.entries())
          if (value > limit)
            violations.push({ unit: name, scale: sample.scale, repetition: index + 1, value, limit, kind: 'limit' });
      }
    const bound = check.bounds?.[name];
    if (bound === undefined) continue;
    const slack = check.slack?.[name] ?? { absolute: 0, relative: 0 };
    for (let index = 0; index < samples.length - 2; index += 1) {
      const triple = samples.slice(index, index + 3);
      const scales = triple.map(({ scale }) => scale);
      const values = triple.map(({ counted }) => counted[name]!.value);
      const ratio = checkedDivide(scales[1]!, scales[0]!, 'Counted scale ratio');
      const firstStep = checkedSubtract(values[1]!, values[0]!, `First ${name} growth step`);
      const secondStep = checkedSubtract(values[2]!, values[1]!, `Second ${name} growth step`);
      const allowance = Math.max(
        slack.absolute,
        checkedMultiply(slack.relative, values[0]!, `Relative ${name} growth slack`),
      );
      const allowed =
        bound === 'constant'
          ? allowance
          : checkedAdd(
              checkedMultiply(
                bound === 'logarithmic' ? 2 : checkedMultiply(1.5, ratio, `${name} linear scale allowance`),
                Math.max(firstStep, 0),
                `${name} growth allowance`,
              ),
              allowance,
              `Total ${name} growth allowance`,
            );
      const observed =
        bound === 'constant'
          ? checkedSubtract(Math.max(values[1]!, values[2]!), values[0]!, `Observed ${name} growth`)
          : secondStep;
      if (observed > allowed)
        violations.push({ unit: name, scale: scales[2]!, value: values[2]!, limit: bound, kind: 'bound' });
    }
  }
  return violations;
}
