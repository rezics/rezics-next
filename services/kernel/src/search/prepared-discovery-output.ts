import {
  relationFacetProperty,
  type DiscoveryFilterDocument,
  type FilterDocument,
  type FilterRelease,
} from '@rezics/filter';
import type { DiscoveryEngineHit, DiscoveryRegistry } from './discovery.ts';
import { currentDiscoveryFilter } from './discovery-filter.ts';
import { checkHits, type Hit } from './disclosure/check.ts';
import type { PublicFilterPreparationSegmentEntry } from './public-filter-preparation-segment.ts';
import type { SubjectSource } from './source.ts';
import { subjectPartition } from './source.ts';

export type PreparedDiscoveryPredicateMeter = Readonly<{
  sourceRead(keys: number): void;
  relationBatch(): void;
}>;

function hasQualifiedStatement(filter: DiscoveryFilterDocument): boolean {
  const pending: DiscoveryFilterDocument[] = [filter];
  while (pending.length) {
    const node = pending.pop()!;
    if ('and' in node || 'or' in node) pending.push(...('and' in node ? node.and : node.or));
    else if ('not' in node) pending.push(node.not);
    else if ('statement' in node && node.statement.qualifiers?.length) return true;
  }
  return false;
}

/**
 * Remove only request-bound concept membership that preparation cannot own. A positive exact-concept
 * statement's value and qualifiers remain a safe necessary filter. Descendant and negated concepts
 * require a caller-bound concept execution, so preparation leaves their whole predicate untouched.
 */
function publicPreparationFilter(filter: DiscoveryFilterDocument): DiscoveryFilterDocument | undefined {
  let unsupported = false;
  function rewrite(node: DiscoveryFilterDocument, positive = true): DiscoveryFilterDocument {
    if ('not' in node) {
      const child = rewrite(node.not, !positive);
      return { not: child };
    }
    if ('and' in node) return { and: node.and.map((child) => rewrite(child, positive)) };
    if ('or' in node) return { or: node.or.map((child) => rewrite(child, positive)) };
    if ('realm' in node || 'ratingQuestion' in node || 'owner' in node || 'saved' in node) {
      unsupported = true;
      return node;
    }
    if ('statement' in node) {
      if ('inverse' in node.statement && node.statement.inverse) unsupported = true;
      if ('concept' in node.statement && node.statement.concept) {
        if (!positive || node.statement.concept.includeChildren) unsupported = true;
        const { concept: _concept, ...statement } = node.statement;
        return { statement };
      }
    }
    return node;
  }
  const prepared = rewrite(filter);
  return unsupported ? undefined : prepared;
}

async function preparedDiscoveryOutputPositions(
  hits: readonly DiscoveryEngineHit[],
  filter: DiscoveryFilterDocument | undefined,
  registry: DiscoveryRegistry,
  release: FilterRelease,
  meter?: PreparedDiscoveryPredicateMeter,
): Promise<ReadonlySet<number>> {
  const selected = new Set<number>();
  if (!filter || !hasQualifiedStatement(filter)) {
    hits.forEach((_hit, position) => selected.add(position));
    return selected;
  }
  const preparedFilter = publicPreparationFilter(filter);
  if (!preparedFilter) {
    hits.forEach((_hit, position) => selected.add(position));
    return selected;
  }

  const grouped = new Map<
    string,
    { predicate: FilterDocument; entries: { hit: DiscoveryEngineHit; position: number }[] }
  >();
  for (const [position, hit] of hits.entries()) {
    if (hit.key.owner !== 'semantic') {
      // Owner eligibility is caller-sensitive and stays in the current serving disclosure pass.
      selected.add(position);
      continue;
    }
    const predicate = currentDiscoveryFilter(preparedFilter, registry, hit.key.kind, release);
    if (predicate === true) {
      selected.add(position);
      continue;
    }
    if (predicate === false) continue;
    const group = grouped.get(hit.key.kind) ?? { predicate, entries: [] };
    group.entries.push({ hit, position });
    grouped.set(hit.key.kind, group);
  }

  const relationProperties = Object.keys(release.properties).filter((property) =>
    relationFacetProperty(release, property),
  );
  for (const [kind, group] of grouped) {
    const entry = registry.get(kind);
    if (entry.owner !== 'semantic') continue;
    if (!entry.source.matchRelationFacets && !entry.source.prepareRelationFacets) {
      group.entries.forEach(({ position }) => selected.add(position));
      continue;
    }
    const source: SubjectSource = {
      ...entry.source,
      ...(entry.source.prepareRelationFacets
        ? {
            async prepareRelationFacets(probes) {
              meter?.sourceRead(probes.length);
              const page = await entry.source.prepareRelationFacets!(probes);
              return {
                bounds: page.bounds,
                async match() {
                  meter?.sourceRead(probes.length);
                  meter?.relationBatch();
                  return page.match();
                },
                async revalidate() {
                  meter?.sourceRead(probes.length);
                  return page.revalidate();
                },
              };
            },
          }
        : {}),
      async read(partition, ids) {
        meter?.sourceRead(ids.length);
        return entry.source.read(partition, ids);
      },
      async matchRelationFacets(partition, probes) {
        meter?.relationBatch();
        return entry.source.matchRelationFacets!(partition, probes);
      },
    };
    const candidates = group.entries.map(({ hit }) => {
      const current: Hit = {
        id: hit.key.id,
        partition: subjectPartition(hit.key.id),
        securityRevision: Number(hit.revision),
        matched: [],
      };
      return current;
    });
    const checked = await checkHits(source, candidates, new Map(), {
      filter: group.predicate,
      relationProperties,
      includeOutcomes: true,
    });
    // The ordinary serving check treats any sensitive rejection as a stale-window signal. Preparation
    // can use its aligned current truth: definite false is excluded; uncertainty stays a candidate.
    group.entries.forEach(({ position }, index) => {
      if (checked.outcomes?.[index] !== false) selected.add(position);
    });
  }
  return selected;
}

export async function createPreparedDiscoveryOutputSegment(
  input: Readonly<{
    hits: readonly DiscoveryEngineHit[];
    ownerRows: readonly Readonly<{ original: string; terminal: string }>[];
    ownerPositions: readonly number[];
    rawCount: number;
    outputCount: number;
    filter: DiscoveryFilterDocument | undefined;
    registry: DiscoveryRegistry;
    release: FilterRelease;
    meter?: PreparedDiscoveryPredicateMeter;
  }>,
): Promise<
  Readonly<{
    entries: readonly PublicFilterPreparationSegmentEntry[];
    rawCount: number;
    outputCount: number;
  }>
> {
  const predicatePositions = await preparedDiscoveryOutputPositions(
    input.hits,
    input.filter,
    input.registry,
    input.release,
    input.meter,
  );
  const owned = new Set(input.ownerPositions);
  let outputCount = input.outputCount;
  const entries = input.hits.map((hit, position): PublicFilterPreparationSegmentEntry => {
    const outputOrdinal = owned.has(position) && predicatePositions.has(position) ? outputCount++ : null;
    return {
      rawOrdinal: input.rawCount + position,
      outputOrdinal,
      payload: { hit, owner: input.ownerRows[position]! },
    };
  });
  return { entries, rawCount: input.rawCount + input.hits.length, outputCount };
}
