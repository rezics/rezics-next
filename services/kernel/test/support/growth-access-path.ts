import type { ReportSample } from './growth.ts';
import {
  formatRelationIdentity,
  legacyRelationKey,
  relationIdentityKey,
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

interface RelationCostEvidence {
  readonly key: string;
  readonly cost: unknown;
  readonly identity?: RelationIdentity;
}

interface EvidenceBucket<T> {
  readonly count: number;
  readonly first: T;
  readonly candidates: string;
}

interface EvidenceBucketBuilder<T> {
  count: number;
  first: T;
  candidates: string[];
}

function addEvidence<T>(
  buckets: Map<string, EvidenceBucketBuilder<T>>,
  key: string,
  evidence: T,
  candidate: string,
): void {
  const bucket = buckets.get(key);
  if (bucket === undefined) {
    buckets.set(key, { count: 1, first: evidence, candidates: [candidate] });
    return;
  }
  bucket.count++;
  bucket.candidates.push(candidate);
}

function finishEvidence<T>(builders: Map<string, EvidenceBucketBuilder<T>>): ReadonlyMap<string, EvidenceBucket<T>> {
  const entries: [string, EvidenceBucket<T>][] = [];
  for (const [key, bucket] of builders)
    entries.push([key, { count: bucket.count, first: bucket.first, candidates: bucket.candidates.join(', ') }]);
  return new Map(entries);
}

function relationFieldsKey(identity: RelationIdentity): string {
  return JSON.stringify([identity.kind, identity.name]);
}

function relationDatabaseKey(identity: RelationIdentity): string {
  return JSON.stringify([identity.database ?? null, identity.kind, identity.name]);
}

function relationSchemaKey(identity: RelationIdentity): string {
  return JSON.stringify([identity.schema ?? null, identity.kind, identity.name]);
}

interface RelationCostIndex {
  readonly byLegacySelector: ReadonlyMap<string, EvidenceBucket<RelationCostEvidence>>;
  readonly byIdentity: ReadonlyMap<string, EvidenceBucket<RelationCostEvidence>>;
  readonly byDatabase: ReadonlyMap<string, EvidenceBucket<RelationCostEvidence>>;
  readonly bySchema: ReadonlyMap<string, EvidenceBucket<RelationCostEvidence>>;
  readonly byKindAndName: ReadonlyMap<string, EvidenceBucket<RelationCostEvidence>>;
}

function indexRelationCosts(
  name: string,
  sampleIndex: number,
  repetitionIndex: number,
  costs: Record<string, unknown>,
): RelationCostIndex {
  const legacySelectors = new Map<string, EvidenceBucketBuilder<RelationCostEvidence>>();
  const identities = new Map<string, EvidenceBucketBuilder<RelationCostEvidence>>();
  const databases = new Map<string, EvidenceBucketBuilder<RelationCostEvidence>>();
  const schemas = new Map<string, EvidenceBucketBuilder<RelationCostEvidence>>();
  const kindsAndNames = new Map<string, EvidenceBucketBuilder<RelationCostEvidence>>();

  for (const [key, cost] of Object.entries(costs)) {
    if (!isRecord(cost)) continue;
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
    const evidence = { key, cost, ...(identity === undefined ? {} : { identity }) };
    const label = identity === undefined ? '<unknown identity>' : formatRelationIdentity(identity);
    addEvidence(legacySelectors, identity === undefined ? key : legacyRelationKey(identity), evidence, label);
    if (identity !== undefined) {
      addEvidence(identities, relationIdentityKey(identity), evidence, label);
      addEvidence(databases, relationDatabaseKey(identity), evidence, label);
      addEvidence(schemas, relationSchemaKey(identity), evidence, label);
      addEvidence(kindsAndNames, relationFieldsKey(identity), evidence, label);
    }
  }

  return {
    byLegacySelector: finishEvidence(legacySelectors),
    byIdentity: finishEvidence(identities),
    byDatabase: finishEvidence(databases),
    bySchema: finishEvidence(schemas),
    byKindAndName: finishEvidence(kindsAndNames),
  };
}

function identityMatches(
  index: RelationCostIndex,
  requested: RelationIdentity,
): EvidenceBucket<RelationCostEvidence> | undefined {
  if (requested.database !== undefined && requested.schema !== undefined)
    return index.byIdentity.get(relationIdentityKey(requested));
  if (requested.database !== undefined) return index.byDatabase.get(relationDatabaseKey(requested));
  if (requested.schema !== undefined) return index.bySchema.get(relationSchemaKey(requested));
  return index.byKindAndName.get(relationFieldsKey(requested));
}

function relationMatch(
  name: string,
  sampleIndex: number,
  repetitionIndex: number,
  costs: Record<string, unknown>,
  index: RelationCostIndex,
  requested: RelationRequest,
): RelationCostEvidence | undefined {
  const matches =
    typeof requested === 'string' ? index.byLegacySelector.get(requested) : identityMatches(index, requested);
  if (matches !== undefined && matches.count > 1) {
    invalidEvidence(
      name,
      sampleIndex,
      repetitionIndex,
      'relations',
      `relation ${relationLabel(requested)} is ambiguous across ${matches.candidates}; pass an identity with database and schema`,
    );
  }
  if (matches !== undefined) return matches.first;
  if (typeof requested === 'string' && Object.hasOwn(costs, requested))
    return { key: requested, cost: costs[requested] };
  return undefined;
}

function indexRelationSizes(
  sizes: Record<string, unknown>,
): ReadonlyMap<string, EvidenceBucket<Record<string, unknown>>> {
  const builders = new Map<string, EvidenceBucketBuilder<Record<string, unknown>>>();
  for (const [, size] of Object.entries(sizes)) {
    if (!isRecord(size)) continue;
    const identity = size.identity;
    if (!isRelationIdentity(identity)) continue;
    addEvidence(builders, relationIdentityKey(identity), size, formatRelationIdentity(identity));
  }
  return finishEvidence(builders);
}

function measuredPages(
  name: string,
  sampleIndex: number,
  repetitionIndex: number,
  sizes: Record<string, unknown> | undefined,
  identityIndex: ReadonlyMap<string, EvidenceBucket<Record<string, unknown>>> | undefined,
  match: RelationCostEvidence,
): unknown {
  if (match.identity !== undefined) {
    const matches = identityIndex?.get(relationIdentityKey(match.identity));
    if (matches !== undefined && matches.count > 1)
      invalidEvidence(
        name,
        sampleIndex,
        repetitionIndex,
        'relationSizes',
        `duplicate footprint evidence for ${formatRelationIdentity(match.identity)}`,
      );
    if (matches !== undefined) return matches.first.relpages;
  }
  if (sizes === undefined) return undefined;
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

    let sizes: Record<string, unknown> | undefined;
    let sizesLoaded = false;
    let sizeIdentities: ReadonlyMap<string, EvidenceBucket<Record<string, unknown>>> | undefined;
    let sizeIdentitiesLoaded = false;

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
      const relationIndex = indexRelationCosts(name, sampleIndex, repetitionIndex, costs);

      for (const requested of relations) {
        const evidence = relationMatch(name, sampleIndex, repetitionIndex, costs, relationIndex, requested);
        if (evidence === undefined) continue;
        const relation = evidence.identity === undefined ? evidence.key : formatRelationIdentity(evidence.identity);
        if (!sizesLoaded) {
          sizes = isRecord(sample.relationSizes) ? sample.relationSizes : undefined;
          sizesLoaded = true;
        }
        if (evidence.identity !== undefined && !sizeIdentitiesLoaded) {
          sizeIdentities = sizes === undefined ? undefined : indexRelationSizes(sizes);
          sizeIdentitiesLoaded = true;
        }
        const pages = measuredPages(name, sampleIndex, repetitionIndex, sizes, sizeIdentities, evidence);
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
