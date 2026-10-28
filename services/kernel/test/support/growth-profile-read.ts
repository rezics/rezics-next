import type { CalibrationCheck, CalibrationRunPoint } from './growth-calibration.ts';
import type { GrowthModelBound } from './growth-model.ts';

export const GROWTH_PROFILE_METRICS = ['rows', 'blocks', 'statements'] as const;
export type GrowthProfileMetric = (typeof GROWTH_PROFILE_METRICS)[number];
export type GrowthProfileOutcome = 'compatible' | 'violation' | 'insufficient-evidence';

export type GrowthProfileRunSource = Readonly<{ name: string; text: string }>;
export type GrowthProfileRepetition = Readonly<Record<GrowthProfileMetric, number>>;
export type GrowthProfileRelationSize = Readonly<{ reltuples: number; relpages: number }>;
export type GrowthProfileBounds = Readonly<Record<GrowthProfileMetric, GrowthModelBound>>;
export type GrowthProfileEntry = Readonly<{
  run: string;
  file: string;
  check: string;
  occurrence: number;
  scales: readonly number[];
  repetitions: readonly (readonly GrowthProfileRepetition[])[];
  relationSizes: readonly Readonly<Record<string, GrowthProfileRelationSize>>[];
  bounds: GrowthProfileBounds;
  shadow: Readonly<Record<GrowthProfileMetric, GrowthProfileOutcome>>;
}>;

export type OmittedGrowthProfileCheck = Readonly<{
  file: string;
  check: string;
  occurrence: number;
  missingRuns: readonly string[];
  scalesByRun: readonly Readonly<{ run: string; scales: readonly number[] }>[];
}>;

export type NonGrowingRelation = Readonly<{
  file: string;
  check: string;
  occurrence: number;
  run: string;
  relation: string;
  first: number;
  last: number;
}>;

export type GrowthProfileShadowOutcome = Readonly<{
  file: string;
  check: string;
  occurrence: number;
  run: string;
  outcomes: Readonly<Record<GrowthProfileMetric, GrowthProfileOutcome>>;
}>;

export type GrowthProfileRead = Readonly<{
  entries: readonly GrowthProfileEntry[];
  series: Readonly<Record<GrowthProfileMetric, readonly CalibrationCheck[]>>;
  omitted: readonly OmittedGrowthProfileCheck[];
  nonGrowingRelations: readonly NonGrowingRelation[];
  shadowOutcomes: readonly GrowthProfileShadowOutcome[];
}>;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, description: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${description} must be an object`);
  return value as UnknownRecord;
}

function stringField(source: UnknownRecord, field: string, description: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`${description}.${field} must be a non-empty string`);
  return value;
}

function metricValue(source: UnknownRecord, metric: GrowthProfileMetric, description: string): number {
  const value = source[metric];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new TypeError(`${description}.${metric} must be finite and non-negative`);
  return value;
}

function parseBounds(value: unknown, description: string): GrowthProfileBounds {
  const source = record(value, description);
  const bounds = {} as Record<GrowthProfileMetric, GrowthModelBound>;
  for (const metric of GROWTH_PROFILE_METRICS) {
    const bound = source[metric];
    if (bound !== 'constant' && bound !== 'logarithmic' && bound !== 'linear')
      throw new TypeError(`${description}.${metric} has an unknown growth bound`);
    bounds[metric] = bound;
  }
  return bounds;
}

function parseProfile(value: unknown, run: string, occurrence: number, description: string): GrowthProfileEntry {
  const source = record(value, description);
  const file = stringField(source, 'file', description);
  const check = stringField(source, 'check', description);
  const scalesValue = source.scales;
  if (!Array.isArray(scalesValue) || scalesValue.length < 3 || scalesValue.length > 5)
    throw new TypeError(`${description}.scales must contain three to five scales`);
  const scales = scalesValue.map((scale, index) => {
    if (
      typeof scale !== 'number' ||
      !Number.isFinite(scale) ||
      scale <= 0 ||
      (index > 0 && scale <= scalesValue[index - 1]!)
    )
      throw new TypeError(`${description}.scales must be finite, positive and strictly increasing`);
    return scale;
  });

  const repetitionsValue = source.repetitions;
  if (!Array.isArray(repetitionsValue) || repetitionsValue.length !== scales.length)
    throw new TypeError(`${description}.repetitions must have one group per scale`);
  const repetitions = repetitionsValue.map((group, scaleIndex) => {
    if (!Array.isArray(group) || group.length === 0)
      throw new TypeError(`${description}.repetitions[${scaleIndex}] must contain repetitions`);
    return group.map((item, repetitionIndex) => {
      const sample = record(item, `${description}.repetitions[${scaleIndex}][${repetitionIndex}]`);
      return Object.fromEntries(
        GROWTH_PROFILE_METRICS.map((metric) => [
          metric,
          metricValue(sample, metric, `${description}.repetitions[${scaleIndex}][${repetitionIndex}]`),
        ]),
      ) as GrowthProfileRepetition;
    });
  });

  const relationSizesValue = source.relationSizes;
  if (!Array.isArray(relationSizesValue) || relationSizesValue.length !== scales.length)
    throw new TypeError(`${description}.relationSizes must have one group per scale`);
  const relationSizes = relationSizesValue.map((group, scaleIndex) => {
    const relations = record(group, `${description}.relationSizes[${scaleIndex}]`);
    return Object.fromEntries(
      Object.entries(relations).map(([name, value]) => {
        const size = record(value, `${description}.relationSizes[${scaleIndex}].${name}`);
        const { reltuples, relpages } = size;
        if (typeof reltuples !== 'number' || !Number.isFinite(reltuples))
          throw new TypeError(`${description}.relationSizes[${scaleIndex}].${name}.reltuples must be finite`);
        if (typeof relpages !== 'number' || !Number.isFinite(relpages))
          throw new TypeError(`${description}.relationSizes[${scaleIndex}].${name}.relpages must be finite`);
        return [name, { reltuples, relpages }];
      }),
    ) as Readonly<Record<string, GrowthProfileRelationSize>>;
  });

  const bounds = parseBounds(source.bounds, `${description}.bounds`);
  const shadowSource = record(source.shadow, `${description}.shadow`);
  const shadow = {} as Record<GrowthProfileMetric, GrowthProfileOutcome>;
  for (const metric of GROWTH_PROFILE_METRICS) {
    const outcome = record(shadowSource[metric], `${description}.shadow.${metric}`).outcome;
    if (outcome !== 'compatible' && outcome !== 'violation' && outcome !== 'insufficient-evidence')
      throw new TypeError(`${description}.shadow.${metric}.outcome is unknown`);
    shadow[metric] = outcome;
  }

  return { run, file, check, occurrence, scales, repetitions, relationSizes, bounds, shadow };
}

function identity(file: string, check: string): string {
  return JSON.stringify([file, check]);
}

/** A stable, unambiguous calibration key for the profile's file/check pair. */
export function growthProfileCheckId(file: string, check: string, occurrence = 1): string {
  return occurrence === 1 ? identity(file, check) : JSON.stringify([file, check, occurrence]);
}

function parseRun(source: GrowthProfileRunSource): GrowthProfileEntry[] {
  if (!source.name) throw new TypeError('Each profile run requires a name');
  const entries: GrowthProfileEntry[] = [];
  const occurrences = new Map<string, number>();
  for (const [index, line] of source.text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const description = `${source.name}:${index + 1}`;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (error) {
      throw new TypeError(
        `${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const decodedRecord = record(decoded, description);
    const file = stringField(decodedRecord, 'file', description);
    const check = stringField(decodedRecord, 'check', description);
    const id = identity(file, check);
    const occurrence = (occurrences.get(id) ?? 0) + 1;
    occurrences.set(id, occurrence);
    const entry = parseProfile(decoded, source.name, occurrence, description);
    entries.push(entry);
  }
  return entries;
}

function median(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[(values.length - 1) >> 1]!;
}

function nonGrowingRelations(entries: readonly GrowthProfileEntry[]): NonGrowingRelation[] {
  return entries.flatMap((entry) => {
    const first = entry.relationSizes[0]!;
    const last = entry.relationSizes.at(-1)!;
    return Object.entries(first).flatMap(([relation, firstSize]) => {
      const lastSize = last[relation];
      if (!lastSize || lastSize.reltuples > firstSize.reltuples) return [];
      return [
        {
          file: entry.file,
          check: entry.check,
          occurrence: entry.occurrence,
          run: entry.run,
          relation,
          first: firstSize.reltuples,
          last: lastSize.reltuples,
        },
      ];
    });
  });
}

/** Parse JSONL collected from repeated unchanged-code runs and build calibration inputs by file/check and metric. */
export function readGrowthProfiles(sources: readonly GrowthProfileRunSource[]): GrowthProfileRead {
  const runNames = new Set<string>();
  for (const source of sources) {
    if (runNames.has(source.name)) throw new TypeError(`Profile run names must be unique: ${source.name}`);
    runNames.add(source.name);
  }
  const entries = sources.flatMap(parseRun);
  const entriesByCheck = new Map<string, GrowthProfileEntry[]>();
  for (const entry of entries) {
    const id = growthProfileCheckId(entry.file, entry.check, entry.occurrence);
    const group = entriesByCheck.get(id) ?? [];
    group.push(entry);
    entriesByCheck.set(id, group);
  }

  const omitted: OmittedGrowthProfileCheck[] = [];
  const complete: GrowthProfileEntry[][] = [];
  for (const group of entriesByCheck.values()) {
    const first = group[0]!;
    const byRun = new Map(group.map((entry) => [entry.run, entry]));
    const missingRuns = sources.map(({ name }) => name).filter((name) => !byRun.has(name));
    const scalesByRun = group.map(({ run, scales }) => ({ run, scales }));
    const referenceScales = group[0]!.scales;
    const scalesMatch = group.every(
      ({ scales }) =>
        scales.length === referenceScales.length && scales.every((scale, index) => scale === referenceScales[index]),
    );
    if (missingRuns.length > 0 || !scalesMatch) {
      omitted.push({ file: first.file, check: first.check, occurrence: first.occurrence, missingRuns, scalesByRun });
      continue;
    }
    complete.push(
      sources.map(({ name }) => byRun.get(name)!).filter((entry): entry is GrowthProfileEntry => entry !== undefined),
    );
  }

  complete.sort(
    (left, right) => left[0]!.file.localeCompare(right[0]!.file) || left[0]!.check.localeCompare(right[0]!.check),
  );
  omitted.sort((left, right) => left.file.localeCompare(right.file) || left.check.localeCompare(right.check));

  const series: Record<GrowthProfileMetric, readonly CalibrationCheck[]> = {
    rows: [],
    blocks: [],
    statements: [],
  };
  for (const metric of GROWTH_PROFILE_METRICS) {
    series[metric] = complete.map((group) => ({
        check: growthProfileCheckId(group[0]!.file, group[0]!.check, group[0]!.occurrence),
        runs: group.map(({ scales, repetitions }) =>
          scales.map((scale, scaleIndex): CalibrationRunPoint => ({
            scale,
            repetitions: repetitions[scaleIndex]!.map((repetition) => repetition[metric]),
          })),
        ),
      }));
  }

  const shadowOutcomes = entries.map(({ file, check, occurrence, run, shadow }) => ({
    file,
    check,
    occurrence,
    run,
    outcomes: shadow,
  }));
  return {
    entries,
    series,
    omitted,
    nonGrowingRelations: nonGrowingRelations(entries),
    shadowOutcomes,
  };
}

export function medianGrowthValue(values: readonly number[]): number {
  if (values.length === 0) throw new TypeError('Cannot find the median of an empty series');
  return median(values);
}
