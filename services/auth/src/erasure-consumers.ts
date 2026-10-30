import type { Pool, PoolClient } from 'pg';
import type { AccountWorkflowPorts } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { isRefusal } from './workflows.ts';

/** Close only the native credential CAS consumer. The locked source receipt,
 * immutable stage binding and permanent producer fence are the proof; neither
 * account absence nor workflow status participates. The caller owns the native
 * page transaction, so proof, deletion and checkpoint commit together. */
export async function closeCredentialConsumer(connection: PoolClient, receiptId: string): Promise<boolean> {
  const proof = await connection.query(
    `INSERT INTO auth_native_credential_terminal
       (receipt_id,obligation_id,operation_key,effect_reference,effect_digest,account_id,minimum_authn_epoch,
        opening_receipt_id,outcome,committed_result)
     SELECT r.receipt_id,e.id,r.operation_key,r.effect_reference,r.effect_digest,
       r.account_id,r.minimum_authn_epoch,r.opening_receipt_id,
       CASE WHEN r.committed_at IS NOT NULL THEN 'committed' ELSE 'fenced-refusal' END,
       r.committed_result
     FROM auth_effect_receipt r
     JOIN auth_erasure e ON e.id=NULLIF(current_setting('auth.erasure_obligation',true),'')::bigint
     WHERE r.receipt_id=$1 AND r.stage_version=1
       AND r.operation_key IS NOT NULL AND r.effect_reference IS NOT NULL
       AND r.effect_digest ~ '^[a-f0-9]{64}$'
       AND (e.account_id IN (r.account_id,r.acting_human_id,r.erasure_operator_id)
         OR EXISTS (SELECT 1 FROM auth_erased_client c
           WHERE c.client_id=r.client_id AND c.obligation_id=e.id))
       AND ((r.committed_at IS NULL AND r.committed_result IS NULL AND r.opening_receipt_id IS NULL)
         OR (r.committed_at IS NOT NULL AND r.opening_receipt_id IS NOT NULL
           AND r.committed_result=jsonb_build_object('receiptId',r.receipt_id,'replayed',false)))
     ON CONFLICT (receipt_id) DO NOTHING RETURNING receipt_id`,
    [receiptId],
  );
  if (proof.rowCount) return true;
  // An interrupted delivery may already have committed the same immutable proof.
  // Compare every source binding; a missing or replaced source is never evidence.
  return !!(
    await connection.query(
      `SELECT 1 FROM auth_native_credential_terminal t
       JOIN auth_effect_receipt r ON r.receipt_id=t.receipt_id
       WHERE t.receipt_id=$1 AND r.stage_version=1
         AND t.operation_key=r.operation_key AND t.effect_reference=r.effect_reference
         AND t.effect_digest=r.effect_digest
         AND t.account_id=r.account_id AND t.minimum_authn_epoch=r.minimum_authn_epoch
         AND t.opening_receipt_id IS NOT DISTINCT FROM r.opening_receipt_id
         AND ((t.outcome='committed' AND r.committed_at IS NOT NULL
           AND t.committed_result=r.committed_result)
         OR (t.outcome='fenced-refusal' AND r.committed_at IS NULL))`,
      [receiptId],
    )
  ).rowCount;
}

/** These are the existing native release ports, never a caller approval. */
export type NativeConsumerRuntime = {
  access: Pick<
    AccountWorkflowPorts<never>,
    | 'readAccount'
    | 'provisioningEvidence'
    | 'activate'
    | 'expireRegistration'
    | 'releaseExpiredRegistrationHandle'
    | 'retireResponsibility'
    | 'releaseResponsibility'
    | 'raiseFence'
  >;
  auth: AuthService;
  completeRecovery?: (reference: string) => Promise<void>;
};
export type NativeConsumerLocator = { store: string; key: string };

type Registration = {
  registration_id: string;
  consumer_workflow_id: string | null;
  activation_key: string | null;
  account_id: string;
  handle: string;
  reservation_id: string | null;
  expires_at: Date | null;
  erasure_operator_id: string | null;
  operator_reservation_id: string | null;
};
// Exact native columns only. Encrypted credentials and creation/approval payloads
// never enter this consumer, its proof, or the scheduler's workflow history.
const registrationColumns = `registration_id,consumer_workflow_id,activation_key,account_id,handle,
  reservation_id,expires_at,erasure_operator_id,operator_reservation_id`;
const registrationBinding = (row: Registration) => [
  row.registration_id,
  row.consumer_workflow_id,
  row.activation_key,
  row.account_id,
  row.handle,
  row.reservation_id,
  row.erasure_operator_id,
  row.operator_reservation_id,
];
const registrationBindingSql = `jsonb_build_array(s.registration_id,s.consumer_workflow_id,
  s.activation_key,s.account_id,s.handle,s.reservation_id,s.erasure_operator_id,s.operator_reservation_id)`;

export async function registrationTerminal(connection: PoolClient, stageId: string): Promise<boolean> {
  return !!(
    await connection.query(
      `SELECT 1 FROM auth_registration_stage s JOIN auth_native_consumer_proof p
     ON p.store='registration' AND p.key=s.registration_id
     WHERE s.registration_id=$1 AND p.binding=${registrationBindingSql}`,
      [stageId],
    )
  ).rowCount;
}

/** Called only with the actual return from Access.activate, before the ordinary
 * completion marker. The original source key is fixed before any source command. */
export async function recordRegistrationActivation(
  pool: Pool,
  stageId: string,
  activationKey: string,
  result: { accountId: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO auth_native_consumer_proof (store,key,binding,result)
     SELECT 'registration',s.registration_id,${registrationBindingSql},
       jsonb_build_object('outcome','activated','sourceResult',$3::jsonb)
     FROM auth_registration_stage s WHERE s.registration_id=$1 AND s.activation_key=$2
       AND s.account_id=$4 AND s.reservation_id IS NOT NULL AND s.consumer_workflow_id IS NOT NULL
     ON CONFLICT (store,key) DO NOTHING`,
    [stageId, activationKey, JSON.stringify(result), result.accountId],
  );
}

async function continueRegistration(pool: Pool, stageId: string, runtime: NativeConsumerRuntime): Promise<boolean> {
  const row = (
    await pool.query<Registration>(
      `SELECT ${registrationColumns}
    FROM auth_registration_stage WHERE registration_id=$1`,
      [stageId],
    )
  ).rows[0];
  if (!row?.consumer_workflow_id || !row.activation_key || !row.reservation_id || !row.expires_at) return false;
  if (row.erasure_operator_id && !row.operator_reservation_id) return false;
  const current = await runtime.access.readAccount(row.account_id);
  if (!current || current.accountId !== row.account_id) return false;
  if (current.state !== 'pending') {
    // A nonpending source cannot newly activate. Only the original immutable
    // command's replay can return a result, including after later deletion.
    const evidence = await runtime.access.provisioningEvidence({
      accountId: row.account_id,
      reservationId: row.reservation_id,
    });
    if (evidence) {
      try {
        const result = (await runtime.access.activate({ accountId: row.account_id, key: row.activation_key, evidence }))
          .value;
        await recordRegistrationActivation(pool, stageId, row.activation_key, result);
        return true;
      } catch (error) {
        if (!isRefusal(error)) throw error;
      }
    }
  }
  if (current.state !== 'pending' && current.state !== 'deleted') return false;
  // Kernel owns the pending deadline. A not-yet-due source refuses and stays
  // pending; Auth never synthesizes Kernel T or expires a caller's authority.
  const claim = {
    accountId: row.account_id,
    handle: row.handle,
    reservationId: row.reservation_id,
    expiresAt: row.expires_at.toISOString(),
  };
  const sourceResult = (
    await runtime.access.expireRegistration({ ...claim, key: `wf:${row.consumer_workflow_id}:expire` })
  ).value;
  const handleResult = (
    await runtime.access.releaseExpiredRegistrationHandle({
      ...claim,
      key: `wf:${row.consumer_workflow_id}:release-expired`,
    })
  ).value;
  let responsibilityResult: { retired: unknown; released: unknown } | undefined;
  if (row.erasure_operator_id) {
    if (!runtime.access.retireResponsibility || !runtime.access.releaseResponsibility) return false;
    const responsibility = {
      operatorAccountId: row.erasure_operator_id,
      subjectAccountId: row.account_id,
      reservationId: row.operator_reservation_id!,
    };
    const retired = (
      await runtime.access.retireResponsibility({
        ...responsibility,
        key: `wf:${row.consumer_workflow_id}:retire-operator`,
      })
    ).value;
    const released = (
      await runtime.access.releaseResponsibility({
        ...responsibility,
        key: `wf:${row.consumer_workflow_id}:release-operator`,
      })
    ).value;
    responsibilityResult = { retired, released };
  }
  // The real terminal account command precedes the existing Auth obligation.
  // Starting it releases its connection before the parent checkpoint is acquired.
  await runtime.auth.internal.startAccountErasure(row.account_id);
  await pool.query(
    `INSERT INTO auth_native_consumer_proof (store,key,binding,result)
    SELECT 'registration',s.registration_id,${registrationBindingSql},$2::jsonb
    FROM auth_registration_stage s WHERE s.registration_id=$1 AND ${registrationBindingSql}=$3::jsonb
    ON CONFLICT (store,key) DO NOTHING`,
    [
      stageId,
      JSON.stringify({ outcome: 'expired', sourceResult, handleResult, responsibilityResult }),
      JSON.stringify(registrationBinding(row)),
    ],
  );
  return true;
}

const recoveryBindingSql = `jsonb_build_array(w.reference,w.receipt_id,w.account_id,w.establishment_id,
  w.effect_commitment,w.authn_epoch)`;
export async function recoveryTerminal(connection: PoolClient, reference: string): Promise<boolean> {
  return !!(
    await connection.query(
      `SELECT 1 FROM auth_recovery_establishment w
    JOIN auth_native_consumer_proof p ON p.store='recovery' AND p.key=w.reference
    WHERE w.reference=$1 AND p.binding=${recoveryBindingSql}`,
      [reference],
    )
  ).rowCount;
}
export async function recordRecoveryCompletion(
  pool: Pool,
  reference: string,
  sourceDeleted?: { accountId: string; state: 'deleted'; fenced: true },
): Promise<void> {
  await pool.query(
    `INSERT INTO auth_native_consumer_proof (store,key,binding,result)
    SELECT 'recovery',w.reference,${recoveryBindingSql},$2::jsonb
    FROM auth_recovery_establishment w WHERE w.reference=$1
    ON CONFLICT (store,key) DO NOTHING`,
    [
      reference,
      JSON.stringify(
        sourceDeleted ? { outcome: 'source-deleted', sourceResult: sourceDeleted } : { outcome: 'released' },
      ),
    ],
  );
}

/** One already-admitted raw key; no pool slot crosses a foreign service call.
 * Refusal is only a retryable pending outcome. It never creates a terminal proof. */
export async function continueNativeConsumer(
  pool: Pool,
  obligationId: string,
  locator: NativeConsumerLocator,
  runtime: NativeConsumerRuntime,
): Promise<boolean> {
  try {
    if (locator.store === 'auth_registration_stage') return await continueRegistration(pool, locator.key, runtime);
    if (locator.store === 'auth_provisioning_receipt') {
      const row = (
        await pool.query<{ erasure_stage_id: string | null }>(
          'SELECT erasure_stage_id FROM auth_provisioning_receipt WHERE idempotency_key=$1',
          [locator.key],
        )
      ).rows[0];
      return row?.erasure_stage_id ? await continueRegistration(pool, row.erasure_stage_id, runtime) : false;
    }
    if (locator.store === 'auth_client_reduction_progress')
      return await runtime.auth.internal.continueNativeClientReduction(
        { operationId: locator.key, obligationId },
        runtime.access,
      );
    if (locator.store === 'auth_recovery_establishment' && runtime.completeRecovery) {
      const source = (
        await pool.query<{ account_id: string }>(
          'SELECT account_id FROM auth_recovery_establishment WHERE reference=$1',
          [locator.key],
        )
      ).rows[0];
      if (!source) return false;
      const current = await runtime.access.readAccount(source.account_id);
      if (!current || current.accountId !== source.account_id) return false;
      if (current.state === 'deleted' && current.fenced) {
        // The actual source's deleted state is immutable and clearFence can
        // never write it again. This is a present source row, never account absence.
        await recordRecoveryCompletion(pool, locator.key, {
          accountId: current.accountId,
          state: 'deleted',
          fenced: true,
        });
        return true;
      }
      await runtime.completeRecovery(locator.key);
      await recordRecoveryCompletion(pool, locator.key);
      return true;
    }
    return false;
  } catch (error) {
    if (isRefusal(error)) return false;
    throw error;
  }
}

export async function nativeRequestTerminal(connection: PoolClient, workflowId: string): Promise<boolean> {
  return !!(
    await connection.query(
      `SELECT 1 FROM auth_workflow_request r
    JOIN auth_native_consumer_proof p ON p.store='registration' AND p.key=r.erasure_stage_id
    WHERE r.workflow_id=$1 AND p.binding->>1=r.workflow_id
      AND p.result->>'outcome' IN ('activated','expired')`,
      [workflowId],
    )
  ).rowCount;
}
