import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../modules/work/activate.ts';
import { BackpressureSaturated, BackpressureUnavailable, InFlightAdmission,
  type InFlightBudget, type InFlightCounters, type LaneName } from './admission-budget.ts';

export interface DurableBacklogBudget {
  /** Undelivered source positions at which new intents for this lane are refused. */
  maxBacklog: number;
  retryAfterSeconds: number;
}

export interface BackpressureProfile {
  id: string;
  worker: DurableBacklogBudget;
  broker: DurableBacklogBudget;
  object: InFlightBudget;
}

export const BACKPRESSURE_PROFILE_V1: Readonly<BackpressureProfile> = Object.freeze({
  id: 'operations-backpressure-v1',
  worker: { maxBacklog: 1000, retryAfterSeconds: 5 },
  broker: { maxBacklog: 1000, retryAfterSeconds: 5 },
  object: { maxInFlight: 8, maxBytes: 8 * 1_048_576, retryAfterSeconds: 2 },
});

/** One durable source position and the consumer's acknowledged position. */
export interface DurablePositions {
  dataEpoch: string;
  head: bigint;
  delivered: bigint;
}

export interface BackpressureSources {
  /** Content outbox head and the Content projection worker checkpoint. */
  worker?: () => Promise<DurablePositions>;
  /** Main graph outbox high water and the relay handoff checkpoint. */
  broker?: () => Promise<DurablePositions>;
  /** Immutable object uploads admitted by this process. */
  object?: boolean;
}

export type LaneState = 'open' | 'saturated' | 'unavailable' | 'unobserved';

export interface DurableLaneSnapshot {
  lane: 'worker' | 'broker';
  state: LaneState;
  maxBacklog: number;
  dataEpoch: string | null;
  head: string | null;
  delivered: string | null;
  backlog: string | null;
}

export interface ObjectLaneSnapshot {
  lane: 'object';
  state: Exclude<LaneState, 'unavailable'>;
  maxInFlight: number;
  maxBytes: number;
  counters: InFlightCounters | null;
}

export interface BackpressureSnapshot {
  profile: string;
  complete: boolean;
  lanes: [DurableLaneSnapshot, DurableLaneSnapshot, ObjectLaneSnapshot];
}

const decimal = /^(0|[1-9][0-9]*)$/;

function position(value: string | undefined, name: string): bigint {
  if (!value || !decimal.test(value)) throw new Error(`${name} position is invalid`);
  return BigInt(value);
}

/** Content: two indexed singleton reads, independent of outbox length. */
export function contentProjectionPositions(
  content: { ownerPosition(): Promise<{ dataEpoch: string; sequence: string }> },
  cursor: { read(consumer: string): Promise<{ dataEpoch: string; sequence: string }> },
  consumer: string,
): () => Promise<DurablePositions> {
  return async () => {
    const [owner, checkpoint] = await Promise.all([content.ownerPosition(), cursor.read(consumer)]);
    if (owner.dataEpoch !== checkpoint.dataEpoch) throw new Error('Content projection epoch differs');
    return { dataEpoch: owner.dataEpoch, head: position(owner.sequence, 'Content owner'),
      delivered: position(checkpoint.sequence, 'Content projection') };
  };
}

/** Graph control high water (one bound SPARQL lookup) against the relay
 * checkpoint (one primary-key read). A held or foreign epoch is unavailable. */
export function relayHandoffPositions(fuseki: FusekiClient, dataEpoch: string,
  readCheckpoint: () => Promise<{ dataEpoch: string; sequence: string } | null>,
): () => Promise<DurablePositions> {
  return async () => {
    const [control, checkpoint] = await Promise.all([fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?sequence ?hold WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(dataEpoch)} ;
          rv:sequence ?sequence . }
        OPTIONAL { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold ?hold } }
      } LIMIT 2`), readCheckpoint()]);
    const rows = control.results?.bindings ?? [];
    if (rows.length !== 1 || rows[0]?.hold?.value === 'true') {
      throw new Error('graph outbox source is held or ambiguous');
    }
    if (!checkpoint || checkpoint.dataEpoch !== dataEpoch) {
      throw new Error('relay checkpoint epoch differs');
    }
    return { dataEpoch, head: position(rows[0]?.sequence?.value, 'graph outbox'),
      delivered: position(checkpoint.sequence, 'relay checkpoint') };
  };
}

/**
 * Lane budgets for OPS06. Durable lanes read positions, not rows, so a
 * snapshot costs a fixed four owner calls whatever the backlog; the object lane
 * is process-local. New intents are refused at the Main boundary before any
 * owner effect; admitted outbox records remain until their consumer
 * acknowledges them, so saturation never drops work.
 */
export class OperationsBackpressure {
  readonly objects: InFlightAdmission | undefined;

  constructor(private readonly sources: BackpressureSources,
    readonly profile: BackpressureProfile = BACKPRESSURE_PROFILE_V1) {
    if (!/^[a-z][a-z0-9-]{0,62}-v[1-9][0-9]*$/.test(profile.id)) {
      throw new Error('backpressure profile identity is invalid');
    }
    for (const lane of ['worker', 'broker'] as const) {
      const budget = profile[lane];
      if (!Number.isSafeInteger(budget.maxBacklog) || budget.maxBacklog < 1
        || !Number.isSafeInteger(budget.retryAfterSeconds) || budget.retryAfterSeconds < 1) {
        throw new Error(`${lane} backlog budget is invalid`);
      }
    }
    this.objects = sources.object ? new InFlightAdmission('object', profile.object) : undefined;
  }

  private async durable(lane: 'worker' | 'broker'): Promise<DurableLaneSnapshot> {
    const maxBacklog = this.profile[lane].maxBacklog;
    const empty = { lane, maxBacklog, dataEpoch: null, head: null, delivered: null, backlog: null };
    const probe = this.sources[lane];
    if (!probe) return { ...empty, state: 'unobserved' };
    let positions: DurablePositions;
    try { positions = await probe(); }
    catch { return { ...empty, state: 'unavailable' }; }
    // A checkpoint ahead of its source is a gap, never negative backlog.
    if (positions.delivered > positions.head) return { ...empty, state: 'unavailable' };
    const backlog = positions.head - positions.delivered;
    return { lane, maxBacklog, state: backlog >= BigInt(maxBacklog) ? 'saturated' : 'open',
      dataEpoch: positions.dataEpoch, head: positions.head.toString(),
      delivered: positions.delivered.toString(), backlog: backlog.toString() };
  }

  private object(): ObjectLaneSnapshot {
    const { maxInFlight, maxBytes } = this.profile.object;
    if (!this.objects) return { lane: 'object', state: 'unobserved', maxInFlight, maxBytes, counters: null };
    return { lane: 'object', state: this.objects.saturated() ? 'saturated' : 'open',
      maxInFlight, maxBytes, counters: this.objects.counters() };
  }

  async read(): Promise<BackpressureSnapshot> {
    const [worker, broker] = await Promise.all([this.durable('worker'), this.durable('broker')]);
    const object = this.object();
    return { profile: this.profile.id,
      complete: [worker, broker, object].every(lane => lane.state === 'open' || lane.state === 'saturated'),
      lanes: [worker, broker, object] };
  }

  /** Refuse a new intent that would append to a saturated or unprovable durable lane.
   * An unobserved lane has no configured source in this process and admits. */
  async admitDurable(lane: Extract<LaneName, 'worker' | 'broker'>): Promise<void> {
    const snapshot = await this.durable(lane);
    if (snapshot.state === 'unavailable') throw new BackpressureUnavailable(lane);
    if (snapshot.state === 'saturated') {
      throw new BackpressureSaturated(lane, this.profile[lane].retryAfterSeconds);
    }
  }
}
