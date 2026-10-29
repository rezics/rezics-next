import type { ReportSample } from './growth.ts';

export type AccessPathSample = Pick<ReportSample, 'scale' | 'repetitions' | 'relationSizes'>;

const TINY_RELATION_PAGE_LIMIT = 8;

function describe(value: unknown): string {
  return value === undefined ? 'missing' : String(value);
}

/** Rejects executed sequential scans of requested relations whose measured footprint exceeds eight pages. */
export function assertGrowthAccessPaths(
  name: string,
  samples: readonly AccessPathSample[],
  relations: readonly string[],
): void {
  for (const sample of samples) {
    for (const [index, repetition] of sample.repetitions.entries()) {
      for (const relation of relations) {
        if (!Object.hasOwn(repetition.relations, relation)) continue;

        const pages = sample.relationSizes?.[relation]?.relpages;
        const sequentialScans = repetition.relations[relation]?.sequentialScans;
        const context = `${name}: relation ${relation} at scale ${sample.scale}, actual pages ${describe(pages)}, repetition ${index + 1}, scan count ${describe(sequentialScans)}`;

        if (typeof pages !== 'number' || !Number.isFinite(pages) || !Number.isInteger(pages) || pages < 0) {
          throw new Error(
            `${context}: missing or invalid measured relation footprint; relpages must be a finite nonnegative integer`,
          );
        }
        if (typeof sequentialScans !== 'number' || !Number.isFinite(sequentialScans) || sequentialScans < 0) {
          throw new Error(`${context}: missing or invalid sequential scan count; expected a finite nonnegative number`);
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
