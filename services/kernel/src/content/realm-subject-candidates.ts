import type { Pool, PoolClient } from 'pg';
import { within, deadlineClient } from '../access/authenticate.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ProblemError } from '../http/problem.ts';

export const REALM_SUBJECT_RAW_LIMIT = 32;
export type CandidateVersion = Readonly<{ epoch: number; position: string }>;
export type RealmSubjectCandidate = Readonly<{
  realm: string;
  original: string;
  terminal: string | null;
  identityEpoch: string | null;
  thread: string;
  opening: string;
  revision: string;
  board: string;
  kind: 'discussion' | 'review';
  active: boolean;
}>;
export type RealmSubjectCoverage = Readonly<{
  generation: string;
  revision: string;
  unresolved: string;
}>;
export type CandidateKey = Readonly<{ terminal: string; original: string; thread: string }>;
export function realmSubjectRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Expected native Realm Subject locator');
  return route;
}
export function candidateVersion(value: CandidateVersion): void {
  if (
    !Number.isInteger(value.epoch) ||
    value.epoch < 1 ||
    value.epoch > 2147483647 ||
    !/^(0|[1-9][0-9]*)$/.test(value.position) ||
    BigInt(value.position) > 9223372036854775807n
  )
    throw new TypeError('Invalid native candidate position');
}
/** A single native home, released before any foreign owner is consulted. */
export async function realmSubjectHome<T>(
  pool: Pool,
  route: number,
  deadline: number,
  write: boolean,
  run: (client: PoolClient, version: CandidateVersion) => Promise<T>,
): Promise<T> {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const home = await readPartition(client, partitionOf(route));
        if (!home || home.writeState === 'moved' || (write && home.writeState !== 'active'))
          throw new ProblemError('dependency_unavailable');
        const result = await run(client, { epoch: home.epoch, position: home.position.toString() });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollback) {
          discardConnection(connection, rollback as Error);
        }
        throw error;
      }
    }),
  );
}
const columns = `realm_id AS realm, original_id AS original, terminal_id AS terminal,
 identity_epoch::text AS "identityEpoch", thread_id AS thread, opening_id AS opening,
 revision_id AS revision, board_id AS board, kind, active`;
const versionEqual = (a: CandidateVersion, b: CandidateVersion) => a.epoch === b.epoch && a.position === b.position;

/** Structural locators only. Callers obtain and validate native provenance before writing. */
export function createRealmSubjectCandidates(pool: Pool) {
  async function generation(client: PoolClient, route: number, realm: string) {
    await client.query(
      `INSERT INTO content.realm_subject_generation(route,realm_id)
      VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [route, realm],
    );
    await client.query(
      `SELECT revision FROM content.realm_subject_generation
      WHERE route=$1 AND realm_id=$2 FOR UPDATE`,
      [route, realm],
    );
  }
  async function bump(client: PoolClient, route: number, realm: string, delta = 0) {
    await client.query(
      `UPDATE content.realm_subject_generation SET revision=revision+1,
      unresolved=unresolved+$3 WHERE route=$1 AND realm_id=$2`,
      [route, realm, delta],
    );
  }
  async function fenceAt(client: PoolClient, route: number, realm: string, thread: string) {
    return (
      await client.query<CandidateVersion>(
        `SELECT source_epoch AS epoch,
      source_position::text AS position FROM content.realm_subject_thread_fence
      WHERE route=$1 AND realm_id=$2 AND thread_id=$3`,
        [route, realm, thread],
      )
    ).rows[0];
  }
  function rows(route: number, deadline: number, sql: string, parameters: unknown[]) {
    return realmSubjectHome(
      pool,
      route,
      deadline,
      false,
      async (client) => (await client.query<RealmSubjectCandidate>(sql, parameters)).rows,
    );
  }
  return {
    async initialize(realm: string, deadline: number) {
      const route = realmSubjectRoute(realm);
      await realmSubjectHome(pool, route, deadline, true, (client) => generation(client, route, realm));
    },
    async observe(realm: string, deadline: number): Promise<RealmSubjectCoverage | null> {
      const route = realmSubjectRoute(realm);
      return realmSubjectHome(
        pool,
        route,
        deadline,
        false,
        async (client) =>
          (
            await client.query<RealmSubjectCoverage>(
              `SELECT generation::text,revision::text,unresolved::text
          FROM content.realm_subject_generation WHERE route=$1 AND realm_id=$2`,
              [route, realm],
            )
          ).rows[0] ?? null,
      );
    },
    async fence(realm: string, thread: string, version: CandidateVersion, deadline: number) {
      candidateVersion(version);
      realmSubjectRoute(thread);
      if (version.position === '0') throw new TypeError('A live fence needs a committed source position');
      const route = realmSubjectRoute(realm);
      return realmSubjectHome(pool, route, deadline, true, async (client) => {
        await generation(client, route, realm);
        const result = await client.query(
          `INSERT INTO content.realm_subject_thread_fence AS f
          (route,realm_id,thread_id,source_epoch,source_position) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(route,realm_id,thread_id) DO UPDATE SET source_epoch=$4,source_position=$5
          WHERE (f.source_epoch,f.source_position)<($4::integer,$5::bigint) RETURNING 1`,
          [route, realm, thread, version.epoch, version.position],
        );
        if (result.rowCount) await bump(client, route, realm);
        return versionEqual((await fenceAt(client, route, realm, thread))!, version);
      });
    },
    async write(
      candidate: RealmSubjectCandidate,
      version: CandidateVersion,
      mode: 'baseline' | 'live',
      deadline: number,
    ) {
      candidateVersion(version);
      const route = realmSubjectRoute(candidate.realm);
      for (const id of [candidate.original, candidate.thread, candidate.opening, candidate.revision, candidate.board])
        realmSubjectRoute(id);
      if (
        realmSubjectRoute(candidate.opening) !== realmSubjectRoute(candidate.thread) ||
        realmSubjectRoute(candidate.revision) !== realmSubjectRoute(candidate.thread) ||
        (candidate.kind !== 'discussion' && candidate.kind !== 'review') ||
        (candidate.terminal === null) !== (candidate.identityEpoch === null)
      )
        throw new TypeError('Invalid candidate provenance');
      if (candidate.terminal !== null) {
        realmSubjectRoute(candidate.terminal);
        if (
          !/^(0|[1-9][0-9]*)$/.test(candidate.identityEpoch!) ||
          BigInt(candidate.identityEpoch!) > 9223372036854775807n
        )
          throw new TypeError('Invalid identity epoch');
      }
      return realmSubjectHome(pool, route, deadline, true, async (client) => {
        await generation(client, route, candidate.realm);
        const fence = await fenceAt(client, route, candidate.realm, candidate.thread);
        if (mode === 'baseline' ? fence !== undefined : !fence || !versionEqual(fence, version)) return false;
        const key = [route, candidate.realm, candidate.original, candidate.thread];
        const old = (
          await client.query<
            RealmSubjectCandidate & { unresolved: boolean; live: boolean; epoch: number; position: string }
          >(
            `SELECT ${columns},active AND terminal_id IS NULL AS unresolved,live,source_epoch AS epoch,source_position::text AS position
          FROM content.realm_subject_candidate WHERE route=$1 AND realm_id=$2 AND original_id=$3 AND thread_id=$4`,
            key,
          )
        ).rows[0];
        if (mode === 'baseline' && old) return false;
        if (
          old?.live &&
          versionEqual(old, version) &&
          (Object.keys(candidate) as (keyof RealmSubjectCandidate)[]).every((key) => old[key] === candidate[key])
        )
          return false;
        await client.query(
          `INSERT INTO content.realm_subject_candidate
          (route,realm_id,original_id,thread_id,opening_id,revision_id,board_id,kind,terminal_id,identity_epoch,active,live,source_epoch,source_position)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT(route,realm_id,original_id,thread_id) DO UPDATE SET
          opening_id=$5,revision_id=$6,board_id=$7,kind=$8,terminal_id=$9,identity_epoch=$10,
          active=$11,live=$12,source_epoch=$13,source_position=$14`,
          [
            ...key,
            candidate.opening,
            candidate.revision,
            candidate.board,
            candidate.kind,
            candidate.terminal,
            candidate.identityEpoch,
            candidate.active,
            mode === 'live',
            version.epoch,
            version.position,
          ],
        );
        await bump(
          client,
          route,
          candidate.realm,
          Number(candidate.active && candidate.terminal === null) - Number(old?.unresolved ?? false),
        );
        return true;
      });
    },
    async thread(realm: string, thread: string, after: string | null, deadline: number) {
      const route = realmSubjectRoute(realm);
      realmSubjectRoute(thread);
      return rows(
        route,
        deadline,
        `SELECT ${columns} FROM content.realm_subject_candidate
        WHERE route=$1 AND realm_id=$2 AND thread_id=$3 AND original_id>$4::uuid
        ORDER BY original_id LIMIT 32`,
        [route, realm, thread, after ?? zero],
      );
    },
    async page(realm: string, after: CandidateKey | null, subject: string | null, limit: number, deadline: number) {
      if (!Number.isInteger(limit) || limit < 1 || limit > REALM_SUBJECT_RAW_LIMIT)
        throw new RangeError('Invalid raw candidate budget');
      const route = realmSubjectRoute(realm);
      return rows(
        route,
        deadline,
        `SELECT ${columns} FROM content.realm_subject_candidate
        WHERE route=$1 AND realm_id=$2 AND active AND terminal_id IS NOT NULL
        ${subject === null ? '' : 'AND terminal_id=$7::uuid'}
        AND (terminal_id,original_id,thread_id)>($3::uuid,$4::uuid,$5::uuid)
        ORDER BY terminal_id,original_id,thread_id LIMIT $6`,
        [
          route,
          realm,
          after?.terminal ?? zero,
          after?.original ?? zero,
          after?.thread ?? zero,
          limit,
          ...(subject === null ? [] : [subject]),
        ],
      );
    },
  };
}
const zero = '00000000-0000-0000-0000-000000000000';
