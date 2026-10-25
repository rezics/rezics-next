import type { Pool } from 'pg';

/** Committed successful native Auth recovery, bound to the exact Access barrier
 * and a new credential establishment. Structurally matches Access evidence. */
export type RecoveryEstablishmentEvidence = Readonly<{
  accountId: string;
  receiptId: string;
  minimumAuthnEpoch: string;
  authnEpoch: number;
  establishmentId: string;
}>;

const hash = async (value: unknown) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))).toString('hex');

/** A nonsecret exact locator, never caller evidence. All joins seek unique keys;
 * credential material stays inside Auth. Access owns current account, fence and
 * receipt comparison. The original proof owns expiry and cascading cleanup.
 * Construction reads no environment, opens no database and starts no workflows.
 */
export function createRecoveryEstablishmentVerifier({ database }: { database: Pool }) {
  return {
    async resolve(reference: unknown): Promise<RecoveryEstablishmentEvidence | null> {
      if (typeof reference !== 'string' || !/^[0-9a-f]{64}$/.test(reference)) return null;
      // Admit each exact PK before applying owner predicates. Joining all
      // predicates at once can make the planner walk same-owner history instead.
      const row = (
        await database.query<{
          account_id: string;
          receipt_id: string;
          authn_epoch: number;
          establishment_id: string;
          credential_id: string;
          credential_fingerprint: string;
          effect_commitment: string;
          previous_epoch: number;
          operation_key: string;
          digest: string;
          evidence: unknown[];
          password: string;
          updatedAt: Date;
          expires_at: Date;
        }>(
          `SELECT w.*,p.previous_epoch,p.operation_key,p.digest,p.evidence,p.expires_at,c.password,c."updatedAt"
         FROM auth_recovery_establishment w
         JOIN LATERAL (
           SELECT account_id,purpose,previous_epoch,operation_key,digest,evidence,expires_at,applied_at
           FROM auth_barrier_proof WHERE reference=w.reference LIMIT 1
         ) p ON true
         JOIN LATERAL (
           SELECT account_id,purpose,minimum_authn_epoch
           FROM auth_effect_receipt WHERE receipt_id=w.receipt_id LIMIT 1
         ) e ON true
         JOIN LATERAL (
           SELECT "userId","accountId","providerId",password,"updatedAt"
           FROM account WHERE id=w.credential_id LIMIT 1
         ) c ON true
         JOIN LATERAL (
           SELECT account_id,authn_epoch,consumed_operation,consumed_at,consumed_verification_id,expires_at
           FROM auth_recovery WHERE proof_hash=p.evidence->>3 LIMIT 1
         ) r ON true
         WHERE w.reference=$1 AND p.purpose='recovery' AND p.applied_at IS NOT NULL
           AND p.expires_at>statement_timestamp() AND p.account_id=w.account_id
           AND e.account_id=w.account_id AND e.purpose='recovery' AND e.minimum_authn_epoch=w.authn_epoch
           AND w.authn_epoch>p.previous_epoch
           AND c."userId"=w.account_id AND c."accountId"=w.account_id AND c."providerId"='credential'
           AND c.password IS NOT NULL AND c.password<>''
           AND r.account_id=w.account_id AND r.authn_epoch=p.previous_epoch
           AND r.consumed_operation=p.operation_key AND r.consumed_at IS NOT NULL
           AND r.consumed_verification_id=p.evidence->>4 AND r.expires_at>=p.expires_at`,
          [reference],
        )
      ).rows[0];
      if (!row) return null;
      const e = row.evidence;
      if (
        !Number.isSafeInteger(row.authn_epoch) ||
        row.authn_epoch < 1 ||
        row.authn_epoch > 2147483647 ||
        !Array.isArray(e) ||
        e.length !== 9 ||
        e[0] !== 'recovery-v1' ||
        e[1] !== row.account_id ||
        e[2] !== row.previous_epoch ||
        e[5] !== row.credential_id ||
        e[7] !== 'set-password' ||
        e[8] !== row.effect_commitment ||
        (await hash(e)) !== row.digest ||
        (await hash(['auth-recovery-v1', row.account_id, e[3]])) !== row.operation_key ||
        (await hash(['auth-barrier-reference-v1', row.operation_key, row.digest])) !== reference ||
        (await hash([row.password, row.updatedAt.toISOString()])) !== row.credential_fingerprint ||
        row.expires_at.getTime() <= Date.now()
      )
        return null;
      return Object.freeze({
        accountId: row.account_id,
        receiptId: row.receipt_id,
        minimumAuthnEpoch: String(row.authn_epoch),
        authnEpoch: row.authn_epoch,
        establishmentId: row.establishment_id,
      });
    },
  };
}
