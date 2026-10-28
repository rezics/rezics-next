import type { Pool, PoolClient } from 'pg';
import { discardConnection, withConnection } from '../database/pool.ts';
import { subjectIndexName } from './indices.ts';
import { subjectConsumer } from './runner.ts';
import allocateControl from './coverage-store-control.sql';
import registerLineage from './coverage-store-lineage.sql';
import readHome from './coverage-store-home.sql';
import writeHome from './coverage-store-attempt.sql';
import promoteHome from './coverage-store-promote.sql';
import * as codec from './coverage-store-codec.ts';
import type {
  ApplyAttempt,
  CoverageCheckpoint,
  CoverageHome,
  CoveragePrefixControl,
  HomeCoverage,
  IndexIncarnation,
  PopulationLineage,
  StructuralFence,
} from './coverage.ts';

/** Coordinator observations, not a certificate or permission to publish; observed native generation 0 is valid. */
export type CoverageObservation = Readonly<{
  current: CoverageHome;
  fence: StructuralFence;
  coveredThrough: CoverageCheckpoint;
}>;

/** Every mutation compares the complete physical identity and lifecycle revision. */
export type CoverageGuard = Readonly<{ incarnation: IndexIncarnation; lineageRevision: bigint }>;
export type HomeGuard = CoverageGuard & Readonly<{ partition: number; revision: bigint }>;

/**
 * Current state only. null means absent/CAS lost, false means CAS lost; invalid input rejects.
 * Revisions start at 1 and increment on every successful mutation. Missing home revision is 0.
 * No method reads native identity, performs engine I/O, advances core checkpoints or certifies Scope.
 */
export interface CoverageStore {
  readPrefix(prefix: string): Promise<CoveragePrefixControl | null>;
  /** Missing prefix has revision 0; generation must exceed the retained allocation fence. */
  allocate(prefix: string, revision: bigint, generation: number): Promise<CoveragePrefixControl | null>;
  readLineage(incarnation: IndexIncarnation): Promise<PopulationLineage | null>;
  /** Exact latest allocation revision; at most three retained incarnations, including retiring ones. */
  register(
    control: CoveragePrefixControl,
    incarnation: IndexIncarnation,
    origin: PopulationLineage['origin'],
  ): Promise<PopulationLineage | null>;
  /** CAS frontier; only populating, partition 0..4095 (4096 only for complete), after UUID or null. */
  population(
    guard: CoverageGuard,
    frontier: Pick<PopulationLineage, 'partition' | 'after' | 'complete'>,
  ): Promise<PopulationLineage | null>;
  /** populating -> live only when complete; populating/live -> quarantined; any nonretired -> retiring. */
  transition(guard: CoverageGuard, state: 'live' | 'quarantined' | 'retiring'): Promise<PopulationLineage | null>;
  /** Only retiring, with no new enroll/settle/promote possible; deletes <=4096 homes and the lineage. */
  reclaim(guard: CoverageGuard): Promise<boolean>;
  readHome(incarnation: IndexIncarnation, partition: number): Promise<HomeCoverage | null>;
  /** Only populating/live; pending or ambiguous slot cannot be replaced, even by the same ID. */
  enroll(guard: HomeGuard, attempt: ApplyAttempt): Promise<HomeCoverage | null>;
  /** Exact attempt ID; enrolled -> visible/ambiguous, ambiguous -> visible on actual resolution only. */
  outcome(
    guard: HomeGuard,
    attemptId: string,
    observation: { outcome: 'visible' | 'ambiguous'; source: CoverageHome | null; fence: StructuralFence | null },
  ): Promise<HomeCoverage | null>;
  /** Visible only; records actual core CAS result, including loss, and completes this attempt. */
  complete(
    guard: HomeGuard,
    attemptId: string,
    checkpoint: 'advanced' | 'lost' | 'stopped',
  ): Promise<HomeCoverage | null>;
  /** Live only, completed attempt ID; exact source/current/fence/barrier agreement, no unresolved slot. */
  promote(guard: HomeGuard, attemptId: string, observation: CoverageObservation): Promise<HomeCoverage | null>;
}

const lineageColumns = `prefix, generation::double precision, index_name, index_uuid, protocol, consumer,
  revision::text, state, origin, population_partition, population_after, population_complete`;

function one(value: unknown): unknown | null {
  if (!Array.isArray(value)) return value;
  codec.requireValue(value.length <= 1);
  return value[0] ?? null;
}
function guard(value: CoverageGuard | HomeGuard, perHome = false): HomeGuard {
  // A HomeGuard is also a valid lifecycle guard (structural subtyping).
  const hasHome = value !== null && typeof value === 'object' && Object.hasOwn(value, 'partition');
  const v = codec.object(
    value,
    hasHome ? 'incarnation lineageRevision partition revision' : 'incarnation lineageRevision',
  );
  codec.requireValue(!perHome || hasHome);
  return {
    incarnation: codec.incarnation(v.incarnation),
    lineageRevision: codec.bigint(v.lineageRevision, false, 1n),
    partition: hasHome ? codec.integer(v.partition, 0, 4095) : 0,
    revision: hasHome ? codec.bigint(v.revision) : 0n,
  };
}
function json(value: unknown): Record<string, unknown> | null {
  return value === null ? null : (JSON.parse(codec.encode(value)) as Record<string, unknown>);
}

/** Current durable state only; every CAS holds its lifecycle lock until the transaction commits. */
export function createCoverageStore(pool: Pool): CoverageStore {
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return withConnection(pool, async (client) => {
      await client.query('BEGIN');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollback) {
          discardConnection(client, rollback instanceof Error ? rollback : new Error(String(rollback)));
        }
        throw error;
      }
    });
  }
  async function prefixRow(client: Pick<PoolClient, 'query'>, prefix: string, lock = false) {
    const result = await client.query(
      `SELECT prefix, revision::text,
      issued_generation::double precision AS "issuedGeneration"
      FROM search.index_prefix_control WHERE partition_no=0 AND prefix=$1${lock ? ' FOR UPDATE' : ''}`,
      [prefix],
    );
    return result.rows[0] ? codec.control(result.rows[0], true) : null;
  }
  async function lineage(client: Pick<PoolClient, 'query'>, physical: IndexIncarnation, lock = false) {
    const result = await client.query(
      `SELECT ${lineageColumns} FROM search.index_incarnation
      WHERE partition_no=0 AND consumer=$1 AND index_uuid=$2${lock ? ' FOR UPDATE' : ''}`,
      [physical.consumer, physical.uuid],
    );
    const row = result.rows[0] ? codec.lineageRow(result.rows[0]) : null;
    return row && codec.equal(row.incarnation, physical) ? row : null;
  }
  async function locked(client: PoolClient, g: CoverageGuard) {
    const row = await lineage(client, g.incarnation, true);
    return row && row.revision === g.lineageRevision && row.revision < codec.MAX ? row : null;
  }
  async function home(client: Pick<PoolClient, 'query'>, physical: IndexIncarnation, partition: number) {
    const row = one(await readHome.run(client, { partition, consumer: physical.consumer, uuid: physical.uuid }));
    return row ? codec.homeRow(row, physical) : null;
  }
  async function mutateHome(
    g: HomeGuard,
    change: (old: HomeCoverage | null, live: PopulationLineage) => HomeCoverage | null,
    promotion = false,
  ) {
    return transaction(async (client) => {
      const live = await locked(client, g);
      if (!live || !['populating', 'live'].includes(live.state)) return null;
      const old = await home(client, g.incarnation, g.partition);
      if ((old?.revision ?? 0n) !== g.revision || g.revision === codec.MAX) return null;
      const next = change(old, live);
      if (!next) return null;
      const key = {
        partition: g.partition,
        consumer: g.incarnation.consumer,
        uuid: g.incarnation.uuid,
        revision: g.revision,
      };
      const result = promotion
        ? await promoteHome.run(client, {
            ...key,
            verified: json(next.verified)!,
            covered_through: json(next.coveredThrough)!,
          })
        : await writeHome.run(client, {
            ...key,
            current: json(next.current),
            fence: json(next.fence),
            verified: json(next.verified),
            covered_through: json(next.coveredThrough),
            attempt: json(next.attempt),
          });
      const row = one(result);
      return row ? codec.homeRow(row, g.incarnation) : null;
    });
  }
  return {
    async readPrefix(value) {
      return prefixRow(pool, codec.prefix(value));
    },
    async allocate(value, expected, issued) {
      const prefix = codec.prefix(value),
        revision = codec.bigint(expected);
      const generation = codec.integer(issued, 1, Number.MAX_SAFE_INTEGER);
      return transaction(async (client) => {
        const current = await prefixRow(client, prefix, true);
        if (
          (current?.revision ?? 0n) !== revision ||
          revision === codec.MAX ||
          (current && generation <= current.issuedGeneration)
        )
          return null;
        const row = one(await allocateControl.run(client, { prefix, revision, generation: BigInt(generation) }));
        return row ? codec.control(row, true) : null;
      });
    },
    async readLineage(value) {
      return lineage(pool, codec.incarnation(value));
    },
    async register(value, physical, provenance) {
      const control = codec.control(value),
        incarnation = codec.incarnation(physical);
      const origin = codec.choice(provenance, ['created-empty', 'replay', 'audit']);
      if (
        incarnation.index !== subjectIndexName(incarnation.prefix, incarnation.generation) ||
        incarnation.consumer !== subjectConsumer(incarnation.prefix, incarnation.generation)
      )
        return null;
      if (control.prefix !== incarnation.prefix || control.issuedGeneration !== incarnation.generation) return null;
      return transaction(async (client) => {
        const current = await prefixRow(client, control.prefix, true);
        if (!codec.equal(current, control)) return null;
        const row = one(
          await registerLineage.run(client, { ...incarnation, generation: BigInt(incarnation.generation), origin }),
        );
        return row ? codec.lineageRow(row) : null;
      });
    },
    async population(value, progress) {
      const g = guard(value),
        next = codec.frontier(progress);
      return transaction(async (client) => {
        const old = await locked(client, g);
        if (
          !old ||
          old.state !== 'populating' ||
          old.complete ||
          next.partition < old.partition ||
          (next.partition === old.partition && (next.after === null || (old.after !== null && next.after <= old.after)))
        )
          return null;
        const result = await client.query(
          `UPDATE search.index_incarnation SET revision=revision+1,
          population_partition=$4, population_after=$5, population_complete=$6
          WHERE partition_no=0 AND consumer=$1 AND index_uuid=$2 AND revision=$3 RETURNING ${lineageColumns}`,
          [
            g.incarnation.consumer,
            g.incarnation.uuid,
            g.lineageRevision.toString(),
            next.partition,
            next.after,
            next.complete,
          ],
        );
        return result.rows[0] ? codec.lineageRow(result.rows[0]) : null;
      });
    },
    async transition(value, target) {
      const g = guard(value),
        state = codec.choice(target, ['live', 'quarantined', 'retiring']);
      return transaction(async (client) => {
        const old = await locked(client, g);
        if (
          !old ||
          (state === 'live' && !(old.state === 'populating' && old.complete)) ||
          (state === 'quarantined' && !['populating', 'live'].includes(old.state))
        )
          return null;
        const result = await client.query(
          `UPDATE search.index_incarnation SET revision=revision+1, state=$4
          WHERE partition_no=0 AND consumer=$1 AND index_uuid=$2 AND revision=$3 RETURNING ${lineageColumns}`,
          [g.incarnation.consumer, g.incarnation.uuid, g.lineageRevision.toString(), state],
        );
        return result.rows[0] ? codec.lineageRow(result.rows[0]) : null;
      });
    },
    async reclaim(value) {
      const g = guard(value);
      return transaction(async (client) => {
        // Same lock order as admission. Home mutations hold only the lifecycle lock.
        await prefixRow(client, g.incarnation.prefix, true);
        const old = await lineage(client, g.incarnation, true);
        if (!old || old.revision !== g.lineageRevision || old.state !== 'retiring') return false;
        await client.query('DELETE FROM search.index_home_coverage WHERE consumer=$1 AND index_uuid=$2', [
          g.incarnation.consumer,
          g.incarnation.uuid,
        ]);
        await client.query(
          `DELETE FROM search.index_incarnation
          WHERE partition_no=0 AND consumer=$1 AND index_uuid=$2 AND revision=$3`,
          [g.incarnation.consumer, g.incarnation.uuid, g.lineageRevision.toString()],
        );
        return true;
      });
    },
    async readHome(value, number) {
      const physical = codec.incarnation(value),
        partition = codec.integer(number, 0, 4095);
      return transaction(async (client) => {
        if (!(await lineage(client, physical, true))) return null;
        return home(client, physical, partition);
      });
    },
    async enroll(value, proposed) {
      const g = guard(value, true),
        slot = codec.attempt(proposed);
      codec.requireValue(slot.outcome === 'enrolled' && slot.checkpoint === 'pending' && slot.source === null);
      return mutateHome(g, (old) => {
        if (old?.attempt && (old.attempt.outcome !== 'completed' || old.attempt.id === slot.id)) return null;
        return {
          partition: g.partition,
          incarnation: g.incarnation,
          revision: g.revision,
          current: old?.current ?? null,
          fence: old?.fence ?? null,
          verified: old?.verified ?? null,
          coveredThrough: old?.coveredThrough ?? null,
          attempt: slot,
        };
      });
    },
    async outcome(value, id, observed) {
      const g = guard(value, true),
        attemptId = codec.uuid(id);
      const v = codec.object(observed, 'outcome source fence');
      const outcome = codec.choice(v.outcome, ['visible', 'ambiguous']);
      const source = v.source === null ? null : codec.home(v.source);
      const fence = v.fence === null ? null : codec.fence(v.fence);
      codec.pair(source, fence);
      codec.requireValue(outcome !== 'visible' || source !== null);
      return mutateHome(g, (old) => {
        const slot = old?.attempt;
        if (
          !old ||
          !slot ||
          slot.id !== attemptId ||
          !(slot.outcome === 'enrolled' || (slot.outcome === 'ambiguous' && outcome === 'visible')) ||
          (source && (source.partition !== g.partition || source.epoch !== slot.through.epoch)) ||
          (slot.source && (!codec.equal(slot.source, source) || !codec.equal(old.fence, fence)))
        )
          return null;
        const same = codec.equal(old.current, source) && old.fence?.generation === fence?.generation;
        return {
          ...old,
          current: source,
          fence,
          verified: same ? old.verified : null,
          coveredThrough: same ? old.coveredThrough : null,
          attempt: { ...slot, source, outcome },
        };
      });
    },
    async complete(value, id, result) {
      const g = guard(value, true),
        attemptId = codec.uuid(id);
      const checkpoint = codec.choice(result, ['advanced', 'lost', 'stopped']);
      return mutateHome(g, (old) =>
        !old || old.attempt?.id !== attemptId || old.attempt.outcome !== 'visible'
          ? null
          : { ...old, attempt: { ...old.attempt, outcome: 'completed', checkpoint } },
      );
    },
    async promote(value, id, observed) {
      const g = guard(value, true),
        attemptId = codec.uuid(id);
      const v = codec.object(observed, 'current fence coveredThrough');
      const current = codec.home(v.current),
        fence = codec.fence(v.fence),
        through = codec.checkpoint(v.coveredThrough);
      return mutateHome(
        g,
        (old, live) => {
          if (
            !old ||
            live.state !== 'live' ||
            old.attempt?.id !== attemptId ||
            old.attempt.outcome !== 'completed' ||
            current.partition !== g.partition ||
            !codec.equal(current, old.current) ||
            !codec.equal(current, old.attempt.source) ||
            !codec.equal(fence, old.fence) ||
            current.epoch !== fence.epoch ||
            current.generation !== fence.generation ||
            through.epoch !== fence.epoch ||
            through.position < fence.position ||
            !codec.equal(through, old.attempt.through)
          )
            return null;
          return { ...old, verified: current, coveredThrough: through };
        },
        true,
      );
    },
  };
}
