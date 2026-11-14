import type { PoolClient } from 'pg';
import { ProblemError } from '../http/problem-error.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { STANDARD_QUESTION_ID } from './standard-question.ts';
import type { RealmRankOrderCandidate, RealmRankOrderObservation } from './realm-rank.ts';

/** Internal continuation key. Score uses the stored 0–10 arithmetic, even for custom questions. */
export type RealmRankScoredCanonicalKey = Readonly<{
  score: string;
  name: string | null;
  subjectId: string;
}>;
export type RealmRankScoredCanonicalRequest = Readonly<{
  realmId: string;
  questionId: string;
  partition: number;
  after: RealmRankScoredCanonicalKey | null;
  limit: number;
}>;
export type RealmRankScoredCanonicalPage = Readonly<{
  partition: number;
  epoch: number;
  position: bigint;
  generation: string;
  candidates: readonly (RealmRankOrderCandidate &
    Readonly<{
      name: string | null;
      key: RealmRankScoredCanonicalKey;
    }>)[];
}>;

const storedScore = /^(?:[0-9](?:\.[0-9]{1,4})?|10(?:\.0{1,4})?)$/;
function validName(name: unknown): name is string | null {
  return name === null || (typeof name === 'string' && name.length <= 512 && name.isWellFormed());
}

export function copyScoredCanonicalRequest(input: RealmRankScoredCanonicalRequest): RealmRankScoredCanonicalRequest {
  const request = { ...input, after: input.after === null ? null : { ...input.after } };
  if (
    routeOf(request.realmId) === null ||
    routeOf(request.questionId) === null ||
    !Number.isInteger(request.partition) ||
    request.partition < 0 ||
    request.partition > 4095 ||
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 200
  )
    throw new ProblemError('invalid_request');
  const after = request.after;
  if (
    after !== null &&
    (typeof after.score !== 'string' ||
      !storedScore.test(after.score) ||
      !validName(after.name) ||
      routeOf(after.subjectId) === null ||
      partitionOf(routeOf(after.subjectId)!) !== request.partition)
  )
    throw new ProblemError('invalid_cursor');
  return request;
}

/** Called only between the factory's complete before/after authority and publication observations. */
export async function readScoredCanonicalPartition(
  client: PoolClient,
  input: RealmRankScoredCanonicalRequest,
  observation: RealmRankOrderObservation,
  home: Readonly<{ epoch: number; position: bigint }>,
): Promise<RealmRankScoredCanonicalPage> {
  const canonicalHome = observation.canonicalPopulation.homes.find(({ partition }) => partition === input.partition);
  const publicationHome = observation.scoredHomes.find(({ partition }) => partition === input.partition);
  for (const expected of [canonicalHome, publicationHome]) {
    if (expected && (home.epoch !== expected.epoch || home.position.toString() !== expected.position))
      throw new ProblemError('search_restart_required');
  }
  if (!canonicalHome && !publicationHome) throw new ProblemError('search_restart_required');
  const parameters: unknown[] = [
    input.partition,
    input.questionId,
    input.realmId,
    observation.questionIdentity,
    observation.priorGeneration,
    observation.priorEpoch,
  ];
  const state = await client.query<{
    generation: string;
    canonicalGeneration: string | null;
    canonicalRevision: string | null;
  }>(
    `SELECT COALESCE(publication.generation,0)::text AS generation,
            canonical.canonical_generation::text AS "canonicalGeneration",
            canonical.revision::text AS "canonicalRevision"
     FROM (SELECT $1::integer AS partition_no) AS requested
     LEFT JOIN rating.realm_rank_generation AS publication
       ON publication.partition_no=requested.partition_no AND publication.question_id=$2 AND publication.population_id=$3
     LEFT JOIN rating.realm_rank_canonical_state AS canonical ON canonical.partition_no=requested.partition_no`,
    parameters.slice(0, 3),
  );
  const current = state.rows[0];
  if (
    !current ||
    current.generation !== (publicationHome?.generation ?? '0') ||
    (publicationHome &&
      (current.canonicalGeneration !== publicationHome.canonicalGeneration ||
        current.canonicalRevision !== publicationHome.canonicalRevision))
  )
    throw new ProblemError('search_restart_required');
  const base = { partition: input.partition, ...home, generation: current.generation };
  // The inventory retains emptied partitions. Prove the entire exact scored prefix empty,
  // independently of the caller's continuation, when Semantic has no Subjects in this home.
  if (!canonicalHome) {
    const remaining = await client.query(
      `SELECT 1 FROM rating.realm_rank
       WHERE partition_no=$1 AND question_id=$2 AND population_id=$3 AND question_identity=$4
         AND prior_generation=$5 AND prior_epoch=$6 LIMIT 1`,
      parameters,
    );
    if (remaining.rows.length > 0) throw new ProblemError('index_not_ready');
    return { ...base, candidates: [] };
  }
  // This whole-home gate precedes even an empty continuation. Checking only fetched names
  // would miss a renamed candidate which moved across the cursor.
  if (current.canonicalGeneration !== canonicalHome.generation) throw new ProblemError('index_not_ready');
  parameters.push(input.limit);
  if (input.after)
    parameters.push(input.after.score, input.after.name === null, input.after.name ?? '', input.after.subjectId);
  const result = await client.query<{
    subjectId: string;
    name: string | null;
    count: string;
    mean: string;
    score: string;
    priorEpoch: number;
    revision: string;
    asOf: Date;
    securityRevision: string | null;
    current: boolean;
  }>(
    `WITH candidates AS MATERIALIZED (
       SELECT * FROM rating.realm_rank
       WHERE partition_no=$1 AND question_id=$2 AND population_id=$3 AND question_identity=$4
         AND prior_generation=$5 AND prior_epoch=$6
       ${
         input.after
           ? `AND ROW(-score,canonical_name IS NULL,COALESCE(canonical_name,'') COLLATE "C",subject_id)
         > ROW(-$8::numeric,$9::boolean,$10::text COLLATE "C",$11::uuid)`
           : ''
       }
       ORDER BY (-score),(canonical_name IS NULL),COALESCE(canonical_name,'') COLLATE "C",subject_id LIMIT $7
     )
     SELECT rank.subject_id::text AS "subjectId",rank.canonical_name AS name,
            rank.count::text,rank.mean::text,rank.score::text,rank.prior_epoch AS "priorEpoch",
            rank.revision::text,rank.as_of AS "asOf",subject.security_revision::text AS "securityRevision",
            (subject.subject_id IS NOT NULL AND figure.subject_id IS NOT NULL
             AND rank.canonical_name IS NOT DISTINCT FROM subject.canonical_name
             AND figure.pending_position IS NULL
             AND ROW(rank.count,rank.mean,rank.score,rank.prior_epoch,rank.prior_generation,
                     rank.revision,rank.as_of,rank.question_identity)
                 IS NOT DISTINCT FROM
                 ROW(figure.count,figure.mean,figure.score,figure.prior_epoch,figure.published_prior_generation,
                     figure.revision,figure.as_of,figure.question_identity)) AS current
     FROM candidates AS rank
     LEFT JOIN rating.public_figure AS figure
       ON figure.route=get_byte(uuid_send(rank.subject_id),10)*256+get_byte(uuid_send(rank.subject_id),11)
      AND figure.question_id=rank.question_id AND figure.population_id=rank.population_id AND figure.subject_id=rank.subject_id
     LEFT JOIN semantic.subject AS subject
       ON subject.route=get_byte(uuid_send(rank.subject_id),10)*256+get_byte(uuid_send(rank.subject_id),11)
      AND subject.subject_id=rank.subject_id
     ORDER BY (-rank.score),(rank.canonical_name IS NULL),COALESCE(rank.canonical_name,'') COLLATE "C",rank.subject_id`,
    parameters,
  );
  const multiplier = input.questionId === STANDARD_QUESTION_ID ? 1 : 2;
  return {
    ...base,
    candidates: result.rows.map((row) => {
      const count = Number(row.count);
      const securityRevision = row.securityRevision === null ? NaN : Number(row.securityRevision);
      if (
        !row.current ||
        !validName(row.name) ||
        !storedScore.test(row.score) ||
        !storedScore.test(row.mean) ||
        !Number.isSafeInteger(count) || count < 5 ||
        !Number.isSafeInteger(securityRevision) || securityRevision < 0 ||
        !/^[1-9][0-9]{0,18}$/.test(row.revision) ||
        !Number.isFinite(row.asOf.getTime()) ||
        row.priorEpoch !== observation.priorEpoch ||
        routeOf(row.subjectId) === null ||
        partitionOf(routeOf(row.subjectId)!) !== input.partition
      )
        throw new ProblemError('index_not_ready');
      return {
        subjectId: row.subjectId,
        name: row.name,
        count,
        mean: Number(row.mean) * multiplier,
        score: Number(row.score) * multiplier,
        priorEpoch: row.priorEpoch,
        revision: row.revision,
        asOf: row.asOf.toISOString(),
        updating: false,
        securityRevision,
        key: { score: row.score, name: row.name, subjectId: row.subjectId },
      };
    }),
  };
}
