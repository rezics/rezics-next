import type { ReportSample } from './growth.ts';
import {
  formatRelationIdentity,
  legacyRelationKey,
  relationIdentityKey,
  relationIdentityMatches,
  type RelationIdentity,
} from './growth-relation-identity.ts';

export type AccessPathSample = Pick<ReportSample, 'scale' | 'repetitions' | 'relationSizes'>;
export type RelationRequest = string | RelationIdentity;

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
  throw new Error(`${name}: sample ${sampleIndex + 1}, repetition ${repetitionIndex + 1}, field ${field}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRelationIdentity(value: unknown): value is RelationIdentity {
  return (
    isRecord(value) &&
    (value.database === undefined || typeof value.database === 'string') &&
    (value.schema === undefined || typeof value.schema === 'string') &&
    (value.kind === 'relation' || value.kind === 'index') &&
    typeof value.name === 'string'
  );
}

function relationLabel(requested: RelationRequest): string {
  return typeof requested === 'string' ? requested : formatRelationIdentity(requested);
}

function relationMatches(
  name: string,
  sampleIndex: number,
  repetitionIndex: number,
  costs: Record<string, unknown>,
  requested: RelationRequest,
): { readonly key: string; readonly cost: unknown; readonly identity?: RelationIdentity } | undefined {
  const matches = Object.entries(costs).flatMap(([key, cost]) => {
    if (!isRecord(cost)) return [];
    const rawIdentity = cost.identity;
    if (rawIdentity !== undefined && !isRelationIdentity(rawIdentity))
      invalidEvidence(
        name,
        sampleIndex,
        repetitionIndex,
        `relations.${key}.identity`,
        'expected a database/schema/relation identity',
      );
    const identity = rawIdentity as RelationIdentity | undefined;
    const matchesRequest =
      identity === undefined
        ? typeof requested === 'string' && key === requested
        : typeof requested === 'string'
          ? legacyRelationKey(identity) === requested
          : relationIdentityMatches(identity, requested);
    return matchesRequest ? [{ key, cost, ...(identity === undefined ? {} : { identity }) }] : [];
  });
  if (matches.length > 1) {
    const candidates = matches.map(({ identity }) => (identity === undefined ? '<unknown identity>' : formatRelationIdentity(identity)));
    invalidEvidence(
      name,
      sampleIndex,
      repetitionIndex,
      'relations',
      `relation ${relationLabel(requested)} is ambiguous across ${candidates.join(', ')}; pass an identity with database and schema`,
    );
  }
  if (matches.length === 1) return matches[0];
  if (typeof requested === 'string' && Object.hasOwn(costs, requested))
    return { key: requested, cost: costs[requested] };
  return undefined;
}

function measuredPages(
  name: string,
  sampleIndex: number,
  repetitionIndex: number,
  sample: AccessPathSample,
  match: { readonly key: string; readonly identity?: RelationIdentity },
): unknown {
  const sizes = sample.relationSizes;
  if (!isRecord(sizes)) return undefined;
  if (match.identity !== undefined) {
    const key = relationIdentityKey(match.identity);
    const matches = Object.entries(sizes).filter(
      ([, size]) => isRecord(size) && isRelationIdentity(size.identity) && relationIdentityKey(size.identity) === key,
    );
    if (matches.length > 1)
      invalidEvidence(
        name,
        sampleIndex,
        repetitionIndex,
        'relationSizes',
        `duplicate footprint evidence for ${formatRelationIdentity(match.identity)}`,
      );
    if (matches.length === 1) return (matches[0]![1] as Record<string, unknown>).relpages;
  }
  const size = sizes[match.key];
  return isRecord(size) ? size.relpages : undefined;
}

/** Rejects executed sequential scans of requested relations whose measured footprint exceeds eight pages. */
export function assertGrowthAccessPaths(
  name: string,
  samples: readonly AccessPathSample[],
  relations: readonly RelationRequest[],
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
        invalidEvidence(
          name,
          sampleIndex,
          repetitionIndex,
          `repetitions[${repetitionIndex + 1}]`,
          'expected an object',
        );
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

      for (const requested of relations) {
        const evidence = relationMatches(name, sampleIndex, repetitionIndex, costs, requested);
        if (evidence === undefined) continue;
        const relation = evidence.identity === undefined ? evidence.key : formatRelationIdentity(evidence.identity);
        const pages = measuredPages(name, sampleIndex, repetitionIndex, sample, evidence);
        const relationCost = evidence.cost;
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
