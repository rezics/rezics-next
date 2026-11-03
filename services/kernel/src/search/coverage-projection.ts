import type { BatchResult, Envelope } from '../events/log.ts';
import { CommandUnavailableError } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import { readIdentityHome, type HomeIdentity } from '../semantic/identity-basis.ts';
import { withConnection } from '../database/pool.ts';
import { createSubjectIndexer } from './indexer.ts';
import { createCoverageStore, type HomeGuard } from './coverage-store.ts';
import * as codec from './coverage-store-codec.ts';
import type {
  ApplyAttempt,
  CoverageHome,
  IndexIncarnation,
  ProjectionOptions,
  StructuralFence,
  SubjectProjectionCoordinator,
} from './coverage.ts';

class EnrollmentBusy extends Error {
  constructor() {
    super('Coverage enrollment is busy');
    this.name = 'EnrollmentBusy';
  }
}

function mutating(envelopes: readonly Envelope[]): boolean {
  return envelopes.some((envelope) =>
    envelope.events.some(
      (event) =>
        event.type.startsWith('com.rezics.subject.') ||
        event.type === 'com.rezics.library.subject.listed.v1' ||
        event.type === 'com.rezics.rating.public_figure.changed.v1',
    ),
  );
}

export async function observeCoverageHome(
  pool: ProjectionOptions['pool'],
  partition: number,
): Promise<{ source: CoverageHome; fence: StructuralFence; pending: bigint }> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const home: HomeIdentity = await readIdentityHome(client, partition);
      const core = (
        await client.query<{ epoch: number; position: string }>(
          'SELECT epoch, position::text FROM core.partition WHERE partition_no=$1',
          [partition],
        )
      ).rows[0];
      if (!core) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
      await client.query('COMMIT');
      return {
        source: { partition: home.partition, epoch: home.epoch, home: home.home, generation: home.generation },
        fence: { epoch: home.epoch, position: BigInt(core.position), generation: home.generation },
        pending: home.pending,
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* keep the original error */
      }
      if (error instanceof CommandUnavailableError)
        throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
      throw error;
    }
  });
}

/** Internal producer seam; durable enrollment precedes source reads and engine writes. */
export function createCoverageProjection(options: ProjectionOptions): Pick<SubjectProjectionCoordinator, 'run'> {
  return {
    async run(incarnation: IndexIncarnation, partition: number): Promise<BatchResult> {
      const store = createCoverageStore(options.pool);
      const lineage = await store.readLineage(incarnation);
      if (!lineage || lineage.state === 'retiring' || lineage.state === 'quarantined')
        throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
      const existing = await store.readHome(incarnation, partition);
      if (
        existing?.attempt &&
        ['enrolled', 'ambiguous'].includes(existing.attempt.outcome) &&
        existing.attempt.checkpoint === 'pending'
      )
        return { status: 'busy' };

      let guard: HomeGuard = {
        incarnation,
        lineageRevision: lineage.revision,
        partition,
        revision: existing?.revision ?? 0n,
      };
      let wrote = false;
      let visible = false;
      let skipped = false;
      let slot: ApplyAttempt | undefined;
      const search = {
        ...options.search,
        async bulk<T>(...args: Parameters<typeof options.search.bulk>) {
          wrote = true;
          return options.search.bulk<T>(...args);
        },
      };
      const source = {
        ...options.source,
        async read(home: number, ids: readonly string[]) {
          const before = await observeCoverageHome(options.pool, home);
          if (before.pending !== 0n) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
          const snapshot = await options.source.read(home, ids);
          const after = await observeCoverageHome(options.pool, home);
          if (after.pending !== 0n || !codec.equal(before.source, after.source))
            throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
          return snapshot;
        },
      };
      const indexer = createSubjectIndexer({
        pool: options.pool,
        search,
        source,
        listing: options.listing,
        index: incarnation.index,
        consumer: incarnation.consumer,
        aroundApply: async (_home, envelopes, apply) => {
          const last = envelopes.at(-1)!;
          slot = {
            id: crypto.randomUUID(),
            from: { epoch: envelopes[0]!.epoch, position: envelopes[0]!.position - 1n },
            through: { epoch: last.epoch, position: last.position },
            source: null,
            outcome: 'enrolled',
            checkpoint: 'pending',
          };
          if (slot.from.position < 0n) slot = { ...slot, from: { ...slot.from, position: 0n } };
          const enrolled = await store.enroll(guard, slot);
          if (!enrolled) throw new EnrollmentBusy();
          guard = { ...guard, revision: enrolled.revision };
          skipped = !mutating(envelopes);
          try {
            await apply();
            if (skipped) return;
            const observed = await observeCoverageHome(options.pool, partition);
            if (observed.pending !== 0n)
              throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
            const next = await store.outcome(guard, slot.id, {
              outcome: 'visible',
              source: observed.source,
              fence: {
                epoch: observed.fence.epoch,
                position: slot.through.position,
                generation: observed.fence.generation,
              },
            });
            if (!next) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
            guard = { ...guard, revision: next.revision };
            visible = true;
          } catch (error) {
            if (error instanceof EnrollmentBusy) throw error;
            if (!slot) throw error;
            if (!wrote) {
              const aborted = await store.settleNoWrite(guard, slot.id, { outcome: 'aborted', checkpoint: 'pending' });
              if (aborted) guard = { ...guard, revision: aborted.revision };
              throw error;
            }
            const observed = await observeCoverageHome(options.pool, partition).catch(() => null);
            const ambiguous = await store.outcome(guard, slot.id, {
              outcome: 'ambiguous',
              source: observed?.source ?? null,
              fence: observed?.fence ?? null,
            });
            if (ambiguous) guard = { ...guard, revision: ambiguous.revision };
            throw error;
          }
        },
      });
      let result: BatchResult;
      try {
        result = await indexer.run(partition);
      } catch (error) {
        if (error instanceof EnrollmentBusy) return { status: 'busy' };
        throw error;
      }
      if (!slot) return result;
      const checkpoint = result.status === 'stopped' ? 'stopped' : result.status === 'busy' ? 'lost' : 'advanced';
      if (skipped) {
        const settled = await store.settleNoWrite(guard, slot.id, { outcome: 'skipped', checkpoint });
        if (settled) return result;
        if (result.status === 'busy') return result;
        throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
      }
      if (visible) {
        const done = await store.complete(guard, slot.id, checkpoint);
        if (!done && result.status !== 'busy')
          throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
      }
      return result;
    },
  };
}
