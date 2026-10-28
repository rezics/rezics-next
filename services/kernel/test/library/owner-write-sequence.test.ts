import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { shareAccount } from '../../src/access/account-share.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  noEffect,
  runCommand,
  type CommandEvent,
  type CommandTransaction,
} from '../../src/command/command.ts';
import { createLibraryCommandRunner, type LibraryCommandBody } from '../../src/library/command-support.ts';
import { allocateOwnerWriteSeq } from '../../src/library/owner-write-sequence.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { createProfileEntryFixture } from './support/profile-entry-fixture.ts';

const db = await openGrowthDatabase();
const accounts = { owner: newId(0x6d10), neighbour: newId(0x6d11), other: newId(0x6e20), fresh: newId(0x6f30) };
const action = 'library_entry:update',
  at = new Date();
const real = await createRealAccess(db.admin, accounts, [action]);
const access = real.access({ actions: new Map([[action, { anonymous: false }]]) });
const actors = await Promise.all(
  Object.keys(accounts).map(async (persona) =>
    access.authenticate(real.bearer(persona as keyof typeof accounts), {
      pool: db.pool,
      deadline: Date.now() + 30_000,
    }),
  ),
);
const runner = createLibraryCommandRunner({ pool: db.pool, clock: () => at });
let fixture: Awaited<ReturnType<typeof createProfileEntryFixture>>, subjects: string[];
beforeAll(async () => {
  fixture = await createProfileEntryFixture({ pool: db.pool });
  subjects = [await fixture.createSubject('game'), await fixture.createSubject('recipe')];
}, 60_000);
afterAll(async () => {
  await fixture?.close();
  await db.close();
});
const event = { type: 'com.rezics.test.happened.v1', data: {} };
const rows = async (sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows;
const read = async (id = accounts.owner) =>
  (await rows('SELECT seq FROM library.owner_write_counter WHERE route=$1 AND account_id=$2', [routeOf(id), id]))[0]
    ?.seq ?? null;
const receipts = () =>
  rows(
    "SELECT principal_id,idempotency_key,transaction_id FROM core.receipt WHERE command_kind='library.sequence.probe' ORDER BY principal_id,idempotency_key",
  );
async function invoke(
  index = 0,
  body: LibraryCommandBody<string> = async (tx) => {
    const seq = await allocateOwnerWriteSeq(tx, actors[index]!.accountId);
    expect(typeof seq).toBe('bigint');
    return { value: seq.toString(), events: [event] };
  },
  key = randomUUID(),
) {
  return runner.ownAccount(
    actors[index]!,
    { action, kind: 'library.sequence.probe', requestKey: key, input: {} },
    async (tx, command) => {
      await shareAccount(tx, actors[index]!.accountId);
      return body(tx, command);
    },
  );
}

test('native owner state-write sequence is allocated transactionally in one owner partition and rolls back on failure without ordering legacy facts', async () => {
  expect(await read()).toBeNull();
  const legacy = async () => (await fixture.inspect()).entries;
  const original = await legacy();
  expect(original.length).toBeGreaterThan(0);
  expect(original.every(({ row }) => row.owner_write_seq === null)).toBe(true);
  expect(
    await rows(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='library' AND table_name IN ('entry','entry_deleted') AND column_name='owner_write_seq'
      AND data_type='bigint' AND is_nullable='YES' AND column_default IS NULL`),
  ).toEqual([{ n: 2 }]);
  const observed: string[] = [],
    key = randomUUID();
  const write = (subjectId: string) => async (tx: CommandTransaction, command: { transactionId: string }) => {
    const seq = await allocateOwnerWriteSeq(tx, accounts.owner);
    const time = authoritativeTimeValue(currentCommand(tx).time);
    observed.push(time);
    // Test-only consumer probe; existing production entry writers are deliberately untouched.
    await tx.query(
      `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,owner_write_seq)
      VALUES($1,$2,$3,'planned',1,$4,$4,$5,$6)`,
      [routeOf(accounts.owner), accounts.owner, subjectId, time, command.transactionId, seq],
    );
    return { value: seq.toString(), events: [event] };
  };
  const first = await invoke(0, write(subjects[0]!), key);
  expect(first.value).toBe('1');
  expect((await invoke(0, write(subjects[0]!), key)).replayed).toBe(true);
  expect(await read()).toBe('1');
  expect((await invoke(0, write(subjects[1]!))).value).toBe('2');
  expect(observed).toHaveLength(2);
  expect(observed[0]).toBe(observed[1]);
  expect(new Date(observed[0]!).toISOString()).toBe(at.toISOString());
  expect(
    await rows('SELECT owner_write_seq FROM library.entry WHERE route=$1 AND account_id=$2 ORDER BY owner_write_seq', [
      routeOf(accounts.owner),
      accounts.owner,
    ]),
  ).toEqual([{ owner_write_seq: '1' }, { owner_write_seq: '2' }]);
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => invoke()));
  expect(concurrent.map((x) => BigInt(x.value)).sort((a, b) => (a < b ? -1 : 1))).toEqual([3n, 4n, 5n, 6n, 7n, 8n]);
  const ordered = concurrent.toSorted((a, b) => (a.position < b.position ? -1 : 1));
  expect(ordered.map((x) => x.value)).toEqual(['3', '4', '5', '6', '7', '8']);
  expect((await Promise.all([invoke(1), invoke(2)])).map((x) => x.value)).toEqual(['1', '1']);
  const before = await receipts(),
    failure = new Error('deliberate domain failure');
  await expect(
    invoke(0, async (tx) => {
      await allocateOwnerWriteSeq(tx, accounts.owner);
      throw failure;
    }),
  ).rejects.toBe(failure);
  await expect(
    invoke(0, async (tx) => {
      await allocateOwnerWriteSeq(tx, accounts.owner);
      return noEffect('hidden') as { value: string; events: CommandEvent[] };
    }),
  ).rejects.toThrow('no-effect command registers no work');
  expect(await read()).toBe('8');
  expect(await receipts()).toEqual(before);
  expect(await legacy()).toEqual(original);
});

test('wrong-home, invalid, copied, dead and unauthorized transactions reject before allocator mutation', async () => {
  let saved!: CommandTransaction;
  await invoke(0, async (tx) => {
    saved = tx;
    const queries = spyOn(tx, 'query');
    await expect(allocateOwnerWriteSeq(tx, accounts.other)).rejects.toThrow('another command partition');
    await expect(allocateOwnerWriteSeq(tx, accounts.neighbour)).rejects.toThrow('same-owner');
    await expect(allocateOwnerWriteSeq(tx, 'bad')).rejects.toThrow('Invalid owner');
    await expect(allocateOwnerWriteSeq({ ...tx }, accounts.owner)).rejects.toThrow('No authorized live');
    expect(queries).not.toHaveBeenCalled();
    queries.mockRestore();
    return { value: 'checked', events: [event] };
  });
  await expect(allocateOwnerWriteSeq(saved, accounts.owner)).rejects.toThrow('No authorized live');
  await expect(allocateOwnerWriteSeq(db.pool, accounts.owner)).rejects.toThrow('No authorized live');
  await expect(
    runCommand(db.pool, { partition: 0x6d1 }, async (tx) => {
      await allocateOwnerWriteSeq(tx, accounts.owner);
      return { value: '', events: [event] };
    }),
  ).rejects.toThrow('same-owner');
  const before = await read(),
    completed = await receipts();
  await expect(
    runner.ownAccount(
      { ...actors[0]!, scopes: [] },
      { action, kind: 'library.sequence.probe', requestKey: randomUUID(), input: {} },
      async (tx) => {
        await allocateOwnerWriteSeq(tx, accounts.owner);
        return { value: '', events: [event] };
      },
    ),
  ).rejects.toThrow();
  expect(await read()).toBe(before);
  expect(await receipts()).toEqual(completed);
});

test('another owner allocates while an owner counter is held', async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const held = invoke(0, async (tx) => {
    const seq = await allocateOwnerWriteSeq(tx, accounts.owner);
    entered.resolve();
    await release.promise;
    return { value: seq.toString(), events: [event] };
  });
  await entered.promise;
  try {
    expect((await invoke(2)).value).toBe('2');
  } finally {
    release.resolve();
    await held;
  }
});

test('first-write failure removes initialization and bigint overflow aborts counter and receipt', async () => {
  const accountId = accounts.fresh;
  await expect(
    invoke(3, async (tx) => {
      await allocateOwnerWriteSeq(tx, accountId);
      throw new Error('first write failed');
    }),
  ).rejects.toThrow('first write failed');
  expect(await read(accountId)).toBeNull();
  expect((await invoke(3)).value).toBe('1');
  // Internal boundary probe only; no subject, permission or account truth is forged.
  await db.admin.query('UPDATE library.owner_write_counter SET seq=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(accountId),
    accountId,
    '9223372036854775806',
  ]);
  expect((await invoke(3)).value).toBe('9223372036854775807');
  const before = await receipts();
  await expect(invoke(3)).rejects.toMatchObject({ code: '22003' });
  expect(await read(accountId)).toBe('9223372036854775807');
  expect(await receipts()).toEqual(before);
});

test('allocation has constant native rows/statements behind unrelated counters and history', async () => {
  // Unrelated receipt history keeps the native envelope lookup indexed; setup is not measured.
  await db.admin.query(`INSERT INTO core.receipt(partition_no,principal_id,command_kind,idempotency_key,
    request_digest,epoch,position,transaction_id,response,principal_kind)
    SELECT partition_no,principal_id,command_kind,'allocation-noise-'||n,
    request_digest,epoch,position,transaction_id,response,principal_kind
    FROM (SELECT * FROM core.receipt WHERE command_kind='library.sequence.probe' LIMIT 1) r,
    generate_series(1,4096) n`);
  for (const axis of ['counters', 'history']) {
    const report = await checkGrowth(db, {
      name: `owner sequence allocation behind ${axis}`,
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_db, scale, previous) {
        // Noise only: these rows never serve as subject/permission truth or selected owners.
        if (axis === 'counters')
          await db.admin.query(
            `INSERT INTO library.owner_write_counter(route,account_id,seq)
        SELECT 27920, ('10000000-0000-7000-8000-6d10'||lpad(to_hex(n),8,'0'))::uuid,1
        FROM generate_series($1::int*64+1,$2::int*64) n`,
            [previous, scale],
          );
        else
          await db.admin.query(
            `INSERT INTO library.entry_deleted(route,account_id,subject_id,state,revision,created_at,updated_at,
        transaction_id,incarnation_id,deletion_id,deleted_revision,deleted_at,restore_until)
        SELECT $3,$4,$5,'planned',1,$6,$6,$5,$5,gen_random_uuid(),2,$6::timestamptz,$6::timestamptz+interval '720 hours'
        FROM generate_series($1::int*64+1,$2::int*64) n`,
            [previous, scale, routeOf(accounts.owner), accounts.owner, subjects[0], at],
          );
      },
      async operation() {
        await invoke();
      },
    });
    expect(
      report.samples.map(({ cost }) => cost.statements).every((n) => n === report.samples[0]!.cost.statements),
    ).toBe(true);
    for (const { cost } of report.samples) {
      expect(cost.relations['library.owner_write_counter']?.rows).toBe(2);
      expect(cost.relations['library.entry_deleted']).toBeUndefined();
      expect(cost.relations['library.entry']).toBeUndefined();
    }
  }
}, 300_000);
