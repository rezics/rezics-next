import type { FilterDocument, FilterRelease } from '@rezics/filter';
import {
  admitFacets,
  codeFacet,
  discloseFacetValues,
  typeFacetLabels,
  validateFacets,
  type Facet,
  type FacetValue,
} from './facets.ts';
import { checkHits, type FactClause, type Hit } from './disclosure/check.ts';
import { chooseTexts, validateHitOptions } from './hits.ts';
import type { IndexedSubject, SubjectSource } from './source.ts';

const MAX_LIVE_FACET_CANDIDATES = 200;
const MAX_LABEL_BATCH = 200;

export type LiveFacetRequest = {
  source: SubjectSource;
  hits: readonly Hit[];
  clauses: ReadonlyMap<string, FactClause>;
  filter?: FilterDocument;
  relationProperties?: readonly string[];
  facets: readonly Facet[];
  release: FilterRelease;
  languages?: readonly string[];
  /** True only when the caller exhausted the engine's candidate set. */
  complete: boolean;
};

export type LiveFacet = {
  property: string;
  relation: 'exact' | 'lower_bound';
  values: FacetValue[];
};

export type LiveFacetResult = {
  facets: LiveFacet[];
  total: { value: number; relation: 'exact' | 'lower_bound' };
};

/**
 * Read bounded source-backed facet counts from actual engine candidates.
 *
 * Cost
 * - Touches: `checkHits` reads grouped candidate anchor partitions and rechecks current positive relation
 *   membership in bounded point batches. Item labels use `discloseFacetValues` for only the top `2 * size`
 *   values per facet, grouped by target partition.
 * - Bound: At most 200 candidates, 8 facets, size 20 and 40 label targets per facet. Label reads are split into
 *   batches of at most 200 anchors; point probes retain the source's 256 probe bound. Work is independent of total
 *   subjects and statement history, with no engine requests or unbounded label fanout.
 * - Growth check: `test/search/live-facets.test.ts` covers bounded candidates and labels, current disclosure,
 *   relation proof and exactness across complete and incomplete samples.
 */
export async function readLiveFacets(request: LiveFacetRequest): Promise<LiveFacetResult> {
  if (!Array.isArray(request.hits)) throw new TypeError('Live facet hits must be an array');
  if (request.hits.length > MAX_LIVE_FACET_CANDIDATES)
    throw new RangeError(`Live facets accept at most ${MAX_LIVE_FACET_CANDIDATES} candidates`);
  if (typeof request.complete !== 'boolean') throw new TypeError('Live facet completeness must be a boolean');
  if (!Array.isArray(request.facets)) throw new TypeError('Live facets must be an array');
  if (request.relationProperties !== undefined && !Array.isArray(request.relationProperties))
    throw new TypeError('Relation properties must be an array');
  if (request.relationProperties?.some((property) => typeof property !== 'string'))
    throw new TypeError('Relation properties must be strings');
  if (!(request.clauses instanceof Map) && typeof request.clauses?.entries !== 'function')
    throw new TypeError('Live facet clauses must be a map');

  // Run all request and release admission checks before the first source read.
  const facets = validateFacets({ facets: [...request.facets] });
  const { languages } = validateHitOptions({ languages: request.languages });
  admitFacets(facets, request.filter, request.release);

  const checked = await checkHits(request.source, request.hits, request.clauses, {
    ...(request.filter === undefined ? {} : { filter: request.filter }),
    ...(request.relationProperties === undefined ? {} : { relationProperties: request.relationProperties }),
  });

  // Repeated engine hits cannot contribute more than once per current source id.
  const subjects = new Map<string, IndexedSubject>();
  for (const { hit, subject } of checked.passed) if (!subjects.has(hit.id)) subjects.set(hit.id, subject);

  // A dropped candidate or uncertain relation proof cannot establish an exact count. An empty engine sample also
  // cannot prove current absence: `complete` describes engine exhaustion, not source truth.
  const exactCandidates =
    request.complete && request.hits.length > 0 && checked.dropped === 0 && checked.relationRejected !== true;
  const counts = facets.map(() => new Map<string, number>());
  const overflow = facets.map(() => false);

  for (const [index, facet] of facets.entries()) {
    const values = counts[index]!;
    const isCode = facet.property !== 'type' && codeFacet(request.release, facet.property);
    const property = Object.hasOwn(request.release.properties, facet.property)
      ? request.release.properties[facet.property]
      : undefined;
    const isItem = facet.property !== 'type' && !isCode && property?.datatype === 'wikibase-item';

    for (const subject of subjects.values()) {
      if (facet.property === 'type') {
        values.set(subject.type, (values.get(subject.type) ?? 0) + 1);
        continue;
      }
      if (subject.relationFacetOverflow?.includes(facet.property)) overflow[index] = true;

      const seen = new Set<string>();
      for (const statement of subject.statements) {
        if (
          statement.property !== facet.property ||
          (isItem && statement.facet?.kind !== 'item') ||
          (isCode && statement.facet?.kind !== 'code') ||
          (!isItem && !isCode)
        )
          continue;
        if (seen.has(statement.value)) continue;
        seen.add(statement.value);
        values.set(statement.value, (values.get(statement.value) ?? 0) + 1);
      }
    }
  }

  const ordered = counts.map((values) =>
    [...values].sort((left, right) => right[1] - left[1] || compare(left[0], right[0])),
  );
  const labelTargets = new Set<string>();
  for (const [index, facet] of facets.entries()) {
    if (facet.property === 'type' || codeFacet(request.release, facet.property)) continue;
    for (const [value] of ordered[index]!.slice(0, 2 * facet.size)) labelTargets.add(value);
  }

  const visibleTargets = new Map<string, IndexedSubject>();
  const targets = [...labelTargets];
  for (let offset = 0; offset < targets.length; offset += MAX_LABEL_BATCH) {
    const visible = await discloseFacetValues(request.source, targets.slice(offset, offset + MAX_LABEL_BATCH));
    for (const [id, subject] of visible) visibleTargets.set(id, subject);
  }

  const disclosureIncomplete = facets.map((facet, index) => {
    if (facet.property !== 'type' && codeFacet(request.release, facet.property)) return false;
    const candidates = ordered[index]!.slice(0, 2 * facet.size);
    if (candidates.length === ordered[index]!.length) return false;
    const disclosed = candidates.filter(([value]) =>
      facet.property === 'type' ? typeFacetLabels(request.release, value) !== undefined : visibleTargets.has(value),
    ).length;
    return disclosed < facet.size;
  });

  const resultFacets = facets.map((facet, index): LiveFacet => {
    const isCode = facet.property !== 'type' && codeFacet(request.release, facet.property);
    const values = ordered[index]!.slice(0, 2 * facet.size)
      .flatMap(([value, count]): FacetValue[] => {
        if (facet.property === 'type') {
          const available = typeFacetLabels(request.release, value);
          return available === undefined
            ? []
            : [
                {
                  value,
                  count,
                  labels: chooseTexts(
                    Object.entries(available).map(([language, text]) => ({ language, value: text })),
                    languages,
                    undefined,
                  ),
                },
              ];
        }
        if (isCode) return [{ value, count, labels: {} }];
        const target = visibleTargets.get(value);
        return target
          ? [{ value, count, labels: chooseTexts(target.labels, languages, originalLanguage(target)) }]
          : [];
      })
      .slice(0, facet.size);
    return {
      property: facet.property,
      relation: exactCandidates && !overflow[index] && !disclosureIncomplete[index] ? 'exact' : 'lower_bound',
      values,
    };
  });

  return {
    facets: resultFacets,
    total: { value: subjects.size, relation: exactCandidates ? 'exact' : 'lower_bound' },
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function originalLanguage(subject: IndexedSubject): string | undefined {
  return subject.statements.find(({ property }) => property === 'schema:inLanguage')?.value;
}
