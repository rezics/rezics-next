import { relationFacetProperty } from '@rezics/filter';
import type { Pool } from 'pg';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { RealmRankOrderObservation, RealmRankOrderSource } from '../rating/realm-rank.ts';
import { accessCheck } from '../request/access.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { checkHits, type FactClause } from './disclosure/check.ts';
import { createCurrentTextMatcher } from './disclosure/current-text.ts';
import { analyzeInstalledMany } from './engine-analysis.ts';
import { compileFilter } from './filter.ts';
import { subjectIndexName } from './indices.ts';
import { activeRelease } from './native-bindings.ts';
import type { OpenSearch } from './opensearch.ts';
import {
  normalizeRealmRatingHit,
  type RealmRatingContext,
  type RealmRatingHit,
  type RealmRatingQuery,
} from './realm-rating-order.ts';
import { validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import { subjectPartition, type IndexedSubject, type SubjectSource } from './source.ts';
import type { SearchFrontier } from './useful-page.ts';

const notReady = () => new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
const restart = () => new ProblemError('search_restart_required');
const BATCH_SIZE = 16;
type NameKey = { name: string | null; id: string };
type NativePage = Awaited<ReturnType<RealmRankOrderSource['readCanonicalPartition']>>;

/** Each release observation closes its local snapshot before any native owner work. */
export function readRealmRatingRelease(pool: Pool, deadline: number): ReturnType<typeof activeRelease> {
  return withBoundedReadOnlyTransaction(pool, deadline, (client) => activeRelease(client), {
    deadlineError: () => new ProblemError('deadline_exceeded'),
    isUncertainSettledQueryError: () => true,
  });
}

function compareNames(left: NameKey, right: NameKey): number {
  if (left.name !== right.name) {
    if (left.name === null) return 1;
    if (right.name === null) return -1;
    return Buffer.compare(Buffer.from(left.name), Buffer.from(right.name));
  }
  return Buffer.compare(Buffer.from(left.id), Buffer.from(right.id));
}

function realmRatingNameAfter(request: SearchFrontier & { size: number }): NameKey | null {
  if (!Number.isInteger(request.size) || request.size < 1 || request.size > 200) throw notReady();
  if (request.ratingPhase !== undefined && request.ratingPhase !== 'unscored') throw notReady();
  if (request.after === undefined) return null;
  const [name, id] = request.after;
  if (
    request.ratingPhase !== 'unscored' ||
    request.after.length !== 2 ||
    !(name === null || (typeof name === 'string' && name.length <= 512 && name.isWellFormed())) ||
    typeof id !== 'string' ||
    routeOf(id) === null
  )
    throw notReady();
  return { name, id };
}

function canonicalHit(
  candidate: NativePage['candidates'][number],
  page: NativePage,
  context: RealmRatingContext,
  index: string,
): RealmRatingHit {
  const { proof } = candidate;
  if (
    subjectPartition(candidate.id) !== page.partition ||
    !Number.isSafeInteger(candidate.securityRevision) ||
    candidate.securityRevision < 0 ||
    !proof ||
    proof.subjectId !== candidate.id ||
    typeof proof.scored !== 'boolean' ||
    proof.updating !== false ||
    (!proof.scored && proof.figure !== null && proof.figure.score !== null)
  )
    throw notReady();
  const figure = proof.figure === null
    ? null
    : {
        ...proof.figure,
        questionId: context.questionId,
        populationId: context.populationId,
      };
  // Validate the actual figure BEFORE suppressing a scored row in the complement.
  // Score zero is scored; an absent/below-threshold figure is never fabricated.
  const hit: RealmRatingHit = {
    id: candidate.id,
    index,
    partition: page.partition,
    securityRevision: candidate.securityRevision,
    matched: [],
    sort: proof.scored ? [figure?.score ?? null, candidate.name, candidate.id] : [candidate.name, candidate.id],
    ratingPhase: proof.scored ? 'scored' : 'unscored',
    position: page.position,
    threshold: 5,
    figure,
  };
  normalizeRealmRatingHit(hit, context);
  if (!proof.scored) return hit;
  return { ...hit, sort: [candidate.name, candidate.id], ratingPhase: 'unscored', figure: null, suppressed: true };
}

/**
 * Merge occupied canonical homes, retaining at most 16 rows per home plus the
 * requested raw window. Initial seeks cost P*min(16,B) rows; each refill follows
 * a consumed buffer, never rescans a prefix. At most P+B seeks and 16P+16B
 * reserved rows per call, with P <= 4096 and B <= 200. Native reobservations add
 * O(P*(P+B)) frontier metadata work; the original deadline bounds that work too.
 * No short page proves EOF: only an empty native seek retires a home.
 */
export async function readRealmRatingCanonical(input: {
  native: RealmRankOrderSource;
  observed: RealmRankOrderObservation;
  query: RealmRatingQuery;
  context: RealmRatingContext;
  request: SearchFrontier & { size: number };
  prefix: string;
  reserve: (rows: number) => void;
}): Promise<RealmRatingHit[]> {
  const { native, observed, query, context, request } = input;
  const after = realmRatingNameAfter(request);
  const limit = Math.min(BATCH_SIZE, request.size);
  const index = subjectIndexName(input.prefix, context.searchGeneration);
  type Frontier = {
    home: RealmRankOrderObservation['canonicalPopulation']['homes'][number];
    after: NameKey | null;
    hits: RealmRatingHit[];
    offset: number;
    exhausted: boolean;
  };
  const frontiers: Frontier[] = [];
  const fill = async (frontier: Frontier) => {
    input.reserve(limit);
    const page = await native.readCanonicalPartition(
      query.authority!.actor,
      {
        realmId: query.populationId,
        questionId: context.questionId,
        partition: frontier.home.partition,
        after: frontier.after,
        limit,
      },
      observed,
      { deadline: query.deadline },
    );
    if (
      page.partition !== frontier.home.partition ||
      page.epoch !== frontier.home.epoch ||
      page.position.toString() !== frontier.home.position
    )
      throw restart();
    if (!Array.isArray(page.candidates) || page.candidates.length > limit) throw notReady();
    let previous = frontier.after;
    frontier.hits = page.candidates.map((candidate) => {
      if (previous && compareNames(previous, candidate) >= 0) throw notReady();
      previous = { name: candidate.name, id: candidate.id };
      return canonicalHit(candidate, page, context, index);
    });
    frontier.after = previous;
    frontier.offset = 0;
    frontier.exhausted = page.candidates.length === 0;
  };
  for (const home of observed.canonicalPopulation.homes) {
    const frontier: Frontier = { home, after, hits: [], offset: 0, exhausted: false };
    await fill(frontier);
    frontiers.push(frontier);
  }
  const hits: RealmRatingHit[] = [];
  while (hits.length < request.size) {
    let selected: Frontier | undefined;
    for (const frontier of frontiers) {
      if (frontier.exhausted) continue;
      const hit = frontier.hits[frontier.offset]!;
      const current = selected?.hits[selected.offset];
      if (
        !current ||
        compareNames(
          { name: hit.sort[0] as string | null, id: hit.id },
          { name: current.sort[0] as string | null, id: current.id },
        ) < 0
      )
        selected = frontier;
    }
    if (!selected) break;
    hits.push(selected.hits[selected.offset++]!);
    if (hits.length < request.size && selected.offset === selected.hits.length) await fill(selected);
  }
  return hits;
}

/**
 * Evaluate the complete current predicate on raw keys, without using indexed
 * absence, a PIT hit subset, or a fetched scored prefix as membership evidence.
 * The caller charges every raw row and refills rejected windows before returning
 * a complete seek. Only scored complement rows use the existing suppressed marker.
 * Source must be the configured, fenced Subject source used by the outer reader.
 */
export async function discloseRealmRatingWindow(input: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource | undefined;
  prefix: string;
  query: RealmRatingQuery;
  context: RealmRatingContext;
  observed: RealmRankOrderObservation;
  hits: RealmRatingHit[];
}): Promise<RealmRatingHit[]> {
  const { pool, query, context, observed, hits } = input;
  if ((query.text !== undefined || query.filter !== undefined) && !input.source) throw notReady();
  const authority = query.authority!;
  const allowed = async (hit: RealmRatingHit) => {
    const resource = { route: routeOf(hit.id)!, id: hit.id };
    const check = await accessCheck(
      authority.access,
      authority.actor,
      'subject:read',
      { ...resource, eligibility: subjectReadEligibility(resource) },
      { pool, deadline: query.deadline },
    );
    return withBoundedReadOnlyTransaction(pool, query.deadline, (client) => check(client), {
      deadlineError: () => new ProblemError('deadline_exceeded'),
      isUncertainSettledQueryError: () => true,
    });
  };
  const candidates: RealmRatingHit[] = [];
  for (const hit of hits) if (!hit.suppressed && (await allowed(hit))) candidates.push(hit);
  let accepted = new Set(candidates);
  if (input.source) {
    const nativeSource = input.source;
    const homes = new Map(observed.canonicalPopulation.homes.map((home) => [home.partition, home]));
    const source: SubjectSource = {
      ...nativeSource,
      async read(partition, ids) {
        const snapshot = await nativeSource.read(partition, ids);
        validateRequestSourceSnapshot(snapshot, partition, ids);
        if (snapshot.position.toString() !== homes.get(partition)?.position) throw restart();
        return snapshot;
      },
      count: nativeSource.count.bind(nativeSource),
      ...(nativeSource.matchRelationFacets
        ? { matchRelationFacets: nativeSource.matchRelationFacets.bind(nativeSource) }
        : {}),
      ...(nativeSource.prepareRelationFacets
        ? { prepareRelationFacets: nativeSource.prepareRelationFacets.bind(nativeSource) }
        : {}),
    };
    const compiled = query.filter ? compileFilter(query.filter, { prefix: 'f', relationOverflow: true }) : undefined;
    const clauses = new Map<string, FactClause>(compiled?.leaves.map((leaf) => [leaf.name, leaf]));
    const relationProperties = query.release
      ? [...new Set(compiled?.leaves.flatMap((leaf) =>
          leaf.facet === 'statement' && relationFacetProperty(query.release!, leaf.property) ? [leaf.property] : [],
        ))]
      : [];
    const text = createCurrentTextMatcher((analyzer, texts) =>
      analyzeInstalledMany(input.search, subjectIndexName(input.prefix, context.searchGeneration), {
        analyzer, text: texts,
      }),
    );
    // Carry the original deadline through the configured source and retained
    // relation work. Do not hold a local transaction around these owners.
    const checked = await withRequestDeadline(query.deadline, () =>
      checkHits(source, candidates, clauses, {
        ...(query.filter ? { filter: query.filter, relationProperties } : {}),
        ...(query.text ? { currentText: (subject: IndexedSubject) => text.matchesText(subject, query.text!) } : {}),
        includeOutcomes: true,
        ...(query.release
          ? { observeRelationRelease: async () => {
              const release = await readRealmRatingRelease(pool, query.deadline);
              if (!release) throw notReady();
              if (release.digest !== context.meaningDigest) throw restart();
              return release;
            } }
          : {}),
      }),
    );
    if (!checked.outcomes || checked.outcomes.length !== candidates.length || checked.outcomes.includes('not_proven'))
      throw notReady();
    accepted = new Set(checked.passed.map(({ hit }) => hit));
  }
  const result: RealmRatingHit[] = [];
  for (const hit of hits) {
    if (hit.suppressed || (accepted.has(hit) && (await allowed(hit)))) result.push(hit);
  }
  return result;
}
