import type { Pool } from 'pg';

export interface RelayHandoffPosition {
  dataEpoch: string;
  sequence: string;
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
    const result = await this.pool.query<{ data_epoch: string; sequence: string }>(
      'SELECT data_epoch, sequence::text AS sequence FROM relay.checkpoint WHERE consumer = $1',
      [this.consumer]);
    const row = result.rows[0];
    return row ? { dataEpoch: row.data_epoch, sequence: row.sequence } : null;
  }
}
