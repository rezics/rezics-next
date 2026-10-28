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
export type CountedViolation = {
  readonly unit: string;
  readonly scale: number;
  readonly value: number;
  readonly limit: number | Bound;
  readonly kind: 'limit' | 'bound';
};

export function countedNames(check: CountedCheck): string[] {
  return [...new Set([...Object.keys(check.limits ?? {}), ...Object.keys(check.bounds ?? {})])].sort();
}

export function validateCountedConfig(check: CountedCheck): void {
  for (const [name, limit] of Object.entries(check.limits ?? {})) {
    if (!name || !Number.isSafeInteger(limit) || limit < 0)
      throw new TypeError(`Counted limit for ${name || '<empty>'} must be a non-negative safe integer`);
  }
  for (const [name, bound] of Object.entries(check.bounds ?? {}))
    if (!name || !['constant', 'logarithmic', 'linear'].includes(bound))
      throw new TypeError(`Unknown counted growth bound for ${name || '<empty>'}`);
  for (const [name, slack] of Object.entries(check.slack ?? {}))
    if (
      !Number.isFinite(slack.absolute) ||
      slack.absolute < 0 ||
      !Number.isFinite(slack.relative) ||
      slack.relative < 0
    )
      throw new TypeError(`Slack for counted unit ${name} must be finite and non-negative`);
  for (const name of Object.keys(check.slack ?? {}))
    if (!countedNames(check).includes(name))
      throw new TypeError(`Slack configured for undeclared counted unit ${name}`);
}

export function validateCountedRun(check: CountedCheck, values: CountedValues, scale: number): CountedValues {
  const names = countedNames(check);
  for (const name of names) {
    if (!Object.hasOwn(values, name)) throw new Error(`Counted unit ${name} was not reported at scale ${scale}`);
    const value = values[name];
    if (!Number.isSafeInteger(value) || value! < 0)
      throw new TypeError(`Counted unit ${name} at scale ${scale} must be a non-negative safe integer`);
  }
  for (const [name, value] of Object.entries(values)) {
    if (!name || !Number.isSafeInteger(value) || value < 0)
      throw new TypeError(`Counted unit ${name || '<empty>'} at scale ${scale} must be a non-negative safe integer`);
  }
  return { ...values };
}

export function medianCounted(repetitions: readonly CountedValues[]): CountedValues {
  if (repetitions.length === 0) return {};
  const names = Object.keys(repetitions[0]!);
  return Object.fromEntries(
    names.map((name) => {
      const values = repetitions.map((run) => run[name]!).toSorted((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      return [name, values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2];
    }),
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

export function countedViolations(
  check: CountedCheck,
  samples: readonly { readonly scale: number; readonly counted: CountedSample }[],
): CountedViolation[] {
  const violations: CountedViolation[] = [];
  for (const name of countedNames(check)) {
    const limit = check.limits?.[name];
    if (limit !== undefined)
      for (const sample of samples) {
        const value = sample.counted[name]!.value;
        if (value > limit) violations.push({ unit: name, scale: sample.scale, value, limit, kind: 'limit' });
      }
    const bound = check.bounds?.[name];
    if (bound === undefined) continue;
    const slack = check.slack?.[name] ?? { absolute: 0, relative: 0 };
    for (let index = 0; index < samples.length - 2; index++) {
      const triple = samples.slice(index, index + 3);
      const scales = triple.map(({ scale }) => scale);
      const values = triple.map(({ counted }) => counted[name]!.value);
      const ratio = scales[1]! / scales[0]!;
      const firstStep = values[1]! - values[0]!;
      const secondStep = values[2]! - values[1]!;
      const allowance = Math.max(slack.absolute, slack.relative * values[0]!);
      const allowed =
        bound === 'constant'
          ? allowance
          : (bound === 'logarithmic' ? 2 : 1.5 * ratio) * Math.max(firstStep, 0) + allowance;
      const observed = bound === 'constant' ? Math.max(values[1]!, values[2]!) - values[0]! : secondStep;
      if (observed > allowed)
        violations.push({ unit: name, scale: scales[2]!, value: values[2]!, limit: bound, kind: 'bound' });
    }
  }
  return violations;
}
