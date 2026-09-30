import type { Pool } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionUnavailable, type VerifiedPrincipal } from './admission.ts';
import { newBaselineProof } from './baseline.ts';
import { ensureBaselineScopeGate } from './scope-gates.ts';
import { publicCatalogueWork, roleWorkProof, type RoleWorkProof } from './role-proof.ts';
import { representedWorkProof } from './represented-work-proof.ts';

export interface WorkEditAuthorityProof {
  principalId: string; principalEpoch: string; actingSubject: string;
  subjectGeneration: string; scope: string; action: 'work.edit';
  authorityEpoch: string; recoveryGeneration: string;
  representationId: string; representationGeneration: string;
  grantId: string | null; grantGeneration: string | null; validUntil: string;
  role?: RoleWorkProof;
  baseline?: { kind: 'author-baseline-v1'; provisionId: string;
    policyGeneration: string; workGeneration: string };
}

/** No graph admission: the callback may only commit a short owner SQL transaction.
 * Access and Source use different databases, so this is a live lock envelope,
 * not a distributed transaction or a coordinated backup frontier. Cost: indexed
 * principal/controller/grant reads, at most 16 pinned catalogue bindings and
 * one exact public-Work ASK for a catalogue role. */
export async function withWorkEditAuthority<T>(pool: Pool, principal: VerifiedPrincipal,
  actingSubject: string, work: string, commit: (proof: WorkEditAuthorityProof) => Promise<T>,
  graph?: Pick<FusekiClient, 'query'>): Promise<T> {
  const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
  if (!native.test(work) || !native.test(actingSubject) || !principal.issuer || !principal.subject) {
    throw new AdmissionDenied('invalid Work edit authority');
  }
  let current: VerifiedPrincipal | undefined;
  if (principal.emailVerified === true && principal.currentAssertion) {
    try { current = await principal.currentAssertion(); }
    catch (error) {
      if (error instanceof AccountAssertionDenied) throw new AdmissionDenied('Account assertion is inactive');
      throw error;
    }
    if (current.issuer !== principal.issuer || current.subject !== principal.subject) {
      throw new AdmissionDenied('Account identity changed');
    }
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
    await ensureBaselineScopeGate(client, scope);
    const gate = (await client.query<{ open: boolean; dispatch_open: boolean; authority_epoch: string }>(
      'SELECT open, dispatch_open, authority_epoch FROM access.scope_gate WHERE id = $1 FOR SHARE',
      [scope])).rows[0];
    if (!gate?.open || !gate.dispatch_open) throw new AdmissionDenied('Work edit scope is closed');
    const identity = (await client.query<{ id: string; enforcement_epoch: string }>(
      `SELECT id, enforcement_epoch FROM access.principal
       WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [principal.issuer, principal.subject])).rows[0];
    if (!identity) throw new AdmissionDenied('principal is inactive');
    const baseline = current?.emailVerified === true ? await newBaselineProof(client, graph, {
      principal: current, actingSubject, scope, action: 'work.edit',
      idempotencyKey: 'work-edit-authority', requestDigest: '0'.repeat(64),
    }, identity.id) : null;
    if (baseline?.author_generation != null) {
      // The proof holds the policy, controller, principal and maintainer-set
      // locks through the caller's short owner transaction. No grant is forged.
      const lease = (await client.query<{ valid_until: Date }>(`SELECT
        LEAST(valid_until, clock_timestamp() + interval '15 seconds') AS valid_until
        FROM access.representation WHERE id = $1
          AND valid_until > clock_timestamp() + interval '6 seconds'`, [baseline.representation_id])).rows[0];
      if (!lease) throw new AdmissionDenied('Work edit mandate expires too soon');
      const result = await commit({ principalId: identity.id, principalEpoch: identity.enforcement_epoch,
        actingSubject, subjectGeneration: baseline.subject_generation, scope, action: 'work.edit',
        authorityEpoch: gate.authority_epoch, recoveryGeneration: recovery.generation,
        representationId: baseline.representation_id, representationGeneration: baseline.representation_generation,
        grantId: null, grantGeneration: null, validUntil: lease.valid_until.toISOString(),
        baseline: { kind: 'author-baseline-v1', provisionId: baseline.provision_id,
          policyGeneration: baseline.policy_generation, workGeneration: baseline.author_generation } });
      await client.query('COMMIT');
      return result;
    }
    const represented = await representedWorkProof(client, identity.id, actingSubject, 'work.edit', scope);
    if (!represented) throw new AdmissionDenied('Work edit mandate is unavailable');
    const role = !represented.grantId ? await roleWorkProof(client, actingSubject, 'work.edit') : null;
    if (role && !await publicCatalogueWork(graph, work)) {
      throw new AdmissionDenied('Catalogue edit roles require a publicly readable Work');
    }
    if (!represented.grantId && !role) throw new AdmissionDenied('Work edit permission is unavailable');
    // Recheck after every lock has been acquired, not at transaction start. Leave
    // more validity than the bounded five-second Source transaction can consume.
    // Person controller mandates use PostgreSQL infinity. Compute and cap the
    // lease in SQL so both infinite and finite mandates yield a real instant.
    const lease = (await client.query<{ valid_until: Date }>(`SELECT
      LEAST(r.valid_until, COALESCE(g.valid_until, b.valid_until),
        clock_timestamp() + interval '15 seconds') AS valid_until
      FROM access.representation r
      LEFT JOIN access.permission_grant g ON g.id = $2
      LEFT JOIN access.role_binding b ON b.id = $3
      WHERE r.id = $1 AND LEAST(r.valid_until, COALESCE(g.valid_until, b.valid_until))
        > clock_timestamp() + interval '6 seconds'`,
    [represented.representationId, represented.grantId, role?.bindingId ?? null])).rows[0];
    if (!lease) throw new AdmissionDenied('Work edit mandate expires too soon');
    const result = await commit({ principalId: identity.id, principalEpoch: identity.enforcement_epoch,
      actingSubject, subjectGeneration: represented.subjectGeneration, scope, action: 'work.edit',
      authorityEpoch: gate.authority_epoch, recoveryGeneration: recovery.generation,
      representationId: represented.representationId, representationGeneration: represented.representationGeneration,
      grantId: represented.grantId, grantGeneration: represented.grantGeneration,
      ...(role ? { role } : {}), validUntil: lease.valid_until.toISOString() });
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
