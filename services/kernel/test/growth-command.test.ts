import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';
import { runCommand, type CommandAuthorization, type CommandEvent } from '../src/command/command.ts';
import { newId } from '../src/route/route.ts';
import {
  capture,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from './support/growth.ts';
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
const ordinalsPerScale = 64;

// This population matches fence.sql's route-shaped UUIDs, one-event outbox rows, and receipt/write-basis values.
const population: Population = {
  name: 'kernel-command-growth',
  hotPartition: anchorPartition,
  rows: ({ ordinal, route, partition }) => {
    const tx = newId(route);
    return {
      'core.outbox': [
        {
          partition_no: partition,
          position: ordinal * 100 + 100,
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
          position: ordinal * 100 + 100,
          principal_id: actor,
          principal_kind: 'account',
          client_id: clientId,
          requested_by: null,
        },
      ],
      'core.receipt': [
        {
          partition_no: partition,
          principal_id: actor,
          principal_kind: 'account',
          command_kind: kind,
          idempotency_key: `${prefix}seed-${ordinal}`,
          request_digest: digest,
          epoch: 1,
          position: ordinal * 100 + 100,
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
             WHERE position >= $1 * 100 + 100 AND position < $2 * 100 + 100 GROUP BY partition_no) v
       WHERE p.partition_no = v.partition_no`,
      [range.from, range.to],
    );
  },
};

let db: GrowthDatabase;
let pool: GrowthDatabase['pool'];
beforeAll(async () => {
  db = await dbPromise;
  pool = db.pool;
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
    from: 4096 + previous * ordinalsPerScale,
    to: 4096 + scale * ordinalsPerScale,
  });
}

async function createAnchorCommand(): Promise<void> {
  await runCommand(
    pool,
    {
      partition: anchorPartition,
      basis,
      receipt: { actorAccountId: actor, kind, key: `${prefix}anchor`, digest },
    },
    async () => ({ value: { ok: true }, events: events() }),
  );
}

function check(name: string, operation: Parameters<typeof checkGrowth>[1]['operation']) {
  return checkGrowth(db, {
    name,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    ...(name === 'New command' ? { rule: 'series' as const } : {}),
    grow,
    operation,
  });
}

function planNodes(plans: readonly unknown[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    nodes.push(node);
    if (Array.isArray(node.Plans)) for (const child of node.Plans) visit(child);
  };
  for (const plan of plans) {
    for (const entry of Array.isArray(plan) ? plan : [plan]) {
      if (entry && typeof entry === 'object' && 'Plan' in entry) visit((entry as { Plan: unknown }).Plan);
    }
  }
  return nodes;
}

test('New command stays within its bound as N grows', async () => {
  await reset();
  await seed({ pool: db.pool, admin }, population, { from: 0, to: 4096 });
  await createAnchorCommand();
  await checkGrowth(db, {
    name: 'New command',
    rule: 'series',
    scales: [1, 8, 64],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    indexProbes: 4,
    grow,
    prepare: async (_growthDb, scale, repetition) => {
      const measured = await capture(db, () =>
        runCommand(
          pool,
          {
            partition: anchorPartition,
            basis,
            receipt: { actorAccountId: actor, kind, key: `${prefix}plan-${scale}-${repetition}`, digest },
          },
          async () => ({ value: { ok: true }, events: events() }),
        ),
      );
      const nodes = planNodes(measured.capture.plans);
      const receiptRead = nodes.find(
        (node) =>
          node['Schema'] === 'core' && node['Relation Name'] === 'receipt' && node['Index Name'] === 'receipt_pkey',
      );
      expect(receiptRead).toBeDefined();
      expect(String(receiptRead?.['Index Cond'] ?? '')).toContain('partition_no');
      expect(String(receiptRead?.['Index Cond'] ?? '')).toContain('idempotency_key');
      const partitionWrite = nodes.find(
        (node) =>
          node['Schema'] === 'core' && node['Relation Name'] === 'partition' && node['Index Name'] === 'partition_pkey',
      );
      expect(partitionWrite).toBeDefined();
      expect(Number(partitionWrite?.['Actual Rows'])).toBe(1);
    },
    operation: async (_growthDb, scale, repetition) =>
      runCommand(
        pool,
        {
          partition: anchorPartition,
          basis,
          receipt: { actorAccountId: actor, kind, key: `${prefix}new-${scale}-${repetition}`, digest },
        },
        async () => ({ value: { ok: true }, events: events() }),
      ),
  });
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
  await createAnchorCommand();
  const denial = new Error('denied');
  const authorization: CommandAuthorization = {
    action: 'growth.denied',
    resource: { route: anchorRoute, id: newId(anchorRoute) },
    authorize: async () => 'receipt-only',
    denied: () => denial,
  };
  await check('Denied replay', async (_growthDb, scale, repetition) => {
    try {
      await runCommand(
        pool,
        {
          partition: anchorPartition,
          basis,
          receipt: {
            actorAccountId: actor,
            kind,
            key: `${prefix}denied-miss-${scale}-${repetition}`,
            digest,
          },
          authorization,
        },
        async () => {
          throw new Error('denied command must not run');
        },
      );
    } catch (error) {
      if (error === denial) return;
      throw error;
    }
    throw new Error('denied replay unexpectedly succeeded');
  });
}, 90_000);

test('One contention retry stays within its bound as N grows', async () => {
  await reset();
  await createAnchorCommand();
  await check('One contention retry', async (_growthDb, scale, repetition) => {
    let injected = false;
    return runCommand(
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
    );
  });
}, 90_000);

test('Concurrent commands in one partition stay within their bound as concurrency grows', async () => {
  await reset();
  await checkGrowth(db, {
    name: 'Concurrent commands in one partition stay within their bound as concurrency grows',
    scales: [2, 8, 32],
    bounds: { rows: 'linear', blocks: 'linear', statements: 'linear' },
    grow,
    operation: async (_growthDb, scale, repetition) => {
      let serializableBegins = 0;
      const restorations = new Map<
        PoolClient,
        { descriptor: PropertyDescriptor | undefined; wrapped: PoolClient['query'] }
      >();
      const observe = (client: PoolClient) => {
        if (restorations.has(client)) return;
        const descriptor = Object.getOwnPropertyDescriptor(client, 'query');
        const query = client.query.bind(client);
        const wrapped = ((...args: Parameters<PoolClient['query']>) => {
          if (/^BEGIN ISOLATION LEVEL SERIALIZABLE/i.test(String(args[0]))) serializableBegins++;
          return query(...args);
        }) as PoolClient['query'];
        client.query = wrapped;
        restorations.set(client, { descriptor, wrapped });
      };
      pool.on('acquire', observe);
      try {
        const results = await Promise.all(
          Array.from({ length: scale }, (_, n) =>
            runCommand(
              pool,
              {
                partition: anchorPartition,
                deadline: Date.now() + 60_000,
                basis,
                receipt: {
                  actorAccountId: actor,
                  kind,
                  key: `${prefix}concurrent-${scale}-${repetition}-${n}`,
                  digest,
                },
              },
              async () => ({ value: { ok: true }, events: events() }),
            ),
          ),
        );
        expect(results).toHaveLength(scale);
        expect(results.every((result) => !result.replayed)).toBe(true);
        expect(new Set(results.map((result) => result.position)).size).toBe(scale);
        expect(serializableBegins).toBe(scale);
      } finally {
        pool.removeListener('acquire', observe);
        for (const [client, { descriptor, wrapped }] of restorations) {
          if (client.query !== wrapped) continue;
          if (descriptor) Object.defineProperty(client, 'query', descriptor);
          else Reflect.deleteProperty(client, 'query');
        }
      }
    },
  });
}, 90_000);

test('Partition state stays within its bound as N grows', async () => {
  await reset();
  await createAnchorCommand();
  await check('Partition state', async (growthDb) => {
    const client = await growthDb.pool.connect();
    try {
      return await readPartition(client, anchorPartition);
    } finally {
      client.release();
    }
  });
}, 90_000);
