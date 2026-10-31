import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  OriginalLifecycleRequest,
  OriginalLifecycleSource,
  OriginalLifecycleSourcePort,
  OriginalLifecycleResultPort,
} from '@rezics/auth-contract';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0');
const epoch = (value: number) => Number.isSafeInteger(value) && value > 0;
const iso = (value: Date) => value instanceof Date && Number.isFinite(value.getTime());

/** The original Auth owner only. No current credential, transient verifier,
 * credential fingerprint or private payload is returned to Access. Missing full
 * original rows (including retirement/cascading cleanup) are deliberately null.
 * Expiry alone does not erase a committed source. All dependent reads use PKs. */
export function createOriginalLifecycleSourceReader({ database }: { database: Pool }): OriginalLifecycleSourcePort {
  return {
    async readOriginalLifecycleSource(value): Promise<OriginalLifecycleSource | null> {
      const input = structuredClone(value);
      if (!bounded(input.accountId) || !bounded(input.operationKey)) return null;
      if (input.kind === 'activation') {
        if (
          !bounded(input.source.registrationId) ||
          !bounded(input.source.provisioningReceiptKey) ||
          !bounded(input.reservationId)
        )
          return null;
        const row = (
          await database.query<{
            account_id: string;
            registration_id: string;
            reservation_id: string;
            authn_epoch: string;
            expires_at: Date;
            pending_reference: string;
          }>(
            `SELECT r.account_id,r.registration_id,r.reservation_id,r.authn_epoch::text,r.expires_at,s.pending_reference
           FROM auth_provisioning_receipt r
           JOIN LATERAL (SELECT account_id,reservation_id,pending_reference,activation_key,expires_at
             FROM auth_registration_stage WHERE registration_id=$4 LIMIT 1) s ON true
           WHERE r.idempotency_key=$1 AND r.account_id=$2 AND r.reservation_id=$3
             AND r.registration_id=$3 AND r.owner_id=r.account_id AND r.credential_id IS NOT NULL
             AND r.provisioning_kind IN ('password','credentialless') AND octet_length(r.digest)=32
             AND r.erasure_stage_id=$4 AND s.account_id=r.account_id AND s.reservation_id=r.reservation_id
             AND s.pending_reference IS NOT NULL AND s.activation_key=$5 AND s.expires_at=r.expires_at`,
            [
              input.source.provisioningReceiptKey,
              input.accountId,
              input.reservationId,
              input.source.registrationId,
              input.operationKey,
            ],
          )
        ).rows[0];
        if (!row || !epoch(Number(row.authn_epoch)) || !iso(row.expires_at)) return null;
        return {
          kind: 'activation',
          pendingReference: row.pending_reference,
          expiresAt: row.expires_at.toISOString(),
          proof: {
            accountId: row.account_id,
            registrationId: row.registration_id,
            authIdentityId: row.account_id,
            authnEpoch: Number(row.authn_epoch),
          },
        };
      }
      if (input.kind !== 'recovery' || !/^[a-f0-9]{64}$/.test(input.source.establishmentReference)) return null;
      const row = (
        await database.query<{
          account_id: string;
          receipt_id: string;
          authn_epoch: number;
          establishment_id: string;
          credential_id: string;
          effect_commitment: string;
          credential_fingerprint: string;
          previous_epoch: number;
          operation_key: string;
          digest: string;
          evidence: unknown[];
          expires_at: Date;
        }>(
          `SELECT w.account_id,w.receipt_id,w.authn_epoch,w.establishment_id,w.credential_id,
           w.effect_commitment,w.credential_fingerprint,p.previous_epoch,p.operation_key,p.digest,p.evidence,p.expires_at
         FROM auth_recovery_establishment w
         JOIN LATERAL (SELECT account_id,purpose,previous_epoch,operation_key,digest,evidence,expires_at,applied_at
           FROM auth_barrier_proof WHERE reference=w.reference LIMIT 1) p ON true
         JOIN LATERAL (SELECT account_id,purpose,minimum_authn_epoch
           FROM auth_effect_receipt WHERE receipt_id=w.receipt_id LIMIT 1) e ON true
         JOIN LATERAL (SELECT account_id,authn_epoch,consumed_operation,consumed_at,consumed_verification_id,expires_at
           FROM auth_recovery WHERE proof_hash=p.evidence->>3 LIMIT 1) r ON true
         WHERE w.reference=$1 AND w.account_id=$2 AND p.account_id=w.account_id
           AND p.purpose='recovery' AND p.applied_at IS NOT NULL
           AND e.account_id=w.account_id AND e.purpose='recovery' AND e.minimum_authn_epoch=w.authn_epoch
           AND w.authn_epoch=p.previous_epoch+1
           AND r.account_id=w.account_id AND r.authn_epoch=p.previous_epoch
           AND r.consumed_operation=p.operation_key AND r.consumed_at IS NOT NULL
           AND r.consumed_verification_id=p.evidence->>4 AND r.expires_at>=p.expires_at`,
          [input.source.establishmentReference, input.accountId],
        )
      ).rows[0];
      if (
        !row ||
        !epoch(row.authn_epoch) ||
        !epoch(row.previous_epoch) ||
        !iso(row.expires_at) ||
        !bounded(row.establishment_id) ||
        !/^[a-f0-9]{64}$/.test(row.credential_fingerprint)
      )
        return null;
      const e = row.evidence;
      if (
        !Array.isArray(e) ||
        e.length !== 9 ||
        e[0] !== 'recovery-v1' ||
        e[1] !== input.accountId ||
        e[2] !== row.previous_epoch ||
        e[5] !== row.credential_id ||
        e[7] !== 'set-password' ||
        e[8] !== row.effect_commitment ||
        !/^[a-f0-9]{64}$/.test(row.effect_commitment) ||
        hash(e) !== row.digest ||
        hash(['auth-recovery-v1', input.accountId, e[3]]) !== row.operation_key ||
        hash(['auth-barrier-reference-v1', row.operation_key, row.digest]) !== input.source.establishmentReference ||
        hash(['access-recovery-completion-v1', input.accountId, row.receipt_id, row.establishment_id]) !==
          input.operationKey
      )
        return null;
      return {
        kind: 'recovery',
        proof: {
          accountId: row.account_id,
          receiptId: row.receipt_id,
          minimumAuthnEpoch: String(row.authn_epoch),
          authnEpoch: row.authn_epoch,
          establishmentId: row.establishment_id,
          expiresAt: row.expires_at.toISOString(),
        },
        floor: { operationKey: row.operation_key, previousEpoch: row.previous_epoch, proofDigest: row.digest },
      };
    },
  };
}

/** Auth native consumer composition. Producers choose the installed source and
 * exact command key from their own durable row; clients cannot choose a receipt.
 * Each Auth query releases its checkout before the Access callback. */
export function createNativeLifecycleResults(config: { database: Pool; access: Partial<OriginalLifecycleResultPort> }) {
  const read = (input: OriginalLifecycleRequest) =>
    config.access.readOriginalLifecycleResult?.(input) ?? Promise.resolve(null);
  return {
    async readRegistrationResult(registrationId: string) {
      if (!bounded(registrationId)) return null;
      const row = (
        await config.database.query<{
          account_id: string;
          reservation_id: string;
          activation_key: string;
          idempotency_key: string;
        }>(
          `SELECT s.account_id,s.reservation_id,s.activation_key,r.idempotency_key
         FROM auth_registration_stage s
         JOIN LATERAL (SELECT idempotency_key,erasure_stage_id FROM auth_provisioning_receipt
           WHERE account_id=s.account_id LIMIT 1) r ON r.erasure_stage_id=s.registration_id
         WHERE s.registration_id=$1 AND s.reservation_id IS NOT NULL AND s.activation_key IS NOT NULL`,
          [registrationId],
        )
      ).rows[0];
      return row
        ? read({
            kind: 'activation',
            accountId: row.account_id,
            reservationId: row.reservation_id,
            operationKey: row.activation_key,
            source: { registrationId, provisioningReceiptKey: row.idempotency_key },
          })
        : null;
    },
    async readRecoveryResult(establishmentReference: string) {
      if (!/^[a-f0-9]{64}$/.test(establishmentReference)) return null;
      const row = (
        await config.database.query<{ account_id: string; receipt_id: string; establishment_id: string }>(
          'SELECT account_id,receipt_id,establishment_id FROM auth_recovery_establishment WHERE reference=$1',
          [establishmentReference],
        )
      ).rows[0];
      return row
        ? read({
            kind: 'recovery',
            accountId: row.account_id,
            operationKey: hash(['access-recovery-completion-v1', row.account_id, row.receipt_id, row.establishment_id]),
            source: { establishmentReference },
          })
        : null;
    },
  };
}
