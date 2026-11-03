import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access } from '../request/access.ts';
import type {
  PublicFilterConsumerUnavailable,
  PublicFilterConsumerContext,
} from '../search/public-filter-consumer-contract.ts';
import type { PublicFilterCost } from './public-filter-source-contract.ts';
import { withReadTransaction } from './read.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { requireAccessDeadline, classifyUnavailability } from '../access/unavailable.ts';
import { mintReadTime } from '../command/command.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { globalReadEligibility } from './eligibility.ts';
import ownerStatement from './subject-source-key-pages-owner.sql';
import pageStatement from './subject-source-key-pages-read.sql';

export type SubjectCanonicalHome = Readonly<{
  partition: number;
  generation: string;
  epoch: number;
  position: string;
}>;
export type SubjectCanonicalPopulation = Readonly<{
  generation: string;
  homes: readonly SubjectCanonicalHome[];
}>;
export type SubjectCanonicalNameKey = Readonly<{ name: string | null; id: string }>;
/** Internal canonical candidates, before Subject disclosure. Never a public read grant. */
export interface SubjectCanonicalNames {
  observe(context: { deadline: number }): Promise<SubjectCanonicalPopulation>;
  read(
    request: Readonly<{ partition: number; after: SubjectCanonicalNameKey | null; limit: number }>,
    expected: SubjectCanonicalPopulation,
    context: { deadline: number },
  ): Promise<Readonly<{
    home: SubjectCanonicalHome;
    candidates: readonly (SubjectCanonicalNameKey & Readonly<{ securityRevision: number }>)[];
  }>>;
}

/** Current native name order, separate from the fixed-cut ID-key rebuild inventory below.
 * The finite frontier reads occupied native homes, never every partition's Subject rows.
 * A committed per-home generation avoids treating an uncommitted sequence increment as publication.
 */
export function createSubjectCanonicalNames(pool: Pool): SubjectCanonicalNames {
  const source: SubjectCanonicalNames = {
    async observe({ deadline }) {
      requireAccessDeadline(deadline);
      const result = await withConnection(pool, (connection) => deadlineClient(connection, deadline).query<{
        partition: number;
        generation: string;
        epoch: number | null;
        position: string | null;
        state: string | null;
      }>(
        `SELECT population.partition_no AS partition,population.canonical_generation::text AS generation,
                home.epoch,home.position::text,home.write_state AS state
         FROM semantic.partition_subjects population
         LEFT JOIN core.partition home ON home.partition_no=population.partition_no
         WHERE population.canonical_count>0 ORDER BY population.partition_no LIMIT 4097`,
      ));
      requireAccessDeadline(deadline);
      if (result.rows.length > 4096) throw new ProblemError('index_not_ready');
      const homes = result.rows.map((row, index): SubjectCanonicalHome => {
        if (row.epoch === null || row.position === null || row.state === null || row.state === 'moved')
          throw new ProblemError('partition_unavailable');
        if (
          !Number.isInteger(row.partition) || row.partition < 0 || row.partition > 4095 ||
          (index > 0 && row.partition <= result.rows[index - 1]!.partition) ||
          !Number.isSafeInteger(row.epoch) || row.epoch < 1 ||
          !/^[1-9][0-9]*$/.test(row.generation) || !/^[0-9]+$/.test(row.position)
        ) throw new ProblemError('index_not_ready');
        return { partition: row.partition, generation: row.generation, epoch: row.epoch, position: row.position };
      });
      return { generation: createHash('sha256').update(JSON.stringify(homes)).digest('hex'), homes };
    },
    async read(request, expected, { deadline }) {
      const { partition, limit } = request;
      const after = request.after === null ? null : { ...request.after };
      const expectedGeneration = expected.generation;
      if (!Number.isInteger(partition) || partition < 0 || partition > 4095 ||
          !Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new ProblemError('invalid_request');
      if (after !== null && (routeOf(after.id) === null ||
          !(after.name === null || (typeof after.name === 'string' && after.name.length <= 512 && after.name.isWellFormed()))))
        throw new ProblemError('invalid_cursor');
      const current = await source.observe({ deadline });
      if (current.generation !== expectedGeneration) throw new ProblemError('search_restart_required');
      const home = current.homes.find((home) => home.partition === partition);
      if (!home) throw new ProblemError('search_restart_required');
      const candidates = await withConnection(pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const owner = await ownerStatement.run(client, { partition_no: partition });
          if (!owner || owner.write_state === 'moved') throw new ProblemError('partition_unavailable');
          if (owner.epoch !== home.epoch || owner.position !== home.position)
            throw new ProblemError('search_restart_required');
          const parameters: unknown[] = [partition, limit];
          if (after) parameters.push(after.name === null, after.name ?? '', after.id);
          const result = await client.query<{ id: string; name: string | null; securityRevision: string }>(
            `SELECT subject_id::text AS id,canonical_name AS name,security_revision::text AS "securityRevision"
             FROM semantic.subject WHERE route/16=$1
             ${after ? `AND ROW(canonical_name IS NULL,COALESCE(canonical_name,'') COLLATE "C",subject_id)
               > ROW($3::boolean,$4::text COLLATE "C",$5::uuid)` : ''}
             ORDER BY (canonical_name IS NULL),COALESCE(canonical_name,'') COLLATE "C",subject_id LIMIT $2`,
            parameters,
          );
          const keys = result.rows.map((row) => {
            const securityRevision = Number(row.securityRevision);
            if (routeOf(row.id) === null || partitionOf(routeOf(row.id)!) !== partition ||
                !Number.isSafeInteger(securityRevision) || securityRevision < 0 ||
                !(row.name === null || (typeof row.name === 'string' && row.name.length <= 512 && row.name.isWellFormed())))
              throw new ProblemError('index_not_ready');
            return { ...row, securityRevision };
          });
          await client.query('COMMIT');
          return keys;
        } catch (error) {
          try { await connection.query('ROLLBACK'); }
          catch (rollback) { discardConnection(connection, rollback as Error); }
          throw error;
        }
      });
      if ((await source.observe({ deadline })).generation !== expectedGeneration)
        throw new ProblemError('search_restart_required');
      return { home, candidates };
    },
  };
  return source;
}

/** Agreed background-only additive capability on subjectSource; never exposed to request capture. */
export interface SubjectSourceKeyTraversal {
  readSubjectKeyPage(
    request: Readonly<{
      partition: number;
      epoch: number;
      after: Readonly<{ route: number; id: string }> | null;
      through: bigint;
      inputLimit: number;
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{
        status: 'progress' | 'complete';
        partition: number;
        epoch: number;
        through: bigint;
        keys: readonly string[];
        after: Readonly<{ route: number; id: string }> | null;
        position: bigint;
        cost: PublicFilterCost;
      }>
    | Readonly<{ status: 'changed' | 'gap'; cost: PublicFilterCost }>
    | PublicFilterConsumerUnavailable
  >;
}

/** PROVISIONAL Semantic producer adapter. No unavailable owner becomes a complete empty page. */
export const readSubjectKeyPage: SubjectSourceKeyTraversal['readSubjectKeyPage'] = async () => ({
  status: 'unavailable',
  reason: 'source_pending',
  cost: {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  },
});

export type SubjectSourceKeyCursor = Readonly<{ route: number; id: string }>;
export type SubjectSourceKeyPage =
  | Readonly<{
      status: 'eligible';
      partition: number;
      epoch: number;
      position: bigint;
      ids: readonly string[];
      after: SubjectSourceKeyCursor | null;
      complete: boolean;
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'identity_pending';
      partition: number;
      epoch: number;
      position: bigint;
      after: SubjectSourceKeyCursor | null;
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'unavailable';
      reason: 'missing_owner' | 'moved' | 'deadline' | 'metadata_missing';
      cost: PublicFilterCost;
    }>;
export interface SubjectSourceKeyPages {
  read(
    request: Readonly<{
      partition: number;
      after: SubjectSourceKeyCursor | null;
      inputLimit: number;
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<SubjectSourceKeyPage>;
}

/** Search's older prepared-index continuation carries a fixed source cut and is a separate owner port. */
export type SubjectSourceKeyPageWorkerRequest = Readonly<{
  partition: number;
  epoch: number;
  after: SubjectSourceKeyCursor | null;
  through: bigint;
  inputLimit: number;
}>;
export type SubjectSourceKeyPageWorkerResult = Readonly<{
  status: 'progress' | 'complete' | 'unavailable';
  partition: number;
  epoch: number;
  through: bigint;
  position: bigint;
  keys: readonly string[];
  after: SubjectSourceKeyCursor | null;
  cost: PublicFilterCost;
}>;
export interface SubjectSourceKeyPageWorker {
  readSubjectKeyPage(
    request: SubjectSourceKeyPageWorkerRequest,
    context: PublicFilterConsumerContext,
  ): Promise<SubjectSourceKeyPageWorkerResult>;
}

/** Missing fixed-cut bridge stays pending; a current page cannot certify an older rebuild cut. */
export function pendingSubjectSourceKeyPage(
  request: SubjectSourceKeyPageWorkerRequest,
): SubjectSourceKeyPageWorkerResult {
  return {
    status: 'unavailable',
    partition: request.partition,
    epoch: request.epoch,
    through: request.through,
    position: request.through,
    keys: [],
    after: request.after,
    cost: {
      inputKeys: 0,
      candidates: 0,
      accessPoints: 0,
      dependencyPoints: 0,
      engineSearches: 0,
      engineIteratorSteps: 0,
      outputSlots: 0,
      resultWrites: 0,
      frontierWrites: 0,
    },
  };
}

/** Internal rebuild inventory. Never used for request-time privacy observation or disclosure. */
export function createSubjectSourceKeyPages(pool: Pool, routing: Uint8Array, access: Access): SubjectSourceKeyPages {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function')
    throw new TypeError('A native pool is required');
  if (!(routing instanceof Uint8Array) || routing.byteLength < 32)
    throw new TypeError('Route key must contain at least 32 bytes');
  if (!access || typeof access.authorize !== 'function' || typeof access.authenticate !== 'function')
    throw new TypeError('A native Access instance is required');
  return {
    async read(request, context) {
      const { partition, inputLimit } = request;
      // Copy caller-owned cursor and deadline before suspension.
      const after = request.after === null ? null : { ...request.after };
      const deadline = context.deadline;
      if (!Number.isInteger(partition) || partition < 0 || partition > 4095)
        throw new RangeError('Partition must be an integer from 0 through 4095');
      if (!Number.isInteger(inputLimit) || inputLimit < 1 || inputLimit > 256)
        throw new RangeError('Input limit must be an integer from 1 through 256');
      if (
        after !== null &&
        (!Number.isInteger(after.route) || routeOf(after.id) !== after.route || partitionOf(after.route) !== partition)
      )
        throw new TypeError('Cursor must contain a native key in the requested home');
      const cost = {
        inputKeys: 0,
        candidates: 0,
        accessPoints: 0,
        dependencyPoints: 0,
        engineSearches: 0,
        engineIteratorSteps: 0,
        outputSlots: 0,
        resultWrites: 0,
        frontierWrites: 0,
      };
      const unavailable = (
        reason: Extract<SubjectSourceKeyPage, { status: 'unavailable' }>['reason'],
      ): SubjectSourceKeyPage => ({ status: 'unavailable', reason, cost });
      if (!Number.isFinite(deadline) || deadline <= Date.now()) return unavailable('deadline');
      try {
        return await withRequestDeadline(deadline, async () => {
          // Access is checked on Global's home with all connections released before the source home.
          const resource = { route: 0, id: GLOBAL_CONTEXT, eligibility: globalReadEligibility('subject:read') };
          const actor = { kind: 'anonymous' as const };
          cost.accessPoints++;
          const evidence = access.prepare
            ? await access.prepare(actor, 'subject:read', resource, { pool, deadline })
            : null;
          requireAccessDeadline(deadline);
          const allowed = await withReadTransaction(pool, async (client) =>
            access.authorize(client, actor, 'subject:read', resource, evidence, await mintReadTime(client)),
          );
          if (!allowed) return unavailable('metadata_missing');
          const snapshot = await withReadTransaction(pool, async (client) => {
            requireAccessDeadline(deadline);
            cost.dependencyPoints++;
            const owner = await ownerStatement.run(client, { partition_no: partition });
            if (!owner || owner.write_state !== 'active') return { owner, rows: [] };
            // Reserve the admitted bound before I/O, so cancellation cannot report free raw work.
            cost.inputKeys = inputLimit;
            cost.candidates = inputLimit;
            cost.dependencyPoints += inputLimit * 4 + 1;
            const rows = await pageStatement.run(client, {
              partition_no: partition,
              after_route: after?.route ?? partition * 16,
              after_id: after?.id ?? '00000000-0000-0000-0000-000000000000',
              input_limit: inputLimit,
            });
            cost.inputKeys = rows.length;
            cost.candidates = rows.length;
            // Successful reads settle to all actual fetched rows, including rejects and unused suffixes.
            cost.dependencyPoints -= (inputLimit - rows.length) * 4;
            return { owner, rows };
          });
          const { owner, rows } = snapshot;
          if (!owner) return unavailable('missing_owner');
          if (owner.write_state === 'moved') return unavailable('moved');
          if (owner.write_state !== 'active' || owner.position === null || owner.epoch <= 0)
            return unavailable('metadata_missing');
          // No subject reread or foreign-home join. A changed/moved owner invalidates the page;
          // callers retain the actual source position for the separate rebuild change bridge.
          cost.dependencyPoints++;
          const current = await withReadTransaction(pool, (client) =>
            ownerStatement.run(client, { partition_no: partition }),
          );
          requireAccessDeadline(deadline);
          if (!current) return unavailable('missing_owner');
          if (current.write_state === 'moved' || current.epoch !== owner.epoch) return unavailable('moved');
          if (current.write_state !== 'active' || current.position !== owner.position)
            return unavailable('metadata_missing');
          const base = { partition, epoch: owner.epoch, position: BigInt(owner.position), cost };
          const ids: string[] = [];
          let cursor = after;
          for (const row of rows) {
            if (row.visibility === 'visible' && row.redirect === null && !row.identity_ready) {
              // Do not lose an already accepted prefix: deliver it before surfacing the unknown key.
              if (cursor !== after) {
                cost.outputSlots = ids.length;
                return { status: 'eligible', ...base, ids, after: cursor, complete: false };
              }
              return { status: 'identity_pending', ...base, after };
            }
            cursor = { route: row.route, id: row.id };
            if (row.visibility === 'visible' && row.redirect === null) ids.push(row.id);
          }
          // An exactly full page never claims completeness. Its next read pays for the empty seek.
          cost.outputSlots = ids.length;
          return { status: 'eligible', ...base, ids, after: cursor, complete: rows.length < inputLimit };
        });
      } catch (error) {
        const reason = classifyUnavailability(error);
        if (reason === 'deadline' || Date.now() >= deadline) return unavailable('deadline');
        if (reason !== undefined) return unavailable('metadata_missing');
        throw error;
      }
    },
  };
}

export type FacetPopulationSubjectSourceKeyPages = SubjectSourceKeyPages;
