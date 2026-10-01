import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { AdmissionConflict, AdmissionDenied, type AdmissionRequest, type RegisteredAdmission } from '../access/admission.ts';
import { withWorkEditAuthority } from '../access/work-edit-authority.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
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
  const publicWorks = await requireReview(client, proposal, row.principal, row.actor,graph);
  const basis = await reviewBasis(client, proposal, row.required,graph,row.approve ? { principal: row.principal,
    review: { id: row.id, proposal: row.proposal, revision: row.revision, reviewer: row.actor,
      reviewerKey: independenceKey(row.proposal,row.principal), outcome: 'approve', message: row.message, sequence: '0' } } : undefined);
  const state = reviewState(proposal,basis.reviews,basis.authority,row.required,await viewerFor(client,proposal,row.principal,row.actor,graph));
  if (!state.allowedActions.includes('apply')) throw new EditorialBlocked(state.blockers[0] ?? { code: 'review_authority_required' });
  return [...new Set([...publicWorks,...basis.publicWorks])];
}
export async function registerEditorialAdmission(pool: Pool, request: AdmissionRequest,
  graph: Pick<FusekiClient,'query'> | undefined,
  registerOrdinary: (client: PoolClient, request: AdmissionRequest) => Promise<RegisteredAdmission>): Promise<RegisteredAdmission> {
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
    // The permit narrows an ordinary owner admission; it never supplies its
    // authority. Ordinary proof, admission and permit attachment share this
    // transaction; registration needs no extra pooled connection or crash gap.
    return withCommandOwnerAuthority(pool, request, graph, async () => {
      const admission = await registerOrdinary(client,{ ...request, editorialPermit: undefined });
      if (old && old.id !== admission.id) throw new AdmissionConflict('Editorial owner admission changed');
      if (!old) {
        if (command) await client.query(`INSERT INTO access.editorial_command_admission (application,position,admission)
          VALUES ($1,$2,$3)`,[row.id,command.position,admission.id]);
        else await client.query(`INSERT INTO access.editorial_owner_admission (application,admission) VALUES ($1,$2)`, [row.id,admission.id]);
      }
      return admission;
    }, row.kind === 'wiki-bundle' ? row.target.work : undefined);
  });
}
export async function checkEditorialAdmission(client: PoolClient, admission: string,
  graph: Pick<FusekiClient,'query'> | undefined, pool: Pool, request: AdmissionRequest): Promise<boolean> {
  const binding = (await client.query<{ application: string }>(
    `SELECT application FROM access.editorial_owner_admission WHERE admission = $1
      UNION ALL SELECT application FROM access.editorial_command_admission WHERE admission = $1`, [admission])).rows[0];
  if (!binding) return false;
  const row = await permit(client,binding.application);
  await current(client,row,graph);
  await withCommandOwnerAuthority(pool, request, graph, async () => {},row.kind === 'wiki-bundle' ? row.target.work : undefined);
  // Generic explicit owner grants have no pinned Work/baseline proof. Recheck
  // their live mandate at claim, as well as the independent review authority.
  const ordinary = await client.query(`SELECT 1 FROM access.admission a
    WHERE a.id = $1 AND (a.represented_representation_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM access.baseline_admission b WHERE b.admission_id = a.id)
      OR EXISTS (SELECT 1 FROM access.representation r
        JOIN access.permission_grant g ON g.recipient_subject = r.subject_id
          AND g.scope_id = a.scope_id AND g.action = a.action AND g.active AND g.valid_until > clock_timestamp()
        WHERE r.principal_id = a.principal_id AND r.subject_id = a.acting_subject AND r.action = a.action
          AND r.active AND r.valid_until > clock_timestamp()))`, [admission]);
  if (!ordinary.rowCount) throw new AdmissionDenied('Owner authority changed before claim');
  return true;
}

/** An entity edit also belongs to each Work that owns its semantic record,
 * independently of the proposal's Work and its reviewing steward. */
export async function withCommandOwnerAuthority<T>(pool: Pool, request: AdmissionRequest,
  graph: Pick<FusekiClient,'query'> | undefined, operation: () => Promise<T>, publicationWork?: string | null): Promise<T> {
  const works = new Set(publicationWork ? [publicationWork] : []);
  if (request.scope.startsWith('semantic:edit:')) {
    if (!graph) throw new AdmissionDenied('Owner authority is unavailable');
    const target = request.scope.slice('semantic:edit:'.length);
    const rows = (await graph.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?work WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        { ${iri(target)} rv:semanticWork ?work }
        UNION { ${iri(target)} a <https://schema.org/CreativeWork> . BIND(${iri(target)} AS ?work) }
      } } LIMIT 17`,8192)).results?.bindings ?? [];
    if (rows.length > 16) throw new AdmissionDenied('Owner authority exceeds its bound');
    for (const row of rows) works.add(row.work!.value);
  }
  // Check sequentially: an entity shared by several Works must not consume one
  // pooled connection per Work. Every check runs again at dispatch claim.
  for (const work of works) {
    if (request.scope === `work:edit:${work}`) continue; // Ordinary admission owns this fence.
    await withWorkEditAuthority(pool,request.principal,request.actingSubject,work,async () => {},graph);
  }
  return operation();
}

/** A resumable reviewed operation can deliver several native owner commands.
 * Each effect transaction checks the SAME shared lifecycle application, holding
 * its current reviewer/controller dependencies through that owner's commit.
 * This does not create another review policy or an ordinary edit delegation. */
export async function checkEditorialApplication(client: PoolClient, application: string,
  binding: { kind: string; operationKey: string; candidateDigest: string },
  graph: Pick<FusekiClient, 'query'> | undefined): Promise<string[]> {
  const row = await permit(client, application);
  const revision = (await client.query<{ candidate_digest: string }>(
    'SELECT candidate_digest FROM access.editorial_revision WHERE proposal=$1 AND n=$2',
    [row.proposal, row.revision])).rows[0];
  if (row.kind !== binding.kind || row.operation_key !== binding.operationKey
    || revision?.candidate_digest !== binding.candidateDigest
    || binding.kind === 'merge' && row.required !== 2) {
    throw new AdmissionConflict('Native owner command differs from its reviewed application');
  }
  return current(client, row, graph);
}
