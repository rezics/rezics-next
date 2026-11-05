import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';
import { effectWorkflowId, launchWork, registerEffects, relayEffects, shutdownWork } from '../src/events/effects.ts';
import type { CloudEvent } from '../src/events/log.ts';

test('the effects relay releases the supplied runtime pool before the actual SDK enqueues work', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  // The old transactional readBatch monopolizes this pool while SDK enqueue needs its only connection.
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  const seen: CloudEvent[] = [];
  const type = 'com.rezics.subject.created.v1';
  const effects = registerEffects([{ name: 'record', types: [type], run: async (event) => void seen.push(event) }]);
  try {
    // Core fixture only: the same valid native outbox envelope used by effects.test.ts.
    const partition = 3072;
    const subject = crypto.randomUUID();
    const client = await pool.connect();
    let envelope: { epoch: number; position: bigint; partition: number; events: CloudEvent[] };
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ epoch: number; position: string }>(
        'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
        [partition],
      );
      const { epoch, position } = rows[0]!;
      await client.query(
        `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
         VALUES ($1, $2, 0, 1, $3, $4, $5, $6, $7)`,
        [partition, position, epoch, Bun.randomUUIDv7(), type, subject, JSON.stringify({ id: subject })],
      );
      await client.query('COMMIT');
      envelope = { epoch, position: BigInt(position), partition, events: [] };
    } finally {
      client.release();
    }
    await launchWork({ databaseUrl, systemDatabasePool: pool });
    const result = await relayEffects(pool, effects, partition);
    expect(result).toEqual({ status: 'read', envelopes: 1, position: envelope.position });
    const id = effectWorkflowId(envelope, 0, 'record');
    await DBOS.retrieveWorkflow(id).getResult();
    expect(seen).toMatchObject([{ type, subject, data: { id: subject } }]);
    expect(await DBOS.getWorkflowStatus(id)).toMatchObject({ status: 'SUCCESS', workflowName: 'effect' });
  } finally {
    try {
      await shutdownWork();
    } finally {
      await pool.end();
    }
  }
}, 30_000);
