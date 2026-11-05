import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  IdempotencyConflictError,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandAuthorization,
  type CommandAuthorizationMode,
} from '../src/command/command.ts';
import { createPool } from '../src/database/pool.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new Pool({ connectionString: databaseUrl, max: 2 });
const actor = '019a1b2c-3d4e-7f00-8a00-123400000001';
const partitions = {
  commit: 31,
  replay: 32,
  receiptOnly: 33,
  withoutReceipt: 34,
  empty: 35,
  callback: 36,
  finalize: 37,
  fenced: 38,
  conflict: 39,
  zero: 40,
} as const;

type DynamicClient = { query: (...args: unknown[]) => Promise<unknown> };
const tracedStatements: string[] = [];
let tracing = false;
const wrappedClients = new WeakSet<PoolClient>();
const tracedPool = new Proxy(pool, {
  get(target, property) {
    if (property === 'connect') {
      return async () => {
        const client = await target.connect();
        if (!wrappedClients.has(client)) {
          const dynamic = client as unknown as DynamicClient;
          const query = dynamic.query.bind(client);
          dynamic.query = (...args) => {
            if (tracing) {
              const queryText = args[0];
              tracedStatements.push(
                typeof queryText === 'string'
                  ? queryText
                  : queryText && typeof queryText === 'object' && 'text' in queryText
                    ? String(queryText.text)
                    : '',
              );
            }
            return query(...args);
          };
          wrappedClients.add(client);
        }
        return client;
      };
    }
    return Reflect.get(target, property, target);
  },
});

type Trace<T> = { value: T; statements: string[] };
async function trace<T>(work: () => Promise<T>): Promise<Trace<T>> {
  tracedStatements.length = 0;
  tracing = true;
  try {
    const value = await work();
    return { value, statements: [...tracedStatements] };
  } finally {
    tracing = false;
  }
}

async function traceRejected(work: () => Promise<unknown>): Promise<{ error: unknown; statements: string[] }> {
  tracedStatements.length = 0;
  tracing = true;
  try {
    const error = await work().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    return { error, statements: [...tracedStatements] };
  } finally {
    tracing = false;
  }
}

type AuthorizationFixture = {
  authorization: CommandAuthorization;
  order: string[];
};
function authorizationFixture(
  options: {
    mode?: CommandAuthorizationMode;
    refuseFinalize?: boolean;
    finalizeRow?: string;
  } = {},
): AuthorizationFixture {
  const order: string[] = [];
  const authorization: CommandAuthorization = {
    action: 'fixture:no-effect',
    resource: { route: 0, id: actor },
    async authorize() {
      order.push('authorize');
      return options.mode ?? 'execute';
    },
    async finalize(tx) {
      order.push('finalize');
      if (options.finalizeRow)
        await tx.query('INSERT INTO public.command_no_effect_fixture (id) VALUES ($1)', [options.finalizeRow]);
      if (options.refuseFinalize) throw new Error('fixture finalizer refused');
    },
    denied() {
      return new Error('receipt only');
    },
  };
  return { authorization, order };
}

function receipt(key = randomUUID(), digest = 'same request') {
  return {
    actorAccountId: actor,
    kind: 'fixture.no-effect',
    key,
    digest: createHash('sha256').update(digest).digest(),
  };
}

function commandOptions(partition: number, fixture: AuthorizationFixture, commandReceipt?: ReturnType<typeof receipt>) {
  return {
    partition,
    basis: { actorAccountId: actor, clientId: 'fixture', requestedBy: null },
    authorization: fixture.authorization,
    ...(commandReceipt ? { receipt: commandReceipt } : {}),
  };
}

async function snapshot(partition: number) {
  const [partitionRows, outboxRows, basisRows, receiptRows] = await Promise.all([
    admin.query('SELECT epoch, position::text, write_state, moved_to FROM core.partition WHERE partition_no = $1', [
      partition,
    ]),
    admin.query(
      'SELECT position::text, event_seq, id::text, type FROM core.outbox WHERE partition_no = $1 ORDER BY position, event_seq',
      [partition],
    ),
    admin.query(
      'SELECT transaction_id::text, position::text FROM editorial.write_basis WHERE partition_no = $1 ORDER BY position',
      [partition],
    ),
    admin.query(
      `SELECT idempotency_key, request_digest, epoch, position::text, transaction_id::text, response
       FROM core.receipt WHERE partition_no = $1 ORDER BY idempotency_key`,
      [partition],
    ),
  ]);
  return {
    partition: partitionRows.rows,
    outbox: outboxRows.rows,
    basis: basisRows.rows,
    receipts: receiptRows.rows.map((row) => ({
      ...row,
      request_digest: Buffer.from(row.request_digest).toString('hex'),
    })),
  };
}

function noEffectStatements(statements: readonly string[]): string[] {
  return statements.filter(
    (statement) => statement.includes('FROM core.partition AS p') && statement.includes('FOR SHARE OF p'),
  );
}

beforeAll(async () => {
  await admin.query('CREATE TABLE public.command_no_effect_fixture (id uuid PRIMARY KEY)');
});

afterEach(async () => {
  const selected = Object.values(partitions);
  await admin.query('DELETE FROM core.receipt WHERE partition_no = ANY($1::integer[])', [selected]);
  await admin.query('DELETE FROM editorial.write_basis WHERE partition_no = ANY($1::integer[])', [selected]);
  await admin.query('DELETE FROM core.outbox WHERE partition_no = ANY($1::integer[])', [selected]);
  await admin.query(
    "UPDATE core.partition SET write_state = 'active', moved_to = NULL, position = 0 WHERE partition_no = ANY($1::integer[])",
    [selected],
  );
  await admin.query('TRUNCATE public.command_no_effect_fixture');
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

test('a no-effect result commits its receipt without an outbox row write basis or position change', async () => {
  const partition = partitions.commit;
  const seedAuthorization = authorizationFixture();
  await runCommand(pool, commandOptions(partition, seedAuthorization), async () => ({
    value: 'seed',
    events: [{ type: 'com.rezics.test.happened.v1', data: {} }],
  }));
  const warmupReceipt = receipt();
  await runCommand(pool, commandOptions(partition, authorizationFixture(), warmupReceipt), async () =>
    noEffect({ warmup: true }),
  );
  await admin.query('DELETE FROM core.receipt WHERE partition_no = $1 AND idempotency_key = $2', [
    partition,
    warmupReceipt.key,
  ]);
  const before = await snapshot(partition);
  const commandReceipt = receipt();
  const fixture = authorizationFixture();
  const response = noEffect({ accepted: true });
  expect(Object.isFrozen(response)).toBe(true);
  expect(Object.isFrozen(response.events)).toBe(true);
  expect(response.events).toEqual([]);

  const traced = await trace(() =>
    runCommand(tracedPool, commandOptions(partition, fixture, commandReceipt), async () => response),
  );
  const after = await snapshot(partition);
  expect(traced.value).toMatchObject({
    value: { accepted: true },
    partition,
    epoch: 1,
    position: BigInt(before.partition[0]!.position),
    replayed: false,
  });
  expect(after.partition).toEqual(before.partition);
  expect(after.outbox).toEqual(before.outbox);
  expect(after.basis).toEqual(before.basis);
  expect(after.receipts).toHaveLength(before.receipts.length + 1);
  expect(after.receipts.at(-1)).toMatchObject({
    idempotency_key: commandReceipt.key,
    position: before.partition[0]!.position,
    epoch: 1,
    transaction_id: traced.value.transactionId,
    response: { accepted: true },
  });
  expect(traced.statements).toHaveLength(8);
  expect(noEffectStatements(traced.statements)).toHaveLength(1);
});

test('a replay of a no-effect receipt returns the same value epoch position and transaction id', async () => {
  const partition = partitions.replay;
  const commandReceipt = receipt();
  const fixture = authorizationFixture();
  let bodies = 0;
  const body = async () => {
    bodies += 1;
    return noEffect({ assigned: true, count: 3 });
  };
  const first = await runCommand(pool, commandOptions(partition, fixture, commandReceipt), body);
  const replay = await runCommand(pool, commandOptions(partition, fixture, commandReceipt), body);

  expect(replay).toEqual({ ...first, replayed: true });
  expect(replay.value).toEqual(first.value);
  expect(replay.epoch).toBe(first.epoch);
  expect(replay.position).toBe(first.position);
  expect(replay.transactionId).toBe(first.transactionId);
  expect(bodies).toBe(1);
});

test('receipt-only authorization replays a no-effect receipt and still denies a miss', async () => {
  const partition = partitions.receiptOnly;
  const commandReceipt = receipt();
  const original = await runCommand(pool, commandOptions(partition, authorizationFixture(), commandReceipt), async () =>
    noEffect({ removed: true }),
  );
  const receiptOnly = authorizationFixture({ mode: 'receipt-only' });
  let replayBodyRan = false;
  const replay = await runCommand(pool, commandOptions(partition, receiptOnly, commandReceipt), async () => {
    replayBodyRan = true;
    return noEffect({ removed: false });
  });
  expect(replay).toEqual({ ...original, replayed: true });
  expect(replayBodyRan).toBe(false);

  let missBodyRan = false;
  await expect(
    runCommand(pool, commandOptions(partition, receiptOnly, receipt()), async () => {
      missBodyRan = true;
      return noEffect({ wrong: true });
    }),
  ).rejects.toThrow('receipt only');
  expect(missBodyRan).toBe(false);
});

test('a no-effect result without a receipt commits nothing', async () => {
  const partition = partitions.withoutReceipt;
  const before = await snapshot(partition);
  const fixture = authorizationFixture();
  const traced = await trace(() =>
    runCommand(tracedPool, commandOptions(partition, fixture), async () => noEffect({ unchanged: true })),
  );

  expect(traced.value).toMatchObject({
    value: { unchanged: true },
    partition,
    epoch: 1,
    position: 0n,
    replayed: false,
  });
  expect(await snapshot(partition)).toEqual(before);
  expect(traced.statements).toHaveLength(7);
  expect(noEffectStatements(traced.statements)).toHaveLength(1);
});

test('an empty event list without noEffect still throws', async () => {
  const partition = partitions.empty;
  const fixture = authorizationFixture();
  const before = await snapshot(partition);
  const traced = await traceRejected(() =>
    runCommand(tracedPool, commandOptions(partition, fixture), async () => ({ value: null, events: [] })),
  );
  expect(traced.error).toBeInstanceOf(TypeError);
  expect(traced.error).toMatchObject({ message: 'A command must emit at least one event' });
  expect(await snapshot(partition)).toEqual(before);
  expect(noEffectStatements(traced.statements)).toHaveLength(0);

  const copied = { ...noEffect(true) };
  await expect(runCommand(pool, commandOptions(partition, fixture), async () => copied)).rejects.toThrow(
    'A command must emit at least one event',
  );
});

test('a no-effect result with a registered command callback throws TypeError and rolls back', async () => {
  const partition = partitions.callback;
  const fixture = authorizationFixture();
  const commandReceipt = receipt();
  const before = await snapshot(partition);
  let callbackRan = false;
  const traced = await traceRejected(() =>
    runCommand(tracedPool, commandOptions(partition, fixture, commandReceipt), async (tx) => {
      registerCommandCallback(tx, () => {
        callbackRan = true;
      });
      return noEffect({ accepted: true });
    }),
  );

  expect(traced.error).toBeInstanceOf(TypeError);
  expect(traced.error).toMatchObject({ message: 'A no-effect command registers no work' });
  expect(callbackRan).toBe(false);
  expect(await snapshot(partition)).toEqual(before);
  expect(noEffectStatements(traced.statements)).toHaveLength(0);
});

test('finalize runs for a no-effect result and its refusal rolls back', async () => {
  const success = authorizationFixture();
  await runCommand(pool, commandOptions(partitions.finalize, success), async () => noEffect({ finalized: true }));
  expect(success.order).toEqual(['authorize', 'finalize']);

  const partition = partitions.finalize + 1;
  const before = await snapshot(partition);
  const rowId = randomUUID();
  const refusal = authorizationFixture({ refuseFinalize: true, finalizeRow: rowId });
  await expect(
    runCommand(pool, commandOptions(partition, refusal, receipt()), async () => noEffect({ refused: true })),
  ).rejects.toThrow('fixture finalizer refused');
  expect(refusal.order).toEqual(['authorize', 'finalize']);
  expect((await admin.query('SELECT id FROM public.command_no_effect_fixture WHERE id = $1', [rowId])).rows).toEqual(
    [],
  );
  expect(await snapshot(partition)).toEqual(before);
});

test('a no-effect commit on a fenced partition is retried like any command', async () => {
  const partition = partitions.fenced;
  await admin.query("UPDATE core.partition SET write_state = 'fenced' WHERE partition_no = $1", [partition]);
  const fixture = authorizationFixture();
  let bodies = 0;
  let activationError: unknown;
  const activation = setTimeout(() => {
    void admin
      .query("UPDATE core.partition SET write_state = 'active' WHERE partition_no = $1", [partition])
      .catch((error: unknown) => {
        activationError = error;
      });
  }, 100);
  const traced = await trace(() =>
    runCommand(tracedPool, { ...commandOptions(partition, fixture), deadline: Date.now() + 2500 }, async () =>
      noEffect({ attempt: ++bodies }),
    ),
  ).finally(() => clearTimeout(activation));

  if (activationError) throw activationError;
  expect(traced.value.value).toEqual({ attempt: 2 });
  expect(traced.value.replayed).toBe(false);
  expect(bodies).toBe(2);
  expect(noEffectStatements(traced.statements)).toHaveLength(2);
});

test('a different request under the same key still conflicts', async () => {
  const partition = partitions.conflict;
  const firstReceipt = receipt();
  const fixture = authorizationFixture();
  await runCommand(pool, commandOptions(partition, fixture, firstReceipt), async () => noEffect({ value: 1 }));
  let bodyRan = false;
  await expect(
    runCommand(
      pool,
      commandOptions(partition, fixture, { ...firstReceipt, digest: receipt(firstReceipt.key, 'different').digest }),
      async () => {
        bodyRan = true;
        return noEffect({ value: 2 });
      },
    ),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(bodyRan).toBe(false);
  expect((await snapshot(partition)).receipts).toHaveLength(1);
});

test('a no-effect receipt on a partition at position 0 is stored and replayed at position 0', async () => {
  const partition = partitions.zero;
  const before = await snapshot(partition);
  expect(before.partition[0]!.position).toBe('0');
  const commandReceipt = receipt();
  const fixture = authorizationFixture();
  const first = await runCommand(pool, commandOptions(partition, fixture, commandReceipt), async () =>
    noEffect({ noop: true }),
  );
  const replay = await runCommand(pool, commandOptions(partition, fixture, commandReceipt), async () =>
    noEffect({ noop: false }),
  );
  const after = await snapshot(partition);

  expect(first.position).toBe(0n);
  expect(replay).toEqual({ ...first, replayed: true });
  expect(after.partition[0]!.position).toBe('0');
  expect(after.outbox).toEqual([]);
  expect(after.basis).toEqual([]);
  expect(after.receipts).toMatchObject([
    {
      idempotency_key: commandReceipt.key,
      position: '0',
      transaction_id: first.transactionId,
      response: { noop: true },
    },
  ]);
});
