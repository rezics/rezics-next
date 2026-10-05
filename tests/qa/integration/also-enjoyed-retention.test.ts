import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { automaticCoReaders } from '../../../services/main/src/modules/also-enjoyed/automation.ts';
import { AlsoEnjoyedStore, ALSO_ENJOYED_COST } from '../../../services/main/src/modules/also-enjoyed/store.ts';
import { cloneOwners, requireQa } from './recommendation-support.ts';

test('co-reader retention purges expired, cancelled and failed rows in bounded resumable batches', async () => {
  const owners = await cloneOwners(requireQa(), ['access', 'content']);
  const access = new Pool({ connectionString: owners.urls.access });
  const content = new Pool({ connectionString: owners.urls.content });
  let now = Date.now();
  const store = new AlsoEnjoyedStore(access, content, () => now);
  const position = { dataEpoch: 'co-reader-retention', sequence: '0' };
  const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: 'd'.repeat(64) });
  try {
    await migrateContent(content);
    const stage = async (rows = 3, key = receipt()) => {
      const { generation } = await store.register(automaticCoReaders, position, key);
      await access.query(`INSERT INTO access.also_enjoyed_signal
        (generation_id,reader_agent,work,source_eligible,candidate_eligible)
        SELECT $1,'reader-'||n,'source',true,true FROM generate_series(1,$2::integer) n`, [generation, rows]);
      await access.query(`INSERT INTO access.also_enjoyed_pair
        (generation_id,source_work,candidate_work,shared_readers,candidate_readers,score)
        SELECT $1,'source','candidate-'||n,1,1,1 FROM generate_series(1,$2::integer) n`, [generation, rows]);
      return generation;
    };
    const ready = async (generation: string) => {
      await access.query(`UPDATE access.also_enjoyed_generation SET phase='complete'
        WHERE generation_id=$1`, [generation]);
      await access.query(`UPDATE access.derived_generation_input SET snapshot_complete=true
        WHERE generation_id=$1`, [generation]);
      await access.query(`UPDATE access.derived_generation SET state='ready',lease_expires_at=NULL,
        ready_at=clock_timestamp(),validation_digest=$2 WHERE id=$1`, [generation, 'e'.repeat(64)]);
    };
    const terminate = (generation: string, state: 'cancelled' | 'failed') => access.query(`
      UPDATE access.derived_generation SET state=$2,lease_expires_at=NULL,
        finished_at=clock_timestamp(),failure_reason='interrupted' WHERE id=$1`, [generation, state]);
    const counts = async (generation: string) => (await access.query<{ signals: number; pairs: number }>(`
      SELECT (SELECT count(*)::integer FROM access.also_enjoyed_signal WHERE generation_id=$1) AS signals,
        (SELECT count(*)::integer FROM access.also_enjoyed_pair WHERE generation_id=$1) AS pairs`, [generation])).rows[0]!;

    const firstKey = receipt();
    const expired = await stage(ALSO_ENJOYED_COST.purgeRows + 1, firstKey);
    const retained = [await stage(), await stage(), await stage()];
    let revision: string | null = null;
    for (const generation of [expired, ...retained]) {
      await ready(generation);
      const activated = await store.activate(automaticCoReaders, generation, revision, receipt(), position);
      expect(activated.outcome).toBe('succeeded');
      revision = activated.headRevision;
    }
    expect((await store.generation(expired)).state).toBe('expired');
    const cancelled = await stage(ALSO_ENJOYED_COST.purgeRows + 1);
    const failed = await stage(ALSO_ENJOYED_COST.purgeRows + 1);
    await terminate(cancelled, 'cancelled');
    await terminate(failed, 'failed');
    const recent = await stage();
    await terminate(recent, 'cancelled');
    const building = await stage(), unactivated = await stage();
    await ready(unactivated);

    now = Date.now();
    const retention = Number((await access.query<{ ms: string }>(`SELECT
      (extract(epoch FROM retain_for)*1000)::text AS ms FROM access.derived_generation_family
      WHERE family='also-enjoyed'`)).rows[0]!.ms);
    const terminal = [expired, cancelled, failed];
    // Deterministic finish order, with even the oldest one still inside retention.
    for (const [index, generation] of [...terminal, ...retained.slice(0, 2)].entries()) {
      await access.query('UPDATE access.derived_generation SET finished_at=$2 WHERE id=$1',
        [generation, new Date(now - retention + index + 1)]);
    }
    expect(await store.purge()).toBe(0);
    now += terminal.length;
    for (const generation of terminal) {
      expect(await store.purge()).toBe(2 * ALSO_ENJOYED_COST.purgeRows);
      expect(await counts(generation)).toEqual({ signals: 1, pairs: 1 });
      expect((await access.query('SELECT 1 FROM access.also_enjoyed_generation WHERE generation_id=$1',
        [generation])).rows).toHaveLength(1);
      // A new store resumes the durable partial purge after an interruption.
      expect(await new AlsoEnjoyedStore(access, content, () => now).purge()).toBe(2);
      expect(await counts(generation)).toEqual({ signals: 0, pairs: 0 });
      expect((await access.query('SELECT 1 FROM access.also_enjoyed_generation WHERE generation_id=$1',
        [generation])).rows).toHaveLength(0);
    }
    now += 10;
    expect(await store.purge()).toBe(0);
    for (const generation of [...retained, recent, building, unactivated]) {
      expect(await counts(generation)).toEqual({ signals: 3, pairs: 3 });
    }
    // Immutable receipts/head history remain replayable after bulky data leaves.
    expect(await store.register(automaticCoReaders, position, firstKey)).toEqual({ generation: expired, replayed: true });
    expect((await access.query(`SELECT active_generation FROM access.derived_generation_head
      WHERE family='also-enjoyed'`)).rows[0]!.active_generation).toBe(retained.at(-1));
  } finally { await access.end(); await content.end(); await owners.close(); }
}, 240_000);
