import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  currentCommand,
  currentCommandResources,
  currentCommandReceipt,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandResult,
  type CommandTransaction,
} from '../../src/command/command.ts';
import {
  COMMAND_DISPATCH_ALLOWANCE,
  COMMAND_DISPATCH_TIME_SQL,
  CommandDispatchLifetimeError,
  SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE,
  SOURCE_FENCE_BINDING_BYTES,
  withCommandDispatchLifetime,
  withSourceFenceCommandDispatchLifetime,
  type CommandDispatchOwner,
  type SourceFenceCommandDispatchOwner,
} from '../../src/command/dispatch-lifetime.ts';
import {
  declareCommandRecordSources,
  declareCommandRecordSourceSet,
} from '../../src/history/adapters/record-source.ts';
import { declareAgentIdentitySource } from '../../src/history/adapters/agent-identity-source.ts';
import { beginSemanticRecordSourceSet } from '../../src/semantic/record-source-set.ts';
import { writeIdentityScopeConsumerNativeCommit } from '../../src/semantic/identity-epoch-native-commit.ts';
import { createPool } from '../../src/database/pool.ts';
import { enterCommandGate } from '../../src/command/gate.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import { observeSql, type SqlObserver } from '../content/support/sql-observer.ts';

// Genuine executor/native association outcomes. This fixture's real ledger exercises the
// reservation ABI, NOT private Accounts funding or Source/Library owner authority.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const foreign = createPool(url);
const admin = new Pool({ connectionString: url, max: 2 });
const partition = 3554;
const account = '00000000-0000-0000-0000-000000000000';
const type = 'com.rezics.semantic.erasure.progress.v1';
const begin = 'BEGIN ISOLATION LEVEL SERIALIZABLE';
const lock = "SET LOCAL lock_timeout = '200ms'";
const bodySQL = 'SELECT pg_backend_pid() AS pid';
let eventFence = '';
let noEffectFence = '';
const observers: SqlObserver[] = [];
function observe() {
  const observer = observeSql(pool);
  observers.push(observer);
  return observer;
}
const texts = (observer: SqlObserver) => observer.records.map((record) => record.statement);
const event = (id = account) => ({ type, subject: id, data: { accountId: id } });
const response = <T>(value: T, id = account): CommandResult<T> => ({ value, events: [event(id)] });
const failed = <T>(promise: Promise<T>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );
function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
const ownerContext = new AsyncLocalStorage<object>();
function fixture(statements = 8, id = account) {
  const original = Object.freeze({});
  const deadline = Date.now() + 30_000;
  const ledger = new NativeCollectionWork(
    {
      reservationId: randomUUID(),
      remaining: {
        candidateKeys: 0,
        nativeRows: 3,
        identityMetadataRows: 0,
        nativePoints: 2,
        witnessKeys: 0,
        statements,
        bytes: 651,
        emptySeeks: 1,
      },
    },
    deadline,
  );
  let live = true;
  let reservations = 0;
  let afterReserve: (() => void | Promise<void>) | undefined;
  const owner: SourceFenceCommandDispatchOwner = {
    original,
    validate() {
      if (!live || ownerContext.getStore() !== original) throw new Error('Source original revoked or escaped');
    },
    async reserve(allowance) {
      expect(allowance).toBe(SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE);
      reservations++;
      const held = ledger.reserve(allowance.total.work);
      held.dispatch();
      held.settle();
      await afterReserve?.();
    },
  };
  const scope = <T>(body: () => Promise<T>) =>
    ownerContext.run(original, () => withSourceFenceCommandDispatchLifetime(pool, deadline, owner, id, body));
  const run = <T>(body: (tx: CommandTransaction) => Promise<CommandResult<T>> = async () => response(1 as T)) =>
    scope(() => runCommand(pool, { partition, deadline }, body));
  return {
    owner,
    deadline,
    ledger,
    scope,
    run,
    reservations: () => reservations,
    revoke: () => {
      live = false;
    },
    afterReserve: (hook: () => void | Promise<void>) => {
      afterReserve = hook;
    },
  };
}
beforeAll(async () => {
  await admin.query("INSERT INTO core.partition(partition_no,node) VALUES($1,'local') ON CONFLICT DO NOTHING", [
    partition,
  ]);
  // Learn the actual mapped native statements, never a replacement fence or executor.
  const observer = observe();
  await runCommand(pool, { partition }, async () => response(0));
  await runCommand(pool, { partition }, async () => noEffect(null));
  eventFence = texts(observer).find((sql) => sql.includes('INSERT INTO core.outbox'))!;
  noEffectFence = texts(observer).find((sql) => sql.includes('FOR SHARE OF p'))!;
  await observer.close();
});
afterEach(async () => {
  for (const observer of observers.splice(0)) await observer.close();
  await admin.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=$1", [partition]);
});
afterAll(async () => {
  await pool.end();
  await foreign.end();
  await admin.end();
});

async function position() {
  return BigInt(
    (await admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [partition])).rows[0].position,
  );
}
async function countOutbox() {
  return (await admin.query('SELECT count(*)::int AS n FROM core.outbox WHERE partition_no=$1', [partition])).rows[0]
    .n as number;
}

test('Source native component and exact catalogue event commit once at the same fence/outbox position', async () => {
  const f = fixture();
  const observer = observe();
  const before = await position();
  let native!: Awaited<ReturnType<typeof writeIdentityScopeConsumerNativeCommit>>;
  const outcome = await f.run(async (tx) => {
    expect(currentCommandResources(tx)).toEqual({ pool, deadline: f.deadline });
    expect(currentCommand(tx).basis).toBeNull();
    native = await writeIdentityScopeConsumerNativeCommit(tx);
    return response({ fence: native });
  });
  expect(outcome.value.fence).toBe(native);
  expect(outcome.position).toBe(before + 1n);
  expect(native).toEqual({
    partition,
    epoch: outcome.epoch,
    position: outcome.position,
    transactionId: outcome.transactionId,
  });
  const stored = await admin.query(
    'SELECT event_seq,event_count,type,subject,data,id FROM core.outbox WHERE partition_no=$1 AND position=$2',
    [partition, outcome.position.toString()],
  );
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0]).toMatchObject({
    event_seq: 0,
    event_count: 1,
    type,
    subject: account,
    data: { accountId: account },
  });
  expect(stored.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  expect(texts(observer).filter((sql) => sql === eventFence)).toHaveLength(1);
  expect(texts(observer)).not.toContain(noEffectFence);
  expect(texts(observer).filter((sql) => sql === begin)).toHaveLength(1);
  expect(texts(observer).filter((sql) => sql === 'COMMIT')).toHaveLength(1);
  expect(f.reservations()).toBe(1);
});

for (const value of [null, { fence: null }]) {
  test(`authentic Source ${value === null ? 'noncurrent or failed native fence' : 'nonexhausted page'} retains no-effect observation`, async () => {
    const f = fixture();
    const observer = observe();
    const before = await position();
    const count = await countOutbox();
    const outcome = await f.run(async () => noEffect(value));
    expect(outcome.value).toBe(value);
    expect(outcome.position).toBe(before);
    expect(await countOutbox()).toBe(count);
    expect(texts(observer).filter((sql) => sql === noEffectFence)).toHaveLength(1);
    expect(texts(observer)).not.toContain(eventFence);
    expect(texts(observer)).toHaveLength(7);
  });
}

for (const id of [account, 'ffffffff-ffff-ffff-ffff-ffffffffffff', '12345678-9abc-0def-0123-456789abcdef']) {
  test(`selected account retains full catalogue UUID domain: ${id}`, async () => {
    const f = fixture(8, id);
    expect((await f.run(async () => response(1, id))).value).toBe(1);
  });
}

test('Core preserves body value identity without serializing or traversing it', async () => {
  const value = {
    toJSON() {
      throw new Error('foreign result serializer');
    },
    circular: undefined as unknown,
  };
  value.circular = value;
  expect((await fixture().run(async () => response(value))).value).toBe(value);
});

const invalid: [string, () => unknown][] = [
  ['wrong type', () => ({ value: 1, events: [{ ...event(), type: 'com.rezics.semantic.erasure.scheduled.v1' }] })],
  ['wrong subject', () => ({ value: 1, events: [{ ...event(), subject: randomUUID() }] })],
  ['wrong data account', () => ({ value: 1, events: [{ ...event(), data: { accountId: randomUUID() } }] })],
  ['extra data field', () => ({ value: 1, events: [{ ...event(), data: { accountId: account, extra: 1 } }] })],
  ['extra event', () => ({ value: 1, events: [event(), event()] })],
  ['forged noEffect', () => ({ value: 1, events: [] })],
  ['extra event field', () => ({ value: 1, events: [{ ...event(), id: randomUUID() }] })],
  ['unknown response field', () => ({ ...response(1), extra: 1 })],
  [
    'data getter',
    () => ({
      value: 1,
      events: [
        {
          ...event(),
          data: {
            get accountId() {
              throw new Error('getter executed');
            },
          },
        },
      ],
    }),
  ],
  [
    'event getter',
    () => ({
      value: 1,
      events: [
        {
          ...event(),
          get type() {
            throw new Error('getter executed');
          },
        },
      ],
    }),
  ],
  [
    'response getter',
    () => ({
      value: 1,
      get events() {
        throw new Error('getter executed');
      },
    }),
  ],
  [
    'array getter',
    () => ({
      value: 1,
      events: Object.defineProperty([event()], '0', {
        get() {
          throw new Error('getter executed');
        },
      }),
    }),
  ],
  [
    'custom serializer',
    () => ({
      value: 1,
      events: [
        {
          ...event(),
          data: {
            accountId: account,
            toJSON() {
              throw new Error('serializer executed');
            },
          },
        },
      ],
    }),
  ],
  [
    'custom prototype',
    () => ({
      value: 1,
      events: [{ ...event(), data: Object.assign(Object.create({ inherited: true }), { accountId: account }) }],
    }),
  ],
  [
    'hidden field',
    () => ({
      value: 1,
      events: [{ ...event(), data: Object.defineProperty({ accountId: account }, 'hidden', { value: 1 }) }],
    }),
  ],
  [
    'proxy',
    () =>
      new Proxy(response(1), {
        ownKeys() {
          throw new Error('proxy executed');
        },
      }),
  ],
];
for (const [name, make] of invalid) {
  test(`${name} refuses before serialization, final settings, event fence and unsupported IO`, async () => {
    const f = fixture();
    const observer = observe();
    const before = await position();
    await expect(f.run(async () => make() as CommandResult<number>)).rejects.toThrow('Unsupported dispatch lifetime');
    expect(await position()).toBe(before);
    expect(texts(observer)).toHaveLength(5); // BEGIN/settings/time + separately held rollback
    expect(texts(observer).at(-1)).toBe('ROLLBACK');
    expect(texts(observer)).not.toContain(eventFence);
  });
}

for (const option of ['actor', 'basis', 'principal', 'receipt', 'authorization', 'clock', 'unknown']) {
  test(`unsupported ${option} refuses before reservation and checkout`, async () => {
    const f = fixture();
    const observer = observe();
    await expect(
      f.scope(() =>
        runCommand(pool, { partition, deadline: f.deadline, [option]: undefined }, async () => response(1)),
      ),
    ).rejects.toThrow('Unsupported');
    expect(f.reservations()).toBe(0);
    expect(observer.records).toHaveLength(0);
  });
}

test('options getters and prototypes refuse before reading an unsupported option', async () => {
  const f = fixture();
  const observer = observe();
  await expect(
    f.scope(() =>
      runCommand(
        pool,
        {
          partition,
          get deadline(): number {
            throw new Error('getter executed');
          },
        },
        async () => response(1),
      ),
    ),
  ).rejects.toThrow('Unsupported');
  const g = fixture();
  await expect(
    g.scope(() =>
      runCommand(
        pool,
        Object.assign(Object.create({ clock: () => new Date() }), { partition, deadline: g.deadline }),
        async () => response(1),
      ),
    ),
  ).rejects.toThrow('Unsupported');
  expect(observer.records).toHaveLength(0);
});

for (const mismatch of ['Pool', 'deadline']) {
  test(`wrong immutable ${mismatch} refuses before reservation and checkout`, async () => {
    const f = fixture();
    const observer = observe();
    await expect(
      f.scope(() =>
        runCommand(
          mismatch === 'Pool' ? foreign : pool,
          { partition, deadline: f.deadline + (mismatch === 'deadline' ? 1 : 0) },
          async () => response(1),
        ),
      ),
    ).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
    expect(f.reservations()).toBe(0);
    expect(observer.records).toHaveLength(0);
  });
}

for (const association of ['callback', 'source', 'source set', 'agent identity source']) {
  test(`native ${association} refuses before executor callbacks, History serialization or finalization IO`, async () => {
    const f = fixture();
    const observer = observe();
    await expect(
      f.run(async (tx) => {
        if (association === 'callback')
          registerCommandCallback(tx, () => {
            throw new Error('callback executed');
          });
        if (association === 'source') declareCommandRecordSources(tx, [{ kind: 'context', contextId: randomUUID() }]);
        if (association === 'source set') await beginSemanticRecordSourceSet(tx);
        if (association === 'agent identity source')
          await declareAgentIdentitySource(
            tx,
            {
              route: 0,
              accountId: account,
              direction: 'account-agent.verify',
              receiptId: randomUUID(),
            },
            'sha256:' + '0'.repeat(64),
          );
        return response(1);
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(texts(observer)).not.toContain(eventFence);
    expect(texts(observer)).not.toContain('COMMIT');
    expect(texts(observer).some((sql) => /record_history|history_locator/.test(sql))).toBe(false);
    expect(texts(observer).at(-1)).toBe('ROLLBACK');
  });
}

test('copied native tx has no context, receipt, callback, source or source-set authority', async () => {
  const f = fixture();
  await f.run(async (tx) => {
    const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(tx)) as CommandTransaction;
    for (const operation of [
      () => currentCommand(copy),
      () => currentCommandResources(copy),
      () => currentCommandReceipt(copy),
      () => registerCommandCallback(copy, () => {}),
      () => declareCommandRecordSources(copy, [{ kind: 'context', contextId: randomUUID() }]),
      () => declareCommandRecordSourceSet(copy, Object.freeze({}) as never),
    ])
      expect(operation).toThrow();
    await expect(copy.query('SELECT 999')).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
    return response(1);
  });
});

test('one association refuses nested, concurrent, repeated and escaped invocation', async () => {
  const f = fixture();
  const observer = observe();
  const resume = barrier();
  let escaped!: Promise<unknown>;
  await f.scope(async () => {
    await expect(
      withSourceFenceCommandDispatchLifetime(pool, f.deadline, f.owner, account, async () => 0),
    ).rejects.toThrow();
    const entered = barrier();
    const hold = barrier();
    const first = runCommand(pool, { partition, deadline: f.deadline }, async () => {
      entered.release();
      await hold.waiting;
      return response(1);
    });
    await entered.waiting;
    try {
      await expect(runCommand(pool, { partition, deadline: f.deadline }, async () => response(2))).rejects.toThrow();
      await expect(f.run()).rejects.toThrow();
    } finally {
      hold.release();
    }
    await first;
    await expect(runCommand(pool, { partition, deadline: f.deadline }, async () => response(3))).rejects.toThrow();
    escaped = failed(
      (async () => {
        await resume.waiting;
        return runCommand(pool, { partition, deadline: f.deadline }, async () => response(4));
      })(),
    );
    return 1;
  });
  resume.release();
  expect(await escaped).toBeInstanceOf(CommandDispatchLifetimeError);
  expect(texts(observer).filter((sql) => sql === begin)).toHaveLength(1);
  expect(f.reservations()).toBe(1);
});

test('insufficient complete reservation and revocation around awaited reservation refuse before checkout', async () => {
  const observer = observe();
  await expect(fixture(7).run()).rejects.toThrow();
  const revoked = fixture();
  revoked.revoke();
  await expect(revoked.run()).rejects.toThrow('revoked');
  expect(revoked.reservations()).toBe(0);
  const after = fixture();
  after.afterReserve(() => after.revoke());
  await expect(after.run()).rejects.toThrow('revoked');
  expect(after.ledger.receipt().used.statements).toBe(8);
  expect(observer.records).toHaveLength(0);
});

test('revocation while queued at the genuine gate releases acquired admission without checkout', async () => {
  const f = fixture();
  const observer = observe();
  const held = await enterCommandGate(pool, partition, f.deadline);
  if (held.status !== 'acquired') throw new Error('Fixture could not acquire gate');
  try {
    const outcome = failed(f.run());
    // Drain preparation's finite microtasks to the already-held gate, without a timed sleep.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.reservations()).toBe(1);
    f.revoke();
    held.release();
    expect(await outcome).toBeInstanceOf(Error);
    expect(observer.records).toHaveLength(0);
    const next = await enterCommandGate(pool, partition, Date.now() + 200);
    if (next.status !== 'acquired') throw new Error('Refused checkout retained the gate');
    next.release();
  } finally {
    held.release();
  }
});

for (const expire of [false, true]) {
  test(`${expire ? 'expiry' : 'revocation'} after checkout releases the original client before BEGIN`, async () => {
    const f = fixture();
    const observer = observe();
    const connect = pool.connect.bind(pool);
    const now = spyOn(Date, 'now').mockReturnValue(f.deadline - 30_000);
    const spy = spyOn(pool, 'connect').mockImplementation((async () => {
      const client = await connect();
      if (expire) now.mockReturnValue(f.deadline);
      else f.revoke();
      return client;
    }) as Pool['connect']);
    try {
      await expect(f.run()).rejects.toThrow();
    } finally {
      spy.mockRestore();
      now.mockRestore();
    }
    expect(observer.records).toHaveLength(0);
    expect(pool.waitingCount).toBe(0);
  });
}

for (const expire of [false, true]) {
  for (const selected of [
    'begin',
    'lock',
    'timeout',
    'time',
    'body',
    'final timeout',
    'event fence',
    'no-effect fence',
    'COMMIT',
  ] as const) {
    test(`${expire ? 'expiry' : 'revocation'} after awaited ${selected} retains spent work and only same-client prepaid cleanup`, async () => {
      const f = fixture();
      const observer = observe();
      const now = spyOn(Date, 'now').mockReturnValue(f.deadline - 30_000);
      const timeout = "SET LOCAL statement_timeout = '30000ms'";
      const statement = {
        begin,
        lock,
        timeout,
        time: COMMAND_DISPATCH_TIME_SQL,
        body: bodySQL,
        'final timeout': timeout,
        'event fence': eventFence,
        'no-effect fence': noEffectFence,
        COMMIT: 'COMMIT',
      }[selected]!;
      const held = observer.hold({ statement, occurrence: selected === 'final timeout' ? 2 : 1 }, 'after');
      const before = await position();
      try {
        const outcome = failed(
          f.run(async (tx) => {
            await tx.query(bodySQL);
            return selected === 'no-effect fence' ? noEffect(1) : response(1);
          }),
        );
        await held.entered;
        if (expire) now.mockReturnValue(f.deadline);
        else f.revoke();
        held.release();
        expect(await outcome).toBeInstanceOf(Error);
      } finally {
        held.release();
        now.mockRestore();
      }
      expect(texts(observer).at(-1)).toBe('ROLLBACK');
      expect(texts(observer).filter((sql) => sql === 'ROLLBACK')).toHaveLength(1);
      expect(new Set(observer.records.map((record) => record.connectionId)).size).toBe(1);
      expect(f.ledger.receipt().used.statements).toBe(8);
      expect(f.reservations()).toBe(1);
      expect(await position()).toBe(before + (selected === 'COMMIT' ? 1n : 0n));
      expect(texts(observer).filter((sql) => sql === begin)).toHaveLength(1);
    });
  }
}

for (const boundary of ['before', 'after'] as const) {
  test(`${boundary === 'before' ? 'failed' : 'lost'} COMMIT refuses publication certainty without refund or retry`, async () => {
    const f = fixture();
    const observer = observe();
    const error = Object.assign(new Error('COMMIT response unavailable'), { code: '40001' });
    observer.armFault({ match: { statement: 'COMMIT' }, boundary, error });
    const before = await position();
    const result = await failed(f.run());
    expect((result as Error).cause).toBe(error);
    expect(await position()).toBe(before + (boundary === 'after' ? 1n : 0n));
    expect(texts(observer).filter((sql) => sql === begin)).toHaveLength(1);
    expect(texts(observer).at(-1)).toBe('ROLLBACK');
    expect(f.ledger.receipt().used.statements).toBe(8);
  });
}

test('cleanup failure preserves combined evidence and discards the same client without a replacement checkout', async () => {
  const f = fixture();
  const observer = observe();
  const primary = new Error('owned body failure');
  const cleanup = new Error('cleanup failure');
  observer.armFault({ match: { statement: 'ROLLBACK' }, boundary: 'after', error: cleanup });
  const failure = await failed(
    f.run(async () => {
      throw primary;
    }),
  );
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
  expect((failure as Error).cause).toBe(primary);
  const pid = observer.records[0]!.connectionId;
  expect(new Set(observer.records.map((record) => record.connectionId)).size).toBe(1);
  expect((await pool.query<{ pid: number }>(bodySQL)).rows[0]!.pid).not.toBe(pid);
  expect(f.reservations()).toBe(1);
});

for (const state of ['fenced', 'moved']) {
  for (const noEffectBranch of [false, true]) {
    test(`empty ${state} native ${noEffectBranch ? 'no-effect' : 'event'} fence refuses before partition projection, writable wait or a second attempt`, async () => {
      await admin.query('UPDATE core.partition SET write_state=$2,moved_to=$3 WHERE partition_no=$1', [
        partition,
        state,
        state === 'moved' ? 'elsewhere' : null,
      ]);
      const f = fixture();
      const observer = observe();
      await expect(f.run(async () => (noEffectBranch ? noEffect(null) : response(null)))).rejects.toThrow();
      expect(texts(observer).filter((sql) => sql === (noEffectBranch ? noEffectFence : eventFence))).toHaveLength(1);
      expect(texts(observer)).toHaveLength(7);
      expect(texts(observer).at(-1)).toBe('ROLLBACK');
      expect(texts(observer).some((sql) => /SELECT.*node|SELECT.*moved_to/.test(sql))).toBe(false);
      expect(f.reservations()).toBe(1);
    });
  }
}

test('failed native event fence remains spent with one attempt and cleanup', async () => {
  const f = fixture();
  const observer = observe();
  observer.armFault({
    match: { statement: eventFence },
    boundary: 'after',
    error: Object.assign(new Error('serialization'), { code: '40001' }),
  });
  const before = await position();
  await expect(f.run()).rejects.toThrow();
  expect(await position()).toBe(before);
  expect(texts(observer)).toHaveLength(7);
  expect(texts(observer).at(-1)).toBe('ROLLBACK');
});

test('the outer callback closes descendant effects and escaped exact native queries', async () => {
  const f = fixture();
  const observer = observe();
  const held = observer.hold({ statement: bodySQL }, 'after');
  let child!: Promise<unknown>;
  let escaped!: CommandTransaction;
  const returned = barrier();
  const scope = failed(
    f.scope(async () => {
      child = failed(
        runCommand(pool, { partition, deadline: f.deadline }, async (tx) => {
          escaped = tx;
          await tx.query(bodySQL);
          return response(1);
        }),
      );
      await held.entered;
      returned.release();
      return 7;
    }),
  );
  await returned.waiting;
  await Promise.resolve();
  await Promise.resolve();
  held.release();
  expect(await scope).toBeInstanceOf(CommandDispatchLifetimeError);
  expect(await child).toBeInstanceOf(CommandDispatchLifetimeError);
  await expect(escaped.query('SELECT 999')).rejects.toThrow();
  expect(() => currentCommand(escaped)).toThrow();
  expect(texts(observer).at(-1)).toBe('ROLLBACK');
  expect(texts(observer)).not.toContain('COMMIT');
});

test('Promise exact-tx queries refuse concurrency, callback overloads and unsettled descendants', async () => {
  const f = fixture();
  const observer = observe();
  const held = observer.hold({ statement: bodySQL }, 'after');
  let pending!: Promise<unknown>;
  const result = failed(
    f.run(async (tx) => {
      pending = failed(tx.query(bodySQL));
      await held.entered;
      await expect(tx.query('SELECT 999')).rejects.toThrow();
      await expect(Promise.resolve().then(() => tx.query('SELECT 999', () => {}))).rejects.toThrow();
      return response(1);
    }),
  );
  await held.entered;
  expect(await result).toBeInstanceOf(CommandDispatchLifetimeError);
  held.release();
  expect(await pending).toBeInstanceOf(CommandDispatchLifetimeError);
  expect(texts(observer)).not.toContain('SELECT 999');
  expect(texts(observer)).not.toContain('COMMIT');
});

test('the old no-effect adapter receives exactly its frozen allowance and still refuses this event', async () => {
  const deadline = Date.now() + 30_000;
  const owner: CommandDispatchOwner = {
    original: {},
    validate() {},
    reserve(allowance) {
      expect(allowance).toBe(COMMAND_DISPATCH_ALLOWANCE);
    },
  };
  await expect(
    withCommandDispatchLifetime(pool, deadline, owner, () =>
      runCommand(pool, { partition, deadline }, async () => response(1)),
    ),
  ).rejects.toThrow('Unsupported dispatch lifetime');
  expect(
    (
      await withCommandDispatchLifetime(pool, deadline, owner, () =>
        runCommand(pool, { partition, deadline }, async () => noEffect(7)),
      )
    ).value,
  ).toBe(7);
  expect(COMMAND_DISPATCH_ALLOWANCE.effect.work.bytes).toBe(169);
  // Compile-time only: a no-effect reservation adapter is not a Source event owner.
  const compatible = (_owner: SourceFenceCommandDispatchOwner) => {};
  if (false) {
    // @ts-expect-error distinct profile/allowance reserve parameter
    compatible(owner);
  }
});

test('ordinary events, schema refusal, noEffect and callback rules retain their genuine outcomes', async () => {
  const before = await position();
  const outcome = await runCommand(pool, { partition }, async () => response(3));
  expect(outcome.position).toBe(before + 1n);
  await expect(
    runCommand(pool, { partition }, async () => ({
      value: 1,
      events: [{ ...event(), data: { accountId: 'invalid' } }],
    })),
  ).rejects.toThrow('Invalid event data');
  await expect(runCommand(pool, { partition }, async () => ({ value: 1, events: [] }))).rejects.toThrow(
    'at least one event',
  );
  await expect(
    runCommand(pool, { partition }, async (tx) => {
      registerCommandCallback(tx, () => {});
      return noEffect(1);
    }),
  ).rejects.toThrow('no-effect command registers no work');
  expect((await runCommand(pool, { partition }, async () => noEffect(9))).value).toBe(9);
});

test('independent literal branch derivation uses max alternatives plus disjoint cleanup on every axis', () => {
  const allowance = SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE;
  const components = {
    accountSelection: [0, 0, 0, 36, 0],
    checkout: [0, 0, 0, 0, 0],
    begin: [0, 0, 1, 0, 0],
    lockTimeout: [0, 0, 1, 0, 0],
    statementTimeout: [0, 0, 1, 12, 0],
    time: [1, 0, 1, 40, 0],
    eventShape: [0, 0, 0, 111, 0],
    eventSerialization: [0, 0, 0, 52, 0],
    eventValidation: [0, 0, 0, 52, 0],
    finalStatementTimeout: [0, 0, 1, 12, 0],
    noEffectFence: [1, 1, 1, 105, 1],
    eventFence: [2, 2, 1, 336, 1],
    finalize: [0, 0, 0, 0, 0],
    commit: [0, 0, 1, 0, 0],
    cleanupRollback: [0, 0, 1, 0, 0],
  } as const;
  expect(Object.keys(allowance.components)).toEqual(Object.keys(components));
  for (const name of Object.keys(components) as (keyof typeof components)[]) {
    const [nativeRows, nativePoints, statements, bytes, emptySeeks] = components[name];
    expect(allowance.components[name]).toEqual({
      work: {
        candidateKeys: 0,
        nativeRows,
        identityMetadataRows: 0,
        nativePoints,
        witnessKeys: 0,
        statements,
        bytes,
        emptySeeks,
      },
      engineRequests: 0,
    });
  }
  expect(allowance.maxima).toEqual({ attempts: 1, checkouts: 1, fences: 1, events: 1, cleanupRollbacks: 1 });
  expect(allowance.effect.work).toEqual({
    candidateKeys: 0,
    nativeRows: 3,
    identityMetadataRows: 0,
    nativePoints: 2,
    witnessKeys: 0,
    statements: 7,
    bytes: 651,
    emptySeeks: 1,
  });
  expect(allowance.branches.noEffect.work).toEqual({
    candidateKeys: 0,
    nativeRows: 2,
    identityMetadataRows: 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 7,
    bytes: 205,
    emptySeeks: 1,
  });
  expect(allowance.total.work.statements).toBe(8);
  expect(allowance.branches.event).toEqual(allowance.effect);
  expect(allowance.cleanup).toEqual(allowance.components.cleanupRollback);
  expect(allowance.total.engineRequests).toBe(0);
  const id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const encoded = [{ ...event(id), id }];
  expect(Buffer.byteLength(JSON.stringify(encoded))).toBe(205);
  expect(Buffer.byteLength(JSON.stringify([4095, JSON.stringify(encoded), id, null, null]))).toBe(
    SOURCE_FENCE_BINDING_BYTES,
  );
  expect(SOURCE_FENCE_BINDING_BYTES).toBe(281);
  expect(Buffer.byteLength(JSON.stringify([{ epoch: 2147483647, position: '9223372036854775807' }]))).toBe(55);
  expect(allowance.components.eventFence.work.bytes).toBe(336);
  expect(Object.isFrozen(allowance)).toBe(true);
  expect(Object.isFrozen(allowance.components.eventFence.work)).toBe(true);
});

for (const id of ['not-a-uuid', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', '00000000-0000-0000-0000-0000000000000']) {
  test(`invalid selected account ${id} refuses before reservation and checkout`, async () => {
    const f = fixture(8, id);
    const observer = observe();
    await expect(f.run()).rejects.toThrow('Source fence account');
    expect(f.reservations()).toBe(0);
    expect(observer.records).toHaveLength(0);
  });
}

test('expiry across reservation and changed immutable invocation refuse without checkout', async () => {
  const observer = observe();
  const expired = fixture();
  const now = spyOn(Date, 'now').mockReturnValue(expired.deadline - 30_000);
  expired.afterReserve(() => {
    now.mockReturnValue(expired.deadline);
  });
  try {
    await expect(expired.run()).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
  } finally {
    now.mockRestore();
  }
  expect(expired.ledger.receipt().used.statements).toBe(8);
  const changed = fixture();
  const options = { partition, deadline: changed.deadline };
  changed.afterReserve(() => {
    options.deadline++;
  });
  await expect(changed.scope(() => runCommand(pool, options, async () => response(1)))).rejects.toBeInstanceOf(
    CommandDispatchLifetimeError,
  );
  const replaced = fixture();
  replaced.afterReserve(() => {
    (replaced.owner as { original: object }).original = {};
  });
  await expect(replaced.run()).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
  expect(observer.records).toHaveLength(0);
});

test('independent callbacks cannot overlap on the same Source original', async () => {
  const f = fixture();
  const entered = barrier();
  const hold = barrier();
  const first = f.run(async () => {
    entered.release();
    await hold.waiting;
    return response(1);
  });
  await entered.waiting;
  try {
    await expect(f.run()).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
  } finally {
    hold.release();
  }
  await first;
  expect(f.reservations()).toBe(1);
});

test('late callback registration during the final setting cannot acquire unsupported effect authority', async () => {
  const f = fixture();
  const observer = observe();
  const now = spyOn(Date, 'now').mockReturnValue(f.deadline - 30_000);
  const held = observer.hold({ statement: "SET LOCAL statement_timeout = '30000ms'", occurrence: 2 }, 'after');
  let late!: Promise<unknown>;
  let invoked = false;
  const resume = barrier();
  try {
    const command = f.run(async (tx) => {
      late = failed(
        (async () => {
          await resume.waiting;
          registerCommandCallback(tx, () => {
            invoked = true;
          });
        })(),
      );
      return response(1);
    });
    await held.entered;
    resume.release();
    expect(await late).toBeInstanceOf(TypeError);
    held.release();
    await command;
    expect(invoked).toBe(false);
  } finally {
    held.release();
    now.mockRestore();
  }
});
