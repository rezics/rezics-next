import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import type { PoolClient } from 'pg';
import {
  CommandUnavailableError,
  noEffect,
  runCommand,
  type CommandAuthorization,
  type CommandEvent,
} from '../src/command/command.ts';
import { newId } from '../src/route/route.ts';
import {
  capture,
  checkGrowth,
  costOf,
  GrowthBoundError,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const anchorPartition = 3071;
const anchorRoute = anchorPartition * 16;
const actor = '00000000-0000-7000-8000-000000000001';
const prefix = `growth-command-wait-${Bun.randomUUIDv7()}-`;
const kind = `${prefix}command`;
const clientId = `${prefix}client`;
const eventType = 'com.rezics.growth.event.v1';
const digest = Buffer.alloc(32, 7);
const positionBase = 1_000_000_000;
const ordinalsPerScale = 1024;
const scales = [2, 8, 32] as const;
const basis = { actorAccountId: actor, clientId, requestedBy: null };
const event = (): CommandEvent[] => [{ type: eventType, subject: `${prefix}command`, data: { value: 1 } }];
const commandPopulation: Population = {
  name: prefix,
  hotPartition: anchorPartition,
  rows: ({ ordinal, route, partition }) => {
    const transactionId = newId(route);
    const position = positionBase + ordinal * 100 + 100;
    return {
      'core.outbox': [
        {
          partition_no: partition,
          position,
          event_seq: 0,
          event_count: 1,
          epoch: 1,
          id: newId(route),
          type: eventType,
          subject: `${prefix}seed`,
          data: { value: 1 },
        },
      ],
      'editorial.write_basis': [
        {
          partition_no: partition,
          transaction_id: transactionId,
          epoch: 1,
          position,
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
          position,
          transaction_id: transactionId,
          response: { ok: true },
        },
      ],
    };
  },
  finish: async (admin, range) => {
    await admin.query(
      `UPDATE core.partition p SET position = GREATEST(p.position, v.position)
       FROM (
         SELECT partition_no, max(position)::bigint AS position
         FROM core.outbox
         WHERE position >= $1::bigint + $2 * 100 + 100
           AND position < $1::bigint + $3 * 100 + 100
         GROUP BY partition_no
       ) v
       WHERE p.partition_no = v.partition_no`,
      [positionBase, range.from, range.to],
    );
  },
};

// Each first scale has 2,048 representative rows per seeded relation: about half in the target partition and half
// spread across other partitions. The operation keeps one receipt key (or no receipt) and one event fixed.

let db: GrowthDatabase;
const dbPromise = openGrowthDatabase(databaseUrl);

beforeAll(async () => {
  db = await dbPromise;
});

afterEach(async () => {
  await reset();
});

afterAll(async () => {
  await db?.close();
});

async function reset(): Promise<void> {
  if (!db) return;
  await db.admin.query('DELETE FROM core.receipt WHERE command_kind = $1', [kind]);
  await db.admin.query('DELETE FROM editorial.write_basis WHERE client_id = $1', [clientId]);
  await db.admin.query(
    `DELETE FROM core.outbox WHERE type = $1 AND position >= $2::bigint AND position < $2::bigint + 4000000`,
    [eventType, positionBase],
  );
  await db.admin.query(`
    UPDATE core.partition p SET position = COALESCE((
      SELECT max(o.position) FROM core.outbox o WHERE o.partition_no = p.partition_no
    ), 0)
  `);
  await db.admin.query(`UPDATE core.partition SET write_state = 'active', moved_to = NULL WHERE partition_no = $1`, [
    anchorPartition,
  ]);
}

async function grow(growthDb: GrowthDatabase, scale: number, previous: number): Promise<void> {
  await seed({ pool: growthDb.pool, admin: growthDb.admin }, commandPopulation, {
    from: previous * ordinalsPerScale,
    to: scale * ordinalsPerScale,
  });
}

type Operation = Parameters<typeof checkGrowth>[1]['operation'];

type TraceEntry = { statements: Set<string>; plans: unknown[] };
type TraceContext = { scale: number; entry: TraceEntry } | undefined;
let activeTrace: TraceContext;

function sqlText(query: unknown): string | undefined {
  if (typeof query === 'string') return query;
  if (typeof query !== 'object' || query === null || !('text' in query)) return undefined;
  return typeof query.text === 'string' ? query.text : undefined;
}

function tracePlan(message: string): unknown | undefined {
  const marker = 'plan:\n';
  const offset = message.indexOf(marker);
  if (!message.startsWith('duration:') || offset < 0) return undefined;
  try {
    return JSON.parse(message.slice(offset + marker.length));
  } catch {
    return undefined;
  }
}

async function checkedGrowth(name: string, operation: Operation): Promise<void> {
  const entries = new Map<number, TraceEntry>();
  const operationCalls = new Map<number, number>();
  const clients = new Map<
    PoolClient,
    {
      descriptor: PropertyDescriptor | undefined;
      notice: (value: { message: string | undefined }) => void;
    }
  >();
  const observe = (client: PoolClient) => {
    if (clients.has(client)) return;
    const descriptor = Object.getOwnPropertyDescriptor(client, 'query');
    const query = client.query.bind(client);
    client.query = ((...args: Parameters<PoolClient['query']>) => {
      const text = sqlText(args[0]);
      if (activeTrace && text !== undefined) activeTrace.entry.statements.add(text);
      return query(...args);
    }) as PoolClient['query'];
    const notice = (value: { message: string | undefined }) => {
      const plan = typeof value.message === 'string' ? tracePlan(value.message) : undefined;
      if (activeTrace && plan !== undefined) activeTrace.entry.plans.push(plan);
    };
    client.on('notice', notice);
    clients.set(client, { descriptor, notice });
  };
  db.pool.on('acquire', observe);

  try {
    const report = await checkGrowth(db, {
      name,
      scales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow,
      operation: async (growthDb, scale, repetition) => {
        const calls = operationCalls.get(scale) ?? 0;
        operationCalls.set(scale, calls + 1);
        // checkGrowth calls operation once for the warm-up; retain the first explained run at each scale.
        const entry = entries.get(scale) ?? { statements: new Set<string>(), plans: [] };
        entries.set(scale, entry);
        activeTrace = calls === 1 ? { scale, entry } : undefined;
        try {
          return await operation(growthDb, scale, repetition);
        } finally {
          activeTrace = undefined;
        }
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  } catch (error) {
    if (error instanceof GrowthBoundError) {
      console.info(
        `${name} growth evidence (series, SQL and plans):\n${JSON.stringify(
          {
            samples: error.samples,
            statements: [...entries].map(([scale, entry]) => ({ scale, sql: [...entry.statements] })),
            plans: [...entries].map(([scale, entry]) => ({ scale, plans: entry.plans })),
          },
          null,
          2,
        )}`,
      );
    }
    throw error;
  } finally {
    db.pool.off('acquire', observe);
    for (const [client, saved] of clients) {
      client.off('notice', saved.notice);
      if (saved.descriptor) Object.defineProperty(client, 'query', saved.descriptor);
      else delete (client as unknown as { query?: PoolClient['query'] }).query;
    }
  }
}

function authorization(phases: { prepared: number; authorized: number; finalized: number }): CommandAuthorization {
  return {
    action: 'command:write',
    resource: { route: anchorRoute, id: newId(anchorRoute) },
    prepare: async () => {
      phases.prepared++;
      return null;
    },
    authorize: async () => {
      phases.authorized++;
      return 'execute';
    },
    finalize: async () => {
      phases.finalized++;
    },
    denied: () => new Error('The growth command was denied'),
  };
}

test('No-effect command stays within its bound as receipt and partition history grows', async () => {
  await reset();
  const phases = { prepared: 0, authorized: 0, finalized: 0 };
  const auth = authorization(phases);
  let bodies = 0;

  await checkedGrowth('No-effect command', async (_growthDb, scale, repetition) => {
    const withReceipt = await runCommand(
      db.pool,
      {
        partition: anchorPartition,
        basis,
        authorization: auth,
        receipt: {
          actorAccountId: actor,
          kind,
          key: `${prefix}no-effect-${scale}-${repetition}`,
          digest,
        },
      },
      async () => {
        bodies++;
        return noEffect({ ok: true });
      },
    );
    const withoutReceipt = await runCommand(
      db.pool,
      { partition: anchorPartition, basis, authorization: auth },
      async () => {
        bodies++;
        return noEffect({ ok: true });
      },
    );
    expect(withReceipt.replayed).toBe(false);
    expect(withoutReceipt.replayed).toBe(false);
  });

  expect(phases).toEqual({ prepared: 36, authorized: 36, finalized: 36 });
  expect(bodies).toBe(36);
}, 180_000);

async function observePartitionReads<T>(
  onRead: (count: number) => Promise<void> | void,
  operation: () => Promise<T>,
): Promise<{ value: T; reads: number }> {
  let reads = 0;
  const clients = new Map<PoolClient, PropertyDescriptor | undefined>();
  const observe = (client: PoolClient) => {
    if (clients.has(client)) return;
    const descriptor = Object.getOwnPropertyDescriptor(client, 'query');
    const query = client.query.bind(client);
    client.query = (async (...args: Parameters<PoolClient['query']>) => {
      const text = sqlText(args[0]);
      const result = await query(...args);
      if (text && /\bFROM\s+core\.partition\b[\s\S]*?\bWHERE\s+(?:core\.)?partition_no\s*=/i.test(text)) {
        reads++;
        await onRead(reads);
      }
      return result;
    }) as PoolClient['query'];
    clients.set(client, descriptor);
  };
  db.pool.on('acquire', observe);
  try {
    return { value: await operation(), reads };
  } finally {
    db.pool.off('acquire', observe);
    for (const [client, descriptor] of clients) {
      if (descriptor) Object.defineProperty(client, 'query', descriptor);
      else delete (client as unknown as { query?: PoolClient['query'] }).query;
    }
  }
}

async function setPartitionState(writeState: 'active' | 'fenced'): Promise<void> {
  await db.admin.query('UPDATE core.partition SET write_state = $1, moved_to = NULL WHERE partition_no = $2', [
    writeState,
    anchorPartition,
  ]);
}

async function partitionSnapshot() {
  const result = await db.admin.query(
    'SELECT to_jsonb(p)::text AS state FROM core.partition p WHERE partition_no = $1',
    [anchorPartition],
  );
  return result.rows;
}

async function waitingCommand(scale: number, repetition: number, auth: CommandAuthorization, deadline?: number) {
  return runCommand(
    db.pool,
    {
      partition: anchorPartition,
      basis,
      authorization: auth,
      receipt: { actorAccountId: actor, kind, key: `${prefix}wait-${scale}-${repetition}`, digest },
      ...(deadline === undefined ? {} : { deadline }),
    },
    async () => ({ value: { ok: true }, events: event() }),
  );
}

test('Write wait probe stays within its bound as partition and receipt history grows', async () => {
  await reset();

  const releasePhases = { prepared: 0, authorized: 0, finalized: 0 };
  const releaseAuth = authorization(releasePhases);
  const fencedProbesBeforeRelease = 2;
  // One boundedRead poll is BEGIN, SET LOCAL timeout, the partition primary-key read (one row), and COMMIT:
  // four SQL statements, of which one application statement is counted by the harness. It has constant rows and
  // logarithmic blocks. At a 25 ms poll interval, a deadline D permits at most ceil(D / 25 ms) probes, so the wait
  // contribution is one counted statement and one row per probe; D is an independent term, not a history scale.
  // The release branch fixes that contribution at three probes.
  await checkedGrowth('Write wait release', async (_growthDb, scale, repetition) => {
    await setPartitionState('fenced');
    let released = false;
    const observed = await observePartitionReads(
      async (count) => {
        // The first partition read is runCommand's rejected-write check; release after two fenced wait probes.
        if (count === fencedProbesBeforeRelease + 1) {
          released = true;
          await setPartitionState('active');
        }
      },
      () => waitingCommand(scale, repetition, releaseAuth, Date.now() + 5_000),
    );
    expect(released).toBe(true);
    expect(observed.reads).toBe(fencedProbesBeforeRelease + 2);
    expect(observed.value.replayed).toBe(false);
  });
  expect(releasePhases).toEqual({ prepared: 36, authorized: 36, finalized: 36 });

  const deadlinePhases = { prepared: 0, authorized: 0, finalized: 0 };
  const deadlineAuth = authorization(deadlinePhases);
  const deadlineBudgetMs = 500;
  await setPartitionState('fenced');
  const deadline = await capture(db, () =>
    observePartitionReads(
      () => {},
      async () => {
        const error = await waitingCommand(
          scales.at(-1)!,
          Number.MAX_SAFE_INTEGER,
          deadlineAuth,
          Date.now() + deadlineBudgetMs,
        ).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(CommandUnavailableError);
        expect(error).toMatchObject({ reason: 'fenced', partition: anchorPartition });
        return error;
      },
    ),
  );
  const deadlineProbes = deadline.value.reads - 1;
  const deadlineCost = costOf(deadline.capture);
  // At the largest seeded history, the deadline outcome has four fixed application statements (time, receipt read,
  // fence, failed-write state read) plus one partition read per poll: 4 + P statements and P rows for P <= ceil(D / 25 ms).
  expect(deadlinePhases).toEqual({ prepared: 1, authorized: 1, finalized: 1 });
  expect(deadlineProbes).toBeGreaterThan(0);
  expect(deadlineCost.statements).toBe(deadlineProbes + 4);
}, 180_000);

test('Write wait deadline refusal stays bounded at three receipt history scales', async () => {
  await reset();
  await setPartitionState('fenced');
  const phases = { prepared: 0, authorized: 0, finalized: 0 };
  const auth = authorization(phases);
  const now = Date.now.bind(Date);

  await checkedGrowth('Write wait deadline refusal', async (_growthDb, scale, repetition) => {
    const partitionBefore = await partitionSnapshot();
    const deadline = now() + 5_000;
    let expired = false;
    // Expire only after two native fenced probes, keeping the poll term independent of history and host speed.
    const clock = spyOn(Date, 'now').mockImplementation(() => (expired ? Math.max(now(), deadline) : now()));
    try {
      const observed = await observePartitionReads(
        (reads) => {
          if (reads === 3) expired = true;
        },
        () => waitingCommand(scale, repetition, auth, deadline).catch((error: unknown) => error),
      );
      expect(observed.value).toBeInstanceOf(CommandUnavailableError);
      expect(observed.value).toMatchObject({ reason: 'fenced', partition: anchorPartition });
      expect(observed.reads).toBe(3);
    } finally {
      clock.mockRestore();
    }
    expect(await partitionSnapshot()).toEqual(partitionBefore);
  });
  expect(phases).toEqual({ prepared: 18, authorized: 18, finalized: 18 });
  const receipts = await db.admin.query('SELECT count(*)::int AS count FROM core.receipt WHERE command_kind = $1', [
    kind,
  ]);
  expect(receipts.rows).toEqual([{ count: scales.at(-1)! * ordinalsPerScale }]);
  const outbox = await db.admin.query('SELECT count(*)::int AS count FROM core.outbox WHERE subject = $1', [
    `${prefix}command`,
  ]);
  expect(outbox.rows).toEqual([{ count: 0 }]);
}, 180_000);
