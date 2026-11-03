import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import { createRealmRankOrderSource, type RealmRankOrderObservation } from '../rating/realm-rank.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { readSearchCanonicalGeneration } from '../semantic/search-source.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { routeOf } from '../route/route.ts';
import type { Access, Actor } from '../request/access.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { readSubjectSortFormat, SUBJECT_SORT_FORMAT, subjectGenerations, subjectIndexName } from './indices.ts';
import { OpenSearchError, type OpenSearch } from './opensearch.ts';
import type { RealmRatingContext, RealmRatingHit, RealmRatingQuery, RealmRatingSource } from './realm-rating-order.ts';
import type { PublicRatingFigure } from './rating-source.ts';
import { subjectPartition } from './source.ts';
import { compileText } from './text.ts';

type Dependencies = { pool: Pool; search: OpenSearch; prefix: string; tokens: KeyRing };
type Captured = { context: RealmRatingContext; observation: RealmRankOrderObservation };
type RecordValue = Record<string, unknown>;

const MAX_NAME_LENGTH = 512;
const notReady = () => new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
const restart = () => new ProblemError('search_restart_required');
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function actorFor(query: RealmRatingQuery): { actor: Actor; access: Access } {
  const authority = query.authority;
  if (!authority) throw notReady();
  if (
    (authority.actor.kind === 'anonymous' && query.principal !== 'anonymous') ||
    (authority.actor.kind === 'account' && query.principal !== `account:${authority.actor.accountId}`)
  )
    throw new ProblemError('not_found');
  return authority;
}

function questionProvenance(observation: RealmRankOrderObservation): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        observation.question.realmId ?? null,
        observation.question.meaning ?? null,
        observation.question.canonicalLabel ?? null,
        observation.question.labelRevision ?? null,
      ]),
    )
    .digest('hex');
}

function sameContext(left: RealmRatingContext, right: RealmRatingContext): boolean {
  return (
    left.questionId === right.questionId &&
    left.populationId === right.populationId &&
    left.priorEpoch === right.priorEpoch &&
    left.realm.authority === right.realm.authority &&
    left.realm.revision === right.realm.revision &&
    left.generation === right.generation &&
    left.questionIdentity === right.questionIdentity &&
    left.questionRevision === right.questionRevision &&
    left.questionProvenance === right.questionProvenance &&
    left.priorGeneration === right.priorGeneration &&
    left.canonicalGeneration === right.canonicalGeneration &&
    left.publicationGeneration === right.publicationGeneration &&
    left.meaningDigest === right.meaningDigest &&
    left.searchGeneration === right.searchGeneration &&
    left.priorActive === right.priorActive &&
    left.priorUpdating === right.priorUpdating
  );
}

async function capture(deps: Dependencies, query: RealmRatingQuery): Promise<Captured> {
  if (Date.now() >= query.deadline) throw new ProblemError('deadline_exceeded');
  const { actor, access } = actorFor(query);
  const ranks = createRealmRankOrderSource({ pool: deps.pool, access, tokens: deps.tokens });
  const [observation, release, canonicalGeneration, inventory] = await Promise.all([
    ranks.observe(
      actor,
      { realmId: query.populationId, questionId: STANDARD_QUESTION_ID },
      { deadline: query.deadline },
    ),
    activeRelease(deps.pool),
    readSearchCanonicalGeneration(deps.pool),
    subjectGenerations(deps.search, deps.prefix),
  ]);
  if ((release?.digest ?? null) !== (query.meaningDigest ?? null)) throw restart();
  const generation = inventory.active;
  if (generation === null || !inventory.generations.includes(generation)) throw notReady();
  if ((await readSubjectSortFormat(deps.search, deps.prefix, generation)) !== SUBJECT_SORT_FORMAT) throw notReady();
  if (observation.priorUpdating || (!observation.priorActive && observation.priorEpoch !== null)) throw notReady();
  const meaningDigest = query.meaningDigest ?? null;
  const provenance = questionProvenance(observation);
  const observationDigest = createHash('sha256')
    .update(
      JSON.stringify([
        observation.question.id,
        observation.questionRevision,
        provenance,
        observation.questionIdentity,
        observation.priorGeneration,
        observation.priorEpoch,
        observation.priorActive,
        observation.priorUpdating,
        canonicalGeneration,
        observation.publicationGeneration,
        meaningDigest,
        generation,
        observation.realmAuthority,
        observation.realmRevision,
      ]),
    )
    .digest('hex');
  const context: RealmRatingContext = {
    questionId: STANDARD_QUESTION_ID,
    populationId: query.populationId,
    priorEpoch: observation.priorEpoch,
    realm: { authority: observation.realmAuthority, revision: observation.realmRevision },
    generation,
    asOf: new Date().toISOString(),
    questionIdentity: observation.questionIdentity,
    questionRevision: observation.questionRevision,
    questionProvenance: provenance,
    observation: observationDigest,
    priorGeneration: observation.priorGeneration,
    canonicalGeneration,
    publicationGeneration: observation.publicationGeneration,
    meaningDigest,
    searchGeneration: generation,
    priorActive: observation.priorActive,
    priorUpdating: observation.priorUpdating,
  };
  return { context, observation };
}

async function current(deps: Dependencies, query: RealmRatingQuery, context: RealmRatingContext): Promise<Captured> {
  const observed = await capture(deps, query);
  if (!sameContext(context, observed.context)) throw restart();
  return observed;
}

async function boundedMap<T, R>(values: readonly T[], width: number, read: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, values.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        result[index] = await read(values[index]!);
      }
    }),
  );
  return result;
}

function requestTimeout(deadline: number): number {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new ProblemError('deadline_exceeded');
  return Math.min(10_000, timeout);
}

async function matchingIds(
  deps: Dependencies,
  query: RealmRatingQuery,
  generation: number,
  partition: number,
  ids: readonly string[],
): Promise<Set<string>> {
  if (!query.text) return new Set(ids);
  if (ids.length === 0) return new Set();
  const target = subjectIndexName(deps.prefix, generation);
  const compiled = compileText(query.text, { field: 'search_text', prefix: 'rt' });
  const response = await deps.search.request<unknown>(
    'POST',
    `/${target}/_search`,
    {
      size: ids.length,
      track_total_hits: false,
      _source: false,
      query: { bool: { filter: [{ term: { partition } }, { terms: { id: [...ids] } }], must: [compiled.query] } },
    },
    { query: { allow_partial_search_results: false }, timeoutMs: requestTimeout(query.deadline) },
  );
  if (response.status < 200 || response.status >= 300) throw notReady();
  assertCompleteSearch(response.body);
  if (!record(response.body) || !record(response.body.hits) || !Array.isArray(response.body.hits.hits))
    throw notReady();
  const matched = new Set<string>();
  for (const hit of response.body.hits.hits) {
    if (
      !record(hit) ||
      typeof hit._id !== 'string' ||
      hit._index !== target ||
      !ids.includes(hit._id) ||
      matched.has(hit._id)
    )
      throw notReady();
    matched.add(hit._id);
  }
  return matched;
}

function readUnscoredHits(
  value: unknown,
  target: string,
  partitionAfter: readonly (string | number | null)[] | undefined,
  size: number,
): RealmRatingHit[] {
  if (!record(value) || !record(value.hits) || !Array.isArray(value.hits.hits) || value.hits.hits.length > size)
    throw notReady();
  const hits: RealmRatingHit[] = [];
  const seen = new Set<string>();
  let previous = partitionAfter;
  for (const candidate of value.hits.hits) {
    if (!record(candidate) || !record(candidate._source) || typeof candidate._id !== 'string') throw notReady();
    const id = candidate._id;
    const partition = candidate._source.partition;
    const securityRevision = candidate._source.security_revision;
    const sort = candidate.sort;
    if (
      routeOf(id) === null ||
      typeof candidate._index !== 'string' ||
      candidate._index !== target ||
      !Number.isInteger(partition) ||
      Number(partition) !== subjectPartition(id) ||
      !Number.isSafeInteger(securityRevision) ||
      Number(securityRevision) < 0 ||
      !Array.isArray(sort) ||
      sort.length !== 2 ||
      !(
        sort[0] === null ||
        (typeof sort[0] === 'string' && sort[0].length <= MAX_NAME_LENGTH && sort[0].isWellFormed())
      ) ||
      sort[1] !== id ||
      seen.has(id)
    )
      throw notReady();
    if (previous) {
      const order = compareUnscored(previous, sort as (string | number | null)[]);
      if (order >= 0) throw notReady();
    }
    previous = sort as (string | number | null)[];
    seen.add(id);
    hits.push({
      id,
      index: target,
      partition: Number(partition),
      securityRevision: Number(securityRevision),
      matched: [],
      sort: [...sort] as (string | number | null)[],
      ratingPhase: 'unscored',
      position: 0n,
      threshold: 5,
      figure: null,
    });
  }
  return hits;
}

function compareUnscored(a: readonly (string | number | null)[], b: readonly (string | number | null)[]): number {
  for (let index = 0; index < a.length; index++) {
    const left = a[index]!;
    const right = b[index]!;
    if (left === right) continue;
    if (left === null) return 1;
    if (right === null) return -1;
    return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
  }
  return 0;
}

/** Production complete Realm order over private rank rows and the current canonical Search name key. */
export function createRealmRatingNativeSource(deps: Dependencies): RealmRatingSource {
  return {
    async observe(query) {
      return (await capture(deps, query)).context;
    },

    async readScoredFrontiers(query, context, request) {
      const before = await current(deps, query, context);
      const { actor, access } = actorFor(query);
      const ranks = createRealmRankOrderSource({ pool: deps.pool, access, tokens: deps.tokens });
      if (!before.context.priorActive || before.context.priorEpoch === null)
        return { context: before.context, partitions: [] };
      if (!Number.isInteger(request.size) || request.size < 1 || request.size > 200) throw notReady();
      const partitions = await ranks.listScoredPartitions(
        actor,
        { realmId: query.populationId, questionId: STANDARD_QUESTION_ID },
        before.observation,
        { deadline: query.deadline },
      );
      const after =
        request.ratingPhase === 'scored' && request.after
          ? {
              score: String(request.after[0]),
              subjectId: String(request.after.at(-1)),
            }
          : null;
      if (after && (!Number.isFinite(Number(after.score)) || routeOf(after.subjectId) === null)) throw notReady();
      const pages = await boundedMap(partitions, 8, async (partition) =>
        ranks.readScoredPartition(
          actor,
          {
            realmId: query.populationId,
            questionId: STANDARD_QUESTION_ID,
            partition,
            after,
            limit: request.size,
          },
          before.observation,
          { deadline: query.deadline },
        ),
      );
      const target = subjectIndexName(deps.prefix, context.searchGeneration);
      const output = await boundedMap(pages, 8, async (page) => {
        const ids = page.candidates.map(({ subjectId }) => subjectId);
        const admitted = await matchingIds(deps, query, context.searchGeneration, page.partition, ids);
        return {
          partition: page.partition,
          hits: page.candidates.map((candidate): RealmRatingHit => {
            const figure: PublicRatingFigure = {
              questionId: STANDARD_QUESTION_ID,
              populationId: query.populationId,
              subjectId: candidate.subjectId,
              count: candidate.count,
              mean: candidate.mean,
              score: candidate.score,
              priorEpoch: candidate.priorEpoch,
              revision: candidate.revision,
              asOf: candidate.asOf,
            };
            return {
              id: candidate.subjectId,
              index: target,
              partition: page.partition,
              securityRevision: candidate.securityRevision,
              matched: [],
              sort: [candidate.score, null, candidate.subjectId],
              ratingPhase: 'scored',
              position: page.position,
              threshold: 5,
              figure,
              ...(admitted.has(candidate.subjectId) ? {} : { suppressed: true as const }),
            };
          }),
        };
      });
      const observed = await current(deps, query, context);
      return { context: observed.context, partitions: output };
    },

    async readUnscored(query, context, request) {
      const before = await current(deps, query, context);
      if (!Number.isInteger(request.size) || request.size < 1 || request.size > 200) throw notReady();
      const target = subjectIndexName(deps.prefix, context.searchGeneration);
      const text = query.text ? compileText(query.text, { field: 'search_text', prefix: 'rt' }).query : undefined;
      const after = request.ratingPhase === 'unscored' ? request.after : undefined;
      const response = await deps.search.request<unknown>(
        'POST',
        `/${target}/_search`,
        {
          size: request.size,
          track_total_hits: false,
          _source: ['partition', 'security_revision'],
          query: text ?? { match_all: {} },
          sort: [{ name_sort: { order: 'asc', missing: '_last' } }, { id: 'asc' }],
          ...(after === undefined ? {} : { search_after: [...after] }),
        },
        { query: { allow_partial_search_results: false }, timeoutMs: requestTimeout(query.deadline) },
      );
      if (response.status < 200 || response.status >= 300) throw notReady();
      assertCompleteSearch(response.body);
      const hits = readUnscoredHits(response.body, target, after, request.size);
      const { actor, access } = actorFor(query);
      const ranks = createRealmRankOrderSource({ pool: deps.pool, access, tokens: deps.tokens });
      const grouped = new Map<number, RealmRatingHit[]>();
      for (const hit of hits) {
        const group = grouped.get(hit.partition) ?? [];
        group.push(hit);
        grouped.set(hit.partition, group);
      }
      const proofs = await boundedMap([...grouped], 8, async ([partition, group]) => ({
        partition,
        group,
        proof: await ranks.proveFigures(
          actor,
          {
            realmId: query.populationId,
            questionId: STANDARD_QUESTION_ID,
            partition,
            subjectIds: group.map(({ id }) => id),
          },
          before.observation,
          { deadline: query.deadline },
        ),
      }));
      const byId = new Map<string, { position: bigint; scored: boolean; figure: PublicRatingFigure | null }>();
      for (const { partition, group, proof } of proofs) {
        if (proof.partition !== partition || proof.figures.length !== group.length) throw notReady();
        for (const figure of proof.figures) {
          if (figure.updating) throw notReady();
          byId.set(figure.subjectId, {
            position: proof.position,
            scored: figure.scored,
            figure: figure.figure
              ? {
                  questionId: STANDARD_QUESTION_ID,
                  populationId: query.populationId,
                  subjectId: figure.figure.subjectId,
                  count: figure.figure.count,
                  mean: figure.figure.mean,
                  score: figure.figure.score,
                  priorEpoch: figure.figure.priorEpoch,
                  revision: figure.figure.revision,
                  asOf: figure.figure.asOf,
                }
              : null,
          });
        }
      }
      const result = hits.map((hit): RealmRatingHit => {
        const figure = byId.get(hit.id);
        if (!figure) throw notReady();
        return {
          ...hit,
          position: figure.position,
          figure: figure.scored ? null : figure.figure,
          ...(figure.scored ? { suppressed: true as const } : {}),
        };
      });
      const observed = await current(deps, query, context);
      return { context: observed.context, hits: result };
    },
  };
}
