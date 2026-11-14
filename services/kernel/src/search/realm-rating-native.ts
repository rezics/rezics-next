import canonicalize from 'canonicalize';
import { admitFilter, parseFilter } from '@rezics/filter';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem-error.ts';
import { createRealmRankOrderSource, type RealmRankOrderObservation } from '../rating/realm-rank.ts';
import { STANDARD_QUESTION_ID } from '../rating/standard-question.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { subjectGenerations } from './indices.ts';
import { activeRelease } from './native-bindings.ts';
import type { OpenSearch, SearchRequestOptions } from './opensearch.ts';
import { SearchOperationError } from './operation-outcomes.ts';
import { discloseRealmRatingWindow, readRealmRatingCanonical } from './realm-rating-native-read.ts';
import type { RealmRatingContext, RealmRatingHit, RealmRatingQuery, RealmRatingSource } from './realm-rating-order.ts';
import type { SubjectSource } from './source.ts';
import type { SearchFrontier } from './useful-page.ts';

type Dependencies = {
  pool: Pool;
  search: OpenSearch;
  prefix: string;
  tokens: KeyRing;
  /** The same configured, fenced current Subject source supplied to readRealmRatingOrder.
   * Predicate-free traversal can defer facts to that outer reader. Predicate execution
   * requires this source; constructing an unfenced source from just Pool is unsafe.
   */
  source?: SubjectSource;
};

const notReady = () => new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });

function remaining(query: RealmRatingQuery): number {
  const milliseconds = query.deadline - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new ProblemError('deadline_exceeded');
  return Math.max(1, Math.floor(milliseconds));
}

/** Keep physical Search calls on the same deadline as native Pool checkout and cleanup. */
function requestSearch(search: OpenSearch, query: RealmRatingQuery): OpenSearch {
  return {
    ...search,
    async request<T>(
      method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
      path: string,
      body?: unknown,
      options?: SearchRequestOptions,
    ) {
      const timeoutMs = Math.min(options?.timeoutMs ?? Infinity, remaining(query));
      const result = await search.request<T>(method, path, body, { ...options, timeoutMs });
      remaining(query);
      return result;
    },
  };
}

function contextOf(
  observed: RealmRankOrderObservation,
  query: RealmRatingQuery,
  generation: number,
  meaning: { digest: string; head: number } | null,
): RealmRatingContext {
  const meaningDigest = query.meaningDigest ?? null;
  const observation = canonicalize([
    observed,
    generation,
    meaning,
    query.principal,
    query.text ?? null,
    query.filter ?? null,
  ]);
  if (observation === undefined) throw notReady();
  return {
    questionId: STANDARD_QUESTION_ID,
    populationId: observed.populationId,
    priorEpoch: observed.priorEpoch,
    realm: { authority: observed.realmAuthority, revision: observed.realmRevision },
    generation,
    searchGeneration: generation,
    asOf: new Date().toISOString(),
    questionIdentity: observed.questionIdentity,
    questionRevision: observed.questionRevision,
    questionProvenance: observed.questionProvenance,
    priorGeneration: observed.priorGeneration,
    canonicalGeneration: observed.canonicalPopulation.generation,
    publicationGeneration: observed.publicationGeneration,
    priorActive: observed.priorActive,
    priorUpdating: observed.priorUpdating,
    meaningDigest,
    observation: createHash('sha256').update(observation).digest('hex'),
  };
}

function assertContext(expected: RealmRatingContext, current: RealmRatingContext): void {
  const { asOf: _expectedTime, ...before } = expected;
  const { asOf: _currentTime, ...after } = current;
  if (!isDeepStrictEqual(before, after)) throw new ProblemError('search_restart_required');
}

function scoredRequest(request: SearchFrontier & { size: number }): void {
  if (
    !Number.isInteger(request.size) ||
    request.size < 1 ||
    request.size > 200 ||
    (request.ratingPhase !== undefined && request.ratingPhase !== 'scored')
  )
    throw notReady();
  if (request.after === undefined) return;
  const [score, name, id] = request.after;
  if (
    request.ratingPhase !== 'scored' ||
    request.after.length !== 3 ||
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 10 ||
    !(name === null || (typeof name === 'string' && name.length <= 512 && name.isWellFormed())) ||
    typeof id !== 'string' ||
    routeOf(id) === null
  )
    throw notReady();
}

/** Live request authority is mandatory; native observations never constitute a cached grant. */
export function createRealmRatingNativeSource(deps: Dependencies): RealmRatingSource {
  // Request-local work only. No native observations, candidates or grants survive a read.
  // The outer collector has at most three rounds. Reserve raw frontier work too,
  // including empty seeks and unused candidates; useful hits cannot refund it.
  const budgets = new WeakMap<
    RealmRatingQuery,
    {
      observation: string;
      scored: number;
      unscored: number;
      seeks: number;
      rows: number;
      candidates: number;
      candidateLimit: number;
    }
  >();
  const work = (
    query: RealmRatingQuery,
    context: RealmRatingContext,
    phase: 'scored' | 'unscored',
    size: number,
  ) => {
    if (!Number.isInteger(size) || size < 1 || size > 200) throw notReady();
    let budget = budgets.get(query);
    if (!budget) {
      budget = {
        observation: context.observation,
        scored: 0,
        unscored: 0,
        seeks: 0,
        rows: 0,
        candidates: 0,
        // The first collector window is min(200, 2*usefulSize+1).
        candidateLimit: Math.min(600, 3 * size),
      };
      budgets.set(query, budget);
    }
    if (budget.observation !== context.observation) throw new ProblemError('search_restart_required');
    if (++budget[phase] > 3) throw notReady();
    const root = budget;
    return {
      reserve(rows: number) {
        remaining(query);
        if (++root.seeks > 6 * 4096 + 600 || (root.rows += rows) > 51 * 4096 + 9600) throw notReady();
      },
      window(size: number) {
        const available = Math.min(size, root.candidateLimit - root.candidates);
        if (available < 1) throw notReady();
        return available;
      },
      consume(rows: number) {
        if ((root.candidates += rows) > root.candidateLimit) throw notReady();
      },
    };
  };
  const observe = async (query: RealmRatingQuery) => {
    remaining(query);
    const authority = query.authority;
    if (!authority) throw notReady();
    const principal = authority.actor.kind === 'anonymous' ? 'anonymous' : `account:${authority.actor.accountId}`;
    if (query.principal !== principal) throw notReady();
    const native = createRealmRankOrderSource({ pool: deps.pool, access: authority.access, tokens: deps.tokens });
    const selected = { realmId: query.populationId, questionId: STANDARD_QUESTION_ID };
    const observed = await native.observe(authority.actor, selected, { deadline: query.deadline });
    if (observed.populationId !== query.populationId || observed.question.id !== STANDARD_QUESTION_ID) throw notReady();
    let meaning: { digest: string; head: number } | null = null;
    if (query.release !== undefined || query.meaningDigest !== undefined || query.filter !== undefined) {
      const current = await activeRelease(deps.pool);
      if (!current || !query.release || !query.meaningDigest) throw notReady();
      if (
        current.digest !== query.meaningDigest ||
        !isDeepStrictEqual(current.release, query.release)
      )
        throw new ProblemError('search_restart_required');
      meaning = { digest: current.digest, head: current.head };
      if (
        query.filter &&
        !isDeepStrictEqual(admitFilter(parseFilter(query.filter), query.release, { inverse: true }), query.filter)
      )
        throw notReady();
    }
    const { active } = await subjectGenerations(requestSearch(deps.search, query), deps.prefix);
    if (active === null) throw notReady();
    return { native, observed, context: contextOf(observed, query, active, meaning) };
  };
  const current = async (query: RealmRatingQuery, expected: RealmRatingContext) => {
    const value = await observe(query);
    assertContext(expected, value.context);
    return value;
  };
  const run = <T>(query: RealmRatingQuery, read: () => Promise<T>): Promise<T> =>
    withRequestDeadline(query.deadline, async () => {
      try {
        remaining(query);
        const result = await read();
        remaining(query);
        return result;
      } catch (error) {
        if (error instanceof ProblemError) throw error;
        if (error instanceof SearchOperationError && error.code === 'search_restart_required')
          throw new ProblemError('search_restart_required');
        remaining(query);
        throw notReady();
      }
    });
  const predicateReady = (query: RealmRatingQuery) => {
    if ((query.text !== undefined || query.filter !== undefined) && !deps.source) throw notReady();
  };
  return {
    observe: (query) => run(query, async () => {
      const value = await observe(query);
      // The public observation brackets an outer page invocation. Internal
      // current() observations never renew its refill allowance or authority.
      budgets.delete(query);
      return value.context;
    }),
    readScoredFrontiers: (query, context, request) => run(query, async () => {
      const { native, observed } = await current(query, context);
      scoredRequest(request);
      predicateReady(query);
      const budget = work(query, context, 'scored', request.size);
      if (observed.priorActive) {
        const selected = { realmId: query.populationId, questionId: context.questionId };
        const partitions = await native.listScoredPartitions(query.authority!.actor, selected, observed, {
          deadline: query.deadline,
        });
        // Generation rows survive removal of their last rank. Inventory alone is
        // not evidence of a remaining scored candidate or of exhaustion.
        for (const partition of partitions) {
          budget.reserve(1);
          const page = await native.readScoredPartition(
            query.authority!.actor,
            { ...selected, partition, after: null, limit: 1 },
            observed,
            { deadline: query.deadline },
          );
          if (page.candidates.length > 0) {
            /** Dependent operation, Content's existing RealmRankOrderSource owner:
             * add a partition-local bounded scored canonical seek under THIS
             * RealmRankOrderObservation and live actor/deadline. Input is selected
             * Realm/question, partition, limit <= 200 and nullable strict key
             * { score: number, name: string | null, id: string }; order is score
             * DESC, name ASC (missing last, C collation), ID ASC. The key may
             * originate in another home. Return epoch/position, generation and
             * canonical name/security revision plus complete figure proof for
             * every raw row. Reobserve even empty reads; pending/changed evidence
             * is unavailable/restart. Cost must bound ordered work without scanning
             * a whole tie or Subject population. Keep the compatibility port and
             * the current sole Rating publication writer. This is a consumer
             * requirement, not an assumed method on the delivered API.
             */
            throw notReady();
          }
        }
      }
      const refreshed = await current(query, context);
      return { context: refreshed.context, partitions: [] };
    }),
    readUnscored: (query, context, request) => run(query, async () => {
      const { native, observed } = await current(query, context);
      predicateReady(query);
      const budget = work(query, context, 'unscored', request.size);
      const hits: RealmRatingHit[] = [];
      let frontier: SearchFrontier = request;
      while (hits.length < request.size) {
        const raw = await readRealmRatingCanonical({
          native,
          observed,
          query,
          context,
          request: { ...frontier, size: budget.window(request.size - hits.length) },
          prefix: deps.prefix,
          reserve: budget.reserve,
        });
        budget.consume(raw.length);
        // Only a complete empty canonical seek certifies exhaustion. Predicate
        // rejects continue internally under the SAME allowance and source cut.
        if (raw.length === 0) break;
        hits.push(...(await discloseRealmRatingWindow({
          pool: deps.pool,
          search: requestSearch(deps.search, query),
          source: deps.source,
          prefix: deps.prefix,
          query,
          context,
          observed,
          hits: raw,
        })));
        frontier = { ratingPhase: 'unscored', after: raw.at(-1)!.sort };
      }
      const refreshed = await current(query, context);
      return { context: refreshed.context, hits };
    }),
  };
}
