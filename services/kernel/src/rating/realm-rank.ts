import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { readRealm } from '../community/realm.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import readIdentity from '../semantic/read-subject-identity.sql';
import { seal, unseal, type KeyRing } from '../tokens/seal.ts';
import { STANDARD_QUESTION_ID } from './votes.ts';
import readFreshness from './aggregate-read-freshness.sql';
import {
  ratingQuestionIdentity,
  ratingQuestionView,
  readVisibleRatingQuestion,
  realmRankQuestionEligible,
  type QuestionMetadata,
  type RatingQuestionView,
} from './question-directory.ts';

export type RealmRankRequest = Readonly<{
  realmId: string;
  questionId: string;
  partition: number;
  sort: 'score_desc';
  limit: number;
  cursor?: string;
}>;
export type RealmRankCandidate = Readonly<{
  subjectId: string;
  count: number;
  mean: number;
  score: number;
  priorEpoch: number;
  revision: string;
  asOf: string;
  updating: boolean;
}>;
export type RealmRankQuestion = Readonly<RatingQuestionView>;
export type RealmRankPage = Readonly<{
  question: RealmRankQuestion;
  candidates: readonly RealmRankCandidate[];
  next: string | null;
}>;
/** Scored-only compatibility port; it is not Search's complete Realm order provider. */
export interface RealmRankSource {
  page(actor: Actor, request: RealmRankRequest, context: { deadline: number }): Promise<RealmRankPage>;
}
export type RealmRankOrderObservation = Readonly<{
  question: RealmRankQuestion;
  questionIdentity: string;
  questionRevision: number;
  priorGeneration: string;
  priorEpoch: number | null;
  priorIdentity: string | null;
  priorActive: boolean;
  priorUpdating: boolean;
  realmAuthority: string;
  realmRevision: string;
  publicationGeneration: string;
}>;
export type RealmRankOrderCandidate = RealmRankCandidate & Readonly<{ securityRevision: number }>;
export type RealmRankFigureValue = Readonly<{
  subjectId: string;
  count: number;
  mean: number | null;
  score: number | null;
  priorEpoch: number | null;
  revision: string;
  asOf: string;
}>;
export type RealmRankFigureProof = Readonly<{
  subjectId: string;
  scored: boolean;
  figure: RealmRankFigureValue | null;
  updating: boolean;
}>;
export interface RealmRankOrderSource {
  observe(
    actor: Actor,
    input: Readonly<{ realmId: string; questionId: string }>,
    context: { deadline: number },
  ): Promise<RealmRankOrderObservation>;
  listScoredPartitions(
    actor: Actor,
    input: Readonly<{ realmId: string; questionId: string }>,
    observation: RealmRankOrderObservation,
    context: { deadline: number },
  ): Promise<readonly number[]>;
  readScoredPartition(
    actor: Actor,
    input: Readonly<{
      realmId: string;
      questionId: string;
      partition: number;
      after: Readonly<{ score: string; subjectId: string }> | null;
      limit: number;
    }>,
    observation: RealmRankOrderObservation,
    context: { deadline: number },
  ): Promise<Readonly<{
    partition: number;
    epoch: number;
    position: bigint;
    generation: string;
    candidates: readonly RealmRankOrderCandidate[];
  }>>;
  proveFigures(
    actor: Actor,
    input: Readonly<{ realmId: string; questionId: string; partition: number; subjectIds: readonly string[] }>,
    observation: RealmRankOrderObservation,
    context: { deadline: number },
  ): Promise<Readonly<{ partition: number; epoch: number; position: bigint; figures: readonly RealmRankFigureProof[] }>>;
}
type Dependencies = { pool: Pool; access: Access; tokens: KeyRing };
type Row = Omit<RealmRankCandidate, 'count' | 'mean' | 'score' | 'asOf'> & {
  count: string;
  mean: string;
  score: string;
  asOf: Date;
};
type Position = {
  generation: string;
  prior: string;
  epoch: number;
  score: string;
  subject: string;
  at: number;
};

/** Publication metadata is separate from measurement identity: a caption or provenance
 * change must restart a page without assigning a new meaning to published scores. */
function questionPublication(question: QuestionMetadata): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        ratingQuestionIdentity(question),
        question.ownerId,
        question.realmId,
        question.meaning,
        question.label,
        question.presentationLabel,
        question.labelRevision,
        question.lifecycleState,
        question.lifecycleRevision,
      ]),
    )
    .digest('hex');
}

export class RealmRankQuestionUnavailableError extends Error {
  constructor(readonly reason: 'unavailable' | 'retired') {
    super(reason === 'retired' ? 'Rating question is retired' : 'Rating question is unavailable');
    this.name = 'RealmRankQuestionUnavailableError';
  }
}

// Signed AND encrypted: a consumed candidate may have become unreadable. Its key must stay private.
function encryptionKey(tokens: KeyRing, kid: number): Buffer {
  const key = tokens.keys.get(kid);
  if (!key || key.byteLength < 32) throw new Error('Realm rank cursor key unavailable');
  return createHash('sha256').update('rating.realm-rank.encryption.v1\0').update(key).digest();
}
function encode(tokens: KeyRing, scope: string, position: Position): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(tokens, tokens.current), iv);
  cipher.setAAD(Buffer.from(scope));
  const data = Buffer.concat([cipher.update(JSON.stringify(position), 'utf8'), cipher.final()]);
  return seal(tokens, scope, {
    kid: tokens.current,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  });
}
function decode(tokens: KeyRing, scope: string, token: string): Position {
  try {
    const value = unseal(tokens, scope, token) as {
      kid: number;
      iv: string;
      tag: string;
      data: string;
    };
    const cipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(tokens, value.kid),
      Buffer.from(value.iv, 'base64url'),
    );
    cipher.setAAD(Buffer.from(scope));
    cipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    const position = JSON.parse(
      Buffer.concat([cipher.update(Buffer.from(value.data, 'base64url')), cipher.final()]).toString('utf8'),
    ) as Position;
    if (
      !/^[0-9]+$/.test(position.generation) ||
      !/^[0-9]+$/.test(position.prior) ||
      !Number.isSafeInteger(position.epoch) ||
      position.epoch < 1 ||
      !Number.isSafeInteger(position.at) ||
      position.at > Date.now() + 60_000 ||
      Date.now() - position.at > 900_000 ||
      routeOf(position.subject) === null ||
      !/^(?:[0-9]|10)(?:\.[0-9]{1,4})?$/.test(position.score)
    )
      throw new Error('Invalid position');
    return position;
  } catch {
    throw new ProblemError('invalid_cursor');
  }
}

/** Fresh physical snapshots, independent of any caller-owned read transaction. */
async function observe<T>(
  pool: Pool,
  partition: number,
  deadline: number,
  read: (client: PoolClient, epoch: number, home: NonNullable<Awaited<ReturnType<typeof readPartition>>>) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline) as PoolClient;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const home = await readPartition(client, partition);
      if (!home || home.writeState === 'moved') throw new ProblemError('partition_unavailable');
      const value = await read(client, home.epoch, home);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollback) {
        discardConnection(connection, rollback as Error);
      }
      throw error;
    }
  });
}
async function generation(client: PoolClient, input: RealmRankRequest): Promise<string> {
  const result = await client.query<{ generation: string }>(
    `SELECT generation::text FROM rating.realm_rank_generation
     WHERE partition_no=$1 AND question_id=$2 AND population_id=$3`,
    [input.partition, input.questionId, input.realmId],
  );
  return result.rows[0]?.generation ?? '0';
}

/** Production native Search port. No caller-supplied eligibility or disclosure flags are accepted. */
export function createRealmRankSource(deps: Dependencies): RealmRankSource {
  return {
    async page(actor, input, { deadline }) {
      if (
        routeOf(input.realmId) === null ||
        input.realmId === GLOBAL_CONTEXT.id ||
        routeOf(input.questionId) === null ||
        input.sort !== 'score_desc' ||
        !Number.isInteger(input.partition) ||
        input.partition < 0 ||
        input.partition > 4095 ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      )
        throw new ProblemError('invalid_request');
      const authorizeRealm = async () => {
        if (!(await readRealm(deps, actor, input.realmId, { deadline }))) throw new ProblemError('not_found');
      };
      await authorizeRealm();
      const readQuestion = async () => {
        const question = await readVisibleRatingQuestion(deps, actor, input.questionId, deadline);
        if (!question || (question.realmId !== null && question.realmId !== input.realmId))
          throw new ProblemError('not_found');
        if (question.lifecycleState === 'retired') throw new RealmRankQuestionUnavailableError('retired');
        if (!realmRankQuestionEligible(question)) throw new ProblemError('invalid_request');
        return question;
      };
      const question = await readQuestion();
      const identity = ratingQuestionIdentity(question);
      const publication = questionPublication(question);
      const authority = actor.kind === 'anonymous' ? actor : { ...actor, scopes: [...new Set(actor.scopes)].sort() };
      const scope = `rating.realm-rank.v1\0${JSON.stringify({
        realm: input.realmId,
        question: input.questionId,
        identity,
        publication,
        partition: input.partition,
        sort: input.sort,
        limit: input.limit,
        authority: createHash('sha256').update(JSON.stringify(authority)).digest('hex'),
      })}`;
      const after = input.cursor === undefined ? null : decode(deps.tokens, scope, input.cursor);
      if (after && partitionOf(routeOf(after.subject)!) !== input.partition) throw new ProblemError('invalid_cursor');
      const populationRoute = routeOf(input.realmId)!;
      const readPrior = () =>
        observe(deps.pool, partitionOf(populationRoute), deadline, async (client) => {
          const freshness = await readFreshness.run(client, {
            route: populationRoute,
            population_id: input.realmId,
          });
          const result = await client.query<{
            generation: string;
            active: boolean;
            identity: string | null;
          }>(
            `SELECT generation::text,start_count IS NOT NULL AS active, question_identity AS identity FROM rating.population_prior_epoch
           WHERE route=$1 AND question_id=$2 AND population_id=$3`,
            [populationRoute, input.questionId, input.realmId],
          );
          return {
            ...(result.rows[0] ?? {
              generation: '0',
              active: false,
              identity: null,
            }),
            updating: freshness!.updating,
          };
        });
      const prior = await readPrior();
      const observed = await observe(deps.pool, input.partition, deadline, async (client, epoch) => {
        const current = await generation(client, input);
        if (after && (after.generation !== current || after.epoch !== epoch || after.prior !== prior.generation))
          throw new ProblemError('invalid_cursor');
        // This port proves only the scored set. An empty scored page never proves an unscored complement.
        if (!prior.active || prior.identity !== identity) return { generation: current, epoch, rows: [] as Row[] };
        // Separate first/continuation statements retain a strict composite B-tree seek without an OR filter.
        const parameters: unknown[] = [
          input.partition,
          input.questionId,
          input.realmId,
          prior.generation,
          input.limit,
          identity,
        ];
        if (after) parameters.push(after.score, after.subject);
        const result = await client.query<Row>(
          `SELECT rank.subject_id::text AS "subjectId",rank.count::text,rank.mean::text,rank.score::text,
                  rank.prior_epoch AS "priorEpoch",rank.revision::text,rank.as_of AS "asOf",
                  figure.pending_position IS NOT NULL AS updating
           FROM rating.realm_rank AS rank
           JOIN rating.public_figure AS figure
             ON figure.route=get_byte(uuid_send(rank.subject_id),10)*256+get_byte(uuid_send(rank.subject_id),11)
            AND figure.question_id=rank.question_id AND figure.population_id=rank.population_id
            AND figure.subject_id=rank.subject_id
           WHERE rank.partition_no=$1 AND rank.question_id=$2 AND rank.population_id=$3 AND rank.prior_generation=$4 AND rank.question_identity=$6
           ${after ? 'AND (rank.score,rank.subject_id) < ($7::numeric,$8::uuid)' : ''}
           ORDER BY rank.score DESC,rank.subject_id DESC LIMIT $5`,
          parameters,
        );
        return { generation: current, epoch, rows: result.rows };
      });
      if (prior.updating && observed.rows.length === 0) throw new RealmRankQuestionUnavailableError('unavailable');
      const candidates: RealmRankCandidate[] = [];
      for (const row of observed.rows) {
        const route = routeOf(row.subjectId)!;
        const check = await accessCheck(
          deps.access,
          actor,
          'subject:read',
          {
            route,
            id: row.subjectId,
            eligibility: subjectReadEligibility({ route, id: row.subjectId }),
          },
          { pool: deps.pool, deadline },
        );
        const readable = await withConnection(deps.pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          const identity = await readIdentity.run(client, {
            route,
            subject_id: row.subjectId,
            partition_no: input.partition,
          });
          return identity && identity.redirect === null && (await check(client));
        });
        if (!readable) continue;
        const count = Number(row.count);
        if (!Number.isSafeInteger(count)) throw new Error('Realm rank count exceeds safe range');
        candidates.push({
          ...row,
          count,
          mean: Number(row.mean) * (input.questionId === STANDARD_QUESTION_ID ? 1 : 2),
          score: Number(row.score) * (input.questionId === STANDARD_QUESTION_ID ? 1 : 2),
          asOf: row.asOf.toISOString(),
          updating: row.updating || prior.updating,
        });
      }
      await authorizeRealm();
      const latestQuestion = await readQuestion();
      if (questionPublication(latestQuestion) !== publication) throw new ProblemError('invalid_cursor');
      const latest = await readPrior();
      await observe(deps.pool, input.partition, deadline, async (client, epoch) => {
        if (
          epoch !== observed.epoch ||
          (await generation(client, input)) !== observed.generation ||
          latest.generation !== prior.generation ||
          latest.active !== prior.active ||
          latest.identity !== prior.identity ||
          latest.updating !== prior.updating
        )
          throw new ProblemError('invalid_cursor');
      });
      const last = observed.rows.at(-1);
      return {
        question: ratingQuestionView(question),
        candidates,
        // No lookahead, counts or refill. A full consumed batch may lead to one empty terminal page.
        next:
          last && observed.rows.length === input.limit
            ? encode(deps.tokens, scope, {
                generation: observed.generation,
                prior: prior.generation,
                epoch: observed.epoch,
                score: last.score,
                subject: last.subjectId,
                at: Date.now(),
              })
            : null,
      };
    },
  };
}

type PriorObservation = {
  generation: string;
  active: boolean;
  identity: string | null;
  updating: boolean;
};

async function readPriorObservation(
  pool: Pool,
  realmId: string,
  questionId: string,
  deadline: number,
): Promise<PriorObservation> {
  const route = routeOf(realmId)!;
  return observe(pool, partitionOf(route), deadline, async (client) => {
    const freshness = await readFreshness.run(client, { route, population_id: realmId });
    if (!freshness) throw new Error('Rating prior freshness is unavailable');
    const result = await client.query<{ generation: string; active: boolean; identity: string | null }>(
      `SELECT generation::text,start_count IS NOT NULL AS active,question_identity AS identity
       FROM rating.population_prior_epoch WHERE route=$1 AND question_id=$2 AND population_id=$3`,
      [route, questionId, realmId],
    );
    return { ...(result.rows[0] ?? { generation: '0', active: false, identity: null }), updating: freshness.updating };
  });
}

function authorityDigest(actor: Actor): string {
  const authority = actor.kind === 'anonymous' ? actor : { ...actor, scopes: [...new Set(actor.scopes)].sort() };
  return createHash('sha256').update(JSON.stringify(authority)).digest('hex');
}

/** Current native producer for Search's complete ordered Realm traversal. The legacy page remains scored-only. */
export function createRealmRankOrderSource(deps: Dependencies): RealmRankOrderSource {
  return {
    async observe(actor, input, { deadline }) {
      if (routeOf(input.realmId) === null || input.realmId === GLOBAL_CONTEXT.id || routeOf(input.questionId) === null)
        throw new ProblemError('invalid_request');
      const realm = await readRealm(deps, actor, input.realmId, { deadline });
      if (!realm) throw new ProblemError('not_found');
      const question = await readVisibleRatingQuestion(deps, actor, input.questionId, deadline);
      if (!question) throw new ProblemError('not_found');
      if (!realmRankQuestionEligible(question)) throw new ProblemError('invalid_request');
      const questionIdentity = ratingQuestionIdentity(question);
      const prior = await readPriorObservation(deps.pool, input.realmId, input.questionId, deadline);
      // An ended or mismatched prior proves all-unscored only after the native population work is settled.
      const priorActive = prior.active && prior.identity === questionIdentity;
      if (!priorActive && prior.updating) throw new ProblemError('index_not_ready');
      const publication = await deps.pool.query<{ last_value: string; is_called: boolean }>(
        `SELECT last_value::text,is_called FROM rating.realm_rank_publication_generation`,
      );
      const generation = publication.rows[0];
      if (!generation || !/^[0-9]+$/.test(generation.last_value)) throw new Error('Rank publication generation is unavailable');
      return {
        question,
        questionIdentity,
        questionRevision: question.revision,
        priorGeneration: prior.generation,
        priorEpoch: priorActive ? Number(prior.generation) : null,
        priorIdentity: prior.identity,
        priorActive,
        priorUpdating: prior.updating,
        realmAuthority: authorityDigest(actor),
        realmRevision: `${realm.headRevisionId}:${realm.state}:${realm.visibility}`,
        publicationGeneration: `${generation.last_value}:${generation.is_called ? 1 : 0}`,
      };
    },

    async listScoredPartitions(_actor, input, observation, { deadline }) {
      if (
        routeOf(input.realmId) === null ||
        input.realmId === GLOBAL_CONTEXT.id ||
        input.questionId !== observation.question.id ||
        !observation.priorActive ||
        observation.priorEpoch === null
      )
        throw new ProblemError('invalid_request');
      const populationRoute = routeOf(input.realmId)!;
      return observe(deps.pool, partitionOf(populationRoute), deadline, async (client) => {
        const result = await client.query<{ partition: number }>(
          `SELECT partition_no AS partition FROM rating.realm_rank_generation
           WHERE question_id=$1 AND population_id=$2
           ORDER BY partition_no LIMIT 4097`,
          [input.questionId, input.realmId],
        );
        if (
          result.rows.length > 4096 ||
          result.rows.some(
            ({ partition }, index) =>
              !Number.isInteger(partition) || partition < 0 || partition > 4095 ||
              (index > 0 && partition <= result.rows[index - 1]!.partition),
          )
        )
          throw new Error('Rank partition inventory is incomplete');
        return result.rows.map(({ partition }) => partition);
      });
    },

    async readScoredPartition(actor, input, observation, { deadline }) {
      if (
        routeOf(input.realmId) === null ||
        input.realmId === GLOBAL_CONTEXT.id ||
        input.questionId !== observation.question.id ||
        !Number.isInteger(input.partition) ||
        input.partition < 0 ||
        input.partition > 4095 ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 200 ||
        !observation.priorActive ||
        observation.priorEpoch === null
      )
        throw new ProblemError('invalid_request');
      if (
        input.after !== null &&
        (!/^(?:[0-9]|10)(?:\.[0-9]{1,4})?$/.test(input.after.score) ||
          routeOf(input.after.subjectId) === null ||
          partitionOf(routeOf(input.after.subjectId)!) !== input.partition)
      )
        throw new ProblemError('invalid_cursor');
      return observe(deps.pool, input.partition, deadline, async (client, epoch, home) => {
        const current = await generation(client, {
          realmId: input.realmId,
          questionId: input.questionId,
          partition: input.partition,
          sort: 'score_desc',
          limit: input.limit,
        });
        const parameters: unknown[] = [
          input.partition,
          input.questionId,
          input.realmId,
          observation.questionIdentity,
          observation.priorGeneration,
          observation.priorEpoch,
          input.limit,
        ];
        if (input.after) parameters.push(input.after.score, input.after.subjectId);
        const rows = await client.query<Row & { securityRevision: string }>(
          `SELECT rank.subject_id::text AS "subjectId",rank.count::text,rank.mean::text,rank.score::text,
                  rank.prior_epoch AS "priorEpoch",rank.revision::text,rank.as_of AS "asOf",
                  figure.pending_position IS NOT NULL AS updating,subject.security_revision::text AS "securityRevision"
           FROM rating.realm_rank AS rank
           JOIN rating.public_figure AS figure
             ON figure.route=get_byte(uuid_send(rank.subject_id),10)*256+get_byte(uuid_send(rank.subject_id),11)
            AND figure.question_id=rank.question_id AND figure.population_id=rank.population_id
            AND figure.subject_id=rank.subject_id
           JOIN semantic.subject AS subject
             ON subject.route=get_byte(uuid_send(rank.subject_id),10)*256+get_byte(uuid_send(rank.subject_id),11)
            AND subject.subject_id=rank.subject_id
           WHERE rank.partition_no=$1 AND rank.question_id=$2 AND rank.population_id=$3
             AND rank.question_identity=$4 AND rank.prior_generation=$5 AND rank.prior_epoch=$6
           ${input.after ? 'AND (rank.score,rank.subject_id) < ($8::numeric,$9::uuid)' : ''}
           ORDER BY rank.score DESC,rank.subject_id DESC LIMIT $7`,
          parameters,
        );
        if (rows.rows.some(({ updating }) => updating || observation.priorUpdating))
          throw new ProblemError('index_not_ready');
        return {
          partition: input.partition,
          epoch,
          position: BigInt(home.position),
          generation: current,
          candidates: rows.rows.map((row) => {
            const securityRevision = Number(row.securityRevision);
            if (!Number.isSafeInteger(securityRevision) || securityRevision < 0) throw new Error('Invalid subject revision');
            return {
              ...row,
              count: Number(row.count),
              mean: Number(row.mean) * (input.questionId === STANDARD_QUESTION_ID ? 1 : 2),
              score: Number(row.score) * (input.questionId === STANDARD_QUESTION_ID ? 1 : 2),
              asOf: row.asOf.toISOString(),
              updating: row.updating || observation.priorUpdating,
              securityRevision,
            };
          }),
        };
      });
    },

    async proveFigures(actor, input, observation, { deadline }) {
      if (
        routeOf(input.realmId) === null ||
        input.realmId === GLOBAL_CONTEXT.id ||
        input.questionId !== observation.question.id ||
        !Number.isInteger(input.partition) ||
        input.partition < 0 ||
        input.partition > 4095 ||
        !Array.isArray(input.subjectIds) ||
        input.subjectIds.length > 256
      )
        throw new ProblemError('invalid_request');
      const pairs = input.subjectIds.map((subjectId) => ({ subjectId, route: routeOf(subjectId) }));
      if (
        pairs.some(({ route }) => route === null || partitionOf(route!) !== input.partition) ||
        new Set(input.subjectIds).size !== input.subjectIds.length
      )
        throw new ProblemError('invalid_request');
      return observe(deps.pool, input.partition, deadline, async (client, epoch, home) => {
        if (observation.priorUpdating) throw new ProblemError('index_not_ready');
        if (pairs.length === 0) return { partition: input.partition, epoch, position: BigInt(home.position), figures: [] };
        const result = await client.query<{
          subjectId: string;
          count: string | null;
          mean: string | null;
          score: string | null;
          priorEpoch: number | null;
          revision: string | null;
          asOf: Date | null;
          identity: string | null;
          priorGeneration: string | null;
          pending: boolean;
          rankIdentity: string | null;
          rankGeneration: string | null;
          rankScore: string | null;
        }>(
          `WITH requested AS (
             SELECT * FROM unnest($1::uuid[],$2::integer[]) AS input(subject_id,route)
           )
           SELECT requested.subject_id::text AS "subjectId",figure.count::text,figure.mean::text,figure.score::text,
                  figure.prior_epoch AS "priorEpoch",figure.revision::text,figure.as_of AS "asOf",
                  figure.question_identity AS identity,figure.published_prior_generation::text AS "priorGeneration",
                  figure.pending_position IS NOT NULL AS pending,
                  rank.question_identity AS "rankIdentity",rank.prior_generation::text AS "rankGeneration",
                  rank.score::text AS "rankScore"
           FROM requested
           LEFT JOIN rating.public_figure AS figure
             ON figure.route=requested.route AND figure.question_id=$3 AND figure.population_id=$4
            AND figure.subject_id=requested.subject_id
           LEFT JOIN rating.realm_rank AS rank
             ON rank.partition_no=$5 AND rank.question_id=$3 AND rank.population_id=$4
            AND rank.subject_id=requested.subject_id
           ORDER BY requested.subject_id`,
          [pairs.map(({ subjectId }) => subjectId), pairs.map(({ route }) => route), input.questionId, input.realmId, input.partition],
        );
        if (
          result.rows.length !== pairs.length ||
          new Set(result.rows.map(({ subjectId }) => subjectId)).size !== pairs.length
        )
          throw new Error('Figure eligibility observation is incomplete');
        const figures = result.rows.map((row): RealmRankFigureProof => {
          const count = row.count === null ? null : Number(row.count);
          const figureIdentityMatches = row.identity === observation.questionIdentity;
          const eligibleByPrior =
            observation.priorActive &&
            observation.priorIdentity === observation.questionIdentity &&
            row.priorGeneration === observation.priorGeneration;
          const currentRank =
            eligibleByPrior &&
            row.rankIdentity === observation.questionIdentity &&
            row.rankGeneration === observation.priorGeneration &&
            row.rankScore !== null;
          const eligibleFigure =
            eligibleByPrior &&
            figureIdentityMatches &&
            count !== null &&
            count >= 5 &&
            row.score !== null;
          if (currentRank !== eligibleFigure) throw new Error('Figure and ordered-rank publication disagree');
          const scored = currentRank && eligibleFigure;
          if (count !== null && (!Number.isSafeInteger(count) || count < 0))
            throw new Error('Invalid figure count');
          if (row.mean !== null && !Number.isFinite(Number(row.mean))) throw new Error('Invalid figure mean');
          if (row.score !== null && !Number.isFinite(Number(row.score))) throw new Error('Invalid figure score');
          if (row.revision !== null && !/^[1-9][0-9]{0,18}$/.test(row.revision))
            throw new Error('Invalid figure revision');
          const figure =
            count === null || count < 5 || !figureIdentityMatches || row.mean === null || row.revision === null || !row.asOf
              ? null
              : {
                  subjectId: row.subjectId,
                  count,
                  mean: Number(row.mean) * (input.questionId === STANDARD_QUESTION_ID ? 1 : 2),
                  score: scored ? Number(row.score) * (input.questionId === STANDARD_QUESTION_ID ? 1 : 2) : null,
                  priorEpoch: scored ? (row.priorEpoch === null ? null : Number(row.priorEpoch)) : null,
                  revision: row.revision,
                  asOf: row.asOf.toISOString(),
                };
          if (
            row.pending ||
            observation.priorUpdating ||
            (scored && figure === null)
          )
            throw new Error('Selected figure publication is incomplete');
          return {
            subjectId: row.subjectId,
            scored,
            figure,
            updating: false,
          };
        });
        return { partition: input.partition, epoch, position: BigInt(home.position), figures };
      });
    },
  };
}
