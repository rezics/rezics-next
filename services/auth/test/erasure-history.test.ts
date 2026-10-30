import { expect, test } from 'bun:test';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { AuthErasureSource } from '@rezics/auth-contract';
import { nativeFixture, password, scopes } from './support/erasure-native.ts';
import { COPY_TABLES, copiesAbsent, createCopyWriter, eraseCopy } from '../src/erasure-copy.ts';
import { erasureHistoryPage, publishErasureProofs } from '../src/erasure-history.ts';
import { nativeErasurePage, startNativeErasure } from '../src/erasure-native.ts';

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
