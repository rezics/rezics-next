import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readErasureStatus } from '../../src/access/erasure.ts';
import type { Envelope } from '../../src/events/log.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import {
  hasOwnCommandCompletion,
  noEffect,
  principalCommandIdentity,
  runCommand,
  CommandResultErasedError,
} from '../../src/command/command.ts';
import { receiptKeysFor } from '../../src/command/receipt-key.ts';
import { decodeLocator } from '../../src/history/locator.ts';
import { ACCOUNT_ROLE_BITS as R } from '../../src/history/contracts.ts';
import { COMMAND_HISTORY_COVERAGE, declareCommandHistory } from '../../src/history/record.ts';
import { advancePreferenceHistory } from '../../src/history/receipt.ts';
import { HistorySealedError, sealHistoryAccount } from '../../src/history/gates.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { problemResponse } from '../../src/http/problem.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { KERNEL_WORK_MODULES } from '../support/default-work-modules.ts';
import { composeWork } from '../../src/work/registry.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { projectBatch } from '../../src/events/log.ts';
import { deletePersona } from '../support/account-deletion.ts';
import {
  barrier,
  custodyFixture,
  digest,
  kind,
  readOnly,
  scope,
  waitForLock,
  type CustodyFixture,
} from './command-custody-fixture.ts';

let f: CustodyFixture;
let work: Awaited<ReturnType<typeof composeWork>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
beforeAll(async () => {
  f = await custodyFixture();
  client = await createWorkClient(f.db.url);
  const module = KERNEL_WORK_MODULES.find(({ name }) => name === 'preference_history');
  expect(module).toBeDefined();
  // Select the actual default registration; unrelated services need unrelated configuration.
  work = await composeWork([module!], { pool: f.db.pool, client, databaseUrl: f.db.url });
  await work.launch();
}, 180_000);
afterAll(async () => {
  try {
    await work?.shutdown();
  } finally {
    try {
      await client?.close();
    } finally {
      await f?.close();
    }
  }
});
async function locators(accountId: string) {
  return readOnly(
    f.db.admin,
    async (db) =>
      (
        await db.query(
          `SELECT * FROM core.history_locator
    WHERE partition_no=$1 AND account_route=$2 AND account_id=$3 ORDER BY artifact_type,locator`,
          [partitionOf(routeOf(accountId)!), routeOf(accountId), accountId],
        )
      ).rows,
  );
}
const deliveries = new Map<string, readonly Envelope[]>();
async function driveDefault(accountId: string, crash = false) {
  let jobId = '';
  const result = await projectBatch(f.db.pool, {
    partition: partitionOf(routeOf(accountId)!),
    consumer: 'custody_acceptance',
    envelopes: 64,
    async apply(envelopes) {
      for (const envelope of envelopes)
        for (const event of envelope.events)
          if (
            event.type === 'com.rezics.access.account-tombstoned.v1' &&
            (event.data as { accountId: string }).accountId === accountId
          )
            jobId = event.id;
      const db = await f.db.pool.connect();
      try {
        await db.query('BEGIN');
        await work.effects.admit!(db, envelopes);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }
      deliveries.set(accountId, envelopes);
      if (crash) {
        const jobs = await f.db.admin.query('SELECT job_id FROM core.preference_history_job WHERE job_id=$1', [jobId]);
        expect(jobs.rows).toHaveLength(1);
        await f.db.admin.query(`CREATE FUNCTION core.custody_crash_cut() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'custody-crash-cut'; END $$`);
        await f.db.admin.query(`CREATE TRIGGER custody_crash_cut BEFORE UPDATE OF state ON core.history_locator
          FOR EACH ROW WHEN (NEW.state='minimized') EXECUTE FUNCTION core.custody_crash_cut()`);
        try {
          await expect(advancePreferenceHistory(f.db.pool, jobId)).rejects.toThrow('custody-crash-cut');
          const cut = await locators(accountId);
          expect(cut.every((row) => row.state === 'pending')).toBe(true);
          const source = await f.db.admin.query(
            `SELECT response,payload_state FROM core.receipt
            WHERE partition_no=$1 AND principal_id=$2 AND command_kind=$3`,
            [partitionOf(routeOf(accountId)!), accountId, kind],
          );
          expect(source.rows.every((row) => row.payload_state === 'present' && row.response !== null)).toBe(true);
        } finally {
          await f.db.admin.query('DROP TRIGGER custody_crash_cut ON core.history_locator');
          await f.db.admin.query('DROP FUNCTION core.custody_crash_cut()');
        }
      }
      await work.effects.enqueue(envelopes);
    },
  });
  expect(result.status).toBe('read');
  expect(jobId).not.toBe('');
  const handle = await client.retrieveWorkflow(jobId);
  expect(await handle.getResult()).toBe('covered-pending');
  return jobId;
}

test('real HTTP preferences capture the exact version-zero receipt and outbox copy without request identity fields', async () => {
  const person = await f.auth.person('custody-http');
  const kernel = createKernel({
    pool: f.db.pool,
    routeKey: Buffer.alloc(32, 91),
    tokens: f.auth.referenceKeys,
    receiptKeys: receiptKeysFor(f.db.pool),
    access: () => f.auth.access,
    writeRate: createWriteRateLimiter({ secret: 'custody-write-rate-secret-32-bytes' }),
  });
  const key = 'private caller key custody@example.test';
  const marker = 'urn:custody:unique-private-preference';
  const call = (body: unknown) =>
    kernel.handle(
      new Request(`http://kernel.test/v1/accounts/${person.accountId}/preferences`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${person.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(key),
        },
        body: JSON.stringify(body),
      }),
    );
  const input = { expectedVersion: 0, shelf: { layouts: { [marker]: 'table' } }, notifications: { reply: false } };
  expect((await call({ ...input, historyAccounts: [{ accountId: person.accountId, roles: R.operator }] })).status).toBe(
    400,
  );
  const response = await call(input);
  expect(response.status).toBe(200);
  const value = await response.json();
  const source = await f.stored(person, key);
  expect(source.response).toEqual(value);
  expect(source.idempotency_key).toMatch(/^rk1\.0\./);
  const rows = await locators(person.accountId);
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.roles).toBe(R.actor | R.principal | R['acting-human'] | R.subject);
    expect(row.minimizer_version).toBe(1);
    expect(row.locator.length).toBeLessThanOrEqual(256);
    expect(row.locator.includes(Buffer.from(key))).toBe(false);
    expect(row.locator.includes(Buffer.from(marker))).toBe(false);
  }
  const receipt = decodeLocator('command-receipt/v1', rows[0].locator);
  expect(receipt).toMatchObject({
    partitionNo: source.partition_no,
    commandKindId: 1,
    keyVersion: 0,
    principalKind: 'account',
    principalId: person.accountId,
  });
  const event = decodeLocator('outbox-event/v1', rows[1].locator);
  expect(event).toMatchObject({ partitionNo: source.partition_no, position: BigInt(source.position), eventSeq: 0 });
  const outbox = await readOnly(
    f.db.admin,
    async (db) =>
      (
        await db.query(
          `SELECT * FROM core.outbox
    WHERE partition_no=$1 AND position=$2 AND event_seq=0`,
          [source.partition_no, source.position],
        )
      ).rows[0],
  );
  expect(outbox.data).toEqual({ accountId: person.accountId });
  expect((await call(input)).status).toBe(200);
  expect(await locators(person.accountId)).toEqual(rows);
  const untouched = await f.db.admin.query(
    'SELECT notifications,shelf FROM access.account_preferences WHERE route=$1 AND account_id=$2',
    [routeOf(person.accountId), person.accountId],
  );
  expect(untouched.rows[0].notifications).toEqual({ reply: false });
}, 60_000);

test('a native signed delegation captures its verified principal and human delegate, without guessing an operator', async () => {
  const principal = await f.auth.person('custody-principal');
  const delegate = await f.auth.person('custody-delegate');
  const ctx = await f.context(principal);
  const assignment = await createDelegationCommands({
    pool: f.db.pool,
    access: f.auth.access,
    action: 'account:manage',
  }).create(ctx, {
    principalId: principal.accountId,
    assignedActorId: delegate.accountId,
    requestId: (await import('../../src/route/route.ts')).newId(routeOf(principal.accountId)!),
    valid: '(,)',
    key: 'custody-delegation',
  });
  const token = await f.auth.request('/token', { requested_by: assignment.value.requestedBy }, delegate.headers);
  expect(token.status).toBe(200);
  const delegated = { ...delegate, bearer: (await token.json()).access_token as string };
  const result = await f.preferences.setPreferences(await f.context(delegated), {
    accountId: delegate.accountId,
    key: 'delegated-preference',
    expectedVersion: 0,
    spoilerLevel: 2,
  });
  const rows = await readOnly(
    f.db.admin,
    async (db) =>
      (
        await db.query(
          `SELECT account_id,roles FROM core.history_locator
    WHERE partition_no=$1 AND artifact_type='outbox-event/v1' AND locator=$2 ORDER BY account_id`,
          [
            result.partition,
            Buffer.from(
              (await import('../../src/history/locator.ts')).encodeLocator({
                artifactType: 'outbox-event/v1',
                partitionNo: result.partition,
                position: result.position,
                eventSeq: 0,
              }),
            ),
          ],
        )
      ).rows,
  );
  expect(rows).toContainEqual({
    account_id: delegate.accountId,
    roles: R.actor | R.delegate | R['acting-human'] | R.subject,
  });
  expect(rows).toContainEqual({ account_id: principal.accountId, roles: R.principal });
  const forged = { ...ctx.actor };
  await expect(
    f.preferences.setPreferences(
      { ...ctx, actor: forged },
      { accountId: principal.accountId, key: 'forged', expectedVersion: 0 },
    ),
  ).rejects.toThrow();
  expect(await f.stored(principal, 'forged')).toBeUndefined();
}, 90_000);

test('rollback, serialization retry, duplicate delivery, foreign subject locality and position-zero completion use the native executor', async () => {
  const actor = await f.auth.person('custody-retry');
  const foreign = await f.auth.person('custody-foreign');
  const p = 4094;
  await f.db.admin.query("INSERT INTO core.partition(partition_no,node) VALUES($1,'custody') ON CONFLICT DO NOTHING", [
    p,
  ]);
  await expect(
    f.command(
      actor,
      'rollback',
      scope(foreign),
      async () => {
        throw new Error('rollback-cut');
      },
      p,
    ),
  ).rejects.toThrow('rollback-cut');
  expect(await f.stored(actor, 'rollback', p)).toBeUndefined();
  const before = await f.db.admin.query('SELECT * FROM core.history_locator WHERE partition_no=$1 AND account_id=$2', [
    p,
    foreign.accountId,
  ]);
  expect(before.rows).toHaveLength(0);
  let attempts = 0;
  const ctx = await f.context(actor, p);
  let prepares = 0;
  const prepare = ctx.authorization.prepare!;
  const authorization = {
    ...ctx.authorization,
    async prepare(attempt: Parameters<typeof prepare>[0]) {
      prepares++;
      return prepare(attempt);
    },
  };
  const execute = () =>
    runCommand(
      f.db.pool,
      {
        ...principalCommandIdentity(ctx.actor),
        partition: p,
        deadline: ctx.deadline,
        authorization,
        receipt: { kind, key: 'retry-foreign', digest },
      },
      async (tx) => {
        attempts++;
        await declareCommandHistory(tx, kind, scope(foreign));
        if (attempts === 1) await tx.query("DO $$ BEGIN RAISE EXCEPTION 'retry-cut' USING ERRCODE='40001'; END $$");
        return noEffect({ private: 'foreign subject response' });
      },
    );
  const applied = await execute();
  expect(attempts).toBe(2);
  expect(prepares).toBe(2);
  expect(applied.position).toBe(0n);
  const replay = await execute();
  expect(replay.replayed).toBe(true);
  expect(attempts).toBe(2);
  expect(replay.transactionId).toBe(applied.transactionId);
  const rows = await readOnly(
    f.db.admin,
    async (db) =>
      (
        await db.query('SELECT * FROM core.history_locator WHERE partition_no=$1 AND account_id=ANY($2::uuid[])', [
          p,
          [actor.accountId, foreign.accountId],
        ])
      ).rows,
  );
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.account_id === foreign.accountId).roles).toBe(R.subject);
  expect(rows.every((row) => row.partition_no === p)).toBe(true);
  expect(await locators(foreign.accountId)).toHaveLength(0);
  const saved = await f.stored(actor, 'retry-foreign', p);
  expect(saved.epoch).toBe(applied.epoch);
  expect(BigInt(saved.position)).toBe(0n);
  expect(saved.transaction_id).toBe(applied.transactionId);
  const completion = await runCommand(
    f.db.pool,
    { ...principalCommandIdentity(ctx.actor), partition: p, deadline: ctx.deadline, authorization: ctx.authorization },
    async (tx) => noEffect(await hasOwnCommandCompletion(tx, { kind, key: 'retry-foreign', digest })),
  );
  expect(completion.value).toBe(true);
}, 90_000);

test('an actual preference source, receipt and outbox roll back together when custody fails, then serialization retry writes one copy', async () => {
  const person = await f.auth.person('custody-atomic-preference');
  const route = routeOf(person.accountId)!;
  const partition = partitionOf(route);
  const count = async () =>
    (
      await f.db.admin.query(
        `SELECT count(*)::int AS n FROM core.outbox
    WHERE partition_no=$1 AND type='com.rezics.access.account-updated.v1' AND subject=$2`,
        [partition, person.accountId],
      )
    ).rows[0].n;
  const before = await count();
  await f.db.admin.query(`CREATE FUNCTION core.preference_custody_cut() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.account_id='${person.accountId}'::uuid THEN RAISE EXCEPTION 'preference-custody-cut'; END IF; RETURN NEW; END $$`);
  await f.db.admin.query(`CREATE TRIGGER preference_custody_cut BEFORE INSERT ON core.history_locator
    FOR EACH ROW EXECUTE FUNCTION core.preference_custody_cut()`);
  try {
    await expect(
      f.preferences.setPreferences(await f.context(person), {
        accountId: person.accountId,
        key: 'atomic-cut',
        expectedVersion: 0,
        spoilerLevel: 2,
      }),
    ).rejects.toThrow('preference-custody-cut');
    expect(await f.stored(person, 'atomic-cut')).toBeUndefined();
    expect(await locators(person.accountId)).toHaveLength(0);
    expect(await count()).toBe(before);
    expect(
      (
        await f.db.admin.query('SELECT * FROM access.account_preferences WHERE route=$1 AND account_id=$2', [
          route,
          person.accountId,
        ])
      ).rows,
    ).toHaveLength(0);
  } finally {
    await f.db.admin.query('DROP TRIGGER preference_custody_cut ON core.history_locator');
    await f.db.admin.query('DROP FUNCTION core.preference_custody_cut()');
  }
  // Sequence advancement is deliberately nontransactional: one deterministic failure, no timing race.
  await f.db.admin.query('CREATE SEQUENCE core.preference_retry_cut');
  await f.db.admin.query(`CREATE FUNCTION core.preference_retry_cut() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.account_id='${person.accountId}'::uuid AND nextval('core.preference_retry_cut')=1
      THEN RAISE EXCEPTION 'preference-retry-cut' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`);
  await f.db.admin.query(`CREATE TRIGGER preference_retry_cut BEFORE INSERT ON core.history_locator
    FOR EACH ROW EXECUTE FUNCTION core.preference_retry_cut()`);
  try {
    const result = await f.preferences.setPreferences(await f.context(person), {
      accountId: person.accountId,
      key: 'native-retry',
      expectedVersion: 0,
      spoilerLevel: 2,
    });
    expect(result.replayed).toBe(false);
    expect(await count()).toBe(before + 1);
    expect(await locators(person.accountId)).toHaveLength(2);
    expect((await f.stored(person, 'native-retry')).transaction_id).toBe(result.transactionId);
  } finally {
    await f.db.admin.query('DROP TRIGGER preference_retry_cut ON core.history_locator');
    await f.db.admin.query('DROP FUNCTION core.preference_retry_cut()');
    await f.db.admin.query('DROP SEQUENCE core.preference_retry_cut');
  }
}, 90_000);

test('producer-before-seal orders on two real connections, then rejects every covered late producer including an empty prefix', async () => {
  const actor = await f.auth.person('custody-order-actor');
  const subject = await f.auth.person('custody-order-subject');
  const p = partitionOf(routeOf(actor.accountId)!);
  const arrived = barrier(),
    release = barrier();
  let producerPid = 0;
  const producer = f.command(actor, 'before-seal', scope(subject), async (tx) => {
    await tx.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
    producerPid = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    arrived.release();
    await release.reached;
  });
  await arrived.reached;
  const sealer = await f.db.pool.connect();
  try {
    await deletePersona({ pool: f.db.pool, auth: f.auth }, subject);
    await sealer.query('BEGIN');
    const pid = (await sealer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const sealing = sealHistoryAccount(sealer, p, routeOf(subject.accountId)!, subject.accountId);
    await waitForLock(f.db.admin, pid, producerPid);
    release.release();
    await producer;
    await sealing;
    await sealer.query('COMMIT');
    await expect(f.command(actor, 'late', scope(subject))).rejects.toBeInstanceOf(HistorySealedError);
    expect(await f.stored(actor, 'late')).toBeUndefined();
    const empty = await f.auth.person('custody-empty-subject');
    await expect(sealHistoryAccount(sealer, p, routeOf(empty.accountId)!, empty.accountId)).rejects.toThrow(
      'Missing committed erasure obligation',
    );
    await deletePersona({ pool: f.db.pool, auth: f.auth }, empty);
    await sealer.query('BEGIN');
    await sealHistoryAccount(sealer, p, routeOf(empty.accountId)!, empty.accountId);
    await sealer.query('COMMIT');
    await expect(f.command(actor, 'empty-late', scope(empty))).rejects.toBeInstanceOf(HistorySealedError);
    expect(await f.stored(actor, 'empty-late')).toBeUndefined();
    expect(
      (
        await f.db.admin.query('SELECT * FROM core.history_locator WHERE partition_no=$1 AND account_id=$2', [
          p,
          empty.accountId,
        ])
      ).rows,
    ).toHaveLength(0);
  } finally {
    release.release();
    await sealer.query('ROLLBACK');
    sealer.release();
  }
}, 120_000);

test('ordinary account deletion drives the default registered receipt minimizer; replay refuses without disclosing provenance', async () => {
  const subject = await f.auth.person('custody-erased');
  const other = await f.auth.person('custody-unrelated');
  const principal = await f.auth.person('custody-living-reader');
  const key = 'private-erasure-key';
  await f.preferences.setPreferences(await f.context(subject), {
    accountId: subject.accountId,
    key,
    expectedVersion: 0,
    shelf: { layouts: { 'urn:custody:erase-this-exact-payload': 'list' } },
  });
  await f.preferences.setPreferences(await f.context(other), {
    accountId: other.accountId,
    key: 'unrelated',
    expectedVersion: 0,
    spoilerLevel: 1,
  });
  const unrelated = await f.stored(other, 'unrelated');
  const original = await f.stored(subject, key);
  const p = partitionOf(routeOf(subject.accountId)!);
  // A native, living caller owns this result; its independently declared subject can be erased.
  await f.command(principal, 'living-reader', scope(subject), undefined, p);
  const livingOriginal = await f.stored(principal, 'living-reader', p);
  await deletePersona({ pool: f.db.pool, auth: f.auth }, subject);
  const jobId = await driveDefault(subject.accountId, true);
  const minimized = await f.stored(subject, key);
  expect(minimized.response).toBeNull();
  expect(minimized.payload_state).toBe('minimized');
  for (const field of ['epoch', 'position', 'transaction_id', 'request_digest', 'created_at', 'idempotency_key'])
    expect(minimized[field]).toEqual(original[field]);
  expect(await f.stored(other, 'unrelated')).toEqual(unrelated);
  expect(
    (await locators(subject.accountId))
      .filter((row) => row.artifact_type === 'command-receipt/v1')
      .every((row) => row.state === 'minimized'),
  ).toBe(true);
  expect(
    (await locators(subject.accountId))
      .filter((row) => row.artifact_type === 'outbox-event/v1')
      .every((row) => row.state === 'pending'),
  ).toBe(true);
  expect(await advancePreferenceHistory(f.db.pool, jobId)).toBe('covered-pending');
  await work.effects.enqueue(deliveries.get(subject.accountId)!);
  expect(await (await client.retrieveWorkflow(jobId)).getResult()).toBe('covered-pending');
  expect((await f.stored(principal, 'living-reader', p)).response).toBeNull();
  const ctx = await f.context(principal, p);
  const completion = await runCommand(
    f.db.pool,
    { ...principalCommandIdentity(ctx.actor), partition: p, authorization: ctx.authorization },
    async (tx) => noEffect(await hasOwnCommandCompletion(tx, { kind, key: 'living-reader', digest })),
  );
  expect(completion.value).toBe(true);
  expect((await f.stored(principal, 'living-reader', p)).transaction_id).toBe(livingOriginal.transaction_id);
  let bodyCalls = 0;
  let erased: unknown;
  try {
    await f.command(
      principal,
      'living-reader',
      scope(subject),
      async () => {
        bodyCalls++;
      },
      p,
    );
  } catch (error) {
    erased = error;
  }
  expect(erased).toBeInstanceOf(CommandResultErasedError);
  expect(bodyCalls).toBe(0);
  const response = problemResponse(erased, { method: 'POST', id: 'custody-request' });
  expect(response.status).toBe(410);
  const problem = await response.json();
  expect(problem.effect_status).toBe('applied');
  expect(problem.retryable).toBe(false);
  expect(JSON.stringify(problem)).not.toContain(subject.accountId);
  expect(JSON.stringify(problem)).not.toContain('erase-this-exact-payload');
  await expect(
    (async () =>
      f.preferences.setPreferences(await f.context(subject), {
        accountId: subject.accountId,
        key,
        expectedVersion: 0,
      }))(),
  ).rejects.not.toBeInstanceOf(CommandResultErasedError);
  expect(COMMAND_HISTORY_COVERAGE.complete).toBe(false);
  const status = await readErasureStatus(f.db.admin, subject.accountId);
  expect(status!.participants['shared-history']!.outcome).toBe('pending');
  const progress = await f.db.admin.query(
    'SELECT state,proof FROM core.history_progress WHERE account_route=$1 AND account_id=$2',
    [routeOf(subject.accountId), subject.accountId],
  );
  expect(progress.rows.every((row) => row.state === 'pending' && row.proof === null)).toBe(true);
}, 180_000);

test('the complete production unit rejects 65 distinct references and oversized payloads without source or custody writes', async () => {
  const person = await f.auth.person('custody-bounds');
  const { newId } = await import('../../src/route/route.ts');
  const refs = Array.from({ length: 64 }, () => ({ accountId: newId(1), accountRoute: 1, roles: R['related-party'] }));
  await expect(
    f.command(person, 'over-account-cap', {
      response: { artifactType: 'command-receipt/v1', accounts: refs },
      events: [],
    }),
  ).rejects.toThrow();
  const ctx = await f.context(person);
  await expect(
    runCommand(
      f.db.pool,
      {
        ...principalCommandIdentity(ctx.actor),
        partition: ctx.partition,
        authorization: ctx.authorization,
        receipt: { kind, key: 'over-byte-cap', digest },
      },
      async (tx) => {
        await declareCommandHistory(tx, kind, scope(person));
        return noEffect('private'.repeat(10_000));
      },
    ),
  ).rejects.toThrow('64 KiB');
  expect(await f.stored(person, 'over-account-cap')).toBeUndefined();
  expect(await f.stored(person, 'over-byte-cap')).toBeUndefined();
  expect(await locators(person.accountId)).toHaveLength(0);
}, 60_000);

test('each actual emitted event has its own scope union and persisted sequence', async () => {
  const actor = await f.auth.person('custody-event-actor');
  const subject = await f.auth.person('custody-event-subject');
  const ctx = await f.context(actor);
  const result = await runCommand(
    f.db.pool,
    {
      ...principalCommandIdentity(ctx.actor),
      partition: ctx.partition,
      authorization: ctx.authorization,
      receipt: { kind, key: 'two-events', digest },
    },
    async (tx) => {
      const related = scope(subject).response.accounts;
      await declareCommandHistory(tx, kind, {
        response: scope(actor).response,
        events: [
          { artifactType: 'outbox-event/v1', accounts: scope(actor).response.accounts },
          { artifactType: 'outbox-event/v1', accounts: related },
        ],
      });
      return {
        value: { version: 0 },
        events: [
          {
            type: 'com.rezics.access.account-updated.v1',
            subject: actor.accountId,
            data: { accountId: actor.accountId },
          },
          {
            type: 'com.rezics.access.account-updated.v1',
            subject: subject.accountId,
            data: { accountId: subject.accountId },
          },
        ],
      };
    },
  );
  const { encodeLocator } = await import('../../src/history/locator.ts');
  for (const eventSeq of [0, 1]) {
    const locator = Buffer.from(
      encodeLocator({
        artifactType: 'outbox-event/v1',
        partitionNo: ctx.partition,
        position: result.position,
        eventSeq,
      }),
    );
    const rows = await readOnly(
      f.db.admin,
      async (db) =>
        (
          await db.query(
            `SELECT account_id,roles FROM core.history_locator
      WHERE partition_no=$1 AND artifact_type='outbox-event/v1' AND locator=$2 ORDER BY account_id`,
            [ctx.partition, locator],
          )
        ).rows,
    );
    expect(rows).toHaveLength(eventSeq === 0 ? 1 : 2);
    expect(rows).toContainEqual({
      account_id: actor.accountId,
      roles: R.actor | R.principal | R['acting-human'] | (eventSeq === 0 ? R.subject : 0),
    });
    if (eventSeq === 1) expect(rows).toContainEqual({ account_id: subject.accountId, roles: R.subject });
    const source = await readOnly(
      f.db.admin,
      async (db) =>
        (
          await db.query(
            `SELECT event_seq,data FROM core.outbox
      WHERE partition_no=$1 AND position=$2 AND event_seq=$3`,
            [ctx.partition, result.position, eventSeq],
          )
        ).rows,
    );
    expect(source).toEqual([
      { event_seq: eventSeq, data: { accountId: eventSeq === 0 ? actor.accountId : subject.accountId } },
    ]);
  }
}, 90_000);
