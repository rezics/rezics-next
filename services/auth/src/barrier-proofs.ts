import type { BarrierProof, BarrierProofExpectation } from '@rezics/auth-contract';
export type { BarrierProof, BarrierProofExpectation } from '@rezics/auth-contract';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const bounded = (value: unknown, size: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= size;

/** Construction is inert. Only committed Auth rows can resolve a reference.
 * Access must compare previousEpoch inside its own native command transaction.
 * Minting is deliberately private to the validated service paths.
 */
export function createBarrierProofVerifier({ database }: { database: Pool }) {
  return {
    async verify(reference: string, expected: BarrierProofExpectation): Promise<BarrierProof | null> {
      if (
        typeof reference !== 'string' ||
        !/^[0-9a-f]{64}$/.test(reference) ||
        !expected ||
        !bounded(expected.accountId, 1024) ||
        !bounded(expected.operationKey, 128) ||
        !['consent-reduction', 'recovery'].includes(expected.purpose) ||
        !Number.isSafeInteger(expected.previousEpoch) ||
        expected.previousEpoch < 0 ||
        expected.previousEpoch > 2147483647 ||
        (expected.openingReceiptId !== undefined &&
          (expected.purpose !== 'consent-reduction' || !bounded(expected.openingReceiptId, 128)))
      )
        return null;
      const row = (
        await database.query<{
          digest: string;
          evidence: unknown[];
          expires_at: Date;
        }>(
          `SELECT digest,evidence,expires_at FROM auth_barrier_proof
        WHERE reference=$1 AND account_id=$2 AND purpose=$3 AND previous_epoch=$4 AND operation_key=$5
          AND applied_at IS NULL AND expires_at>statement_timestamp()`,
          [reference, expected.accountId, expected.purpose, expected.previousEpoch, expected.operationKey],
        )
      ).rows[0];
      if (!row || !Array.isArray(row.evidence) || hash(JSON.stringify(row.evidence)) !== row.digest) return null;
      if (hash(JSON.stringify(['auth-barrier-reference-v1', expected.operationKey, row.digest])) !== reference)
        return null;
      const e = row.evidence;
      if (e[1] !== expected.accountId || e[2] !== expected.previousEpoch) return null;
      if (expected.purpose === 'consent-reduction') {
        // An operator-opened reduction carries exactly one more field: the opening Auth committed for the session.
        const operated = expected.openingReceiptId !== undefined;
        if (
          e.length !== (operated ? 14 : 13) ||
          (operated && e[13] !== expected.openingReceiptId) ||
          e[0] !== 'consent-v1' ||
          hash(JSON.stringify(['auth-consent-v1', e])) !== expected.operationKey
        )
          return null;
        const source = (
          await database.query(
            `SELECT s."userId" AS account_id,s."clientId",s."grantedScope",s."authnEpoch",s."authTime",s."authMethods",s."expiresAt",a.scopes,a.first_party,c.scopes AS consent
          FROM session s JOIN auth_client a ON a.client_id=s."clientId"
          LEFT JOIN auth_consent c ON c.account_id=s."userId" AND c.client_id=a.client_id
          WHERE s.id=$1 AND s."expiresAt">statement_timestamp()
            AND EXISTS (SELECT 1 FROM auth_client_coverage v WHERE v.client_id=a.client_id AND v.ready)
            AND NOT EXISTS (SELECT 1 FROM auth_client_reduction r WHERE r.client_id=a.client_id)`,
            [e[3]],
          )
        ).rows[0];
        if (
          !source ||
          source.account_id !== expected.accountId ||
          source.authnEpoch !== expected.previousEpoch ||
          (source.authMethods === 'operator') !== operated ||
          !same([source.clientId, source.grantedScope, source.authTime, source.authMethods], e.slice(4, 8)) ||
          row.expires_at > source.expiresAt ||
          source.grantedScope
            .split(' ')
            .filter(Boolean)
            .some((s: string) => !source.scopes.includes(s) || (!source.first_party && !source.consent?.includes(s)))
        )
          return null;
        // Only the opening Auth committed for this very session admits an operator-opened reduction.
        if (
          operated &&
          !(
            await database.query(
              'SELECT 1 FROM auth_session_opening WHERE session_id=$1 AND subject_account_id=$2 AND receipt_id=$3',
              [e[3], expected.accountId, expected.openingReceiptId],
            )
          ).rowCount
        )
          return null;
        const target = (
          await database.query(
            `SELECT c.revision::text,c.scopes,c.pending_scopes,c.pending_reference,a.scopes AS client_scopes,a.first_party
          FROM auth_consent c JOIN auth_client a ON a.client_id=c.client_id
          WHERE c.account_id=$1 AND c.client_id=$2
            AND EXISTS (SELECT 1 FROM auth_client_coverage v WHERE v.client_id=a.client_id AND v.ready)
            AND NOT EXISTS (SELECT 1 FROM auth_client_reduction r WHERE r.client_id=a.client_id)`,
            [expected.accountId, e[8]],
          )
        ).rows[0];
        if (
          !target ||
          target.first_party ||
          !same(target.client_scopes, e[9]) ||
          target.revision !== e[10] ||
          !same(target.scopes, e[11]) ||
          target.pending_reference !== reference ||
          !same(target.pending_scopes, e[12]) ||
          !Array.isArray(e[12]) ||
          !(e[11] as string[]).some((scope) => !(e[12] as string[]).includes(scope)) ||
          (e[12] as string[]).some((scope) => !target.client_scopes.includes(scope))
        )
          return null;
      } else {
        if (
          e.length !== 9 ||
          e[0] !== 'recovery-v1' ||
          hash(JSON.stringify(['auth-recovery-v1', expected.accountId, e[3]])) !== expected.operationKey
        )
          return null;
        const source = (
          await database.query(
            `SELECT r.authn_epoch,r.expires_at,r.consumed_verification_id,a.password,a."updatedAt"
          FROM auth_recovery r JOIN account a ON a.id=$4 AND a."userId"=r.account_id AND a."providerId"='credential'
          WHERE r.proof_hash=$1 AND r.account_id=$2 AND r.consumed_operation=$3
            AND r.consumed_at IS NOT NULL AND r.expires_at>statement_timestamp()`,
            [e[3], expected.accountId, expected.operationKey, e[5]],
          )
        ).rows[0];
        // A missing verification is never consumption evidence: the committed
        // source records the exact native row deleted in the receipt transaction.
        if (
          !source ||
          source.authn_epoch !== expected.previousEpoch ||
          source.consumed_verification_id !== e[4] ||
          row.expires_at > source.expires_at ||
          hash(JSON.stringify([source.password, source.updatedAt.toISOString()])) !== e[6] ||
          e[7] !== 'set-password' ||
          typeof e[8] !== 'string' ||
          !/^[0-9a-f]{64}$/.test(e[8])
        )
          return null;
      }
      if (row.expires_at.getTime() <= Date.now()) return null;
      return Object.freeze({
        accountId: expected.accountId,
        purpose: expected.purpose,
        previousEpoch: expected.previousEpoch,
        operationKey: expected.operationKey,
        digest: row.digest,
        expiresAt: row.expires_at.toISOString(),
        ...(expected.openingReceiptId === undefined ? {} : { openingReceiptId: expected.openingReceiptId }),
      });
    },
    async sweep({ limit }: { limit: number }): Promise<{ removed: number; hasMore: boolean }> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new RangeError('Invalid barrier proof batch');
      // Admission precedes locks: SKIP LOCKED cannot walk an unbounded prefix.
      // The extra key answers hasMore without a second scan or a drain loop.
      const row = (
        await database.query<{ removed: number; hasMore: boolean }>(
          `WITH candidates AS MATERIALIZED (
        SELECT ctid FROM auth_barrier_proof WHERE expires_at<=statement_timestamp()
        ORDER BY expires_at,reference LIMIT $1
      ), admitted AS MATERIALIZED (SELECT ctid FROM candidates LIMIT $2), locked AS MATERIALIZED (
        SELECT p.ctid FROM admitted a CROSS JOIN LATERAL (
          SELECT ctid FROM auth_barrier_proof WHERE ctid=a.ctid FOR UPDATE SKIP LOCKED
        ) p
      ), removed AS (DELETE FROM auth_barrier_proof WHERE ctid=ANY(ARRAY(SELECT ctid FROM locked)) RETURNING reference)
      SELECT (SELECT count(*)::integer FROM removed) AS removed,
        ((SELECT count(*) FROM candidates) > $2 OR (SELECT count(*) FROM removed) < (SELECT count(*) FROM admitted)) AS "hasMore"`,
          [limit + 1, limit],
        )
      ).rows[0]!;
      return row;
    },
  };
}
