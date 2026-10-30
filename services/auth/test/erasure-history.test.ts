import { expect, test } from 'bun:test';
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import type { AuthErasureSource } from '@rezics/auth-contract';
import { nativeFixture, password, scopes } from './support/erasure-native.ts';
import { COPY_TABLES, copiesAbsent, createCopyWriter, eraseCopy } from '../src/erasure-copy.ts';
import { erasureHistoryPage, publishErasureProofs } from '../src/erasure-history.ts';
import { nativeErasurePage, startNativeErasure } from '../src/erasure-native.ts';
import { randomUUID } from 'node:crypto';
import { failNativeQueries } from './support/erasure-native.ts';
import { completeCopy, finishCopyResult } from '../src/erasure-copy.ts';

async function eventually(probe: () => Promise<boolean>, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (!(await probe())) {
    if (Date.now() >= until) throw new Error('Auth shared-copy progress did not finish');
    await Bun.sleep(100);
  }
}

test('real default deletion transfers only its discharged native source, then erases exact Auth copies and durably redrives the separate barrier proof', async () => {
  const f = await nativeFixture();
  let release = () => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ports = f.bindings.trustedAccess;
  const readSource = ports.readAuthErasureSource!;
  const submit = ports.recordAuthHistoryCompletion!;
  let reads = 0;
  let source: AuthErasureSource | null = null;
  let completionAttempts = 0;
  let submissionsEnabled = false;
  let lostReply = true;
  ports.readAuthErasureSource = async (input) => {
    const value = await readSource(input);
    source = value;
    if (++reads === 2) await paused;
    return value;
  };
  ports.recordAuthHistoryCompletion = async (proof) => {
    completionAttempts++;
    if (!submissionsEnabled) throw new Error('test process unavailable before submission');
    await submit(proof);
    if (lostReply) {
      lostReply = false;
      throw new Error('test reply lost after committed proof');
    }
  };
  try {
    const victim = await f.person('copy-victim');
    const survivor = await f.person('copy-survivor');
    const registration = (
      await f.pool.query<{ workflow_id: string }>(
        "SELECT r.workflow_id FROM auth_copy_role r JOIN auth_copy_work w USING(workflow_id) WHERE r.account_id=$1 AND w.name='accounts.registration'",
        [victim.accountId],
      )
    ).rows[0]!;
    // Inspect complete actual persisted rows, including SDK bookkeeping. No
    // adapter-produced substitute is used as evidence of native custody.
    let artifacts = 0;
    for (const table of COPY_TABLES) {
      const actual = await f.pool.query(
        `SELECT row_to_json(t)::text AS artifact FROM auth_dbos.${table} t WHERE ${table === 'notifications' ? 'destination_uuid' : 'workflow_uuid'}=$1`,
        [registration.workflow_id],
      );
      artifacts += actual.rows.length;
      for (const row of actual.rows) expect(Buffer.byteLength(row.artifact)).toBeLessThanOrEqual(65536);
    }
    const ledger = (
      await f.pool.query('SELECT rows,bytes,scope_count FROM auth_copy_work WHERE workflow_id=$1', [
        registration.workflow_id,
      ])
    ).rows[0]!;
    expect(artifacts).toBeGreaterThan(5);
    expect(ledger.rows).toBeGreaterThanOrEqual(artifacts);
    expect(ledger.rows).toBeLessThanOrEqual(139);
    expect(ledger.bytes).toBeLessThanOrEqual(10485760);
    await expect(
      f.pool.query('DELETE FROM auth_copy_role WHERE workflow_id=$1', [registration.workflow_id]),
    ).rejects.toThrow('custody is immutable');
    const deletion = f.delete(victim);
    await eventually(async () => reads === 2);
    const accepted = (await f.pool.query('SELECT * FROM auth_erasure WHERE account_id=$1', [victim.accountId]))
      .rows[0]!;
    expect(accepted.source_accepted_at).toBeInstanceOf(Date);
    expect(accepted.source_discharged_at).toBeNull();
    expect((await nativeErasurePage(f.pool, accepted.id)).code).toBe('native-source');
    expect((await f.pool.query('SELECT 1 FROM "user" WHERE id=$1', [victim.accountId])).rowCount).toBe(1);
    expect(
      (await f.kernel.query('SELECT 1 FROM access.auth_history_proof WHERE account_id=$1', [victim.accountId]))
        .rowCount,
    ).toBe(0);
    // A real consumer is paused after acceptance. Neither terminal status nor
    // acceptance can manufacture a ready copy or permit an early native scrub.
    const live = (
      await f.pool.query<{ workflow_id: string }>(
        'SELECT source_workflow_id AS workflow_id FROM auth_erasure WHERE id=$1',
        [accepted.id],
      )
    ).rows[0]!;
    expect(await eraseCopy(f.pool, live.workflow_id)).toBe(false);
    release();
    const response = await deletion;
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { accountId: victim.accountId },
    });
    expect(source).not.toBeNull();
    const early = (
      await f.kernel.query(
        'SELECT phase,version,at::text,continuation_id,receipt_id FROM access.auth_history_proof WHERE account_id=$1',
        [victim.accountId],
      )
    ).rows;
    expect(early).toEqual([
      {
        phase: 'native-consumed',
        version: source!.version,
        at: source!.at,
        continuation_id: source!.continuationId,
        receipt_id: source!.receiptId,
      },
    ]);
    expect(
      (await f.pool.query('SELECT consent_completed_at FROM auth_erasure WHERE id=$1', [accepted.id])).rows[0]!
        .consent_completed_at,
    ).toBeNull();
    expect(await erasureHistoryPage(f.pool, accepted.id)).toBe(false);
    // Lose the reply after the real supported cancellation returns. The durable
    // retirement cut must still permit exact deletion on retry, with no new
    // producer or consumer inferred from terminal status.
    const cancel = DBOS.cancelWorkflow;
    DBOS.cancelWorkflow = async (id) => {
      await cancel.call(DBOS, id);
      throw new Error('test reply lost after native cancellation');
    };
    try {
      await expect(eraseCopy(f.pool, registration.workflow_id)).rejects.toThrow('reply lost');
    } finally {
      DBOS.cancelWorkflow = cancel;
    }
    expect(
      (
        await f.pool.query('SELECT status FROM auth_dbos.workflow_status WHERE workflow_uuid=$1', [
          registration.workflow_id,
        ])
      ).rows,
    ).toEqual([{ status: 'SUCCESS' }]);
    // The pinned SDK leaves SUCCESS unchanged. Retirement, not cancellation
    // status, persists the earlier verified consumer cut.
    expect(
      (await f.pool.query('SELECT retired FROM auth_copy_work WHERE workflow_id=$1', [registration.workflow_id])).rows,
    ).toEqual([{ retired: true }]);
    expect(await eraseCopy(f.pool, registration.workflow_id)).toBe(true);
    expect(await copiesAbsent(f.pool, registration.workflow_id)).toBe(true);
    await eventually(async () => completionAttempts > 0, 370_000);
    const local = (await f.pool.query('SELECT * FROM auth_erasure WHERE id=$1', [accepted.id])).rows[0]!;
    expect(local.copies_completed_at).toBeInstanceOf(Date);
    expect(local.copies_published_at).toBeNull();
    expect(
      (
        await f.kernel.query("SELECT 1 FROM access.auth_history_proof WHERE account_id=$1 AND phase='copies-erased'", [
          victim.accountId,
        ])
      ).rowCount,
    ).toBe(0);
    await expect(
      publishErasureProofs(f.pool, { ...ports, recordAuthHistoryCompletion: undefined } as never, accepted.id),
    ).rejects.toThrow('binding unavailable');
    expect(await copiesAbsent(f.pool, registration.workflow_id)).toBe(true);
    expect(await copiesAbsent(f.pool, live.workflow_id)).toBe(true);
    await f.host.workflows.close();
    // Every personal DBOS history is already physically absent; the native
    // completion and immutable barrier remain after executor death/history loss.
    expect((await f.pool.query('SELECT 1 FROM auth_copy_role WHERE account_id=$1', [victim.accountId])).rowCount).toBe(
      0,
    );
    submissionsEnabled = true;
    await f.host.workflows.start();
    await eventually(
      async () =>
        !!(
          await f.pool.query('SELECT 1 FROM auth_erasure WHERE id=$1 AND copies_published_at IS NOT NULL', [
            accepted.id,
          ])
        ).rowCount,
    );
    expect(
      (
        await f.kernel.query('SELECT phase FROM access.auth_history_proof WHERE account_id=$1 ORDER BY phase', [
          victim.accountId,
        ])
      ).rows,
    ).toEqual([{ phase: 'copies-erased' }, { phase: 'native-consumed' }]);
    expect(completionAttempts).toBeGreaterThanOrEqual(3);
    const sdk = await DBOSClient.create({
      systemDatabaseUrl: f.fixture.url,
      systemDatabaseSchemaName: 'auth_dbos',
      applicationName: 'rezics-auth-accounts',
      systemDatabasePool: f.pool,
    });
    try {
      const writer = createCopyWriter(f.pool, sdk);
      await expect(
        writer.enqueue('accounts.registration', registration.workflow_id, { registrationId: 'stale' }, [
          { accountId: victim.accountId, role: 'subject' },
        ]),
      ).rejects.toThrow();
      await expect(writer.send(registration.workflow_id, 'install', 'credential', 'stale-message')).rejects.toThrow(
        'retired',
      );
      await expect(
        writer.enqueue(
          'accounts.client-reduction',
          'late-child',
          { operationId: live.workflow_id },
          [{ accountId: victim.accountId, role: 'subject' }],
          live.workflow_id,
        ),
      ).rejects.toThrow('retired');
    } finally {
      await sdk.destroy();
    }
    expect(await copiesAbsent(f.pool, registration.workflow_id)).toBe(true);
    const signed = await f.call('/signin', {
      email: survivor.email,
      password,
      client_id: 'erasure-web',
      scope: scopes,
    });
    expect(signed.status).toBe(200);
    expect((await f.pool.query('SELECT 1 FROM account WHERE "userId"=$1', [survivor.accountId])).rowCount).toBe(1);
    expect(
      (
        await f.kernel.query(
          "SELECT 1 FROM access.erasure_acknowledgement WHERE account_id=$1 AND participant='shared-history'",
          [victim.accountId],
        )
      ).rowCount,
    ).toBe(0);
    // A direct helper-created obligation has no consumed source, even when it
    // names a genuine barrier. Publishing cannot infer the missing source fact.
    const helper = await startNativeErasure(f.pool, 'untrusted-helper', 1);
    expect(await publishErasureProofs(f.pool, ports, helper)).toBe(0);
    expect(
      (await f.pool.query('SELECT source_discharged_at FROM auth_erasure WHERE id=$1', [helper])).rows[0]!
        .source_discharged_at,
    ).toBeNull();
  } finally {
    release();
    await f.close();
  }
}, 450_000);

test('default recovery consumes an ordinary committed native result after caller loss and restart, without a caller retry', async () => {
  const f = await nativeFixture();
  let restore = () => {};
  try {
    const person = await f.person('lost-result');
    const survivor = await f.person('lost-result-survivor');
    const current = await f.bindings.workflowPorts.readAccount(person.accountId);
    const key = randomUUID();
    const operation = {
      kind: 'rename' as const,
      accountId: person.accountId,
      handle: `lost_${key.replaceAll('-', '')}`,
      expectedHandle: current!.handle,
      authorization: 'approval-request',
    };
    const approval = await f.approvals.approve(person.bearer, { operationKey: key, operation }, f.context());
    let interrupted = false;
    restore = failNativeQueries(f.pool, (sql) => {
      if (interrupted || !sql.includes('UPDATE auth_copy_work SET ready=true')) return false;
      interrupted = true;
      return true;
    });
    await expect(
      f.host.workflows.renameHandle({ key, ...operation, authorization: approval.reference }),
    ).rejects.toThrow();
    restore();
    const copy = (
      await f.pool.query<{ workflow_id: string; ready: boolean; result_finished_at: Date }>(
        `SELECT w.workflow_id,w.ready,w.result_finished_at FROM auth_copy_work w JOIN auth_copy_role r USING(workflow_id)
       WHERE r.account_id=$1 AND w.name='accounts.operation' AND r.role='subject'`,
        [person.accountId],
      )
    ).rows[0]!;
    expect(interrupted).toBe(true);
    expect(copy.ready).toBe(false);
    expect(copy.result_finished_at).toBeInstanceOf(Date);
    expect((await f.bindings.workflowPorts.readAccount(person.accountId))!.handle).toBe(operation.handle);
    await f.host.workflows.close();
    await f.host.workflows.start();
    // No resumeOperation or caller retry repairs the native result consumer.
    expect((await f.delete(person)).status).toBe(200);
    await eventually(
      async () =>
        !!(
          await f.pool.query('SELECT 1 FROM auth_erasure WHERE account_id=$1 AND copies_published_at IS NOT NULL', [
            person.accountId,
          ])
        ).rowCount,
      370_000,
    );
    expect(await copiesAbsent(f.pool, copy.workflow_id)).toBe(true);
    expect(
      (
        await f.call('/signin', {
          email: survivor.email,
          password,
          client_id: 'erasure-web',
          scope: scopes,
        })
      ).status,
    ).toBe(200);
  } finally {
    restore();
    await f.close();
  }
}, 450_000);

test('activated registration lost after native result consumption retires through default maintenance after restart', async () => {
  const f = await nativeFixture();
  let restore = () => {};
  try {
    const key = randomUUID();
    const email = `${key}@lost-registration.test`;
    let interrupted = false;
    restore = failNativeQueries(f.pool, (sql) => {
      if (interrupted || !sql.includes('UPDATE auth_copy_work SET ready=true')) return false;
      interrupted = true;
      return true;
    });
    await expect(
      f.host.workflows.register({
        key,
        email,
        password,
        handle: `lostreg_${key.replaceAll('-', '')}`,
      }),
    ).rejects.toThrow();
    restore();
    const source = (
      await f.pool.query<{ account_id: string; consumer_workflow_id: string; completed_at: Date }>(
        'SELECT account_id,consumer_workflow_id,completed_at FROM auth_registration_stage WHERE request_key=$1',
        [key],
      )
    ).rows[0]!;
    expect(source.completed_at).toBeInstanceOf(Date);
    expect(interrupted).toBe(true);
    expect(
      (
        await f.pool.query('SELECT ready,result_finished_at FROM auth_copy_work WHERE workflow_id=$1', [
          source.consumer_workflow_id,
        ])
      ).rows[0],
    ).toMatchObject({ ready: false, result_finished_at: expect.any(Date) });
    await f.host.workflows.close();
    await f.host.workflows.start();
    const person = await f.login({ accountId: source.account_id, email });
    expect((await f.delete(person)).status).toBe(200);
    await eventually(
      async () =>
        !!(
          await f.pool.query('SELECT 1 FROM auth_erasure WHERE account_id=$1 AND copies_published_at IS NOT NULL', [
            source.account_id,
          ])
        ).rowCount,
      370_000,
    );
    expect(await copiesAbsent(f.pool, source.consumer_workflow_id)).toBe(true);
  } finally {
    restore();
    await f.close();
  }
}, 450_000);

test('a live native result consumer stays pending; lawful disclosure refusal after its committed effect cannot strand retirement', async () => {
  const f = await nativeFixture();
  const ports = f.bindings.workflowPorts;
  const finish = ports.completeHandleTransition!;
  let release = () => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = false;
  try {
    const person = await f.person('denied-result');
    const current = await ports.readAccount(person.accountId);
    const key = randomUUID();
    const operation = {
      kind: 'rename' as const,
      accountId: person.accountId,
      handle: `denied_${key.replaceAll('-', '')}`,
      expectedHandle: current!.handle,
      authorization: 'approval-request',
    };
    const approval = await f.approvals.approve(person.bearer, { operationKey: key, operation }, f.context());
    ports.completeHandleTransition = async (input) => {
      const result = await finish(input);
      reached = true;
      await paused;
      return result;
    };
    const result = f.host.workflows.renameHandle({ key, ...operation, authorization: approval.reference });
    // Observe rejection immediately so the deliberate native denial is handled.
    const answer = result.then(
      () => null,
      (error: unknown) => error,
    );
    await eventually(async () => reached);
    const id = (
      await f.pool.query<{ workflow_id: string }>(
        `SELECT w.workflow_id FROM auth_copy_work w JOIN auth_copy_role r USING(workflow_id)
       WHERE r.account_id=$1 AND r.role='subject' AND w.name='accounts.operation'`,
        [person.accountId],
      )
    ).rows[0]!.workflow_id;
    expect(await completeCopy(f.pool, id)).toBe(false);
    expect(await eraseCopy(f.pool, id)).toBe(false);
    await expect(finishCopyResult(f.pool, id, { accountId: person.accountId })).rejects.toThrow('source missing');
    // This is the genuine Access fence, so the subsequent native disclosure
    // check must deny under current authority despite the committed rename.
    await f.bindings.internalLifecycle.raiseFence({ accountId: person.accountId, key: randomUUID() });
    release();
    expect(await answer).toMatchObject({ status: 403 });
    expect((await ports.readAccount(person.accountId))!.handle).toBe(operation.handle);
    expect(
      (await f.pool.query('SELECT ready,result_finished_at FROM auth_copy_work WHERE workflow_id=$1', [id])).rows[0],
    ).toMatchObject({ ready: true, result_finished_at: expect.any(Date) });

    // A separate actual registration remains live until its own native result;
    // neither a guessed return nor retirement of the denied caller completes it.
    const pending = await f.host.workflows.beginRegistration({
      key: randomUUID(),
      handle: `living_${randomUUID().replaceAll('-', '')}`,
    });
    expect(await completeCopy(f.pool, pending.workflowId, { accountId: pending.accountId })).toBe(false);
    expect(await eraseCopy(f.pool, pending.workflowId)).toBe(false);
    await f.host.workflows.installRegistrationCredential({
      registrationId: pending.registrationId,
      email: `${randomUUID()}@living-result.test`,
      password,
    });
    expect(await f.host.workflows.activateRegistration(pending.registrationId)).toEqual({
      accountId: pending.accountId,
    });
    expect(
      (await f.pool.query('SELECT ready FROM auth_copy_work WHERE workflow_id=$1', [pending.workflowId])).rows[0],
    ).toEqual({ ready: true });
  } finally {
    release();
    ports.completeHandleTransition = finish;
    await f.close();
  }
}, 180_000);

test('a lost native-consumed reply redrives from the committed source after restart and DBOS history deletion, independently of copy completion', async () => {
  const f = await nativeFixture();
  const ports = f.bindings.trustedAccess;
  const submit = ports.recordAuthNativeConsumption!;
  let attempts = 0;
  ports.recordAuthNativeConsumption = async (source) => {
    await submit(source);
    if (++attempts === 1) throw new Error('Lost native source reply');
  };
  try {
    const person = await f.person('lost-source-reply');
    expect((await f.delete(person)).status).toBe(200);
    const source = (
      await f.pool.query<{
        id: string;
        source_workflow_id: string;
        source_discharged_at: Date;
        copies_completed_at: Date | null;
      }>(
        'SELECT id,source_workflow_id,source_discharged_at,copies_completed_at FROM auth_erasure WHERE account_id=$1',
        [person.accountId],
      )
    ).rows[0]!;
    expect(source.source_discharged_at).toBeInstanceOf(Date);
    expect(source.copies_completed_at).toBeNull();
    await DBOS.deleteWorkflows([source.source_workflow_id], false);
    await f.host.workflows.close();
    await f.host.workflows.start();
    await eventually(
      async () =>
        !!(
          await f.pool.query('SELECT 1 FROM auth_erasure WHERE id=$1 AND source_published_at IS NOT NULL', [source.id])
        ).rowCount,
    );
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(
      (
        await f.kernel.query('SELECT phase FROM access.auth_history_proof WHERE account_id=$1 ORDER BY phase', [
          person.accountId,
        ])
      ).rows,
    ).toEqual([{ phase: 'native-consumed' }]);
  } finally {
    ports.recordAuthNativeConsumption = submit;
    await f.close();
  }
}, 180_000);
