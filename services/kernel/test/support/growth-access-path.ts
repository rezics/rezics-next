import type { ReportSample } from './growth.ts';

export type AccessPathSample = Pick<ReportSample, 'scale' | 'repetitions' | 'relationSizes'>;

const TINY_RELATION_PAGE_LIMIT = 8;

function describe(value: unknown): string {
  return value === undefined ? 'missing' : String(value);
}

function invalidEvidence(
  name: string,
  sampleIndex: number,
  repetitionIndex: number,
  field: string,
  detail: string,
): never {
  throw new Error(
    `${name}: sample ${sampleIndex + 1}, repetition ${repetitionIndex + 1}, field ${field}: ${detail}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rejects executed sequential scans of requested relations whose measured footprint exceeds eight pages. */
export function assertGrowthAccessPaths(
  name: string,
  samples: readonly AccessPathSample[],
  relations: readonly string[],
): void {
  if (relations.length === 0) return;
  if (samples.length === 0) invalidEvidence(name, 0, 0, 'samples', 'expected at least one measured sample');

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    if (!Object.hasOwn(samples, sampleIndex)) {
      invalidEvidence(name, sampleIndex, 0, `samples[${sampleIndex + 1}]`, 'sample entry is missing');
    }
    const sample = samples[sampleIndex];
    if (typeof sample !== 'object' || sample === null) {
      invalidEvidence(name, sampleIndex, 0, 'samples', 'expected a sample object');
    }

    const repetitions = sample.repetitions;
    if (!Array.isArray(repetitions) || repetitions.length === 0) {
      invalidEvidence(name, sampleIndex, 0, 'repetitions', 'expected at least one measured repetition');
    }

    for (let repetitionIndex = 0; repetitionIndex < repetitions.length; repetitionIndex++) {
      if (!Object.hasOwn(repetitions, repetitionIndex)) {
        invalidEvidence(
          name,
          sampleIndex,
          repetitionIndex,
          `repetitions[${repetitionIndex + 1}]`,
          'measured repetition is missing',
        );
      }
      const repetition = repetitions[repetitionIndex];
      if (!isRecord(repetition)) {
        invalidEvidence(name, sampleIndex, repetitionIndex, `repetitions[${repetitionIndex + 1}]`, 'expected an object');
      }
      const costs = repetition.relations;
      if (!isRecord(costs)) {
        invalidEvidence(
          name,
          sampleIndex,
          repetitionIndex,
          `repetitions[${repetitionIndex + 1}].relations`,
          'expected a relation-cost object',
        );
      }

      for (const relation of relations) {
        if (!Object.hasOwn(costs, relation)) continue;

        const pages = sample.relationSizes?.[relation]?.relpages;
        const relationCost = costs[relation];
        if (!isRecord(relationCost)) {
          invalidEvidence(
            name,
            sampleIndex,
            repetitionIndex,
            `repetitions[${repetitionIndex + 1}].relations.${relation}`,
            'expected a relation-cost object',
          );
        }
        const sequentialScans = relationCost.sequentialScans;
        const context = `${name}: sample ${sampleIndex + 1}, repetition ${repetitionIndex + 1}, relation ${relation} at scale ${describe(sample.scale)}, actual pages ${describe(pages)}, scan count ${describe(sequentialScans)}`;

        if (typeof pages !== 'number' || !Number.isFinite(pages) || !Number.isInteger(pages) || pages < 0) {
          throw new Error(
            `${context}, field relationSizes.${relation}.relpages: missing or invalid measured relation footprint; relpages must be a finite nonnegative integer`,
          );
        }
        if (
          typeof sequentialScans !== 'number' ||
          !Number.isFinite(sequentialScans) ||
          !Number.isInteger(sequentialScans) ||
          sequentialScans < 0
        ) {
          throw new Error(
            `${context}, field repetitions[${repetitionIndex + 1}].relations.${relation}.sequentialScans: missing or invalid sequential scan count; expected a finite nonnegative integer`,
          );
        }
        if (pages > TINY_RELATION_PAGE_LIMIT && sequentialScans > 0) {
          throw new Error(
            `${context}: sequential scans must be zero when the measured relation exceeds ${TINY_RELATION_PAGE_LIMIT} pages`,
          );
        }
      }
    }
  }
}
