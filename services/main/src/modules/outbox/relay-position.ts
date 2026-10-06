import type { Pool } from 'pg';
export const MAIN_RELAY_STREAM_SCOPE = 'urn:rezics:stream:main-rdf';

export interface RelayHandoffPosition {
  streamScope: string;
  dataEpoch: string;
  sequence: string;
}

/** A sequence has meaning only inside one stream and recovery epoch. */
export function compareRelayPositions(left: RelayHandoffPosition, right: RelayHandoffPosition): number {
  if (left.streamScope !== right.streamScope || left.dataEpoch !== right.dataEpoch) {
    throw new Error('relay positions belong to different streams or epochs');
  }
  if (![left.sequence, right.sequence].every(value => /^(0|[1-9][0-9]{0,99})$/.test(value))) {
    throw new Error('invalid relay position');
  }
  return BigInt(left.sequence) < BigInt(right.sequence) ? -1 : BigInt(left.sequence) > BigInt(right.sequence) ? 1 : 0;
}

/**
 * Read-only view of the Main outbox relay's acknowledged handoff position for
 * one consumer: a single primary-key read, independent of retained batches.
 * The relay alone advances the checkpoint; Main only observes it (OPS06).
 */
export class RelayHandoffPositions {
  constructor(private readonly pool: Pick<Pool, 'query'>, readonly consumer: string) {
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(consumer)) throw new Error('invalid relay consumer');
  }

  async read(): Promise<RelayHandoffPosition | null> {
    const result = await this.pool.query<{ stream_scope: string; data_epoch: string; sequence: string }>(
      'SELECT stream_scope, data_epoch, sequence::text AS sequence FROM relay.checkpoint WHERE consumer = $1',
      [this.consumer]);
    const row = result.rows[0];
    return row ? { streamScope: row.stream_scope, dataEpoch: row.data_epoch, sequence: row.sequence } : null;
  }
}
