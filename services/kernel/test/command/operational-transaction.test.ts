import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  authoritativeTimeValue,
  commandTime,
  currentCommand,
  hasLiveCommandTransaction,
  hasOwnCommandCompletion,
  principalCommandIdentity,
  registerCommandCallback,
  type AuthoritativeTime,
  type CommandAuthorization,
} from '../../src/command/command.ts';
import {
  enqueueIntent,
  hasLiveOperationalTransaction,
  runOperationalTransaction,
  type OperationalOptions,
  type OperationalTransaction,
} from '../../src/command/operational.ts';
import { shareAccount } from '../../src/access/account-share.ts';
import { LifecycleDeniedError } from '../../src/access/lifecycle-20261025094010-command.ts';
import { CommandUnavailableError } from '../../src/access/unavailable.ts';
import { problemResponse } from '../../src/http/problem.ts';
import { capture } from '../support/growth.ts';
import { Denied, operationalFixture, workflowName } from './support/operational-fixture.ts';

let native: Awaited<ReturnType<typeof operationalFixture>>;
const partition = 3100;
beforeAll(async () => {
  native = await operationalFixture(partition);
  await native.db.admin.query(
    'CREATE TABLE public.operational_derived(key text PRIMARY KEY, applied boolean NOT NULL DEFAULT false)',
  );
});
afterAll(async () => {
  await native?.close();
});
const key = () => `operational:${crypto.randomUUID()}`;
const intent = (id: string) => ({
  queue: 'workflows' as const,
  workflowName,
  workflowId: id,
  input: { key: id, partition, accounts: native.accounts },
});
async function prepare(tx: OperationalTransaction, id: string) {
  const result = await tx.query(
    'INSERT INTO public.operational_derived(key) VALUES($1) ON CONFLICT DO NOTHING RETURNING key',
    [id],
  );
  if (result.rowCount) await enqueueIntent(tx, intent(id));
  return result.rowCount === 1;
}
async function absent(id: string) {
  expect((await native.db.admin.query('SELECT key FROM public.operational_derived WHERE key=$1', [id])).rows).toEqual(
    [],
  );
  expect(
    (await native.db.admin.query('SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid=$1', [id])).rows,
  ).toEqual([]);
  expect(
    (await native.db.admin.query('SELECT workflow_uuid FROM dbos.workflow_input WHERE workflow_uuid=$1', [id])).rows,
  ).toEqual([]);
}
async function snapshot() {
  return (
    await native.db.admin.query(`SELECT
    (SELECT jsonb_agg(p) FROM core.partition p) AS partitions,
    (SELECT count(*)::int FROM core.receipt) AS receipts,
    (SELECT count(*)::int FROM core.outbox) AS outbox,
    (SELECT count(*)::int FROM editorial.write_basis) AS basis`)
  ).rows;
}
function processFixture(mode = 'runtime', id?: string) {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/support/operational-runtime.ts`, mode], {
    env: { ...process.env, ...(id ? { OPERATIONAL_INPUT: JSON.stringify(intent(id).input) } : {}) },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const listeners = new Set<() => void>();
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk);
      for (const listener of listeners) listener();
    }
  })();
  const errors = new Response(child.stderr).text();
  return {
    child,
    async until(marker: string) {
      await Promise.race([
        new Promise<void>((resolve) => {
          const observe = () => {
            if (output.includes(marker)) {
              listeners.delete(observe);
              resolve();
            }
          };
          listeners.add(observe);
          observe();
        }),
        child.exited.then(async () => {
          throw new Error(`Child exited before ${marker}: ${output}\n${await errors}`);
        }),
      ]);
    },
    async stop() {
      child.stdin.write('stop\n');
      child.stdin.end();
      expect(await child.exited).toBe(0);
      await reading;
      expect(await errors).not.toContain('AssertionError');
    },
    async kill() {
      child.kill('SIGKILL');
      await child.exited;
      await reading;
      await errors;
    },
  };
}

test('Access request commits only derived records and DBOS rows, with distinct live capabilities and native runtime execution', async () => {
  const id = key();
  const options = await native.request();
  const before = await snapshot();
  let saved: OperationalTransaction | undefined;
  let time: AuthoritativeTime | undefined;
  const order: string[] = [];
  const authorization: CommandAuthorization = {
    ...options.authorization!,
    async prepare(attempt) {
      order.push('prepare');
      expect(native.db.pool.idleCount).toBe(native.db.pool.totalCount);
      time = attempt.time;
      return options.authorization!.prepare!(attempt);
    },
    async authorize(tx, attempt, evidence) {
      order.push('authorize');
      expect(commandTime(tx)).toBe(time);
      expect(hasLiveCommandTransaction(tx)).toBe(false);
      return options.authorization!.authorize(tx, attempt, evidence);
    },
    async finalize(tx) {
      order.push('finalize');
      expect(commandTime(tx)).toBe(time);
    },
  };
  const measured = await capture(
    native.db,
    () =>
      runOperationalTransaction(native.db.pool, { ...options, authorization }, async (tx) => {
        order.push('body');
        saved = tx;
        expect(hasLiveOperationalTransaction(tx)).toBe(true);
        expect(hasLiveOperationalTransaction({ query: tx.query })).toBe(false);
        expect(hasLiveCommandTransaction(tx)).toBe(false);
        expect(() => currentCommand(tx)).toThrow(TypeError);
        expect(() => registerCommandCallback(tx, () => {})).toThrow(TypeError);
        await expect(
          hasOwnCommandCompletion(tx, { kind: 'test', key: id, digest: new Uint8Array(32) }),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(shareAccount(tx, native.accounts[0]!)).rejects.toBeInstanceOf(LifecycleDeniedError);
        expect(() => (tx as unknown as { emitEvent(): void }).emitEvent()).toThrow(TypeError);
        expect(authoritativeTimeValue(commandTime(tx)!)).toBeString();
        const settings = await tx.query(
          `SELECT current_setting('transaction_isolation') AS isolation, current_setting('lock_timeout') AS lock`,
        );
        expect(settings.rows).toEqual([{ isolation: 'serializable', lock: '200ms' }]);
        return prepare(tx, id);
      }),
    { includeBackends: true },
  );
  expect(measured.value).toBe(true);
  expect(order).toEqual(['prepare', 'authorize', 'body', 'finalize']);
  expect(await snapshot()).toEqual(before);
  expect(hasLiveOperationalTransaction(saved!)).toBe(false);
  expect(commandTime(saved!)).toBeUndefined();
  expect(() => authoritativeTimeValue(time!)).toThrow(TypeError);
  await expect(enqueueIntent(saved!, intent(key()))).rejects.toBeInstanceOf(TypeError);
  const writes = measured.capture.statements.filter((sql) => /\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/i.test(sql));
  expect(writes).toHaveLength(3);
  expect(writes[0]).toContain('public.operational_derived');
  expect(writes[1]).toContain('"dbos".workflow_status');
  expect(writes[2]).toContain('"dbos".workflow_input');
  const backends = writes.map((sql) => measured.capture.statementBackends![measured.capture.statements.indexOf(sql)]);
  expect(new Set(backends).size).toBe(1);
  expect(measured.capture.statements.filter((sql) => /FROM access.account[\s\S]*FOR SHARE/i.test(sql))).toHaveLength(2);
  const handle = native.workClient.retrieveWorkflow(id);
  expect((await handle.getStatus())?.status).toBe('ENQUEUED');
  const runtime = processFixture();
  try {
    await runtime.until('ready');
    expect(await handle.getResult()).toBe('applied');
    expect(
      (await native.db.admin.query('SELECT applied FROM public.operational_derived WHERE key=$1', [id])).rows,
    ).toEqual([{ applied: true }]);
    await runtime.stop();
  } finally {
    await runtime.kill();
  }
}, 30_000);

test('body errors, finalizer errors and deadline expiry after enqueue roll back both records', async () => {
  for (const failure of ['body', 'finalizer', 'deadline'] as const) {
    const id = key();
    const deadline = Date.now() + 5000;
    const options = await native.request(native.actor, deadline);
    const error = new Error(failure);
    const previousNow = Date.now;
    let saved: OperationalTransaction | undefined;
    try {
      await expect(
        runOperationalTransaction(
          native.db.pool,
          {
            ...options,
            authorization: {
              ...options.authorization!,
              async finalize() {
                if (failure === 'finalizer') throw error;
              },
            },
          },
          async (tx) => {
            saved = tx;
            await prepare(tx, id);
            if (failure === 'deadline') {
              Date.now = () => deadline + 1;
              return;
            }
            if (failure === 'body') throw error;
          },
        ),
      ).rejects.toBeInstanceOf(failure === 'deadline' ? CommandUnavailableError : Error);
    } finally {
      Date.now = previousNow;
    }
    expect(hasLiveOperationalTransaction(saved!)).toBe(false);
    await absent(id);
  }
});

test('missing permission, mismatched principal, receipt-only and expired request deny before a write', async () => {
  let calls = 0;
  const denied = await capture(native.db, async () => {
    await expect(
      runOperationalTransaction(native.db.pool, await native.request(native.restricted), async () => {
        calls++;
      }),
    ).rejects.toBeInstanceOf(Denied);
    const options = await native.request();
    await expect(
      runOperationalTransaction(
        native.db.pool,
        {
          ...options,
          principal: { kind: 'account', id: native.accounts[1]! },
        },
        async () => {
          calls++;
        },
      ),
    ).rejects.toBeInstanceOf(Denied);
    await expect(
      runOperationalTransaction(
        native.db.pool,
        {
          ...options,
          authorization: {
            ...options.authorization!,
            async authorize() {
              return 'receipt-only';
            },
          },
        },
        async () => {
          calls++;
        },
      ),
    ).rejects.toBeInstanceOf(Denied);
    const error = await runOperationalTransaction(
      native.db.pool,
      { ...options, deadline: Date.now() - 1 },
      async () => {
        calls++;
      },
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CommandUnavailableError);
    expect(problemResponse(error, { method: 'GET', id: 'operational' }).status).toBe(503);
  });
  expect(calls).toBe(0);
  expect(denied.capture.statements.some((sql) => /\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/i.test(sql))).toBe(false);
});

test('terminally fenced, inactive and missing accounts refuse before either mode body; inactive partitions are typed unavailable', async () => {
  const account = native.accounts[1]!; // The actor remains active, so Access itself does not obscure this fence.
  for (const state of ['authn_fenced=true', "state='suspended'", "state='deleted'"]) {
    await native.db.admin.query(`UPDATE access.account SET ${state} WHERE account_id=$1`, [account]);
    try {
      for (const options of [await native.request(), native.step]) {
        const id = key();
        let called = false;
        await expect(
          runOperationalTransaction(native.db.pool, options, async (tx) => {
            called = true;
            await prepare(tx, id);
          }),
        ).rejects.toBeInstanceOf(LifecycleDeniedError);
        expect(called).toBe(false);
        await absent(id);
      }
    } finally {
      await native.db.admin.query("UPDATE access.account SET state='active',authn_fenced=false WHERE account_id=$1", [
        account,
      ]);
    }
  }
  await native.db.admin.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [partition]);
  try {
    for (const options of [await native.request(), native.step]) {
      let called = false;
      const error = await runOperationalTransaction(native.db.pool, options, async () => {
        called = true;
      }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CommandUnavailableError);
      expect(called).toBe(false);
      expect(problemResponse(error, { method: 'GET', id: 'operational' }).status).toBe(503);
    }
  } finally {
    await native.db.admin.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [partition]);
  }
});

test('concurrent same-key preparations retry serialization and commit exactly one derived row and workflow', async () => {
  const id = key();
  const secondPool = native.db.openPool();
  const ready = Promise.withResolvers<void>();
  let arrivals = 0;
  let attempts = 0;
  const body = async (tx: OperationalTransaction) => {
    attempts++;
    await tx.query('SELECT key FROM public.operational_derived WHERE key=$1', [id]);
    if (++arrivals <= 2) {
      if (arrivals === 2) ready.resolve();
      await ready.promise;
    }
    return prepare(tx, id);
  };
  const results = await Promise.all([
    runOperationalTransaction(native.db.pool, await native.request(), body),
    runOperationalTransaction(secondPool, await native.request(), body),
  ]);
  expect(results.sort()).toEqual([false, true]);
  expect(attempts).toBeGreaterThan(2);
  expect((await native.db.admin.query('SELECT key FROM public.operational_derived WHERE key=$1', [id])).rowCount).toBe(
    1,
  );
  expect(
    (await native.db.admin.query('SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid=$1', [id]))
      .rowCount,
  ).toBe(1);
  expect(
    (await native.db.admin.query('SELECT workflow_uuid FROM dbos.workflow_input WHERE workflow_uuid=$1', [id]))
      .rowCount,
  ).toBe(1);
}, 15_000);

test('deterministic workflow ids return existing input; conflicting name or queue and account input mismatch raise', async () => {
  const id = key();
  await runOperationalTransaction(native.db.pool, await native.request(), async (tx) => {
    await prepare(tx, id);
    await enqueueIntent(tx, intent(id));
  });
  for (const change of [
    { workflowName: 'test.other' },
    { queue: 'maintenance' as const },
    { input: { accounts: [] } },
  ]) {
    const row = key();
    await expect(
      runOperationalTransaction(native.db.pool, await native.request(), async (tx) => {
        await tx.query('INSERT INTO public.operational_derived(key) VALUES($1)', [row]);
        await enqueueIntent(tx, { ...intent(id), ...change });
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await absent(row);
  }
});

test('a real producer crash before pickup survives a stopped runtime and runs after restart; a subsequently fenced account refuses work-step apply', async () => {
  const initial = processFixture();
  try {
    await initial.until('ready');
    await initial.stop();
  } finally {
    await initial.kill();
  }
  const recovered = key();
  const producer = processFixture('produce', recovered);
  try {
    await producer.until('committed');
  } finally {
    await producer.kill();
  }
  expect((await native.workClient.retrieveWorkflow(recovered).getStatus())?.status).toBe('ENQUEUED');
  const refused = key();
  await runOperationalTransaction(native.db.pool, await native.request(), (tx) => prepare(tx, refused));
  await native.db.admin.query('UPDATE access.account SET authn_fenced=true WHERE account_id=$1', [native.accounts[1]]);
  const runtime = processFixture();
  try {
    await runtime.until('ready');
    expect(await native.workClient.retrieveWorkflow(refused).getResult()).toBe('refused');
    expect(await native.workClient.retrieveWorkflow(recovered).getResult()).toBe('refused');
    expect(
      (
        await native.db.admin.query('SELECT applied FROM public.operational_derived WHERE key=ANY($1)', [
          [recovered, refused],
        ])
      ).rows,
    ).toEqual([{ applied: false }, { applied: false }]);
    await runtime.stop();
  } finally {
    await runtime.kill();
    await native.db.admin.query('UPDATE access.account SET authn_fenced=false WHERE account_id=$1', [
      native.accounts[1],
    ]);
  }
  // A separate process crash with live fences proves successful recovery as well.
  const successful = key();
  const nextProducer = processFixture('produce', successful);
  try {
    await nextProducer.until('committed');
  } finally {
    await nextProducer.kill();
  }
  const restarted = processFixture();
  try {
    await restarted.until('ready');
    expect(await native.workClient.retrieveWorkflow(successful).getResult()).toBe('applied');
    await restarted.stop();
  } finally {
    await restarted.kill();
  }
}, 60_000);

test('option validation rejects anonymous, foreign partitions, unbounded fences and nonprintable operation kinds', async () => {
  const options = await native.request();
  const invalid = [
    { kind: '' },
    { kind: 'x'.repeat(256) },
    { kind: 'line\nbreak' },
    { kind: 'é' },
    { accounts: [...native.accounts, native.actor.accountId] },
    { accounts: ['invalid'] },
    { ...principalCommandIdentity({ kind: 'anonymous' }) },
    { partition: partition + 1 },
    { authorization: undefined },
    { mode: 'work-step' },
  ];
  for (const change of invalid) {
    let called = false;
    await expect(
      runOperationalTransaction(native.db.pool, { ...options, ...change } as OperationalOptions, async () => {
        called = true;
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(called).toBe(false);
  }
});
