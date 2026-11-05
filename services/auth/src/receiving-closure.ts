import type { AuthReceivingBinding, AuthReceivingClosureProducer, TrustedAccessPorts } from '@rezics/auth-contract';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { restoreDatabaseWithin } from './restore-live.ts';
import { copyTransaction } from './erasure-copy.ts';
import { nativeRoleCoverageComplete } from './erasure-coverage.ts';
import { NATIVE_PHASE_VERSION, NATIVE_PHASE_END } from './erasure-role-upgrade.ts';
import { readAuthSdkFence } from './sdk-retirement-fence.ts';
import { nativeErasurePage } from './erasure-native.ts';

export type { CurrentAuthReceivingClosure } from '@rezics/auth-contract';

/** Producer wire identity. Installation requires independent original custody. */
export const AUTH_RECEIVING_CLOSURE_PUBLICATION = 'auth.receiving-closure/v1' as const;

export type { AuthReceivingClosurePublication } from '@rezics/auth-contract';

type Work = { control_revision: string; binding: AuthReceivingBinding; restore_generation: string | null };
/** Called with all homes released. The registration operation cannot install an
 * owner. No URL, live enrollment or image-carried identity is substituted here. */
export async function beginAuthReceivingClosure(
  database: Pool,
  ports: TrustedAccessPorts,
  id: string,
  deadline: number,
) {
  if (!ports.registerAuthReceivingClosure) return false;
  database = restoreDatabaseWithin(database, deadline);
  const root = (
    await database.query<{ accountId: string; version: number; at: string }>(
      `SELECT account_id::text AS "accountId",kernel_version AS version,kernel_at AS at
     FROM auth_erasure WHERE id=$1 AND kernel_version IS NOT NULL AND kernel_at IS NOT NULL`,
      [id],
    )
  ).rows[0];
  if (!root) return false;
  const registration = await ports.registerAuthReceivingClosure({ barrier: root, deadline });
  if (registration.state !== 'bound') return false;
  const binding = registration.binding;
  return copyTransaction(database, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-erasure:${root.accountId}`]);
    const restored = (
      await tx.query<{ generation: string; database_identity: string | null }>(
        "SELECT generation,inventory->>'databaseIdentity' AS database_identity FROM auth_restore_generation WHERE generation=$1",
        [binding.restoreGeneration],
      )
    ).rows[0];
    // Prior generations retain their lineage. Only the exact bound generation
    // may supply current replay; a marked image cannot claim an original binding.
    if (
      restored
        ? restored.database_identity !== binding.databaseIdentity
        : (await tx.query('SELECT 1 FROM auth_restore_generation LIMIT 1')).rowCount
    )
      return false;
    const result = await tx.query(
      `INSERT INTO auth_receiving_work(obligation_id,control_revision,binding,restore_generation)
      VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(obligation_id,control_revision) DO UPDATE
      SET obligation_id=EXCLUDED.obligation_id WHERE auth_receiving_work.binding=EXCLUDED.binding
      AND auth_receiving_work.restore_generation IS NOT DISTINCT FROM EXCLUDED.restore_generation RETURNING obligation_id`,
      [id, binding.controlRevision, JSON.stringify(binding), restored?.generation ?? null],
    );
    return result.rowCount === 1;
  });
}

/** The ORIGINAL native engine calls this only at its actual current terminal
 * role/cursor/consent check, while holding its permanent account writer fence.
 * A carried native_completed_at marker never calls this function by itself. */
export async function recordAuthReceivingNativeCompletion(tx: PoolClient, id: string, restoreGeneration?: string) {
  await tx.query(
    `UPDATE auth_receiving_work w SET native_xid=pg_current_xact_id()
    FROM auth_erasure e WHERE e.id=w.obligation_id AND e.id=$1
    AND w.restore_generation IS NOT DISTINCT FROM $2::text
    AND e.source_accepted_at IS NOT NULL AND e.source_discharged_at IS NOT NULL
    AND e.native_role_version=1 AND e.native_phase_version=$3
    AND w.control_revision=(SELECT control_revision FROM auth_receiving_work
      WHERE obligation_id=$1 ORDER BY control_revision DESC LIMIT 1)
    AND w.native_xid IS NULL AND w.closure_receipt_id IS NULL`,
    [id, restoreGeneration ?? null, NATIVE_PHASE_VERSION],
  );
}

/** Records the actual permanent SDK writer receipt only AFTER eraseCopy has
 * reread that fence and checked physical absence. No SDK status or EOF is used. */
export async function recordAuthReceivingCopy(database: Pool, id: string, workflowId: string): Promise<boolean> {
  const deadline = Date.now() + 5000;
  database = restoreDatabaseWithin(database, deadline);
  const work = (
    await database.query<{ control_revision: string }>(
      `SELECT control_revision::text
    FROM auth_receiving_work WHERE obligation_id=$1 ORDER BY control_revision DESC LIMIT 1`,
      [id],
    )
  ).rows[0];
  if (!work) return true; // Ordinary cleanup continues; no receiving receipt is issued.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fence = await Promise.race([
    readAuthSdkFence(workflowId),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()));
    }),
  ]).finally(() => clearTimeout(timer));
  if (!fence) return false;
  return copyTransaction(database, async (tx) => {
    const root = (await tx.query<{ account_id: string }>('SELECT account_id FROM auth_erasure WHERE id=$1', [id]))
      .rows[0];
    if (!root) return false;
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-erasure:${root.account_id}`]);
    await tx.query(
      `INSERT INTO auth_receiving_copy(obligation_id,control_revision,workflow_id,sdk_closure_id,sdk_closed_at)
      SELECT w.obligation_id,w.control_revision,c.workflow_id,c.sdk_fence_closure_id,c.sdk_fence_closed_at
      FROM auth_receiving_work w CROSS JOIN auth_copy_work c
      WHERE w.obligation_id=$1 AND w.control_revision=$5 AND c.workflow_id=$2 AND c.retired AND c.absent
      AND c.sdk_fence_generation='2' AND c.sdk_fence_closure_id=$3 AND c.sdk_fence_closed_at=$4
      AND w.closure_receipt_id IS NULL ON CONFLICT DO NOTHING`,
      [id, workflowId, fence.closureID, fence.closedAt, work.control_revision],
    );
    return (
      (
        await tx.query(
          `SELECT 1 FROM auth_receiving_copy WHERE obligation_id=$1 AND control_revision=$2
      AND workflow_id=$3 AND sdk_closure_id=$4 AND sdk_closed_at=$5`,
          [id, work.control_revision, workflowId, fence.closureID, fence.closedAt],
        )
      ).rowCount === 1
    );
  });
}

/** Private factory, not a caller attestation. Reads exact durable native work and
 * commits a fresh local receipt under the original writer fence. Independent
 * physical/receiving custody must ALSO be validated by Access before publication.
 */
export function createAuthReceivingClosureProducer(
  database: Pool,
  ports: TrustedAccessPorts,
  beforePage: (id: string, restoreGeneration?: string, deadline?: number) => Promise<void>,
): AuthReceivingClosureProducer {
  return {
    async readClosure({ barrier, nativeObligationId, binding, deadline }) {
      if (Date.now() >= deadline || Buffer.byteLength(JSON.stringify(binding)) > 1024) return null;
      // Even an obligation whose historical publication already finished enters
      // through the actual current native registration. The input binding alone
      // cannot create local receiving work or renew an original cursor.
      if (!(await beginAuthReceivingClosure(database, ports, nativeObligationId, deadline))) return null;
      const bounded = restoreDatabaseWithin(database, deadline);
      const pending = (
        await bounded.query<{ complete: boolean; restore_generation: string | null }>(
          `SELECT w.native_xid IS NOT NULL AS complete,w.restore_generation
         FROM auth_receiving_work w JOIN auth_erasure e ON e.id=w.obligation_id
         WHERE w.obligation_id=$1 AND w.control_revision=$2 AND w.binding=$3::jsonb
         AND e.account_id=$4 AND e.kernel_version=$5 AND e.kernel_at=$6`,
          [
            nativeObligationId,
            binding.controlRevision,
            JSON.stringify(binding),
            barrier.accountId,
            barrier.version,
            barrier.at,
          ],
        )
      ).rows[0];
      if (!pending) return null;
      // A newly bound historical obligation must revisit the ORIGINAL native
      // engine. Its old terminal marker cannot create this generation's xid.
      // One page preserves the original cursor, cutoff and consumer fences.
      if (!pending.complete)
        await nativeErasurePage(
          bounded,
          nativeObligationId,
          undefined,
          pending.restore_generation ?? undefined,
          (id, generation) => beforePage(id, generation, deadline),
        );
      if (Date.now() >= deadline) return null;
      return copyTransaction(bounded, async (tx) => {
        await tx.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
          String(Math.max(1, deadline - Date.now())),
        ]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-erasure:${barrier.accountId}`]);
        if (!(await nativeRoleCoverageComplete(tx))) return null;
        const work = (
          await tx.query<Work & { closure_receipt_id: string | null; continuation_id: string; receipt_id: string }>(
            `SELECT w.control_revision::text,w.binding,w.restore_generation,w.closure_receipt_id,
             e.source_continuation_id::text AS continuation_id,e.source_receipt_id::text AS receipt_id
           FROM auth_receiving_work w JOIN auth_erasure e ON e.id=w.obligation_id
           WHERE e.id=$1 AND e.account_id=$2 AND e.kernel_version=$3 AND e.kernel_at=$4
           AND w.control_revision=$5 AND w.binding=$6::jsonb AND w.native_xid IS NOT NULL
           AND e.source_accepted_at IS NOT NULL AND e.source_discharged_at IS NOT NULL AND e.source_published_at IS NOT NULL
           AND e.source_continuation_id IS NOT NULL AND e.source_receipt_id IS NOT NULL
           AND e.native_role_version=1 AND e.native_phase_version=$7
           AND e.consent_due_at<=statement_timestamp()
           AND ((w.restore_generation IS NULL AND e.phase=$8 AND e.consent_completed_at IS NOT NULL
             AND NOT EXISTS(SELECT 1 FROM auth_restore_generation LIMIT 1))
           OR EXISTS(SELECT 1 FROM auth_restore_replay r JOIN auth_restore_generation g USING(generation)
             WHERE r.generation=w.restore_generation AND r.obligation_id=e.id AND g.inventory IS NOT NULL
             AND g.inventory->>'databaseIdentity'=w.binding->>'databaseIdentity'
             AND r.phase=$8 AND r.native_completed_at IS NOT NULL AND r.consent_completed_at IS NOT NULL))
           AND NOT EXISTS(SELECT 1 FROM auth_copy_role c WHERE c.account_id=e.account_id LIMIT 1)
           AND NOT EXISTS(SELECT 1 FROM auth_consent c WHERE c.account_id=e.account_id LIMIT 1)
           AND EXISTS(SELECT 1 FROM auth_copy_coverage WHERE singleton AND version=1 AND covered AND native_covered)
           FOR UPDATE OF w`,
            [
              nativeObligationId,
              barrier.accountId,
              barrier.version,
              barrier.at,
              binding.controlRevision,
              JSON.stringify(binding),
              NATIVE_PHASE_VERSION,
              NATIVE_PHASE_END,
            ],
          )
        ).rows[0];
        if (!work || Date.now() >= deadline) return null;
        const receipt = work.closure_receipt_id ?? randomUUID(); // Receipt ID, never receiver identity.
        await tx.query(
          `UPDATE auth_receiving_work SET closure_receipt_id=$3,closure_xid=COALESCE(closure_xid,pg_current_xact_id())
          WHERE obligation_id=$1 AND control_revision=$2`,
          [nativeObligationId, binding.controlRevision, receipt],
        );
        return {
          format: AUTH_RECEIVING_CLOSURE_PUBLICATION,
          source: { ...barrier, continuationId: work.continuation_id, receiptId: work.receipt_id },
          binding,
          nativeObligationId,
          closureReceiptId: receipt,
        };
      });
    },
  };
}
