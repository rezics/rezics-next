import type { CalibrationCheck, CalibrationRunPoint } from './growth-calibration.ts';
import type { GrowthModelBound } from './growth-model.ts';
import {
  hasCompleteRelationIdentity,
  parseRelationIdentity,
  relationIdentityKey,
  type RelationIdentity,
} from './growth-relation-identity.ts';
import { admitGrowthProfileInput, GROWTH_PROFILE_EXPANSION, growthProfileLines } from './growth-profile-input.ts';

/** Omitted-check × source-run pairs admitted before missing-run lists, matching calibration's 256×32 capacities. */
export const GROWTH_PROFILE_DIAGNOSTIC_EXPANSION = 256 * 32;

export const GROWTH_PROFILE_METRICS = ['rows', 'blocks', 'statements'] as const;
export const GROWTH_MEASUREMENT_IDENTITY_VERSION = 1 as const;
export type GrowthProfileMetric = (typeof GROWTH_PROFILE_METRICS)[number];
export type GrowthProfileOutcome = 'compatible' | 'violation' | 'inconclusive';
export type GrowthProfileEligibility =
  | { readonly status: 'eligible' }
  | { readonly status: 'ineligible'; readonly reason: string };

export type GrowthProfileRunSource = Readonly<{ name: string; text: string }>;
export type GrowthProfileRepetition = Readonly<Record<GrowthProfileMetric, number>>;
export type GrowthProfileRelationSize = Readonly<{
  reltuples: number;
  relpages: number;
  identity?: RelationIdentity;
}>;
export type GrowthProfileBounds = Readonly<Record<GrowthProfileMetric, GrowthModelBound>>;
export type GrowthMeasurementIdentity = Readonly<{
  version: number;
  indexProbes: number;
  source?: string;
}>;
export type IdentifiedGrowthMeasurement = GrowthMeasurementIdentity & { readonly source: string };
export type GrowthProfileEntry = Readonly<{
  run: string;
  file: string;
  check: string;
  occurrence: number;
  scales: readonly number[];
  repetitions: readonly (readonly GrowthProfileRepetition[])[];
  relationSizes: readonly Readonly<Record<string, GrowthProfileRelationSize>>[];
  bounds: GrowthProfileBounds;
  measurement: GrowthMeasurementIdentity | null;
  shadow: Readonly<Record<GrowthProfileMetric, GrowthProfileOutcome>>;
  eligibility: GrowthProfileEligibility;
}>;

export type OmittedGrowthProfileCheck = Readonly<{
  file: string;
  check: string;
  occurrence: number;
  missingRuns: readonly string[];
  scalesByRun: readonly Readonly<{ run: string; scales: readonly number[] }>[];
  incompatibleBoundsByRun?: readonly Readonly<{ run: string; bounds: GrowthProfileBounds }>[];
  incompatibleMeasurementsByRun?: readonly Readonly<{
    run: string;
    measurement: GrowthMeasurementIdentity | null;
  }>[];
  ineligibleRuns?: readonly Readonly<{ run: string; reason: string }>[];
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

/** Versioned measurement-contract identity written on new profile lines. */
export function growthMeasurementIdentity(
  indexProbes: number | undefined,
  source: string | undefined,
): GrowthMeasurementIdentity {
  return {
    version: GROWTH_MEASUREMENT_IDENTITY_VERSION,
    indexProbes: indexProbes ?? 0,
    ...(source === undefined || source.length === 0 ? {} : { source }),
  };
}

export function isIdentifiedGrowthMeasurement(
  value: GrowthMeasurementIdentity | null | undefined,
): value is IdentifiedGrowthMeasurement {
  return (
    value != null &&
    value.version === GROWTH_MEASUREMENT_IDENTITY_VERSION &&
    typeof value.source === 'string' &&
    value.source.length > 0 &&
    Number.isSafeInteger(value.indexProbes) &&
    value.indexProbes >= 0
  );
}

function sameIdentifiedMeasurement(left: IdentifiedGrowthMeasurement, right: IdentifiedGrowthMeasurement): boolean {
  return left.version === right.version && left.indexProbes === right.indexProbes && left.source === right.source;
}

type ProfileExpansion = { values: number };

function admitExpandedValues(
  expansion: ProfileExpansion,
  count: number,
  description: string,
  scaleIndex: number,
  scale: number,
  field: 'repetitions' | 'relationSizes',
): void {
  expansion.values += count;
  if (expansion.values > GROWTH_PROFILE_EXPANSION.values)
    throw new TypeError(
      `${description}.${field}[${scaleIndex}] exceeds the ${GROWTH_PROFILE_EXPANSION.values} expanded profile value limit (${expansion.values} scalar/footprint values at scale ${scale})`,
    );
}

function parseMeasurement(value: unknown, description: string): GrowthMeasurementIdentity | null {
  if (value === undefined) return null;
  const source = record(value, description);
  const version = source.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)
    throw new TypeError(`${description}.version must be a positive safe integer`);
  const indexProbes = source.indexProbes;
  if (typeof indexProbes !== 'number' || !Number.isSafeInteger(indexProbes) || indexProbes < 0)
    throw new TypeError(`${description}.indexProbes must be a non-negative safe integer`);
  if (source.source === undefined) return { version, indexProbes };
  if (typeof source.source !== 'string' || source.source.length === 0)
    throw new TypeError(`${description}.source must be a non-empty string when present`);
  return { version, indexProbes, source: source.source };
}

function parseProfile(
  value: unknown,
  run: string,
  occurrence: number,
  description: string,
  expansion: ProfileExpansion,
): GrowthProfileEntry {
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
  const relationSizesValue = source.relationSizes;
  if (!Array.isArray(relationSizesValue) || relationSizesValue.length !== scales.length)
    throw new TypeError(`${description}.relationSizes must have one group per scale`);

  for (let scaleIndex = 0; scaleIndex < scales.length; scaleIndex++) {
    const scale = scales[scaleIndex]!;
    const group = repetitionsValue[scaleIndex];
    if (!Array.isArray(group) || group.length === 0)
      throw new TypeError(`${description}.repetitions[${scaleIndex}] must contain repetitions`);
    if (group.length > GROWTH_PROFILE_EXPANSION.repetitions)
      throw new TypeError(
        `${description}.repetitions[${scaleIndex}] exceeds the ${GROWTH_PROFILE_EXPANSION.repetitions} repetition capacity (${group.length} repetitions at scale ${scale})`,
      );
    admitExpandedValues(
      expansion,
      group.length * GROWTH_PROFILE_METRICS.length,
      description,
      scaleIndex,
      scale,
      'repetitions',
    );
    const relations = record(relationSizesValue[scaleIndex], `${description}.relationSizes[${scaleIndex}]`);
    admitExpandedValues(expansion, Object.keys(relations).length * 2, description, scaleIndex, scale, 'relationSizes');
  }

  const repetitions = repetitionsValue.map((group, scaleIndex) => {
    return (group as unknown[]).map((item, repetitionIndex) => {
      const sample = record(item, `${description}.repetitions[${scaleIndex}][${repetitionIndex}]`);
      return Object.fromEntries(
        GROWTH_PROFILE_METRICS.map((metric) => [
          metric,
          metricValue(sample, metric, `${description}.repetitions[${scaleIndex}][${repetitionIndex}]`),
        ]),
      ) as GrowthProfileRepetition;
    });
  });

  const relationSizes = relationSizesValue.map((group, scaleIndex) => {
    const relations = record(group, `${description}.relationSizes[${scaleIndex}]`);
    const identities = new Set<string>();
    return Object.fromEntries(
      Object.entries(relations).map(([name, value]) => {
        const size = record(value, `${description}.relationSizes[${scaleIndex}].${name}`);
        const { reltuples, relpages } = size;
        if (typeof reltuples !== 'number' || !Number.isFinite(reltuples))
          throw new TypeError(`${description}.relationSizes[${scaleIndex}].${name}.reltuples must be finite`);
        if (typeof relpages !== 'number' || !Number.isFinite(relpages))
          throw new TypeError(`${description}.relationSizes[${scaleIndex}].${name}.relpages must be finite`);
        const identity =
          size.identity === undefined
            ? undefined
            : parseRelationIdentity(size.identity, `${description}.relationSizes[${scaleIndex}].${name}.identity`);
        if (identity !== undefined) {
          const key = relationIdentityKey(identity);
          if (identities.has(key))
            throw new TypeError(`${description}.relationSizes[${scaleIndex}] contains a duplicate relation identity`);
          identities.add(key);
        }
        return [name, { reltuples, relpages, ...(identity === undefined ? {} : { identity }) }];
      }),
    ) as Readonly<Record<string, GrowthProfileRelationSize>>;
  });

  const bounds = parseBounds(source.bounds, `${description}.bounds`);
  const measurement = parseMeasurement(source.measurement, `${description}.measurement`);
  const shadowSource = record(source.shadow, `${description}.shadow`);
  const shadow = {} as Record<GrowthProfileMetric, GrowthProfileOutcome>;
  for (const metric of GROWTH_PROFILE_METRICS) {
    const outcome = record(shadowSource[metric], `${description}.shadow.${metric}`).outcome;
    if (outcome !== 'compatible' && outcome !== 'violation' && outcome !== 'inconclusive')
      throw new TypeError(`${description}.shadow.${metric}.outcome is unknown`);
    shadow[metric] = outcome;
  }

  return {
    run,
    file,
    check,
    occurrence,
    scales,
    repetitions,
    relationSizes,
    bounds,
    measurement,
    shadow,
    eligibility: parseEligibility(source.eligibility, `${description}.eligibility`),
  };
}

function parseEligibility(value: unknown, description: string): GrowthProfileEligibility {
  if (value === undefined) return { status: 'eligible' };
  const source = record(value, description);
  if (source.status === 'eligible') return { status: 'eligible' };
  if (source.status === 'ineligible') {
    if (typeof source.reason !== 'string' || source.reason.length === 0)
      throw new TypeError(`${description}.reason must be a non-empty string`);
    return { status: 'ineligible', reason: source.reason };
  }
  throw new TypeError(`${description}.status is unknown`);
}

function identity(file: string, check: string): string {
  return JSON.stringify([file, check]);
}

/** A stable, unambiguous calibration key for the profile's file/check pair. */
export function growthProfileCheckId(file: string, check: string, occurrence = 1): string {
  return occurrence === 1 ? identity(file, check) : JSON.stringify([file, check, occurrence]);
}

function parseRun(source: GrowthProfileRunSource, expansion: ProfileExpansion): GrowthProfileEntry[] {
  if (!source.name) throw new TypeError('Each profile run requires a name');
  const entries: GrowthProfileEntry[] = [];
  const occurrences = new Map<string, number>();
  for (const { line, text } of growthProfileLines(source)) {
    if (!text.trim()) continue;
    const description = `${source.name}:${line}`;
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
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
    const entry = parseProfile(decoded, source.name, occurrence, description, expansion);
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
    const lastByIdentity = new Map<string, GrowthProfileRelationSize>();
    for (const size of Object.values(last))
      if (hasCompleteRelationIdentity(size.identity)) lastByIdentity.set(relationIdentityKey(size.identity), size);
    return Object.entries(first).flatMap(([relation, firstSize]) => {
      const lastSize =
        firstSize.identity === undefined
          ? last[relation]?.identity === undefined
            ? last[relation]
            : undefined
          : hasCompleteRelationIdentity(firstSize.identity)
            ? lastByIdentity.get(relationIdentityKey(firstSize.identity))
            : undefined;
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
  admitGrowthProfileInput(sources);
  const runNames = new Set<string>();
  for (const source of sources) {
    if (runNames.has(source.name)) throw new TypeError(`Profile run names must be unique: ${source.name}`);
    runNames.add(source.name);
  }
  const expansion = { values: 0 };
  const entries = sources.flatMap((source) => parseRun(source, expansion));
  const entriesByCheck = new Map<string, GrowthProfileEntry[]>();
  for (const entry of entries) {
    const id = growthProfileCheckId(entry.file, entry.check, entry.occurrence);
    const group = entriesByCheck.get(id) ?? [];
    group.push(entry);
    entriesByCheck.set(id, group);
  }

  const omitted: OmittedGrowthProfileCheck[] = [];
  const complete: GrowthProfileEntry[][] = [];
  let diagnosticExpansion = 0;
  for (const group of entriesByCheck.values()) {
    const first = group[0]!;
    const byRun = new Map(group.map((entry) => [entry.run, entry]));
    const scalesByRun = group.map(({ run, scales }) => ({ run, scales }));
    const referenceScales = group[0]!.scales;
    const scalesMatch = group.every(
      ({ scales }) =>
        scales.length === referenceScales.length && scales.every((scale, index) => scale === referenceScales[index]),
    );
    const boundsMatch = group.every(({ bounds }) =>
      GROWTH_PROFILE_METRICS.every((metric) => bounds[metric] === first.bounds[metric]),
    );
    const referenceMeasurement = first.measurement;
    const measurementsMatch =
      isIdentifiedGrowthMeasurement(referenceMeasurement) &&
      group.every(
        ({ measurement }) =>
          isIdentifiedGrowthMeasurement(measurement) && sameIdentifiedMeasurement(measurement, referenceMeasurement),
      );
    const ineligibleRuns = group.flatMap((entry) =>
      entry.eligibility.status === 'ineligible' ? [{ run: entry.run, reason: entry.eligibility.reason }] : [],
    );
    if (
      byRun.size === sources.length &&
      scalesMatch &&
      boundsMatch &&
      measurementsMatch &&
      ineligibleRuns.length === 0
    ) {
      complete.push(
        sources.map(({ name }) => byRun.get(name)!).filter((entry): entry is GrowthProfileEntry => entry !== undefined),
      );
      continue;
    }
    diagnosticExpansion += sources.length;
    if (diagnosticExpansion > GROWTH_PROFILE_DIAGNOSTIC_EXPANSION) {
      throw new TypeError(
        `Growth profile ${growthProfileCheckId(first.file, first.check, first.occurrence)} exceeds the ${GROWTH_PROFILE_DIAGNOSTIC_EXPANSION} check×run diagnostic expansion (${diagnosticExpansion} check×run pairs)`,
      );
    }
    omitted.push({
      file: first.file,
      check: first.check,
      occurrence: first.occurrence,
      missingRuns: sources.map(({ name }) => name).filter((name) => !byRun.has(name)),
      scalesByRun,
      ...(boundsMatch ? {} : { incompatibleBoundsByRun: group.map(({ run, bounds }) => ({ run, bounds })) }),
      ...(measurementsMatch
        ? {}
        : { incompatibleMeasurementsByRun: group.map(({ run, measurement }) => ({ run, measurement })) }),
      ...(ineligibleRuns.length === 0 ? {} : { ineligibleRuns }),
    });
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
