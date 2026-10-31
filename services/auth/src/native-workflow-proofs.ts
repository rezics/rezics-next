import type { NativeWorkflowPair, AutomatedCreationBinding, NativeWorkflowProofPorts } from '@rezics/auth-contract';
export type { NativeWorkflowPair, AutomatedCreationBinding, NativeWorkflowProofPorts } from '@rezics/auth-contract';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createProvisioningEvidenceVerifier } from './provisioning-evidence.ts';
import { createOriginalLifecycleSourceReader } from './native-lifecycle-results.ts';

function bounded(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}
function pair(input: NativeWorkflowPair) {
  if (!bounded(input.accountId) || !bounded(input.reservationId)) throw new Error('Native workflow proof denied');
}

/** Auth-owned transport only. Every lookup starts at a unique staging owner or
 * registration key. No JSON search, history traversal, credential or policy cache.
 * Deleting the native staging owner also deletes these embedded references. */
export function createNativeWorkflowProofPorts({ database }: { database: Pool }) {
  const verifier = createProvisioningEvidenceVerifier({ database });
  return {
    ...createOriginalLifecycleSourceReader({ database }),
    async recordPending(input: NativeWorkflowPair & { reference: string }): Promise<void> {
      const { accountId, reservationId, reference } = input;
      pair(input);
      if (!bounded(reference)) throw new Error('Native workflow proof denied');
      const result = await database.query(
        `UPDATE auth_registration_stage SET reservation_id=$2,pending_reference=$3
         WHERE account_id=$1 AND (reservation_id IS NULL OR reservation_id=$2)
           AND (pending_reference IS NULL OR pending_reference=$3) RETURNING registration_id`,
        [accountId, reservationId, reference],
      );
      if (result.rowCount !== 1) throw new Error('Native pending binding conflict');
    },
    async pendingReference(input: NativeWorkflowPair): Promise<string | null> {
      const { accountId, reservationId } = input;
      pair(input);
      return (
        (
          await database.query<{ pending_reference: string | null }>(
            'SELECT pending_reference FROM auth_registration_stage WHERE account_id=$1 AND reservation_id=$2',
            [accountId, reservationId],
          )
        ).rows[0]?.pending_reference ?? null
      );
    },
    async recordAutomatedPending(input: NativeWorkflowPair & { reference: string }): Promise<void> {
      const { accountId, reservationId, reference } = input;
      pair(input);
      if (!bounded(reference)) throw new Error('Native workflow proof denied');
      const result = await database.query(
        `UPDATE auth_registration_stage SET automated_reference=$3
         WHERE account_id=$1 AND reservation_id=$2 AND pending_reference IS NOT NULL
           AND (automated_reference IS NULL OR automated_reference=$3) RETURNING registration_id`,
        [accountId, reservationId, reference],
      );
      if (result.rowCount !== 1) throw new Error('Native automated binding conflict');
    },
    async automatedReference(input: NativeWorkflowPair): Promise<string | null> {
      const { accountId, reservationId } = input;
      pair(input);
      return (
        (
          await database.query<{ automated_reference: string | null }>(
            'SELECT automated_reference FROM auth_registration_stage WHERE account_id=$1 AND reservation_id=$2',
            [accountId, reservationId],
          )
        ).rows[0]?.automated_reference ?? null
      );
    },
    async provisioningEvidence(input: NativeWorkflowPair): Promise<unknown> {
      const { accountId, reservationId } = input;
      pair(input);
      const row = (
        await database.query<{
          receiptKey: string;
          accountId: string;
          registrationId: string;
          reservationId: string;
          authnEpoch: string;
          expiresAt: Date;
        }>(
          `SELECT r.idempotency_key AS "receiptKey",r.account_id AS "accountId",
           r.registration_id AS "registrationId",r.reservation_id AS "reservationId",
           r.authn_epoch::text AS "authnEpoch",r.expires_at AS "expiresAt"
         FROM auth_registration_stage s JOIN auth_provisioning_receipt r ON r.account_id=s.account_id
         WHERE s.account_id=$1 AND s.reservation_id=$2 AND s.pending_reference IS NOT NULL
           AND r.registration_id=s.reservation_id AND r.reservation_id=s.reservation_id
           AND r.expires_at=s.expires_at`,
          [accountId, reservationId],
        )
      ).rows[0];
      return row
        ? verifier.createReference({
            ...row,
            authnEpoch: Number(row.authnEpoch),
            expiresAt: row.expiresAt.toISOString(),
          })
        : null;
    },
    async creationBinding(input: {
      registrationId: string;
      operationKey: string;
      accountId?: string;
      reservationId?: string;
    }): Promise<AutomatedCreationBinding | null> {
      const { registrationId, operationKey, accountId, reservationId } = input;
      // Only the still-live original stage can answer this approval reader.
      // Terminal proof skeletons never reconstruct a creation descriptor or
      // authorize a new producer after the stage's final reader has retired.
      if (!bounded(registrationId) || !bounded(operationKey) || operationKey.length > 128) return null;
      const requestKey = `automated:${createHash('sha256').update(JSON.stringify(operationKey)).digest('hex')}`;
      const row = (
        await database.query<{ creation_binding: AutomatedCreationBinding | null }>(
          'SELECT creation_binding FROM auth_registration_stage WHERE registration_id=$1 AND request_key=$2 AND ($3::text IS NULL OR account_id=$3) AND ($4::text IS NULL OR reservation_id=$4)',
          [registrationId, requestKey, accountId ?? null, reservationId ?? null],
        )
      ).rows[0];
      return row?.creation_binding?.operationKey === operationKey ? row.creation_binding : null;
    },
  } satisfies NativeWorkflowProofPorts;
}
