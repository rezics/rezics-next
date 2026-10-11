import type { Pool } from 'pg';
import type { ContentCore, ContentPosition } from '../../../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../../../content/src/projection-cursor.ts';
import { MAIN_RELAY_STREAM_SCOPE, RelayHandoffPositions } from '../outbox/relay-position.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../outbox/relay.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { deliverRetainedContentEligibilityOnce } from './eligibility-delivery.ts';
import { ContentRebuildUnavailable, readContentRebuildStep } from './rebuild.ts';
import { assertFrozenContentRebuildAuthority } from './rebuild-authority.ts';

/** Existing job progress retains the Main frontier before delivery, then C.
 * The Content delivery cursor owns ingestion acknowledgement, including a
 * lost response; this record never substitutes for that owner checkpoint. */
export interface ContentRebuildFrontier {
  dataEpoch: string;
  routingEpoch: string;
  graphSequence: string;
  mainSequence: string;
  cut?: ContentPosition;
}

export interface ContentRebuildDelivery {
  relayPosition(): Promise<string>;
  relayOnce(): Promise<string | null>;
  deliveryPosition(): Promise<string>;
  deliverOnce(throughSequence: string): Promise<string | null>;
}

/** Use the same retained relay and Content ingestion owners as the body worker. */
export function contentRebuildDelivery(env: WorkActivationEnvironment,
  content: ContentCore, pool: Pool, consumer: string): ContentRebuildDelivery {
  const positions = new RelayHandoffPositions(pool, consumer);
  return {
    relayPosition: async () => {
      await initializeRelayCheckpoint(pool, consumer, env.lineage.dataEpoch);
      const at = await positions.read();
      if (!at || at.streamScope !== MAIN_RELAY_STREAM_SCOPE || at.dataEpoch !== env.lineage.dataEpoch) {
        throw new ContentRebuildUnavailable('preflight: Main relay lineage differs');
      }
      return at.sequence;
    },
    relayOnce: async () => (await relayMainOutboxOnce(env.fuseki, pool, consumer,
      { ownerOutbox: env.receiptCustody }))?.sequence ?? null,
    deliveryPosition: async () => (await content.readEligibilityDeliveryProgress(
      MAIN_RELAY_STREAM_SCOPE, env.lineage.dataEpoch)).sequence,
    deliverOnce: async through => (await deliverRetainedContentEligibilityOnce(
      env, content, pool, consumer, through))?.sequence ?? null,
  };
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** Ordinary owner preparation has the repository's 600-second ceiling. */
export const CONTENT_REBUILD_PREPARATION_BUDGET_MS = 600_000;

export function validateContentRebuildFrontier(frontier: ContentRebuildFrontier): void {
  if (!frontier || !UUID.test(frontier.dataEpoch) || !UUID.test(frontier.routingEpoch)
    || !DECIMAL.test(frontier.graphSequence) || !DECIMAL.test(frontier.mainSequence)
    || (frontier.cut && (frontier.cut.owner !== 'content' || !UUID.test(frontier.cut.dataEpoch)
      || !DECIMAL.test(frontier.cut.sequence)))) {
    throw new ContentRebuildUnavailable('preflight: saved frontier is invalid');
  }
}

/** Parked live rows are reconciled only after verified activation. Preflight
 * proves both consumers belong to C without completing or deleting any row. */
export async function assertContentRebuildConsumers(cursor: ContentProjectionCursor,
  publicConsumer: string, rebuildConsumer: string, cut: ContentPosition): Promise<void> {
  for (const consumer of [publicConsumer, rebuildConsumer]) {
    const completed = await cursor.initialize(consumer);
    const scanned = await cursor.readScan(consumer);
    if (completed.dataEpoch !== cut.dataEpoch || scanned.dataEpoch !== cut.dataEpoch
      || !DECIMAL.test(completed.sequence) || !DECIMAL.test(scanned.sequence)
      || BigInt(completed.sequence) > BigInt(scanned.sequence)
      || BigInt(scanned.sequence) > BigInt(cut.sequence)) {
      throw new ContentRebuildUnavailable('preflight: projection consumer differs from frozen Content cut');
    }
  }
}

async function capture(env: WorkActivationEnvironment): Promise<ContentRebuildFrontier> {
  const result = await readContentRebuildStep('preflight: Main frontier', () => env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?routing ?sequence ?mainSequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
        rv:routingEpoch ?routing ; rv:sequence ?sequence .
        ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:streamSequence ?mainSequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    } LIMIT 2`));
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  const frontier = { dataEpoch: row?.epoch?.value ?? '', routingEpoch: row?.routing?.value ?? '',
    graphSequence: row?.sequence?.value ?? '', mainSequence: row?.mainSequence?.value ?? '' };
  validateContentRebuildFrontier(frontier);
  if (rows.length !== 1 || frontier.dataEpoch !== env.lineage.dataEpoch
    || frontier.routingEpoch !== env.lineage.routingEpoch) {
    throw new ContentRebuildUnavailable('preflight: Main frontier lineage differs');
  }
  return frontier;
}

export async function prepareContentRebuild(input: {
  env: WorkActivationEnvironment;
  content: ContentCore;
  delivery: ContentRebuildDelivery;
  frontier?: ContentRebuildFrontier;
  remember(frontier: ContentRebuildFrontier): void;
  assertWritersStopped(): Promise<void>;
  /** Test clock; production always uses the fixed preparation ceiling. */
  now?: () => number;
}): Promise<ContentRebuildFrontier & { cut: ContentPosition }> {
  const now = input.now ?? (() => performance.now());
  const deadline = now() + CONTENT_REBUILD_PREPARATION_BUDGET_MS;
  const checkBudget = () => {
    if (now() >= deadline) throw new ContentRebuildUnavailable('preflight: preparation budget exceeded');
  };
  const step = async <T>(run: () => Promise<T>): Promise<T> => {
    checkBudget();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([run(), new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ContentRebuildUnavailable(
          'preflight: preparation budget exceeded')), Math.max(1, deadline - now()));
      })]);
      checkBudget();
      return result;
    } finally { clearTimeout(timeout); }
  };
  await step(input.assertWritersStopped);
  const frontier = input.frontier ?? await step(() => capture(input.env));
  validateContentRebuildFrontier(frontier);
  if (!input.frontier) input.remember(frontier);
  if (frontier.dataEpoch !== input.env.lineage.dataEpoch
    || frontier.routingEpoch !== input.env.lineage.routingEpoch) {
    throw new ContentRebuildUnavailable('preflight: saved frontier lineage differs');
  }
  await step(() => assertFrozenContentRebuildAuthority(input.env, frontier, frontier.cut));
  if (frontier.cut) {
    const owner = await step(() => input.content.ownerPosition());
    if (owner.dataEpoch !== frontier.cut.dataEpoch || owner.sequence !== frontier.cut.sequence
      || await step(() => input.content.hasUnsequencedEvents())) {
      throw new ContentRebuildUnavailable('preflight: Content moved beyond frozen cut');
    }
    // Do not call either delivery owner once C exists, even on recovery.
    return { ...frontier, cut: frontier.cut };
  }
  for (const [position, advance] of [
    [() => input.delivery.relayPosition(), () => input.delivery.relayOnce()],
    [() => input.delivery.deliveryPosition(), () => input.delivery.deliverOnce(frontier.mainSequence)],
  ] as const) {
    let at = await step(position);
    while (at !== frontier.mainSequence) {
      if (!DECIMAL.test(at) || BigInt(at) > BigInt(frontier.mainSequence)) {
        throw new ContentRebuildUnavailable('preflight: delivery exceeds frozen Main frontier');
      }
      const next = await step(advance);
      if (next === null || !DECIMAL.test(next) || BigInt(next) <= BigInt(at)
        || BigInt(next) > BigInt(frontier.mainSequence)) {
        throw new ContentRebuildUnavailable('preflight: delivery ended before frozen Main frontier');
      }
      at = next;
    }
  }
  await step(() => input.content.sequencePending());
  if (await step(() => input.content.hasUnsequencedEvents())) {
    throw new ContentRebuildUnavailable('preflight: committed Content events remain unsequenced');
  }
  const cut = await step(() => input.content.ownerPosition());
  await step(input.assertWritersStopped);
  await step(() => assertFrozenContentRebuildAuthority(input.env, frontier));
  const frozen = { ...frontier, cut };
  validateContentRebuildFrontier(frozen);
  input.remember(frozen);
  return frozen;
}
