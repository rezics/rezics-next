import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  CommandUnavailableError,
  authoritativeTimeValue,
  currentCommand,
  currentCommandResources,
  currentCommandReceipt,
  hasLiveCommandTransaction,
  hasOwnCommandCompletion,
  noEffect,
  registerCommandCallback,
  runCommand,
  withSingleCommandAttempt,
  type CommandTransaction,
} from '../../src/command/command.ts';
import {
  COMMAND_DISPATCH_ALLOWANCE,
  COMMAND_DISPATCH_CONTROLS,
  COMMAND_DISPATCH_TIME_SQL,
  CommandDispatchLifetimeError,
  withCommandDispatchLifetime,
  type CommandDispatchAllowance,
  type CommandDispatchOwner,
} from '../../src/command/dispatch-lifetime.ts';
import { createPool } from '../../src/database/pool.ts';
import { NativeCollectionWork } from '../../src/work-ledger/native-collection-work.ts';
import { declareCommandRecordSources } from '../../src/history/record-source.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';
import { observeSql, type SqlObserver } from '../content/support/sql-observer.ts';

// Native Core outcomes, using the installed executor and private transaction maps.
// The fixture's callback and real ledger exercise the owner port; they are NOT an
// Accounts original grant or proof of Source/Library/History receiving authority.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const foreign = createPool(url);
const admin = new Pool({ connectionString: url, max: 2 });
const partition = 3553;
const begin = 'BEGIN ISOLATION LEVEL SERIALIZABLE';
const lock = "SET LOCAL lock_timeout = '200ms'";
const bodySQL = 'SELECT pg_backend_pid() AS pid';
const observers: SqlObserver[] = [];
const observe = () => {
  const observer = observeSql(pool);
  observers.push(observer);
  return observer;
};
const texts = (observer: SqlObserver) => observer.records.map((record) => record.statement);
const failed = <T>(operation: Promise<T>) =>
  operation.then(
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
function ownerFixture(statements = COMMAND_DISPATCH_ALLOWANCE.total.work.statements) {
  const original = Object.freeze({});
  const deadline = Date.now() + 30_000;
  const ledger = new NativeCollectionWork(
    {
      reservationId: randomUUID(),
      remaining: {
        ...COMMAND_DISPATCH_ALLOWANCE.total.work,
        statements,
      },
    },
    deadline,
  );
  let live = true;
  let reservations = 0;
  let afterReservation: (() => void | Promise<void>) | undefined;
  const owner: CommandDispatchOwner = {
    original,
    validate() {
      if (!live || ownerContext.getStore() !== original) throw new Error('selected original revoked or escaped');
    },
    async reserve(allowance: CommandDispatchAllowance) {
      expect(allowance).toBe(COMMAND_DISPATCH_ALLOWANCE);
      reservations++;
      const held = ledger.reserve(allowance.total.work);
      held.dispatch();
      held.settle();
      await afterReservation?.();
    },
  };
  const scope = <T>(callback: () => Promise<T>) =>
    ownerContext.run(original, () => withCommandDispatchLifetime(pool, deadline, owner, callback));
  const run = <T>(body: (tx: CommandTransaction) => Promise<T>) =>
    scope(() =>
      withSingleCommandAttempt(() => runCommand(pool, { partition, deadline }, async (tx) => noEffect(await body(tx)))),
    );
  return {
    original,
    owner,
    deadline,
    ledger,
    scope,
    run,
    revoke: () => {
      live = false;
    },
    afterReserve: (hook: () => void | Promise<void>) => {
      afterReservation = hook;
    },
    reservations: () => reservations,
  };
}
beforeAll(async () => {
  configureTestReceiptKeys(pool);
  await admin.query(`INSERT INTO core.partition(partition_no,node) VALUES($1,'local') ON CONFLICT DO NOTHING`, [
    partition,
  ]);
  await admin.query('CREATE TABLE public.dispatch_lifetime_probe(id uuid PRIMARY KEY)');
});
afterEach(async () => {
  for (const observer of observers.splice(0)) await observer.close();
  await admin.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=$1", [partition]);
  await admin.query('TRUNCATE public.dispatch_lifetime_probe');
});
afterAll(async () => {
  await admin.query('DROP TABLE public.dispatch_lifetime_probe');
  await pool.end();
  await foreign.end();
  await admin.end();
});

async function snapshot() {
  return (
    await admin.query(
      `SELECT to_jsonb(p) AS head,
    (SELECT count(*)::int FROM core.receipt WHERE partition_no=$1) AS receipts,
    (SELECT count(*)::int FROM core.outbox WHERE partition_no=$1) AS events,
    (SELECT count(*)::int FROM editorial.write_basis WHERE partition_no=$1) AS basis
    FROM core.partition p WHERE partition_no=$1`,
      [partition],
    )
  ).rows;
}

test('selected original prepays every raw control and encloses the exact native tx through fence and COMMIT', async () => {
  const before = await snapshot();
  const f = ownerFixture();
  const observer = observe();
  f.afterReserve(() => {
    expect(observer.records).toHaveLength(0);
  });
  let escaped!: CommandTransaction;
  const outcome = await f.run(async (tx) => {
    escaped = tx;
    expect(currentCommandResources(tx)).toEqual({ pool, deadline: f.deadline });
    expect(currentCommand(tx).authorization).toBeNull();
    expect(authoritativeTimeValue(currentCommand(tx).time)).toMatch(/Z$/);
    expect(hasLiveCommandTransaction(tx)).toBe(true);
    expect(() => currentCommandReceipt(tx)).toThrow();
    const copy = { ...tx };
    // Even reflecting the old callback symbol cannot copy its native association.
    for (const symbol of Object.getOwnPropertySymbols(tx))
      Object.defineProperty(copy, symbol, Object.getOwnPropertyDescriptor(tx, symbol)!);
    expect(() => currentCommand(copy)).toThrow();
    expect(() => currentCommandResources(copy)).toThrow();
    expect(() => registerCommandCallback(copy, () => {})).toThrow();
    expect(hasLiveCommandTransaction(copy)).toBe(false);
    await expect(copy.query('SELECT 999')).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
    await expect(
      hasOwnCommandCompletion(copy, { kind: 'test', key: 'x', digest: new Uint8Array(32) }),
    ).rejects.toThrow();
    return (await tx.query<{ pid: number }>(bodySQL)).rows[0]!.pid;
  });
  expect(outcome.value).toBe(observer.records[0]!.connectionId);
  expect(new Set(observer.records.map((record) => record.connectionId)).size).toBe(1);
  const sql = texts(observer);
  expect(sql[0]).toBe(begin);
  expect(sql[1]).toBe(lock);
  expect(sql[2]).toMatch(/^SET LOCAL statement_timeout = '\d+ms'$/);
  expect(sql[3]).toBe(COMMAND_DISPATCH_TIME_SQL);
  expect(sql[4]).toBe(bodySQL);
  expect(sql[5]).toMatch(/^SET LOCAL statement_timeout = '\d+ms'$/);
  expect(sql[6]).toContain('FOR SHARE OF p');
  expect(sql[7]).toBe('COMMIT');
  expect(sql).toHaveLength(8); // seven executor SQL controls plus the separately owned body query
  expect(f.reservations()).toBe(1);
  expect(f.ledger.receipt().used).toEqual(COMMAND_DISPATCH_ALLOWANCE.total.work);
  expect(await snapshot()).toEqual(before);
  expect(() => currentCommand(escaped)).toThrow();
  expect(hasLiveCommandTransaction(escaped)).toBe(false);
  await expect(escaped.query('SELECT 999')).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
  expect(texts(observer)).toEqual(sql);
});

test('wrong Pool, changed deadline, actor and receipt profiles refuse without checkout or reservation', async () => {
  const observer = observe();
  for (const changed of ['pool', 'deadline', 'actor', 'receipt', 'authorization', 'clock']) {
    const f = ownerFixture();
    const options = {
      partition,
      deadline: f.deadline,
      ...(changed === 'deadline' ? { deadline: f.deadline + 1 } : {}),
      ...(changed === 'actor' ? { basis: { actorAccountId: randomUUID(), clientId: 'test', requestedBy: null } } : {}),
      ...(changed === 'receipt'
        ? { receipt: { actorAccountId: randomUUID(), kind: 'test', key: 'x', digest: new Uint8Array(32) } }
        : {}),
      ...(changed === 'clock' ? { clock: () => new Date() } : {}),
      ...(changed === 'authorization'
        ? {
            authorization: {
              action: 'test',
              resource: { route: 0, id: randomUUID() },
              authorize: async () => 'execute' as const,
              denied: () => new Error('denied'),
            },
          }
        : {}),
    };
    await expect(
      f.scope(() => runCommand(changed === 'pool' ? foreign : pool, options, async () => noEffect(1))),
    ).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
    expect(f.reservations()).toBe(0);
  }
  expect(observer.records).toHaveLength(0);
});

test('insufficient complete control allowance refuses before BEGIN; a late reservation cannot dispatch', async () => {
  const observer = observe();
  const short = ownerFixture(COMMAND_DISPATCH_ALLOWANCE.total.work.statements - 1);
  await expect(short.run(async () => 1)).rejects.toThrow();
  expect(observer.records).toHaveLength(0);
  const revoked = ownerFixture();
  revoked.afterReserve(async () => {
    await Promise.resolve();
    revoked.revoke();
  });
  await expect(revoked.run(async () => 1)).rejects.toThrow('selected original revoked');
  expect(observer.records).toHaveLength(0);
  expect(revoked.ledger.receipt().used).toEqual(COMMAND_DISPATCH_ALLOWANCE.total.work);
});

test('expired or replaced owner and changed input after reservation refuse before any native dispatch', async () => {
  const observer = observe();
  const revoked = ownerFixture();
  revoked.revoke();
  await expect(revoked.run(async () => 1)).rejects.toThrow('selected original revoked');
  expect(revoked.reservations()).toBe(0);
  const expired = ownerFixture();
  const expiredNow = spyOn(Date, 'now').mockReturnValue(expired.deadline);
  try {
    await expect(expired.run(async () => 1)).rejects.toThrow('deadline');
  } finally {
    expiredNow.mockRestore();
  }
  const replaced = ownerFixture();
  replaced.afterReserve(() => {
    (replaced.owner as { original: object }).original = {};
  });
  await expect(replaced.run(async () => 1)).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
  const changed = ownerFixture();
  const options = { partition, deadline: changed.deadline };
  changed.afterReserve(() => {
    options.deadline++;
  });
  await expect(changed.scope(() => runCommand(pool, options, async () => noEffect(1)))).rejects.toBeInstanceOf(
    CommandDispatchLifetimeError,
  );
  expect(observer.records).toHaveLength(0);
});

test('a late owner callback result and a swallowed failed command cannot manufacture scope success', async () => {
  const late = ownerFixture();
  await expect(
    late.scope(async () => {
      const answer = await runCommand(pool, { partition, deadline: late.deadline }, async () => noEffect(1));
      late.revoke();
      await Promise.resolve();
      return answer;
    }),
  ).rejects.toThrow('selected original revoked');
  const swallowed = ownerFixture();
  await expect(
    swallowed.scope(async () => {
      await failed(
        runCommand(pool, { partition, deadline: swallowed.deadline }, async () => {
          throw new Error('failed');
        }),
      );
      return 1;
    }),
  ).rejects.toThrow('successful settled command');
});

test('post-checkout revocation releases the authentic client without BEGIN', async () => {
  const f = ownerFixture();
  const observer = observe();
  const connect = pool.connect.bind(pool);
  const spy = spyOn(pool, 'connect').mockImplementation((async () => {
    const client = await connect();
    f.revoke();
    return client;
  }) as Pool['connect']);
  try {
    await expect(f.run(async () => 1)).rejects.toThrow('selected original revoked');
  } finally {
    spy.mockRestore();
  }
  expect(observer.records).toHaveLength(0);
  expect(pool.waitingCount).toBe(0);
});

for (const statement of [begin, lock, COMMAND_DISPATCH_TIME_SQL, bodySQL]) {
  test(`revocation after awaited ${statement.split('\n')[0]} refuses the next effect and retains paid cleanup`, async () => {
    const f = ownerFixture();
    const observer = observe();
    const held = observer.hold({ statement }, 'after');
    const outcome = failed(
      f.run(async (tx) => {
        await tx.query(bodySQL);
        return 1;
      }),
    );
    await held.entered;
    f.revoke();
    held.release();
    expect(await outcome).toBeInstanceOf(Error);
    expect(texts(observer).at(-1)).toBe('ROLLBACK');
    expect(texts(observer).filter((sql) => sql === 'ROLLBACK')).toHaveLength(1);
    expect(texts(observer)).not.toContain('COMMIT');
    const reached = texts(observer).indexOf(statement);
    expect(texts(observer)[reached + 1]).toBe('ROLLBACK');
    expect(f.ledger.receipt().used).toEqual(COMMAND_DISPATCH_ALLOWANCE.total.work);
  });
}

for (const occurrence of [1, 2]) {
  test(`revocation after awaited timeout setting ${occurrence} refuses the next control`, async () => {
    const f = ownerFixture();
    const now = spyOn(Date, 'now').mockReturnValue(f.deadline - 30_000);
    const observer = observe();
    const statement = "SET LOCAL statement_timeout = '30000ms'";
    const held = observer.hold({ statement, occurrence }, 'after');
    try {
      const outcome = failed(f.run(async () => 1));
      await held.entered;
      f.revoke();
      held.release();
      expect(await outcome).toBeInstanceOf(Error);
      expect(texts(observer).at(-1)).toBe('ROLLBACK');
      expect(texts(observer).filter((sql) => sql === statement)).toHaveLength(occurrence);
      expect(texts(observer)).not.toContain('COMMIT');
    } finally {
      held.release();
      now.mockRestore();
    }
  });
}

test('revocation after the real no-effect fence refuses finalization and COMMIT', async () => {
  const observer = observe();
  // Learn the actual mapped SQL from a native ordinary attempt, not a replacement
  // executor or a hand-written copy of its fence.
  await runCommand(pool, { partition }, async () => noEffect(0));
  const fence = observer.records.find((record) => record.statement.includes('FOR SHARE OF p'))!.statement;
  const offset = observer.records.length;
  const f = ownerFixture();
  const held = observer.hold({ statement: fence }, 'after');
  const outcome = failed(f.run(async () => 1));
  await held.entered;
  f.revoke();
  held.release();
  expect(await outcome).toBeInstanceOf(Error);
  const selected = texts(observer).slice(offset);
  expect(selected.at(-1)).toBe('ROLLBACK');
  expect(selected).not.toContain('COMMIT');
  expect(f.reservations()).toBe(1);
});

test('expiry after awaited body work rejects before final setting/fence and uses the held rollback', async () => {
  const f = ownerFixture();
  const observer = observe();
  const body = barrier();
  const entered = barrier();
  const outcome = failed(
    f.run(async () => {
      entered.release();
      await body.waiting;
      return 1;
    }),
  );
  await entered.waiting;
  const now = spyOn(Date, 'now').mockReturnValue(f.deadline);
  try {
    body.release();
    expect(await outcome).toBeInstanceOf(CommandDispatchLifetimeError);
  } finally {
    now.mockRestore();
  }
  expect(texts(observer).at(-1)).toBe('ROLLBACK');
  expect(texts(observer)).toHaveLength(5);
  expect(f.reservations()).toBe(1);
});

test('a returned callback closes an in-flight descendant and waits only for its existing cleanup', async () => {
  const f = ownerFixture();
  const observer = observe();
  const held = observer.hold({ statement: bodySQL }, 'after');
  let child!: Promise<unknown>;
  const returned = barrier();
  const scope = failed(
    f.scope(async () => {
      child = failed(
        runCommand(pool, { partition, deadline: f.deadline }, async (tx) => {
          await tx.query(bodySQL);
          return noEffect(1);
        }),
      );
      await held.entered;
      returned.release();
      return 7;
    }),
  );
  await returned.waiting;
  // Let the callback return and close; the already dispatched query can now settle.
  await Promise.resolve();
  await Promise.resolve();
  held.release();
  expect(await scope).toBeInstanceOf(CommandDispatchLifetimeError);
  expect(await child).toBeInstanceOf(CommandDispatchLifetimeError);
  expect(texts(observer).at(-1)).toBe('ROLLBACK');
  expect(texts(observer)).not.toContain('COMMIT');
});

test('unawaited or concurrent body queries and callback query overloads cannot escape to finalization', async () => {
  const f = ownerFixture();
  const observer = observe();
  const held = observer.hold({ statement: bodySQL }, 'after');
  let query!: Promise<unknown>;
  const result = failed(
    f.run(async (tx) => {
      query = failed(tx.query(bodySQL));
      await held.entered;
      await expect(tx.query('SELECT 999')).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
      return 1; // query is intentionally not awaited
    }),
  );
  await held.entered;
  // The body can finish and cleanup can settle while this completed native query's
  // response is held. Its late result must still be refused after closure.
  expect(await result).toBeInstanceOf(CommandDispatchLifetimeError);
  held.release();
  expect(await query).toBeInstanceOf(CommandDispatchLifetimeError);
  expect(texts(observer)).not.toContain('SELECT 999');
  expect(texts(observer)).not.toContain('COMMIT');
  const next = ownerFixture();
  await next.run(async (tx) => {
    await expect(
      Promise.resolve().then(() => tx.query({ text: 'SELECT 999', callback() {} } as never)),
    ).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
    return 1;
  });
  expect(texts(observer)).not.toContain('SELECT 999');
});

test('one association cannot be nested, reused, adopted concurrently or replayed after scope exit', async () => {
  const f = ownerFixture();
  const observer = observe();
  let escaped!: () => Promise<unknown>;
  await f.scope(async () => {
    await expect(withCommandDispatchLifetime(pool, f.deadline, f.owner, async () => 1)).rejects.toBeInstanceOf(
      CommandDispatchLifetimeError,
    );
    const hold = barrier();
    const entered = barrier();
    const first = runCommand(pool, { partition, deadline: f.deadline }, async () => {
      entered.release();
      await hold.waiting;
      return noEffect(1);
    });
    await entered.waiting;
    await expect(runCommand(pool, { partition, deadline: f.deadline }, async () => noEffect(2))).rejects.toBeInstanceOf(
      CommandDispatchLifetimeError,
    );
    hold.release();
    await first;
    await expect(runCommand(pool, { partition, deadline: f.deadline }, async () => noEffect(3))).rejects.toBeInstanceOf(
      CommandDispatchLifetimeError,
    );
    const resume = barrier();
    const pending = (async () => {
      await resume.waiting;
      return runCommand(pool, { partition, deadline: f.deadline }, async () => noEffect(4));
    })();
    // Attach a handler now so the intended rejection is never unhandled.
    const answer = failed(pending);
    escaped = () => {
      resume.release();
      return answer;
    };
    return 1;
  });
  expect(await escaped()).toBeInstanceOf(CommandDispatchLifetimeError);
  expect(texts(observer).filter((sql) => sql === begin)).toHaveLength(1);
  expect(f.reservations()).toBe(1);
});

test('independent callbacks cannot overlap on the same selected original', async () => {
  const f = ownerFixture();
  const entered = barrier();
  const hold = barrier();
  const first = f.run(async () => {
    entered.release();
    await hold.waiting;
    return 1;
  });
  await entered.waiting;
  try {
    await expect(
      f.scope(() => runCommand(pool, { partition, deadline: f.deadline }, async () => noEffect(2))),
    ).rejects.toBeInstanceOf(CommandDispatchLifetimeError);
  } finally {
    hold.release();
  }
  await first;
  expect(f.reservations()).toBe(1);
});

for (const statement of [begin, 'COMMIT']) {
  test(`failed ${statement} remains spent, never retries, and attempts only the separate rollback`, async () => {
    const f = ownerFixture();
    const observer = observe();
    const error = Object.assign(new Error('lost response'), { code: '40001' });
    observer.armFault({ match: { statement }, boundary: 'after', error });
    const id = randomUUID();
    const failure = await failed(
      f.run(async (tx) => {
        await tx.query('INSERT INTO public.dispatch_lifetime_probe VALUES($1)', [id]);
        return 1;
      }),
    );
    expect(failure).toBeInstanceOf(CommandUnavailableError);
    expect((failure as Error).cause).toBe(error);
    const persisted = await admin.query('SELECT id FROM public.dispatch_lifetime_probe WHERE id=$1', [id]);
    expect(persisted.rows).toHaveLength(statement === 'COMMIT' ? 1 : 0);
    expect(texts(observer).filter((sql) => sql === begin)).toHaveLength(1);
    expect(texts(observer).filter((sql) => sql === 'ROLLBACK')).toHaveLength(1);
    expect(texts(observer).at(-1)).toBe('ROLLBACK');
    expect(f.reservations()).toBe(1);
    expect(f.ledger.receipt().used).toEqual(COMMAND_DISPATCH_ALLOWANCE.total.work);
  });
}

test('effect failure preserves evidence, rollback failure discards the connection, with no replacement allowance', async () => {
  const f = ownerFixture();
  const observer = observe();
  const primary = new Error('body failed');
  const cleanup = new Error('cleanup failed');
  observer.armFault({ match: { statement: 'ROLLBACK' }, boundary: 'after', error: cleanup });
  const id = randomUUID();
  const result = await failed(
    f.run(async (tx) => {
      await tx.query('INSERT INTO public.dispatch_lifetime_probe VALUES($1)', [id]);
      throw primary;
    }),
  );
  expect((await admin.query('SELECT id FROM public.dispatch_lifetime_probe WHERE id=$1', [id])).rows).toHaveLength(0);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors).toEqual([primary, cleanup]);
  const broken = observer.records[0]!.connectionId;
  expect(f.reservations()).toBe(1);
  const next = await pool.query<{ pid: number }>(bodySQL);
  expect(next.rows[0]!.pid).not.toBe(broken);
  expect(texts(observer).filter((sql) => sql === 'ROLLBACK')).toHaveLength(1);
});

test('event, callback and native source profiles refuse before the final setting or source finalization', async () => {
  const observer = observe();
  const f = ownerFixture();
  await expect(
    f.scope(() =>
      runCommand(pool, { partition, deadline: f.deadline }, async () => ({
        value: 1,
        events: [{ type: 'com.rezics.test.happened.v1', data: {} }],
      })),
    ),
  ).rejects.toThrow('Unsupported dispatch lifetime');
  const callback = ownerFixture();
  await expect(
    callback.run(async (tx) => {
      registerCommandCallback(tx, () => {
        throw new Error('unpriced');
      });
      return 1;
    }),
  ).rejects.toThrow('Unsupported dispatch lifetime');
  const source = ownerFixture();
  await expect(
    source.run(async (tx) => {
      declareCommandRecordSources(tx, [{ kind: 'context', contextId: 'de110000-0000-4000-8000-000000000001' }]);
      return 1;
    }),
  ).rejects.toThrow('Unsupported dispatch lifetime');
  expect(texts(observer)).not.toContain('COMMIT');
  expect(texts(observer).filter((sql) => /SET LOCAL statement_timeout/.test(sql))).toHaveLength(3);
  expect(texts(observer).some((sql) => sql.includes('record_history_locator'))).toBe(false);
});

test('empty native fence remains one keyed seek and a single attempt with paid rollback and no writable wait', async () => {
  const f = ownerFixture();
  await admin.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [partition]);
  const observer = observe();
  await expect(f.run(async () => 1)).rejects.toThrow();
  expect(texts(observer).filter((sql) => sql === begin)).toHaveLength(1);
  expect(texts(observer).at(-1)).toBe('ROLLBACK');
  expect(texts(observer)).not.toContain('COMMIT');
  expect(texts(observer).filter((sql) => sql.includes('FOR SHARE OF p'))).toHaveLength(1);
  expect(texts(observer)).toHaveLength(7);
});

test('ordinary commands retain native context, authorization-before-receipt, denied replay and no-effect event prohibition', async () => {
  const receipt = {
    actorAccountId: randomUUID(),
    kind: 'test.dispatch.ordinary',
    key: randomUUID(),
    digest: new Uint8Array(32),
  };
  let authorized = 0;
  const options = {
    partition,
    receipt,
    authorization: {
      action: 'test',
      resource: { route: partition << 4, id: randomUUID() },
      async authorize() {
        authorized++;
        return 'execute' as const;
      },
      denied: () => new Error('denied'),
    },
  };
  const original = await runCommand(pool, options, async (tx) => {
    expect(currentCommandResources(tx).pool).toBe(pool);
    expect(hasLiveCommandTransaction(tx)).toBe(true);
    return noEffect(17);
  });
  const replay = await runCommand(pool, options, async () => {
    throw new Error('replayed body');
  });
  expect(replay).toEqual({ ...original, replayed: true });
  expect(authorized).toBe(2);
  const observer = observe();
  await expect(
    runCommand(
      pool,
      {
        ...options,
        authorization: {
          ...options.authorization,
          async authorize(): Promise<never> {
            throw new Error('denied');
          },
        },
      },
      async () => noEffect(0),
    ),
  ).rejects.toThrow('denied');
  expect(texts(observer).some((sql) => sql.includes('FROM core.receipt'))).toBe(false);
  await expect(runCommand(pool, { partition }, async () => ({ value: 1, events: [] }))).rejects.toThrow(
    'at least one event',
  );
  await expect(
    runCommand(pool, { partition }, async (tx) => {
      registerCommandCallback(tx, () => {});
      return noEffect(0);
    }),
  ).rejects.toThrow('no-effect command registers no work');
});

// Literal derivation assertions are authored alongside native outcomes, not physical proof.
test('complete allowance includes the independent cleanup slot, scalar projections and empty partition seek', () => {
  expect(COMMAND_DISPATCH_ALLOWANCE.effect.work).toEqual({
    candidateKeys: 0,
    nativeRows: 2,
    identityMetadataRows: 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 7,
    bytes: 169,
    emptySeeks: 1,
  });
  expect(COMMAND_DISPATCH_ALLOWANCE.total.work.statements).toBe(8);
  expect(COMMAND_DISPATCH_ALLOWANCE.cleanup).toBe(COMMAND_DISPATCH_CONTROLS.cleanupRollback);
  expect(COMMAND_DISPATCH_ALLOWANCE.total.engineRequests).toBe(0);
  expect(Object.isFrozen(COMMAND_DISPATCH_CONTROLS)).toBe(true);
});
