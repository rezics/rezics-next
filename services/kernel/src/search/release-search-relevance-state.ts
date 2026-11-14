import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import type { ReleaseGroupingRequest } from './release-search-grouping.ts';
import type { ReleaseSearchCandidateCut } from './release-search-native-stream.ts';

const LIFETIME_MS = 15 * 60_000;
const CLEAN_WORK_LIMIT = 500;
const CLEAN_POSITION_LIMIT = 500;
const CLEAN_NODE_LIMIT = 500;
const CLEAN_EXECUTION_LIMIT = 100;
const LEGACY_POSITION_BATCH = 32;
const LEGACY_WORK_BATCH = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBJECT_ID = UUID;

export type ReleaseSearchRelevanceBinding = Readonly<{
  principal: string;
  request: ReleaseGroupingRequest;
  generation: number;
  cut: ReleaseSearchCandidateCut;
}>;

export type ReleaseSearchRelevanceLocation = Readonly<{
  execution: string;
  node: string;
}>;

export interface ReleaseSearchRelevanceState {
  /** Creates a new retained lineage. Inline IDs are inserted into its first membership root. */
  start(
    binding: ReleaseSearchRelevanceBinding,
    now: number,
    initialWorks?: readonly string[],
  ): Promise<ReleaseSearchRelevanceLocation>;
  /** Renews a valid cursor's private state before reading it. */
  resume(binding: ReleaseSearchRelevanceBinding, location: ReleaseSearchRelevanceLocation, now: number): Promise<void>;
  /** Looks up only this native page's candidate works in the cursor's immutable membership root. */
  seen(
    binding: ReleaseSearchRelevanceBinding,
    location: ReleaseSearchRelevanceLocation,
    works: readonly string[],
    now: number,
  ): Promise<ReadonlySet<string>>;
  /** Adds the emitted works as one replay-idempotent child of this cursor node. */
  advance(
    binding: ReleaseSearchRelevanceBinding,
    location: ReleaseSearchRelevanceLocation,
    branch: string,
    works: readonly string[],
    now: number,
  ): Promise<ReleaseSearchRelevanceLocation>;
}

export class ReleaseSearchRelevanceStateExpired extends Error {
  constructor() {
    super('release_relevance_state_expired');
  }
}

/** A retained pre-trie cursor needs another bounded preparation slice before it can emit candidates. */
export class ReleaseSearchRelevanceStatePreparing extends Error {
  constructor() {
    super('release_relevance_state_preparing');
  }
}

export class ReleaseSearchRelevanceStateConflict extends Error {
  constructor() {
    super('release_relevance_state_changed');
  }
}

type Bound = Readonly<{
  principal: string;
  requestHash: string;
  generation: number;
  sourceCutHash: string;
}>;

type Run = <T>(operation: () => Promise<T>) => Promise<T>;
type Reserve = (pool: string) => void;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function serialized(value: unknown): string {
  const json = canonicalize(value);
  if (json === undefined) throw new TypeError('Release relevance state binding must be canonical JSON');
  return json;
}

function bound(binding: ReleaseSearchRelevanceBinding): Bound {
  if (
    typeof binding.principal !== 'string' ||
    !binding.principal ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation < 1
  )
    throw new TypeError('Invalid release relevance state binding');
  return {
    principal: binding.principal,
    requestHash: sha256(serialized(binding.request)),
    generation: binding.generation,
    sourceCutHash: sha256(serialized(binding.cut)),
  };
}

function timestamp(now: number): { now: Date; expiresAt: Date } {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + LIFETIME_MS))
    throw new TypeError('Invalid release relevance state time');
  return { now: new Date(now), expiresAt: new Date(now + LIFETIME_MS) };
}

function workIds(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  if (unique.some((id) => typeof id !== 'string' || !SUBJECT_ID.test(id)))
    throw new TypeError('Invalid release relevance work id');
  return unique.sort();
}

function worksDigest(values: readonly string[]): string {
  return sha256(serialized([...values].sort()));
}

function validLocation(location: ReleaseSearchRelevanceLocation): boolean {
  return UUID.test(location.execution) && UUID.test(location.node);
}

/** PostgreSQL-backed exact duplicate suppression with immutable fixed-depth membership roots. */
export function createReleaseSearchRelevanceState(input: {
  pool: Pool;
  run: Run;
  reserve: Reserve;
  poolId: string;
}): ReleaseSearchRelevanceState {
  async function query<Row extends Record<string, unknown>>(sql: string, values: unknown[]): Promise<readonly Row[]> {
    input.reserve(input.poolId);
    const result = await input.run(() => input.pool.query<Row>(sql, values));
    return result.rows;
  }

  async function clean(now: Date): Promise<void> {
    // Each call drains a fixed number of legacy deltas, positions, trie nodes and executions.
    // No traversal or retained membership prefix is expanded during cleanup.
    await query(
      `WITH doomed AS (
         SELECT w.execution_id, w.position_id, w.work_id
         FROM search.release_relevance_work w
         JOIN search.release_relevance_execution e ON e.id = w.execution_id
         WHERE e.expires_at <= $1
         ORDER BY e.expires_at, w.execution_id, w.position_id, w.work_id
         LIMIT ${CLEAN_WORK_LIMIT}
       )
       DELETE FROM search.release_relevance_work w
       USING doomed d
       WHERE (w.execution_id, w.position_id, w.work_id) = (d.execution_id, d.position_id, d.work_id)`,
      [now],
    );
    await query(
      `WITH doomed AS (
         SELECT p.execution_id, p.id
         FROM search.release_relevance_position p
         JOIN search.release_relevance_execution e ON e.id = p.execution_id
         WHERE e.expires_at <= $1
           AND NOT EXISTS (
             SELECT 1 FROM search.release_relevance_work w
             WHERE w.execution_id = p.execution_id AND w.position_id = p.id
           )
         ORDER BY e.expires_at, p.execution_id, p.id
         LIMIT ${CLEAN_POSITION_LIMIT}
       )
       DELETE FROM search.release_relevance_position p
       USING doomed d
       WHERE (p.execution_id, p.id) = (d.execution_id, d.id)`,
      [now],
    );
    await query(
      `WITH doomed AS (
         SELECT n.execution_id, n.id
         FROM search.release_relevance_membership_node n
         JOIN search.release_relevance_execution e ON e.id = n.execution_id
         WHERE e.expires_at <= $1
           AND NOT EXISTS (
             SELECT 1 FROM search.release_relevance_position p
             WHERE p.execution_id = n.execution_id AND p.membership_root = n.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM search.release_relevance_membership_build b
             WHERE b.execution_id = n.execution_id AND b.membership_root = n.id
           )
         ORDER BY e.expires_at, n.execution_id, n.id
         LIMIT ${CLEAN_NODE_LIMIT}
       )
       DELETE FROM search.release_relevance_membership_node n
       USING doomed d
       WHERE (n.execution_id, n.id) = (d.execution_id, d.id)`,
      [now],
    );
    await query(
      `WITH doomed AS (
         SELECT e.id
         FROM search.release_relevance_execution e
         WHERE e.expires_at <= $1
           AND NOT EXISTS (
             SELECT 1 FROM search.release_relevance_position p WHERE p.execution_id = e.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM search.release_relevance_membership_node n WHERE n.execution_id = e.id
           )
         ORDER BY e.expires_at, e.id
         LIMIT ${CLEAN_EXECUTION_LIMIT}
       )
       DELETE FROM search.release_relevance_execution e
       USING doomed d
       WHERE e.id = d.id`,
      [now],
    );
  }

  async function start(
    requestBinding: ReleaseSearchRelevanceBinding,
    currentTime: number,
    initialWorks: readonly string[] = [],
  ): Promise<ReleaseSearchRelevanceLocation> {
    const identity = bound(requestBinding);
    const time = timestamp(currentTime);
    const seed = workIds(initialWorks);
    await clean(time.now);
    const location = { execution: randomUUID(), node: randomUUID() };
    const rootBranch = sha256('release-relevance-root-v1');
    const digest = worksDigest(seed);
    const rows = await query<{ execution_id: string; id: string }>(
      `WITH execution AS (
         INSERT INTO search.release_relevance_execution
           (id, principal, request_hash, generation, source_cut_hash, expires_at)
         VALUES ($1, $3, $4, $5, $6, $7)
         RETURNING id
       ), membership AS MATERIALIZED (
         SELECT e.id, search.release_relevance_membership_add_many(e.id, NULL, $10::text[]) AS root_id
         FROM execution e
       ), root AS (
         INSERT INTO search.release_relevance_position
           (execution_id, id, parent_id, branch_hash, work_digest, membership_root)
         SELECT e.id, $2, NULL, $8, $9, m.root_id
         FROM execution e JOIN membership m ON m.id = e.id
         RETURNING execution_id, id
       ), seeded AS (
         INSERT INTO search.release_relevance_work (execution_id, position_id, work_id)
         SELECT r.execution_id, r.id, seed.work_id
         FROM root r CROSS JOIN unnest($10::text[]) AS seed(work_id)
         ON CONFLICT DO NOTHING
         RETURNING work_id
       )
       SELECT execution_id, id FROM root`,
      [
        location.execution,
        location.node,
        identity.principal,
        identity.requestHash,
        identity.generation,
        identity.sourceCutHash,
        time.expiresAt,
        rootBranch,
        digest,
        seed,
      ],
    );
    if (rows.length !== 1 || rows[0]?.execution_id !== location.execution || rows[0]?.id !== location.node)
      throw new Error('Release relevance state root was not created');
    return location;
  }

  async function resume(
    requestBinding: ReleaseSearchRelevanceBinding,
    location: ReleaseSearchRelevanceLocation,
    currentTime: number,
  ): Promise<void> {
    if (!validLocation(location)) throw new ReleaseSearchRelevanceStateExpired();
    const identity = bound(requestBinding);
    const time = timestamp(currentTime);
    const rows = await query<{ id: string }>(
      `UPDATE search.release_relevance_execution e
       SET expires_at = $7
       WHERE e.id = $1
         AND e.principal = $3
         AND e.request_hash = $4
         AND e.generation = $5
         AND e.source_cut_hash = $6
         AND e.expires_at > $8
         AND EXISTS (
           SELECT 1 FROM search.release_relevance_position p
           WHERE p.execution_id = e.id AND p.id = $2
         )
       RETURNING e.id`,
      [
        location.execution,
        location.node,
        identity.principal,
        identity.requestHash,
        identity.generation,
        identity.sourceCutHash,
        time.expiresAt,
        time.now,
      ],
    );
    if (rows.length !== 1) throw new ReleaseSearchRelevanceStateExpired();
  }

  async function seen(
    requestBinding: ReleaseSearchRelevanceBinding,
    location: ReleaseSearchRelevanceLocation,
    values: readonly string[],
    currentTime: number,
  ): Promise<ReadonlySet<string>> {
    if (!validLocation(location)) throw new ReleaseSearchRelevanceStateExpired();
    const identity = bound(requestBinding);
    const time = timestamp(currentTime);
    const candidates = workIds(values);
    const retained = await query<{ membership_root: string | null }>(
      `SELECT p.membership_root
       FROM search.release_relevance_execution e
       JOIN search.release_relevance_position p ON p.execution_id = e.id
       WHERE e.id = $1
         AND p.id = $2
         AND e.principal = $3
         AND e.request_hash = $4
         AND e.generation = $5
         AND e.source_cut_hash = $6
         AND e.expires_at > $7`,
      [
        location.execution,
        location.node,
        identity.principal,
        identity.requestHash,
        identity.generation,
        identity.sourceCutHash,
        time.now,
      ],
    );
    if (retained.length !== 1) throw new ReleaseSearchRelevanceStateExpired();
    let root = retained[0]!.membership_root;
    if (root === null) {
      const progress = await query<{ ready: boolean }>(
        `SELECT search.release_relevance_membership_build_batch($1, $2, $3, $4, $5) AS ready`,
        [location.execution, location.node, LEGACY_POSITION_BATCH, LEGACY_WORK_BATCH, time.now],
      );
      if (!progress.length) throw new ReleaseSearchRelevanceStateExpired();
      if (!progress[0]!.ready) throw new ReleaseSearchRelevanceStatePreparing();
      const migrated = await query<{ membership_root: string | null }>(
        `SELECT p.membership_root
         FROM search.release_relevance_execution e
         JOIN search.release_relevance_position p ON p.execution_id = e.id
         WHERE e.id = $1 AND p.id = $2 AND e.expires_at > $3`,
        [location.execution, location.node, time.now],
      );
      if (migrated.length !== 1) throw new ReleaseSearchRelevanceStateExpired();
      root = migrated[0]!.membership_root;
      if (root === null) throw new Error('Release relevance membership build completed without a root');
    }
    if (!candidates.length) return new Set();
    const rows = await query<{ work_id: string }>(
      `SELECT candidate.work_id
       FROM unnest($3::text[]) AS candidate(work_id)
       WHERE search.release_relevance_membership_contains($1, $2, candidate.work_id)`,
      [location.execution, root, candidates],
    );
    return new Set(rows.map(({ work_id }) => work_id));
  }

  async function advance(
    requestBinding: ReleaseSearchRelevanceBinding,
    location: ReleaseSearchRelevanceLocation,
    branch: string,
    values: readonly string[],
    currentTime: number,
  ): Promise<ReleaseSearchRelevanceLocation> {
    const emitted = workIds(values);
    if (!emitted.length) return location;
    if (!validLocation(location) || !/^[0-9a-f]{64}$/.test(branch)) throw new ReleaseSearchRelevanceStateExpired();
    const identity = bound(requestBinding);
    const time = timestamp(currentTime);
    const proposed = randomUUID();
    const digest = worksDigest(emitted);
    const rows = await query<{
      execution_id: string;
      id: string;
      work_digest: string;
      membership_ready: boolean;
    }>(
      `SELECT * FROM search.release_relevance_advance(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[]
       )`,
      [
        location.execution,
        location.node,
        proposed,
        branch,
        digest,
        identity.principal,
        identity.requestHash,
        identity.generation,
        identity.sourceCutHash,
        time.expiresAt,
        time.now,
        emitted,
      ],
    );
    const row = rows[0];
    if (!row || rows.length !== 1 || row.execution_id !== location.execution)
      throw new ReleaseSearchRelevanceStateExpired();
    if (!row.membership_ready) throw new ReleaseSearchRelevanceStatePreparing();
    if (row.work_digest !== digest) throw new ReleaseSearchRelevanceStateConflict();
    return { execution: row.execution_id, node: row.id };
  }

  return { start, resume, seen, advance };
}
