import type { Pool } from 'pg';
import { AdmissionDenied, AdmissionUnavailable, type VerifiedPrincipal } from './admission.ts';

export interface WorkEditAuthorityProof {
  principalId: string; principalEpoch: string; actingSubject: string;
  subjectGeneration: string; scope: string; action: 'work.edit';
  authorityEpoch: string; recoveryGeneration: string;
  representationId: string; representationGeneration: string;
  grantId: string; grantGeneration: string; validUntil: string;
}

/** No graph admission: the callback may only commit a short owner SQL transaction.
 * Access and Source use different databases, so this is a live lock envelope,
 * not a distributed transaction or a coordinated backup frontier. */
export async function withWorkEditAuthority<T>(pool: Pool, principal: VerifiedPrincipal,
  actingSubject: string, work: string, commit: (proof: WorkEditAuthorityProof) => Promise<T>): Promise<T> {
  const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
  if (!native.test(work) || !native.test(actingSubject) || !principal.issuer || !principal.subject) {
    throw new AdmissionDenied('invalid Work edit authority');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    // Statement/lock timeouts bound admission work; the idle lease starts afresh
    // after the final proof query and exceeds the five-second Source transaction.
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    const recovery = (await client.query<{ open: boolean; generation: string }>(
      'SELECT open, generation FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
    if (!recovery?.open) throw new AdmissionUnavailable('Access is held for recovery');
    const scope = `work:edit:${work}`;
    const gate = (await client.query<{ open: boolean; dispatch_open: boolean; authority_epoch: string }>(
      'SELECT open, dispatch_open, authority_epoch FROM access.scope_gate WHERE id = $1 FOR SHARE',
      [scope])).rows[0];
    if (!gate?.open || !gate.dispatch_open) throw new AdmissionDenied('Work edit scope is closed');
    const identity = (await client.query<{ id: string; enforcement_epoch: string }>(
      `SELECT id, enforcement_epoch FROM access.principal
       WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [principal.issuer, principal.subject])).rows[0];
    if (!identity) throw new AdmissionDenied('principal is inactive');
    const subject = (await client.query<{ generation: string }>(
      "SELECT generation FROM access.authority_subject WHERE id = $1 AND kind = 'agent' AND active FOR SHARE",
      [actingSubject])).rows[0];
    const mandate = (await client.query<{ id: string; generation: string; valid_until: Date }>(
      `SELECT id, generation, valid_until FROM access.representation
       WHERE principal_id = $1 AND subject_id = $2 AND action = 'work.edit'
         AND active AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE`,
      [identity.id, actingSubject])).rows[0];
    const grant = (await client.query<{ id: string; generation: string; valid_until: Date }>(
      `SELECT id, generation, valid_until FROM access.permission_grant
       WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'work.edit'
         AND active AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE`,
      [actingSubject, scope])).rows[0];
    if (!subject || !mandate || !grant) throw new AdmissionDenied('Work edit mandate is unavailable');
    // Recheck after every lock has been acquired, not at transaction start. Leave
    // more validity than the bounded five-second Source transaction can consume.
    const validUntil = new Date(Math.min(mandate.valid_until.getTime(), grant.valid_until.getTime()));
    const valid = await client.query<{ valid: boolean }>(
      "SELECT $1::timestamptz > clock_timestamp() + interval '6 seconds' AS valid", [validUntil]);
    if (!valid.rows[0]?.valid) throw new AdmissionDenied('Work edit mandate expires too soon');
    const result = await commit({ principalId: identity.id, principalEpoch: identity.enforcement_epoch,
      actingSubject, subjectGeneration: subject.generation, scope, action: 'work.edit',
      authorityEpoch: gate.authority_epoch, recoveryGeneration: recovery.generation,
      representationId: mandate.id, representationGeneration: mandate.generation,
      grantId: grant.id, grantGeneration: grant.generation, validUntil: validUntil.toISOString() });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (['55P03', '57014', '25P03', '25P04'].includes((error as { code?: string }).code ?? '')) {
      throw new AdmissionUnavailable('Work edit authority or Source transaction exceeded its deadline');
    }
    throw error;
  } finally { client.release(); }
}
