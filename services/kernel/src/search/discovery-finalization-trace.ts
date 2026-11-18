import type { Pool } from 'pg';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';
import { discoveryConsumer } from './consumer-name.ts';
import type { DiscoveryMetadataKind } from './discovery-api.ts';
import type { DiscoveryCut } from './generations.ts';

type ObservationField = DiscoveryMetadataKind | 'collectionEpoch' | 'witnessEpoch' | 'revision' | 'claimRevision';

// Two distinct mixed homes across all maintenance turns in the instrumented worker.
const sampledHomes = new WeakMap<Pool, Set<number>>();

// Only fixed diagnostic vocabulary may cross into the mixed Home worker's retained trace.
const failureNames = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'AccessUnavailableError',
  'CommandUnavailableError',
  'SearchUnavailableError',
  'OpenSearchError',
  'ReviewDiscoverySourceError',
  'DiscoveryReviewFrontierError',
  'DiscoveryReviewInvalidationPendingError',
  'DiscoveryProducerCoverageError',
  'CollectionDiscoveryReadinessError',
  'DiscoveryPhysicalTargetChangedError',
]);

export function discoveryFailureObservation(error: unknown) {
  const name = error instanceof Error && failureNames.has(error.name) ? error.name : 'UnknownError';
  const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  if (!(source instanceof Error && source.name === 'ReviewDiscoverySourceError')) return { name };
  return {
    name,
    source: 'ReviewDiscoverySourceError',
    state: ['changed', 'unavailable', 'preparing'].find((state) => 'state' in source && source.state === state),
    missing: [
      'source-home',
      'dependency-home',
      'lifecycle-invalidation',
      'eligibility-dependency',
      'source-lifecycle',
      'review-dependency-directory',
      'dependency-home-bound',
    ].find((missing) => 'missing' in source && source.missing === missing),
    observation: ['keyed-output', 'empty-position'].find(
      (read) => 'observation' in source && source.observation === read,
    ),
  };
}

// The mixed Home fixture opts in to this bounded worker trace.
export function discoveryFinalizationTrace(prefix: string, deadline: number) {
  const startedAt = Date.now();
  let generation: number | undefined;
  let phase = 'select-target';
  let phaseStart = startedAt;
  const phaseMs: Record<string, number> = {};
  function enter(operation: string) {
    const now = Date.now();
    phaseMs[phase] = (phaseMs[phase] ?? 0) + now - phaseStart;
    phase = operation;
    phaseStart = now;
  }
  let completedHomes = 0;
  let firstFailure: { owner: string; partition: number } | undefined;
  const native: Record<string, { calls: number; homes: number; settled: number; totalMs: number }> = {};
  function report(details: Record<string, unknown> = {}) {
    if (generation === undefined) return;
    const observation = {
      prefix,
      generation,
      phase,
      startedAt,
      deadline,
      elapsedMs: Date.now() - startedAt,
      phaseMs: { ...phaseMs, [phase]: (phaseMs[phase] ?? 0) + Date.now() - phaseStart },
      completedHomes,
      native,
      firstFailure,
      ...details,
    };
    console.info('Mixed Home finalization', JSON.stringify(observation));
    return observation;
  }
  // Cut objects live for one inventory read. Sibling checks use the same objects after the initial reopen.
  type NativeObservation = Partial<Record<ObservationField, string>>;
  const observed = new WeakMap<DiscoveryCut, NativeObservation>();
  function observe(cut: DiscoveryCut, field: ObservationField, value: bigint | number | undefined) {
    if (value === undefined) return;
    const values: NativeObservation = observed.get(cut) ?? {};
    values[field] = value.toString();
    observed.set(cut, values);
  }
  function rejectedCuts(pool: Pool, cuts: readonly DiscoveryCut[]) {
    if (generation === undefined) return;
    const sampled = sampledHomes.get(pool) ?? new Set<number>();
    const homes = cuts
      .filter(
        (cut) =>
          !sampled.has(cut.partition) &&
          cut.collection_position !== null &&
          cut.review_position !== null &&
          cut.space_position !== null,
      )
      .slice(0, 2 - sampled.size);
    if (!homes.length) return;
    for (const cut of homes) sampled.add(cut.partition);
    sampledHomes.set(pool, sampled);
    const consumer = discoveryConsumer(prefix, generation);
    return async (stage: 'before-reopen' | 'after-reopen') => {
      const sample = homes.map((cut) => ({
        partition: cut.partition,
        stored: {
          accounts: cut.position,
          semantic: cut.semantic_position,
          collection: cut.collection_position,
          review: cut.review_position,
          space: cut.space_position,
        },
        storedCollectionEpoch: cut.collection_epoch,
        storedAccountWitness: { revision: cut.revision, claimRevision: cut.claim_revision },
        storedSemanticWitness: { revision: cut.semantic_revision, claimRevision: cut.semantic_claim_revision },
        // Accounts and Semantic both compare their stored position with this same inventory head.
        observed: { head: cut.head, ...observed.get(cut) },
      }));
      let details;
      try {
        details = await withBoundedReadOnlyTransaction(pool, Math.min(deadline, Date.now() + 1_500), async (client) => {
          const frontiers = await client.query(
            `SELECT p.partition_no AS partition,p.owner,p.position::text AS scanned_position,
                      p.reconcile_position::text AS certified_cut,p.native_epoch,p.complete,p.native_complete,p.certified,
                      p.revision::text,p.claim_revision::text,c.epoch,c.position::text AS head,
                      cp.epoch AS checkpoint_epoch,cp.position::text AS checkpoint
               FROM search.discovery_population p JOIN core.partition c USING (partition_no)
               LEFT JOIN core.consumer_checkpoint cp ON cp.partition_no=p.partition_no AND cp.consumer=$4
               WHERE p.prefix=$1 AND p.generation=$2 AND p.partition_no=ANY($3::int[])
               ORDER BY p.partition_no,p.owner`,
            [prefix, generation, homes.map((cut) => cut.partition), consumer],
          );
          const events = [];
          if (stage === 'after-reopen') {
            const { EVENT_TYPES } = await import('../events/catalogue.ts');
            const categories = Object.keys(EVENT_TYPES());
            for (const { partition, stored, observed: native } of sample) {
              let from = BigInt(stored.accounts);
              for (const value of Object.values(stored)) {
                if (value !== null && BigInt(value) < from) from = BigInt(value);
              }
              let through = BigInt(native.head);
              for (const value of [native.collection, native.review, native.space]) {
                if (value !== undefined && BigInt(value) > through) through = BigInt(value);
              }
              const result = await client.query(
                `SELECT epoch,position::text AS position,event_seq,event_count,
                          CASE WHEN type=ANY($4::text[]) THEN type ELSE 'other' END AS category
                   FROM core.outbox WHERE partition_no=$1 AND position>$2::bigint AND position<=$3::bigint
                   ORDER BY core.outbox.position,event_seq LIMIT 9`,
                [partition, from.toString(), through.toString(), categories],
              );
              events.push({
                partition,
                fromExclusive: from.toString(),
                through: through.toString(),
                rows: result.rows.slice(0, 8),
                more: result.rows.length > 8,
              });
            }
          }
          return { frontiers: frontiers.rows, events };
        });
      } catch (error) {
        details = { error: discoveryFailureObservation(error) };
      }
      console.info('Mixed Home rejected cuts', JSON.stringify({ prefix, generation, stage, sample, ...details }));
    };
  }
  return {
    observe,
    rejectedCuts,
    start(target: number, operation: string) {
      generation = target;
      enter(operation);
      report();
    },
    step(operation: string, checkedHomes = completedHomes) {
      enter(operation);
      completedHomes = checkedHomes;
      report();
    },
    async read<T>(owner: string, partition: number, homes: number, read: () => Promise<T>) {
      const stats = (native[owner] ??= { calls: 0, homes: 0, settled: 0, totalMs: 0 });
      stats.calls++;
      stats.homes += homes;
      if (stats.calls === 1) report({ reading: owner, partition });
      const start = performance.now();
      try {
        return await read();
      } catch (error) {
        firstFailure ??= { owner, partition };
        throw error;
      } finally {
        stats.settled++;
        stats.totalMs += performance.now() - start;
      }
    },
    report,
  };
}

export type DiscoveryFinalizationTrace = ReturnType<typeof discoveryFinalizationTrace>;
