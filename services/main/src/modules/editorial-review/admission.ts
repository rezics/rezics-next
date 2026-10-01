import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { AdmissionConflict, AdmissionDenied, type AdmissionRequest, type RegisteredAdmission } from '../access/admission.ts';
import { controlTransaction } from '../access/topology-control.ts';
import { editorialController, editorialPrincipal, independenceKey, requireReview, reviewBasis, viewerFor } from './authority.ts';
import { EditorialBlocked, type Proposal } from './contract.ts';
import { reviewState } from './lifecycle.ts';

interface PermitRow { id: string; proposal: string; revision: number; principal: string; actor: string;
  operation_key: string; target: Proposal['target']; kind: string; proposer_agent: string; proposer_key: string;
  owner_command: { action: string; scope: string; digest: string } | null; latest: number; done: boolean; resolved: boolean;
  required: 1 | 2; approve: boolean; message: string }

/** The durable permit binds an immutable candidate to one existing owner
 * action/digest/scope/key. It cannot grant arbitrary edit authority. */
async function permit(client: PoolClient, id: string): Promise<PermitRow> {
  const row = (await client.query<PermitRow>(`SELECT a.*,p.target,p.kind,p.proposer_agent,p.proposer_key,
    r.owner_command, (SELECT max(n) FROM access.editorial_revision WHERE proposal = p.id) AS latest,
    EXISTS(SELECT 1 FROM access.editorial_decision d WHERE d.proposal = p.id) AS done,
    EXISTS(SELECT 1 FROM access.editorial_application_outcome o WHERE o.application = a.id) AS resolved
    FROM access.editorial_application a JOIN access.editorial_proposal p ON p.id = a.proposal
    JOIN access.editorial_revision r ON r.proposal = p.id AND r.n = a.revision WHERE a.id = $1`, [id])).rows[0];
  if (!row || row.latest !== row.revision || row.done || row.resolved) {
    throw new AdmissionDenied('Editorial application permit is not dispatchable');
  }
  return row;
}
async function current(client: PoolClient, row: PermitRow, graph: Pick<FusekiClient,'query'> | undefined) {
  await editorialController(client, row.principal, row.actor);
  const proposal: Proposal = { id: row.proposal, kind: row.kind, target: row.target,
    proposer: row.proposer_agent, proposerKey: row.proposer_key, latestRevision: row.revision, decision: null };
  await requireReview(client, proposal, row.principal, row.actor,graph);
  const basis = await reviewBasis(client, proposal, row.required,graph,row.approve ? { principal: row.principal,
    review: { id: row.id, proposal: row.proposal, revision: row.revision, reviewer: row.actor,
      reviewerKey: independenceKey(row.proposal,row.principal), outcome: 'approve', message: row.message, sequence: '0' } } : undefined);
  const state = reviewState(proposal,basis.reviews,basis.authority,row.required,await viewerFor(client,proposal,row.principal,row.actor,graph));
  if (!state.allowedActions.includes('apply')) throw new EditorialBlocked(state.blockers[0] ?? { code: 'review_authority_required' });
}
export async function registerEditorialAdmission(pool: Pool, request: AdmissionRequest,
  graph: Pick<FusekiClient,'query'> | undefined): Promise<RegisteredAdmission> {
  return controlTransaction(pool, async client => {
    const principal = await editorialPrincipal(client, request.principal);
    // Serialize retries of this one permit without locking the proposal row
    // that the lifecycle's durable application already fences.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`editorial-admission:${request.editorialPermit}`]);
    const row = await permit(client, request.editorialPermit!);
    const command = (await client.query<{ position: number; action: string; scope: string; digest: string }>(`
      SELECT c.position,b.action,b.scope,b.request_digest AS digest
      FROM access.editorial_application_command c JOIN access.editorial_command_binding b USING (application,position)
      JOIN access.editorial_application a ON a.id = c.application
      JOIN access.editorial_revision r ON r.proposal = a.proposal AND r.n = a.revision
      WHERE c.application = $1 AND c.command_key = $2 AND c.candidate_digest = r.candidate_digest
        AND NOT EXISTS (SELECT 1 FROM access.editorial_application_command earlier
          WHERE earlier.application = c.application AND earlier.position < c.position AND NOT EXISTS (
            SELECT 1 FROM access.editorial_command_outcome o
              WHERE o.application = earlier.application AND o.position = earlier.position))`,
    [row.id,request.idempotencyKey])).rows[0];
    const ordered = (await client.query('SELECT 1 FROM access.editorial_application_command WHERE application = $1 LIMIT 1',[row.id])).rowCount;
    const binding = command ?? (!ordered ? row.owner_command : null);
    if (row.principal !== principal || row.actor !== request.actingSubject
      || !binding || !command && row.operation_key !== request.idempotencyKey || binding.action !== request.action
      || binding.scope !== request.scope || binding.digest !== request.requestDigest) {
      throw new AdmissionConflict('Owner command differs from its editorial permit');
    }
    const old = command ? (await client.query<{ id: string }>(`SELECT admission AS id
      FROM access.editorial_command_admission WHERE application = $1 AND position = $2`,[row.id,command.position])).rows[0]
      : (await client.query<{ id: string }>(`SELECT admission AS id FROM access.editorial_owner_admission
        WHERE application = $1`,[row.id])).rows[0];
    await current(client, row,graph);
    await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [request.scope]);
    const gate = (await client.query<{ authority_epoch: string }>(`SELECT authority_epoch::text
      FROM access.scope_gate WHERE id = $1 AND open AND dispatch_open FOR UPDATE`, [request.scope])).rows[0];
    if (!gate) throw new AdmissionDenied('Owner dispatch is fenced');
    const id = old?.id ?? randomUUID();
    if (!old) {
      await client.query(`INSERT INTO access.admission (id,principal_id,acting_subject,scope_id,action,
        idempotency_key,request_digest,authority_epoch,expires_at,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp() + interval '30 seconds','registered')`,
      [id, principal, request.actingSubject, request.scope, request.action, request.idempotencyKey, request.requestDigest, gate.authority_epoch]);
      if (command) await client.query(`INSERT INTO access.editorial_command_admission (application,position,admission)
        VALUES ($1,$2,$3)`,[row.id,command.position,id]);
      else await client.query(`INSERT INTO access.editorial_owner_admission (application,admission) VALUES ($1,$2)`, [row.id,id]);
      await client.query(`INSERT INTO access.admission_receipt (admission_id,principal_id,action,idempotency_key,request_digest,outcome)
        VALUES ($1,$2,$3,$4,$5,'registered')`, [id,principal,request.action,request.idempotencyKey,request.requestDigest]);
      await client.query(`INSERT INTO access.outbox (id,kind,admission_id,scope_id,authority_epoch)
        VALUES ($1,'admission.registered',$2,$3,$4)`, [randomUUID(),id,request.scope,gate.authority_epoch]);
    }
    const saved = (await client.query<{ expires_at: Date; registered_at: Date; state: RegisteredAdmission['state']; eligible: boolean }>(
      `SELECT expires_at,registered_at,state,expires_at > clock_timestamp() AS eligible FROM access.admission WHERE id = $1`, [id])).rows[0]!;
    return { id, principalId: principal, actingSubject: request.actingSubject, scope: request.scope, action: request.action,
      idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, authorityEpoch: gate.authority_epoch,
      expiresAt: saved.expires_at.toISOString(), registeredAt: saved.registered_at.toISOString(), state: saved.state,
      dispatchEligible: saved.eligible && saved.state !== 'sealed', replayed: !!old };
  });
}
export async function checkEditorialAdmission(client: PoolClient, admission: string,
  graph: Pick<FusekiClient,'query'> | undefined): Promise<boolean> {
  const binding = (await client.query<{ application: string }>(
    `SELECT application FROM access.editorial_owner_admission WHERE admission = $1
      UNION ALL SELECT application FROM access.editorial_command_admission WHERE admission = $1`, [admission])).rows[0];
  if (!binding) return false;
  await current(client, await permit(client, binding.application),graph);
  return true;
}
