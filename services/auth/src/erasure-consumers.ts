import type { Pool, PoolClient } from 'pg';
import type {
  AccountWorkflowPorts,
  OriginalLifecycleRequest,
  OriginalLifecycleResult,
  OriginalLifecycleResultPort,
} from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { isRefusal } from './workflows.ts';
import {
  originalLifecycleOutcome,
  registrationActivationResult,
  registrationExpiryResult,
} from './native-proof-minimization.ts';
import { createNativeLifecycleResults } from './native-lifecycle-results.ts';

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
    | 'readOriginalLifecycleResult'
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
     WHERE s.registration_id=$1 AND p.binding=${registrationBindingSql}
       AND p.result->>'outcome' IN ('activated','expired')`,
      [stageId],
    )
  ).rowCount;
}

/** Accept only the actual activation value, returned by Access.activate or its
 * private original-result reader. The original source key precedes source work. */
export async function recordRegistrationActivation(
  pool: Pool | PoolClient,
  stageId: string,
  activationKey: string,
  result: unknown,
): Promise<boolean> {
  if (!registrationActivationResult(result)) return false;
  const recorded = await pool.query(
    `INSERT INTO auth_native_consumer_proof (store,key,binding,result)
     SELECT 'registration',s.registration_id,${registrationBindingSql},
       jsonb_build_object('outcome','activated','sourceResult',$3::jsonb)
     FROM auth_registration_stage s WHERE s.registration_id=$1 AND s.activation_key=$2
       AND s.account_id=$4 AND s.reservation_id IS NOT NULL AND s.consumer_workflow_id IS NOT NULL
     ON CONFLICT (store,key) DO NOTHING RETURNING key`,
    [stageId, activationKey, JSON.stringify(result), result.accountId],
  );
  return (
    (recorded.rowCount ?? 0) > 0 ||
    !!(
      await pool.query(
        `SELECT 1 FROM auth_registration_stage s JOIN auth_native_consumer_proof p
       ON p.store='registration' AND p.key=s.registration_id
       WHERE s.registration_id=$1 AND s.activation_key=$2 AND p.binding=${registrationBindingSql}
         AND p.result=jsonb_build_object('outcome','activated','sourceResult',$3::jsonb)`,
        [stageId, activationKey, JSON.stringify(result)],
      )
    ).rowCount
  );
}

/** Foreign reads run before this transaction. Reacquire the native erasure
 * lock and original row locks before transferring a source's responsibility.
 * Original command provenance never becomes this consumer's transaction ID. */
async function consumeOriginal(
  pool: Pool,
  obligationId: string,
  consume: (connection: PoolClient) => Promise<boolean>,
): Promise<boolean> {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const owner = (
      await connection.query<{ account_id: string }>('SELECT account_id FROM auth_erasure WHERE id=$1', [obligationId])
    ).rows[0];
    let consumed = false;
    if (owner) {
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `auth-erasure:${owner.account_id}`,
      ]);
      const locked = await connection.query('SELECT 1 FROM auth_erasure WHERE id=$1 AND account_id=$2 FOR UPDATE', [
        obligationId,
        owner.account_id,
      ]);
      if (locked.rowCount) consumed = await consume(connection);
    }
    await connection.query('COMMIT');
    return consumed;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

async function readOriginal(
  access: Partial<OriginalLifecycleResultPort>,
  request: OriginalLifecycleRequest,
): Promise<OriginalLifecycleResult | null> {
  return access.readOriginalLifecycleResult?.(request) ?? null;
}

async function continueRegistration(
  pool: Pool,
  obligationId: string,
  stageId: string,
  runtime: NativeConsumerRuntime,
): Promise<boolean> {
  const row = (
    await pool.query<Registration>(
      `SELECT ${registrationColumns}
    FROM auth_registration_stage WHERE registration_id=$1`,
      [stageId],
    )
  ).rows[0];
  if (!row?.consumer_workflow_id || !row.activation_key || !row.reservation_id || !row.expires_at) return false;
  if (row.erasure_operator_id && !row.operator_reservation_id) return false;
  // The receipt's actual key belongs to the original source; it is not derived
  // from a new caller, workflow retry, current account or transient verifier.
  const receipt = (
    await pool.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM auth_provisioning_receipt WHERE account_id=$1 AND erasure_stage_id=$2',
      [row.account_id, stageId],
    )
  ).rows[0];
  if (receipt) {
    const request: OriginalLifecycleRequest = {
      kind: 'activation',
      accountId: row.account_id,
      reservationId: row.reservation_id,
      operationKey: row.activation_key,
      source: { registrationId: stageId, provisioningReceiptKey: receipt.idempotency_key },
    };
    const original = await readOriginal(runtime.access, request);
    if (original) {
      if (
        original.kind !== 'activation' ||
        !originalLifecycleOutcome(original) ||
        original.accountId !== row.account_id ||
        original.reservationId !== row.reservation_id ||
        original.authnEpoch !== 1 ||
        original.outcome.value.accountId !== row.account_id
      )
        return false;
      return consumeOriginal(pool, obligationId, async (connection) => {
        const stage = await connection.query(
          `SELECT 1 FROM auth_registration_stage s WHERE s.registration_id=$1
           AND ${registrationBindingSql}=$2::jsonb AND s.expires_at=$3 FOR UPDATE`,
          [stageId, JSON.stringify(registrationBinding(row)), row.expires_at],
        );
        if (!stage.rowCount) return false;
        const source = await connection.query(
          `SELECT 1 FROM auth_provisioning_receipt WHERE idempotency_key=$1 AND erasure_stage_id=$2
           AND account_id=$3 AND registration_id=$4 AND reservation_id=$4 AND authn_epoch=$5
           AND expires_at=$6 FOR UPDATE`,
          [receipt.idempotency_key, stageId, row.account_id, row.reservation_id, original.authnEpoch, row.expires_at],
        );
        return (
          !!source.rowCount &&
          recordRegistrationActivation(connection, stageId, request.operationKey, original.outcome.value)
        );
      });
    }
  }
  const current = await runtime.access.readAccount(row.account_id);
  if (!current || current.accountId !== row.account_id) return false;
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
  const result = registrationExpiryResult(
    claim,
    sourceResult,
    handleResult,
    row.erasure_operator_id
      ? {
          operatorAccountId: row.erasure_operator_id,
          subjectAccountId: row.account_id,
          reservationId: row.operator_reservation_id!,
        }
      : undefined,
    responsibilityResult,
  );
  if (!result) return false;
  // The real terminal account command precedes the existing Auth obligation.
  // Starting it releases its connection before the parent checkpoint is acquired.
  await runtime.auth.internal.startAccountErasure(row.account_id);
  await pool.query(
    `INSERT INTO auth_native_consumer_proof (store,key,binding,result)
    SELECT 'registration',s.registration_id,${registrationBindingSql},$2::jsonb
    FROM auth_registration_stage s WHERE s.registration_id=$1 AND ${registrationBindingSql}=$3::jsonb
    ON CONFLICT (store,key) DO NOTHING`,
    [stageId, JSON.stringify(result), JSON.stringify(registrationBinding(row))],
  );
  return true;
}

const recoveryBindingSql = `jsonb_build_array(w.reference,w.receipt_id,w.account_id,w.establishment_id,
  w.effect_commitment,w.authn_epoch)`;
type Recovery = {
  reference: string;
  receipt_id: string;
  account_id: string;
  establishment_id: string;
  effect_commitment: string;
  authn_epoch: number;
};
const recoveryBinding = (row: Recovery) => [
  row.reference,
  row.receipt_id,
  row.account_id,
  row.establishment_id,
  row.effect_commitment,
  row.authn_epoch,
];

async function continueRecovery(
  pool: Pool,
  obligationId: string,
  reference: string,
  runtime: NativeConsumerRuntime,
): Promise<boolean> {
  const row = (
    await pool.query<Recovery>(
      `SELECT reference,receipt_id,account_id,establishment_id,effect_commitment,authn_epoch
       FROM auth_recovery_establishment WHERE reference=$1`,
      [reference],
    )
  ).rows[0];
  if (!row) return false;
  // The original producer derives its exact operation key from Auth's source.
  // All checkouts end before the foreign read, even with a single-slot pool.
  const original = await createNativeLifecycleResults({ database: pool, access: runtime.access }).readRecoveryResult(
    reference,
  );
  if (original) {
    if (
      original.kind !== 'recovery' ||
      !originalLifecycleOutcome(original) ||
      original.accountId !== row.account_id ||
      original.establishmentId !== row.establishment_id ||
      original.outcome.value.accountId !== row.account_id ||
      original.outcome.value.receiptId !== row.receipt_id ||
      original.outcome.value.minimumAuthnEpoch !== String(row.authn_epoch)
    )
      return false;
    return consumeOriginal(pool, obligationId, async (connection) => {
      const source = await connection.query(
        `SELECT 1 FROM auth_recovery_establishment w WHERE w.reference=$1
         AND ${recoveryBindingSql}=$2::jsonb FOR UPDATE`,
        [reference, JSON.stringify(recoveryBinding(row))],
      );
      if (!source.rowCount) return false;
      // Keep the same original Auth floor and receipt, independently of any
      // subsequent account deletion/fence. No deadline is renewed here.
      const floor = await connection.query(
        `SELECT 1 FROM auth_barrier_proof WHERE reference=$1 AND account_id=$2
         AND purpose='recovery' AND previous_epoch=$3-1 AND applied_at IS NOT NULL FOR UPDATE`,
        [reference, row.account_id, row.authn_epoch],
      );
      const receipt = await connection.query(
        `SELECT 1 FROM auth_effect_receipt WHERE receipt_id=$1 AND account_id=$2
         AND purpose='recovery' AND minimum_authn_epoch=$3 FOR UPDATE`,
        [row.receipt_id, row.account_id, row.authn_epoch],
      );
      if (!floor.rowCount || !receipt.rowCount) return false;
      const result = JSON.stringify({ outcome: 'released', sourceResult: original.outcome.value });
      await connection.query(
        `INSERT INTO auth_native_consumer_proof (store,key,binding,result)
         VALUES ('recovery',$1,$2::jsonb,$3::jsonb) ON CONFLICT (store,key) DO NOTHING`,
        [reference, JSON.stringify(recoveryBinding(row)), result],
      );
      return !!(
        await connection.query(
          `SELECT 1 FROM auth_native_consumer_proof WHERE store='recovery' AND key=$1
           AND binding=$2::jsonb AND result=$3::jsonb`,
          [reference, JSON.stringify(recoveryBinding(row)), result],
        )
      ).rowCount;
    });
  }
  // Only a still-live fenced source can use the existing completion authority.
  // A deleted account or a completed (unfenced) source cannot replace a missing
  // original result. Unknown/expired sources remain pending in that authority.
  const current = await runtime.access.readAccount(row.account_id);
  if (!current || current.accountId !== row.account_id || current.state !== 'active' || !current.fenced) return false;
  if (!runtime.completeRecovery) return false;
  await runtime.completeRecovery(reference);
  await recordRecoveryCompletion(pool, reference);
  return true;
}

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
export async function recordRecoveryCompletion(pool: Pool, reference: string): Promise<void> {
  await pool.query(
    `INSERT INTO auth_native_consumer_proof (store,key,binding,result)
    SELECT 'recovery',w.reference,${recoveryBindingSql},$2::jsonb
    FROM auth_recovery_establishment w WHERE w.reference=$1
    ON CONFLICT (store,key) DO NOTHING`,
    [reference, JSON.stringify({ outcome: 'released' })],
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
    if (locator.store === 'auth_registration_stage')
      return await continueRegistration(pool, obligationId, locator.key, runtime);
    if (locator.store === 'auth_provisioning_receipt') {
      const row = (
        await pool.query<{ erasure_stage_id: string | null }>(
          'SELECT erasure_stage_id FROM auth_provisioning_receipt WHERE idempotency_key=$1',
          [locator.key],
        )
      ).rows[0];
      return row?.erasure_stage_id
        ? await continueRegistration(pool, obligationId, row.erasure_stage_id, runtime)
        : false;
    }
    if (locator.store === 'auth_client_reduction_progress')
      return await runtime.auth.internal.continueNativeClientReduction(
        { operationId: locator.key, obligationId },
        runtime.access,
      );
    if (locator.store === 'auth_recovery_establishment')
      return await continueRecovery(pool, obligationId, locator.key, runtime);
    return false;
  } catch (error) {
    if (isRefusal(error)) return false;
    throw error;
  }
}

// Registration retains its exact activation/expiry proof. A current non-stage
// operation uses the original finishCopyResult/completeCopy native return reader:
// its committed digest must actually be consumed. terminal_at/SDK status alone
// and historical missing attribution remain insufficient.
export async function nativeRequestTerminal(connection: PoolClient, workflowId: string): Promise<boolean> {
  return !!(
    await connection.query(
      `SELECT 1 FROM auth_workflow_request r WHERE r.workflow_id=$1 AND (
        EXISTS (SELECT 1 FROM auth_native_consumer_proof p
          WHERE p.store='registration' AND p.key=r.erasure_stage_id
            AND p.binding->>1=r.workflow_id AND p.result->>'outcome' IN ('activated','expired'))
        OR (r.erasure_stage_id IS NULL AND r.terminal_at IS NOT NULL
          AND r.request_party_version=1 AND r.request_context_version=1 AND r.erasure_actor_version=1
          AND EXISTS (SELECT 1 FROM auth_copy_work w WHERE w.workflow_id=r.workflow_id
            AND w.source_key=r.workflow_id AND w.result_digest IS NOT NULL
            AND w.result_finished_at IS NOT NULL AND w.ready)))`,
      [workflowId],
    )
  ).rowCount;
}
