import { afterAll, afterEach, beforeAll, test } from 'bun:test';
import pg from 'pg';
import { runCommand, type CommandAuthorization, type CommandEvent } from '../src/command/command.ts';
import { newId } from '../src/route/route.ts';
import { createPool } from '../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from './support/growth.ts';
import { readPartition } from '../src/partition/partition.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const dbPromise = openGrowthDatabase(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const anchorPartition = 4095;
const anchorRoute = anchorPartition * 16;
const actor = '00000000-0000-7000-8000-000000000001';
const clientId = 'growth-command-client';
const digest = Buffer.alloc(32, 7);
const kind = 'growth-command';
const prefix = 'growth-command-';
const events = (): CommandEvent[] => [{ type: 'com.rezics.growth.event.v1', subject: 'fixed', data: { value: 1 } }];
const basis = { actorAccountId: actor, clientId, requestedBy: null };
const pool = createPool(databaseUrl);
const ordinalsPerScale = 64;

// These rows mirror fence.sql's outbox, receipt and write_basis inserts, using route-shaped UUIDs and one event.
const population: Population = {
  name: 'kernel-command-growth',
  hotPartition: anchorPartition,
  rows: ({ ordinal, route, partition }) => {
    const tx = newId(route);
    return {
      'core.outbox': [
        {
          partition_no: partition,
          position: ordinal + 100,
          event_seq: 0,
          event_count: 1,
          epoch: 1,
          id: newId(route),
          type: 'com.rezics.growth.event.v1',
          subject: 'seeded',
          data: { value: 1 },
        },
      ],
      'editorial.write_basis': [
        {
          partition_no: partition,
          transaction_id: tx,
          epoch: 1,
          position: ordinal + 100,
          actor_account_id: actor,
          client_id: clientId,
          requested_by: null,
        },
      ],
      'core.receipt': [
        {
          partition_no: partition,
          actor_account_id: actor,
          command_kind: kind,
          idempotency_key: `${prefix}seed-${ordinal}`,
          request_digest: digest,
          epoch: 1,
          position: ordinal + 100,
          transaction_id: tx,
          response: { ok: true },
        },
      ],
    };
  },
  finish: async (connection, range) => {
    await connection.query(
      `UPDATE core.partition p SET position = GREATEST(p.position, v.position)
       FROM (SELECT partition_no, max(position)::bigint AS position FROM core.outbox
             WHERE position >= $1 + 100 AND position < $2 + 100 GROUP BY partition_no) v
       WHERE p.partition_no = v.partition_no`,
      [range.from, range.to],
    );
  },
};

let db: GrowthDatabase;
beforeAll(async () => {
  db = await dbPromise;
});
afterEach(async () => {
  await admin.query('DELETE FROM core.receipt WHERE command_kind = $1', [kind]);
  await admin.query('DELETE FROM editorial.write_basis WHERE client_id = $1', [clientId]);
  await admin.query("DELETE FROM core.outbox WHERE type = 'com.rezics.growth.event.v1'");
  await admin.query(`UPDATE core.partition p SET position = COALESCE((
    SELECT max(o.position) FROM core.outbox o WHERE o.partition_no = p.partition_no
  ), 0)`);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
  await db?.pool.end();
  await db?.admin.end();
});

async function reset(): Promise<void> {
  await admin.query('DELETE FROM core.receipt WHERE command_kind = $1', [kind]);
  await admin.query('DELETE FROM editorial.write_basis WHERE client_id = $1', [clientId]);
  await admin.query("DELETE FROM core.outbox WHERE type = 'com.rezics.growth.event.v1'");
  await admin.query(`UPDATE core.partition p SET position = COALESCE((
    SELECT max(o.position) FROM core.outbox o WHERE o.partition_no = p.partition_no
  ), 0)`);
}

async function grow(growthDb: GrowthDatabase, scale: number, previous: number): Promise<void> {
  await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
    from: previous * ordinalsPerScale,
    to: scale * ordinalsPerScale,
  });
}

function check(name: string, operation: Parameters<typeof checkGrowth>[1]['operation']) {
  return checkGrowth(db, {
    name,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow,
    operation,
  });
}

test('New command stays within its bound as N grows', async () => {
  await reset();
  await check('New command', async (_growthDb, scale, repetition) =>
    runCommand(
      pool,
      {
        partition: anchorPartition,
        basis,
        receipt: { actorAccountId: actor, kind, key: `${prefix}new-${scale}-${repetition}`, digest },
      },
      async () => ({ value: { ok: true }, events: events() }),
    ),
  );
}, 90_000);

test('Idempotent replay stays within its bound as N grows', async () => {
  await reset();
  const options = {
    partition: anchorPartition,
    basis,
    receipt: { actorAccountId: actor, kind, key: `${prefix}replay`, digest },
  };
  await runCommand(pool, options, async () => ({ value: { ok: true }, events: events() }));
  await check('Idempotent replay', async () =>
    runCommand(pool, options, async () => {
      throw new Error('replay must skip the command body');
    }),
  );
}, 90_000);

test('Denied replay stays within its bound as N grows', async () => {
  await reset();
  const authorization: CommandAuthorization = {
    action: 'growth.denied',
    resource: { route: anchorRoute, id: newId(anchorRoute) },
    authorize: async () => 'receipt-only',
    denied: () => new Error('denied'),
  };
  await check('Denied replay', async () =>
    runCommand(pool, { partition: anchorPartition, authorization }, async () => {
      throw new Error('denied command must not run');
    }),
  );
}, 90_000);

test('One contention retry stays within its bound as N grows', async () => {
  await reset();
  let injected = false;
  await check('One contention retry', async (_growthDb, scale, repetition) =>
    runCommand(
      pool,
      {
        partition: anchorPartition,
        basis,
        receipt: { actorAccountId: actor, kind, key: `${prefix}retry-${scale}-${repetition}`, digest },
      },
      async () => {
        if (!injected) {
          injected = true;
          throw Object.assign(new Error('injected retry'), { code: '40001' });
        }
        return { value: { ok: true }, events: events() };
      },
    ),
  );
}, 90_000);

test('Partition state stays within its bound as N grows', async () => {
  await reset();
  await check('Partition state', async (growthDb) => {
    const client = await growthDb.pool.connect();
    try {
      return await readPartition(client, anchorPartition);
    } finally {
      client.release();
    }
  });
}, 90_000);
