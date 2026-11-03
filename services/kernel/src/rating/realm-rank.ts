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
}>;
export type RealmRankPage = Readonly<{
  candidates: readonly RealmRankCandidate[];
  next: string | null;
}>;
export interface RealmRankSource {
  page(actor: Actor, request: RealmRankRequest, context: { deadline: number }): Promise<RealmRankPage>;
}
type Dependencies = { pool: Pool; access: Access; tokens: KeyRing };
type Row = Omit<RealmRankCandidate, 'count' | 'mean' | 'score' | 'asOf'> & {
  count: string;
  mean: string;
  score: string;
  asOf: Date;
};
type Position = { generation: string; prior: string; epoch: number; score: string; subject: string; at: number };

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
    const value = unseal(tokens, scope, token) as { kid: number; iv: string; tag: string; data: string };
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
  read: (client: PoolClient, epoch: number) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline) as PoolClient;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const home = await readPartition(client, partition);
      if (!home || home.writeState === 'moved') throw new ProblemError('partition_unavailable');
      const value = await read(client, home.epoch);
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
        input.questionId !== STANDARD_QUESTION_ID ||
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
      const authority = actor.kind === 'anonymous' ? actor : { ...actor, scopes: [...new Set(actor.scopes)].sort() };
      const scope = `rating.realm-rank.v1\0${JSON.stringify({
        realm: input.realmId,
        question: input.questionId,
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
          const result = await client.query<{ generation: string; active: boolean }>(
            `SELECT generation::text,start_count IS NOT NULL AS active FROM rating.population_prior_epoch
           WHERE route=$1 AND question_id=$2 AND population_id=$3`,
            [populationRoute, input.questionId, input.realmId],
          );
          return result.rows[0] ?? { generation: '0', active: false };
        });
      const prior = await readPrior();
      const observed = await observe(deps.pool, input.partition, deadline, async (client, epoch) => {
        const current = await generation(client, input);
        if (after && (after.generation !== current || after.epoch !== epoch || after.prior !== prior.generation))
          throw new ProblemError('invalid_cursor');
        if (!prior.active) return { generation: current, epoch, rows: [] as Row[] };
        // Separate first/continuation statements retain a strict composite B-tree seek without an OR filter.
        const parameters: unknown[] = [input.partition, input.questionId, input.realmId, prior.generation, input.limit];
        if (after) parameters.push(after.score, after.subject);
        const result = await client.query<Row>(
          `SELECT subject_id::text AS "subjectId",count::text,mean::text,score::text,
                  prior_epoch AS "priorEpoch",revision::text,as_of AS "asOf"
           FROM rating.realm_rank
           WHERE partition_no=$1 AND question_id=$2 AND population_id=$3 AND prior_generation=$4
           ${after ? 'AND (score,subject_id) < ($6::numeric,$7::uuid)' : ''}
           ORDER BY score DESC,subject_id DESC LIMIT $5`,
          parameters,
        );
        return { generation: current, epoch, rows: result.rows };
      });
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
          mean: Number(row.mean),
          score: Number(row.score),
          asOf: row.asOf.toISOString(),
        });
      }
      await authorizeRealm();
      const latest = await readPrior();
      await observe(deps.pool, input.partition, deadline, async (client, epoch) => {
        if (
          epoch !== observed.epoch ||
          (await generation(client, input)) !== observed.generation ||
          latest.generation !== prior.generation
        )
          throw new ProblemError('invalid_cursor');
      });
      const last = observed.rows.at(-1);
      return {
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
