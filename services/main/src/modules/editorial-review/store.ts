import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AdmissionConflict, AdmissionDenied, type VerifiedPrincipal } from '../access/admission.ts';
import { controlRead, ControlUnavailable, normalizeControlError } from '../access/topology-control.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { workRead } from '../work/read-session.ts';
import { resolveTargets } from '../target/resolve.ts';
import { discoverEditorialAdapters } from './adapters.ts';
import { EditorialCommandJournal } from './command-journal.ts';
import { applyOrderedCommands } from './ordered.ts';
import { editorialController, editorialPrincipal, independenceKey, requireReview, reviewBasis, viewerFor } from './authority.ts';
import { applyReviewedRevision, assertOpenRevision, assertOwnerReceipt, reviewState, type Viewer } from './lifecycle.ts';
import { canonicalCandidate, EDITORIAL_COST, EditorialBlocked, EditorialInvalid, makeProposalRevision, revisionOperationKey,
  type ApplyInput, type BaseHead, type Blocker, type EditorialAdapter, type EditorialTarget, type EvidenceRef, type Json,
  type OwnerReceipt, type Proposal, type ProposalReview, type ProposalRevision, type TerminalDecision } from './contract.ts';

export interface EditorialCall { work: MainWorkDependencies; request: Request; principal: VerifiedPrincipal; actingSubject: string }
export interface CreateProposal { kind: string; target: Omit<EditorialTarget,'work'>; candidate: unknown; baseHeads: BaseHead[];
  evidence: EvidenceRef[] }
export interface RevisionInput { revision: number; candidate: unknown; baseHeads: BaseHead[]; evidence: EvidenceRef[] }
export interface DecisionInput { revision: number; outcome: 'applied' | 'rejected'; approve: boolean; message: string }
export interface CommandResult { proposal: string; revision: number; outcome: string; replayed: boolean;
  receipt?: OwnerReceipt; blocker?: Blocker }
interface ProposalRow { id: string; kind: string; target: EditorialTarget; proposer_agent: string; proposer_key: string;
  proposer_principal: string; latest: number; decision: TerminalDecision | null; reverts: string | null; created_at: Date }
interface RevisionRow { proposal: string; n: number; candidate: string; candidate_digest: string; before_state: string;
  base_heads: BaseHead[]; evidence: EvidenceRef[]; owner_command: ProposalRevision['ownerCommand'] | null }
interface Application { id: string; proposal: string; revision: number; actor: string; principal: string; operation_key: string;
  command_key: string; command_digest: string; approve: boolean; message: string; required: 1 | 2;
  outcome: 'applied' | 'stale_base' | 'cancelled' | null; admission: string | null }
export interface EditorialEvent { sequence: string; id: string; proposal: string; revision: number;
  kind: 'created' | 'revised' | 'reviewed' | 'applied' | 'rejected' | 'withdrawn' | 'reversal-proposed'
    | 'apply-pending' | 'apply-stale' | 'apply-cancelled'; actor: string; occurredAt: string }

/** Logical request costs: one proposal/revision, ≤2 counted approvals and one
 * request_changes stance, ≤32 evidence/head references, ≤50 page rows. Mutation
 * queries use proposal/key indices and one per-proposal session lock. Applying
 * delivers legacy commands within 10s/64 graph calls/4MiB. Ordered delivery uses
 * that bound per command and yields after 10s; recovery resumes its retained list.
 * Native planner/full-corpus costs remain unqualified. */
export const EDITORIAL_STORE_COST = { page: 50, countedApprovals: 2, graphCalls: 64,
  graphBytes: 4 * 1024 * 1024, applyDeadlineMs: 10_000, eventsPage: 50 } as const;

const rowToProposal = (row: ProposalRow): Proposal => ({ id: row.id,kind: row.kind,target: row.target,
  proposer: row.proposer_agent,proposerKey: row.proposer_key,latestRevision: row.latest,decision: row.decision });
const rowToRevision = (row: RevisionRow): ProposalRevision => ({ proposal: row.proposal,n: row.n,
  candidate: JSON.parse(row.candidate) as Json,candidateDigest: row.candidate_digest,before: JSON.parse(row.before_state) as Json,
  baseHeads: row.base_heads,evidence: row.evidence,...(row.owner_command ? { ownerCommand: row.owner_command } : {}) });
// The request envelope must not shrink the candidate's independent 1 MiB/depth
// allowance. Its bounded heads/evidence/operation fields fit this larger envelope.
const digest = (intent: unknown) => canonicalCandidate(intent,{ bytes: 2 * EDITORIAL_COST.candidateBytes,
  depth: EDITORIAL_COST.jsonDepth + 8 }).digest;
function keyCheck(key: string) {
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) throw new EditorialInvalid('Invalid Idempotency-Key');
}
function messageCheck(message: string) {
  if (typeof message !== 'string' || [...message].length > EDITORIAL_COST.messageChars || message.includes('\0')) {
    throw new EditorialInvalid('Review message exceeds its bounds');
  }
}
function cursorEncode(binding: unknown, key: unknown) { return Buffer.from(JSON.stringify({ binding,key })).toString('base64url'); }
function cursorDecode(cursor: string | undefined, binding: unknown): unknown {
  if (!cursor) return null;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid');
    const value = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')) as { binding: unknown; key: unknown };
    if (digest(value.binding) !== digest(binding)) throw new Error('binding');
    return value.key;
  } catch { throw new EditorialInvalid('Cursor belongs to another selection or is invalid'); }
}

export class EditorialReviewStore {
  private readonly modules = discoverEditorialAdapters();
  constructor(private readonly pool: Pool) {}
  /** Internal immutable receipt lookup for an owner's compensation validator. */
  async appliedReceipt(proposal: string): Promise<OwnerReceipt | null> {
    return (await this.pool.query<{ owner_receipt: OwnerReceipt }>(`SELECT owner_receipt FROM access.editorial_decision
      WHERE proposal = $1 AND outcome = 'applied'`,[proposal])).rows[0]?.owner_receipt ?? null;
  }
  private async disclosedReceipt(adapter: EditorialAdapter, revision: ProposalRevision, receipt: OwnerReceipt | null) {
    if (!receipt || !adapter.disclose) return receipt;
    const disclosed = await adapter.disclose({ ...revision,candidate: receipt.candidate,before: receipt.before });
    return { ...receipt,candidate: disclosed.candidate,before: disclosed.before };
  }
  async discloseResult(call: Pick<EditorialCall,'work' | 'request'>, result: CommandResult): Promise<CommandResult> {
    if (!result.receipt) return result;
    const client = await this.pool.connect();
    try {
      const row = await this.proposal(client,result.proposal), revision = await this.revision(client,row.id,result.revision);
      return { ...result,receipt: (await this.disclosedReceipt(await this.adapter(row.kind,call),revision,result.receipt))! };
    } finally { client.release(); }
  }

  private async adapter(kind: string, call: Pick<EditorialCall,'work' | 'request'>): Promise<EditorialAdapter> {
    const module = (await this.modules).get(kind);
    if (!module) throw new EditorialInvalid('Editorial kind is not installed');
    const adapter = module.create(call);
    if (adapter.kind !== kind || ![1,2].includes(adapter.requiredApprovals)) throw new EditorialInvalid('Invalid adapter');
    return adapter;
  }
  private async begin(client: PoolClient, snapshot = false) {
    await client.query(snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    if (!(await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE')).rowCount) {
      throw new ControlUnavailable('Editorial recovery is held');
    }
  }
  private async locked<T>(id: string, work: (client: PoolClient) => Promise<T>, command?: { call: EditorialCall; key: string }): Promise<T> {
    const client = await this.pool.connect();
    const commandLock = command ? `editorial-key:${command.call.principal.issuer}:${command.call.principal.subject}:${command.key}` : null;
    try {
      await client.query("SET statement_timeout = '5s'");
      if (commandLock) await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[commandLock]);
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`editorial:${id}`]);
      return await work(client);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw normalizeControlError(error);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`editorial:${id}`]).catch(() => {});
      if (commandLock) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[commandLock]).catch(() => {});
      await client.query('RESET statement_timeout').catch(() => {});
      client.release();
    }
  }
  private async proposal(client: PoolClient, id: string): Promise<ProposalRow> {
    const row = (await client.query<ProposalRow>(`SELECT p.*,
      (SELECT max(n) FROM access.editorial_revision r WHERE r.proposal = p.id) AS latest,
      (SELECT jsonb_build_object('proposal',d.proposal,'revision',d.revision,'actor',d.actor,'outcome',d.outcome,
        'receipt',d.owner_receipt,'reverts',p.reverts) FROM access.editorial_decision d WHERE d.proposal = p.id) AS decision
      FROM access.editorial_proposal p WHERE p.id = $1`,[id])).rows[0];
    if (!row) throw new AdmissionDenied('Proposal is unavailable');
    return row;
  }
  private async revision(client: PoolClient, id: string, n: number) {
    const row = (await client.query<RevisionRow>('SELECT * FROM access.editorial_revision WHERE proposal = $1 AND n = $2',[id,n])).rows[0];
    if (!row) throw new EditorialBlocked({ code: 'stale_revision',latestRevision: (await this.proposal(client,id)).latest });
    return rowToRevision(row);
  }
  private async application(client: PoolClient, id: string, n: number): Promise<Application | null> {
    return (await client.query<Application>(`SELECT a.*,o.outcome,e.admission FROM access.editorial_application a
      LEFT JOIN access.editorial_application_outcome o ON o.application = a.id
      LEFT JOIN access.editorial_owner_admission e ON e.application = a.id
      WHERE a.proposal = $1 AND a.revision = $2`,[id,n])).rows[0] ?? null;
  }
  private async replay(client: PoolClient, principal: string, key: string, requestDigest: string): Promise<CommandResult | null> {
    const row = (await client.query<{ request_digest: string; result: CommandResult }>(`SELECT request_digest,result
      FROM access.editorial_command_receipt WHERE principal = $1 AND idempotency_key = $2`,[principal,key])).rows[0];
    if (!row) {
      const intent = (await client.query<{ command_digest: string }>(`SELECT command_digest FROM access.editorial_application
        WHERE principal = $1 AND command_key = $2`,[principal,key])).rows[0];
      if (intent && intent.command_digest !== requestDigest) throw new AdmissionConflict('Editorial key binds another application intent');
      return null;
    }
    if (row.request_digest !== requestDigest) throw new AdmissionConflict('Editorial key binds another intent');
    return { ...row.result,replayed: true };
  }
  private async save(client: PoolClient, principal: string, key: string, requestDigest: string, result: CommandResult) {
    await client.query(`INSERT INTO access.editorial_command_receipt (principal,idempotency_key,request_digest,proposal,result)
      VALUES ($1,$2,$3,$4,$5)`,[principal,key,requestDigest,result.proposal,result]);
  }
  private async event(client: PoolClient, proposal: string, revision: number, kind: EditorialEvent['kind'], actor: string) {
    await client.query('INSERT INTO access.editorial_event (proposal,revision,kind,actor) VALUES ($1,$2,$3,$4)',[proposal,revision,kind,actor]);
  }
  private async insertRevision(client: PoolClient, revision: ProposalRevision, actor: string) {
    await client.query(`INSERT INTO access.editorial_revision
      (proposal,n,candidate,candidate_digest,before_state,base_heads,evidence,owner_command,author_agent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[revision.proposal,revision.n,JSON.stringify(revision.candidate),revision.candidateDigest,
      JSON.stringify(revision.before),JSON.stringify(revision.baseHeads),JSON.stringify(revision.evidence),revision.ownerCommand ?? null,actor]);
  }
  async resolveTarget(call: Pick<EditorialCall,'work' | 'request' | 'actingSubject'>,
    resource: string, context: EditorialTarget['context']): Promise<EditorialTarget> {
    const target = await workRead(call.work,call.request,{ actingSubject: call.actingSubject || undefined },
      async session => (await resolveTargets(session,[resource],'discussion'))[0]!);
    if (context !== 'urn:rezics:context:global') {
      const principal = await call.work.account.verify(call.request,['work:read']);
      if (!await call.work.access.realmReadProof?.(principal,call.actingSubject,context)) throw new AdmissionDenied('Context is unavailable');
    }
    return { resource: target.resource,revision: target.revision,context,work: target.work };
  }
  private pending(application: Application | null) {
    if (application && !application.outcome) throw new EditorialBlocked({ code: 'apply_pending',operationKey: application.operation_key });
  }
  async create(call: EditorialCall, input: CreateProposal, key: string, reverts: string | null = null,
    intent: unknown = { operation: 'create',input,reverts,actor: call.actingSubject }): Promise<CommandResult> {
    keyCheck(key);
    const target = await this.resolveTarget(call,input.target.resource,input.target.context);
    const adapter = await this.adapter(input.kind,call), id = randomUUID();
    const requestDigest = digest(intent);
    return this.locked(id,async client => {
      await this.begin(client);
      const principal = await editorialPrincipal(client,call.principal);
      const replay = await this.replay(client,principal,key,requestDigest);
      if (replay) { await client.query('COMMIT'); return replay; }
      await editorialController(client,principal,call.actingSubject);
      if (target.revision !== input.target.revision) throw new EditorialBlocked({ code: 'stale_base',
        expectedHeads: [{ component: target.resource,head: input.target.revision }],actualHeads: [{ component: target.resource,head: target.revision }] });
      const validated = await adapter.validate(target,input.candidate,input.baseHeads);
      const controllers = (await client.query<{ principal_id: string }>(`SELECT DISTINCT principal_id
        FROM access.representation WHERE subject_id = $1 AND action = 'agent.control' AND active
          AND valid_until > clock_timestamp() ORDER BY principal_id LIMIT 17`,[call.actingSubject])).rows.map(row => row.principal_id);
      if (controllers.length > 16) throw new EditorialBlocked({ code: 'owner_unavailable' });
      if (reverts && !(await client.query(`SELECT 1 FROM access.editorial_decision WHERE proposal = $1 AND outcome = 'applied'`,[reverts])).rowCount) {
        throw new EditorialInvalid('Reversal must name an applied proposal');
      }
      await client.query(`INSERT INTO access.editorial_proposal
        (id,kind,target,resource,context,work,proposer_principal,proposer_agent,proposer_key,proposer_controllers,reverts)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,input.kind,target,target.resource,target.context,target.work,principal,
        call.actingSubject,independenceKey(id,principal),controllers,reverts]);
      const revision = makeProposalRevision(id,1,validated,input.evidence);
      await this.insertRevision(client,revision,call.actingSubject);
      await this.event(client,id,1,reverts ? 'reversal-proposed' : 'created',call.actingSubject);
      const result = { proposal: id,revision: 1,outcome: 'created',replayed: false };
      await this.save(client,principal,key,requestDigest,result); await client.query('COMMIT'); return result;
    },{ call,key });
  }
  async revise(call: EditorialCall, id: string, input: RevisionInput, key: string): Promise<CommandResult> {
    keyCheck(key); const requestDigest = digest({ operation: 'revise',id,input,actor: call.actingSubject });
    return this.locked(id,async client => {
      await this.begin(client); const principal = await editorialPrincipal(client,call.principal), row = await this.proposal(client,id);
      await this.resolveTarget(call,row.target.resource,row.target.context);
      const replay = await this.replay(client,principal,key,requestDigest);
      if (replay) { await client.query('COMMIT'); return replay; }
      await editorialController(client,principal,call.actingSubject);
      if (principal !== row.proposer_principal) throw new AdmissionDenied('Only the proposer revises this proposal');
      const proposal = rowToProposal(row), old = await this.revision(client,id,input.revision);
      assertOpenRevision(proposal,old); this.pending(await this.application(client,id,row.latest));
      const adapter = await this.adapter(row.kind,call);
      const validated = await adapter.validate(row.target,input.candidate,input.baseHeads);
      await this.insertRevision(client,makeProposalRevision(id,row.latest + 1,validated,input.evidence),call.actingSubject);
      await this.event(client,id,row.latest + 1,'revised',call.actingSubject);
      const result = { proposal: id,revision: row.latest + 1,outcome: 'revised',replayed: false };
      await this.save(client,principal,key,requestDigest,result); await client.query('COMMIT'); return result;
    },{ call,key });
  }
  private async insertReview(client: PoolClient, proposal: string, revision: number, principal: string,
    actor: string, outcome: ProposalReview['outcome'], message: string, id: string = randomUUID()) {
    await client.query(`INSERT INTO access.editorial_review (id,proposal,revision,principal,reviewer,reviewer_key,outcome,message)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[id,proposal,revision,principal,actor,independenceKey(proposal,principal),outcome,message]);
  }
  async review(call: EditorialCall, id: string, input: { revision: number; outcome: ProposalReview['outcome']; message: string },
    key: string): Promise<CommandResult> {
    keyCheck(key); messageCheck(input.message);
    const requestDigest = digest({ operation: 'review',id,input,actor: call.actingSubject });
    return this.locked(id,async client => {
      await this.begin(client); const principal = await editorialPrincipal(client,call.principal), row = await this.proposal(client,id);
      await this.resolveTarget(call,row.target.resource,row.target.context);
      const replay = await this.replay(client,principal,key,requestDigest);
      if (replay) { await client.query('COMMIT'); return replay; }
      const proposal = rowToProposal(row);
      assertOpenRevision(proposal,await this.revision(client,id,input.revision)); this.pending(await this.application(client,id,row.latest));
      await requireReview(client,proposal,principal,call.actingSubject,call.work.environment.fuseki);
      await this.insertReview(client,id,input.revision,principal,call.actingSubject,input.outcome,input.message);
      await this.event(client,id,input.revision,'reviewed',call.actingSubject);
      const result = { proposal: id,revision: input.revision,outcome: input.outcome,replayed: false };
      await this.save(client,principal,key,requestDigest,result); await client.query('COMMIT'); return result;
    },{ call,key });
  }
  private applyInput(proposal: Proposal, revision: ProposalRevision, application: Application): ApplyInput {
    return { target: proposal.target,revision,expectedHeads: revision.baseHeads,operationKey: application.operation_key,
      ...(application.admission ? { admissionId: application.admission } : {}),
      permit: { proof: application.id,proposal: proposal.id,revision: revision.n,candidateDigest: revision.candidateDigest,
        decidingAgent: application.actor },commands: new EditorialCommandJournal(this.pool) };
  }
  private async finish(client: PoolClient, row: ProposalRow, revision: ProposalRevision, application: Application,
    outcome: 'applied' | 'stale_base' | 'cancelled', receipt?: OwnerReceipt, blocker?: Blocker): Promise<CommandResult> {
    if (receipt) assertOwnerReceipt(receipt,this.applyInput(rowToProposal(row),revision,application));
    await client.query(`INSERT INTO access.editorial_application_outcome (application,outcome,owner_receipt) VALUES ($1,$2,$3)`,
      [application.id,outcome,receipt ?? null]);
    if (outcome === 'applied') {
      if (application.approve) await this.insertReview(client,row.id,revision.n,application.principal,application.actor,
        'approve',application.message,application.id);
      await client.query(`INSERT INTO access.editorial_decision (proposal,revision,principal,actor,outcome,owner_receipt)
        VALUES ($1,$2,$3,$4,'applied',$5)`,[row.id,revision.n,application.principal,application.actor,receipt]);
      await this.event(client,row.id,revision.n,'applied',application.actor);
    } else {
      await this.event(client,row.id,revision.n,outcome === 'stale_base' ? 'apply-stale' : 'apply-cancelled',application.actor);
    }
    const result: CommandResult = { proposal: row.id,revision: revision.n,outcome,replayed: false,...(receipt ? { receipt } : {}),
      ...(outcome !== 'applied' ? { blocker: blocker ?? { code: 'revision_required' } } : {}) };
    await this.save(client,application.principal,application.command_key,application.command_digest,result);
    return result;
  }
  private async recover(client: PoolClient, row: ProposalRow, adapter: EditorialAdapter, application: Application,
    resumeCall?: EditorialCall): Promise<CommandResult | null> {
    if (application.outcome) return null;
    const revision = await this.revision(client,row.id,application.revision);
    if (!adapter.commands && !application.admission && adapter.admission === 'access') {
      // Fence registration before resolving an intent left by a crash before
      // delivery. A later register sees its immutable cancellation and fails.
      await this.begin(client);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`editorial-admission:${application.id}`]);
      const current = (await this.application(client,row.id,application.revision))!;
      if (!current.admission) {
        const result = await this.finish(client,row,revision,application,'cancelled');
        await client.query('COMMIT'); return result;
      }
      await client.query('COMMIT'); application = current;
    }
    if (!adapter.resolve && !adapter.commands) return null;
    let resolution: Awaited<ReturnType<NonNullable<EditorialAdapter['resolve']>>>;
    try {
      const input = { ...this.applyInput(rowToProposal(row),revision,application),resumeDelivery: !!resumeCall };
      if (adapter.commands && resumeCall) {
        await this.begin(client);
        const proposal = rowToProposal(row);
        const graph = resumeCall.work.environment.fuseki;
        await requireReview(client,proposal,application.principal,application.actor,graph);
        const basis = await reviewBasis(client,proposal,adapter.requiredApprovals,graph,application.approve
          ? { principal: application.principal,review: { id: application.id,proposal: row.id,revision: revision.n,
            reviewer: application.actor,reviewerKey: independenceKey(row.id,application.principal),
            outcome: 'approve',message: application.message,sequence: '0' } } : undefined);
        const viewer = await viewerFor(client,proposal,application.principal,application.actor,graph);
        const decision = await applyReviewedRevision(adapter,proposal,input,basis.reviews,basis.authority,viewer,row.reverts);
        resolution = { outcome: 'applied',receipt: decision.receipt! };
        await client.query('ROLLBACK');
      } else resolution = adapter.commands ? await applyOrderedCommands(adapter,input) : await adapter.resolve!(input);
    }
    catch { await client.query('ROLLBACK').catch(() => {}); return null; }
    if (!resolution || resolution.outcome === 'pending') return null;
    await this.begin(client);
    const result = await this.finish(client,row,revision,application,resolution.outcome,
      resolution.outcome === 'applied' ? resolution.receipt : undefined);
    await client.query('COMMIT'); return result;
  }
  async decide(call: EditorialCall, id: string, input: DecisionInput, key: string): Promise<CommandResult> {
    keyCheck(key); messageCheck(input.message);
    const requestDigest = digest({ operation: 'decide',id,input,actor: call.actingSubject });
    return this.locked(id,async client => {
      await this.begin(client); const principal = await editorialPrincipal(client,call.principal);
      let row = await this.proposal(client,id);
      await this.resolveTarget(call,row.target.resource,row.target.context);
      const replay = await this.replay(client,principal,key,requestDigest);
      if (replay) { await client.query('COMMIT'); return replay; }
      const adapter = await this.adapter(row.kind,call);
      let application = await this.application(client,id,row.latest);
      if (application && !application.outcome) {
        await client.query('COMMIT');
        const recovered = await this.recover(client,row,adapter,application,
          application.principal === principal && application.actor === call.actingSubject ? call : undefined);
        if (recovered && application.command_key === key && application.principal === principal
          && application.command_digest === requestDigest) return { ...recovered,replayed: true };
        this.pending(await this.application(client,id,row.latest));
        await this.begin(client); row = await this.proposal(client,id);
      }
      const proposal = rowToProposal(row), revision = await this.revision(client,id,input.revision);
      assertOpenRevision(proposal,revision);
      await requireReview(client,proposal,principal,call.actingSubject,call.work.environment.fuseki);
      if (input.outcome === 'rejected') {
        await client.query(`INSERT INTO access.editorial_decision (proposal,revision,principal,actor,outcome)
          VALUES ($1,$2,$3,$4,'rejected')`,[id,revision.n,principal,call.actingSubject]);
        await this.event(client,id,revision.n,'rejected',call.actingSubject);
        const result = { proposal: id,revision: revision.n,outcome: 'rejected',replayed: false };
        await this.save(client,principal,key,requestDigest,result); await client.query('COMMIT'); return result;
      }
      application = await this.application(client,id,row.latest);
      if (application) throw new EditorialBlocked({ code: 'revision_required' });
      const applicationId = randomUUID();
      const prospective = input.approve ? { principal,review: { id: applicationId,proposal: id,revision: revision.n,
        reviewer: call.actingSubject,reviewerKey: independenceKey(id,principal),outcome: 'approve' as const,message: input.message,sequence: '0' } } : undefined;
      const basis = await reviewBasis(client,proposal,adapter.requiredApprovals,call.work.environment.fuseki,prospective);
      const state = reviewState(proposal,basis.reviews,basis.authority,adapter.requiredApprovals,await viewerFor(client,proposal,principal,call.actingSubject,call.work.environment.fuseki));
      if (!state.allowedActions.includes('apply')) throw new EditorialBlocked(state.blockers[0] ?? { code: 'review_authority_required' });
      await client.query(`INSERT INTO access.editorial_application
        (id,proposal,revision,principal,actor,operation_key,command_key,command_digest,approve,message,required)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[applicationId,id,revision.n,principal,call.actingSubject,
        revisionOperationKey(id,revision.n),key,requestDigest,input.approve,input.message,adapter.requiredApprovals]);
      await this.event(client,id,revision.n,'apply-pending',call.actingSubject);
      await client.query('COMMIT'); // Durable intent precedes cross-owner delivery.
      application = (await this.application(client,id,revision.n))!;
      await this.begin(client);
      let decision: TerminalDecision;
      let deliveryAttempted = false;
      try {
        await requireReview(client,proposal,principal,call.actingSubject,call.work.environment.fuseki);
        const fresh = await reviewBasis(client,proposal,adapter.requiredApprovals,call.work.environment.fuseki,prospective);
        const viewer = await viewerFor(client,proposal,principal,call.actingSubject,call.work.environment.fuseki);
        deliveryAttempted = true;
        const deliver = () => applyReviewedRevision(adapter,proposal,this.applyInput(proposal,revision,application!),fresh.reviews,fresh.authority,viewer,row.reverts);
        decision = adapter.commands ? await deliver() : await fusekiReadBudget.run({ signal: AbortSignal.timeout(EDITORIAL_STORE_COST.applyDeadlineMs),
          callsLeft: EDITORIAL_STORE_COST.graphCalls,bytesLeft: EDITORIAL_STORE_COST.graphBytes },
        deliver);
      } catch (error) {
        await client.query('ROLLBACK');
        if (error instanceof EditorialBlocked && error.blocker.code === 'budget_exhausted') {
          const delivered = (await client.query(`SELECT 1 FROM access.editorial_command_outcome WHERE application = $1
            UNION ALL SELECT 1 FROM access.editorial_command_admission WHERE application = $1 LIMIT 1`,[application.id])).rowCount;
          if (!delivered) {
            await this.begin(client);
            const result = await this.finish(client,row,revision,application,'cancelled',undefined,error.blocker);
            await client.query('COMMIT'); return result;
          }
          return { proposal: id,revision: revision.n,outcome: 'apply_pending',replayed: false,blocker: error.blocker };
        }
        if (error instanceof EditorialBlocked && error.blocker.code === 'stale_base') {
          await this.begin(client); await this.finish(client,row,revision,application,'stale_base',undefined,error.blocker);
          await client.query('COMMIT'); throw error;
        }
        application = (await this.application(client,id,revision.n))!;
        const recovered = await this.recover(client,row,adapter,application);
        if (recovered) return recovered;
        if (!deliveryAttempted && !application.admission) {
          await this.begin(client); await this.finish(client,row,revision,application,'cancelled'); await client.query('COMMIT'); throw error;
        }
        return { proposal: id,revision: revision.n,outcome: 'apply_pending',replayed: false };
      }
      const result = await this.finish(client,row,revision,application,'applied',decision.receipt!);
      await client.query('COMMIT'); return result;
    },{ call,key });
  }
  async withdraw(call: EditorialCall, id: string, revision: number, key: string): Promise<CommandResult> {
    keyCheck(key); const requestDigest = digest({ operation: 'withdraw',id,revision,actor: call.actingSubject });
    return this.locked(id,async client => {
      await this.begin(client); const principal = await editorialPrincipal(client,call.principal), row = await this.proposal(client,id);
      await this.resolveTarget(call,row.target.resource,row.target.context);
      const replay = await this.replay(client,principal,key,requestDigest);
      if (replay) { await client.query('COMMIT'); return replay; }
      await editorialController(client,principal,call.actingSubject);
      if (principal !== row.proposer_principal) throw new AdmissionDenied('Only the proposer withdraws this proposal');
      assertOpenRevision(rowToProposal(row),await this.revision(client,id,revision)); this.pending(await this.application(client,id,row.latest));
      await client.query(`INSERT INTO access.editorial_decision (proposal,revision,principal,actor,outcome)
        VALUES ($1,$2,$3,$4,'withdrawn')`,[id,revision,principal,call.actingSubject]);
      await this.event(client,id,revision,'withdrawn',call.actingSubject);
      const result = { proposal: id,revision,outcome: 'withdrawn',replayed: false };
      await this.save(client,principal,key,requestDigest,result); await client.query('COMMIT'); return result;
    },{ call,key });
  }
  async revert(call: EditorialCall, id: string, evidence: EvidenceRef[], key: string): Promise<CommandResult> {
    const client = await this.pool.connect();
    let row: ProposalRow;
    try { row = await this.proposal(client,id); } finally { client.release(); }
    if (row.decision?.outcome !== 'applied' || !row.decision.receipt) throw new EditorialInvalid('Only an applied proposal can be reverted');
    const target = await this.resolveTarget(call,row.target.resource,row.target.context), adapter = await this.adapter(row.kind,call);
    const candidate = await adapter.compensate(row.decision.receipt);
    return this.create(call,{ kind: row.kind,target,candidate: candidate.candidate,baseHeads: candidate.baseHeads,evidence },key,id,
      { operation: 'revert',id,evidence,actor: call.actingSubject });
  }
  async get(call: Pick<EditorialCall,'work' | 'request' | 'actingSubject'> & { principal?: VerifiedPrincipal }, id: string,
    limit = 50, cursor?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new EditorialInvalid('Page limit must be 1–50');
    const client = await this.pool.connect();
    let recoveryLocked = false;
    try {
      let row = await this.proposal(client,id);
      await this.resolveTarget(call,row.target.resource,row.target.context);
      const adapter = await this.adapter(row.kind,call), application = await this.application(client,id,row.latest);
      if (application && !application.outcome) {
        // Never queue a read behind decide's lock during owner delivery. Only
        // an unattended pending intent needs exclusive, receipt-only recovery.
        recoveryLocked = (await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[`editorial:${id}`])).rows[0]!.acquired;
        if (recoveryLocked) {
          row = await this.proposal(client,id);
          const pending = await this.application(client,id,row.latest);
          if (pending && !pending.outcome) await this.recover(client,row,adapter,pending);
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`editorial:${id}`]);
          recoveryLocked = false;
        }
      }
      await this.begin(client,true);
      // One SQL snapshot keeps the candidate, decision and timeline coherent
      // while writers append new immutable rows without waiting for this read.
      row = await this.proposal(client,id);
      const proposal = rowToProposal(row), revision = await this.revision(client,id,row.latest);
      let viewer: Viewer = { agent: '',principalKey: '',eligibleReviewer: false,ownsProposal: false };
      if (call.principal && call.actingSubject) {
        const principal = await editorialPrincipal(client,call.principal);
        try { await editorialController(client,principal,call.actingSubject); viewer = await viewerFor(client,proposal,principal,call.actingSubject,call.work.environment.fuseki); }
        catch (error) { if (!(error instanceof AdmissionDenied)) throw error; }
      }
      const basis = await reviewBasis(client,proposal,adapter.requiredApprovals,call.work.environment.fuseki);
      const state = reviewState(proposal,basis.reviews,basis.authority,adapter.requiredApprovals,viewer);
      if (!row.decision && viewer.eligibleReviewer && viewer.principalKey !== row.proposer_key) {
        const counted = basis.reviews.some(review => review.outcome === 'approve' && review.reviewerKey === viewer.principalKey);
        if (state.approvalIds.length + (counted ? 0 : 1) >= adapter.requiredApprovals) state.allowedActions.push('approve-and-apply');
      }
      const pending = await this.application(client,id,row.latest);
      if (!row.decision && pending) {
        state.allowedActions = pending.outcome ? state.allowedActions.filter(action => !['apply','approve-and-apply'].includes(action)) : ['recover'];
        state.blockers.push(pending.outcome ? { code: 'revision_required' } : { code: 'apply_pending',operationKey: pending.operation_key });
      }
      const binding = { proposal: id,timeline: 'editorial-v1' }, after = cursorDecode(cursor,binding);
      if (after !== null && (typeof after !== 'string' || !/^(0|[1-9][0-9]*)$/.test(after))) throw new EditorialInvalid('Invalid timeline cursor');
      const events = (await client.query<{ sequence: string; kind: string; actor: string; revision: number; occurredAt: string;
        review: { id: string; outcome: string; message: string } | null }>(`SELECT e.sequence::text,e.kind,e.actor,e.revision,
        e.created_at::text AS "occurredAt", (SELECT jsonb_build_object('id',r.id,'outcome',r.outcome,'message',r.message)
          FROM access.editorial_review r WHERE r.proposal = e.proposal AND r.revision = e.revision AND r.reviewer = e.actor
            AND r.created_at <= e.created_at ORDER BY r.sequence DESC LIMIT 1) AS review
        FROM access.editorial_event e WHERE e.proposal = $1 AND e.sequence > $2 ORDER BY e.sequence LIMIT $3`,[id,after ?? '0',limit + 1])).rows;
      const page = events.slice(0,limit);
      const stale = (await client.query<{ id: string }>(`SELECT id FROM access.editorial_review
        WHERE proposal = $1 AND revision < $2 AND outcome = 'approve' ORDER BY sequence DESC LIMIT 51`,[id,row.latest])).rows;
      state.staleApprovalIds = stale.slice(0,50).map(review => review.id);
      await client.query('COMMIT');
      const { ownerCommand: _owner, ...publicRevision } = adapter.disclose ? await adapter.disclose(revision) : revision;
      return { profile: 'editorial-proposal-v1',proposal: { id: row.id,kind: row.kind,target: row.target,proposer: row.proposer_agent,
        latestRevision: row.latest,decision: row.decision ? { ...row.decision,
          receipt: await this.disclosedReceipt(adapter,revision,row.decision.receipt) } : null,reverts: row.reverts },revision: publicRevision,
        preview: await adapter.preview(revision),...state,staleApprovalIdsComplete: stale.length <= 50,timeline: page,
        nextCursor: events.length > limit ? cursorEncode(binding,page.at(-1)!.sequence) : null };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw normalizeControlError(error);
    } finally {
      if (recoveryLocked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`editorial:${id}`]).catch(() => {});
      client.release();
    }
  }
  async list(call: Pick<EditorialCall,'work' | 'request' | 'actingSubject'> & { principal?: VerifiedPrincipal },
    options: { filter: 'mine' | 'review-requested' | 'target'; target?: string; limit: number; cursor?: string }) {
    const { limit } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || options.filter === 'target' && !options.target) throw new EditorialInvalid('Invalid proposal page');
    const binding = { filter: options.filter,target: options.target ?? null,issuer: call.principal?.issuer ?? null,
      subject: call.principal?.subject ?? null,actor: call.actingSubject };
    const after = cursorDecode(options.cursor,binding) as { time?: unknown; id?: unknown } | null;
    if (after && (typeof after.time !== 'string' || !Number.isFinite(Date.parse(after.time)) || typeof after.id !== 'string'
      || !/^[0-9a-f-]{36}$/.test(after.id))) throw new EditorialInvalid('Invalid proposal cursor');
    const client = await this.pool.connect();
    let rows: Array<{ id: string; target: EditorialTarget; kind: string; created_at: string }>;
    try {
      await this.begin(client);
      const principal = call.principal ? await editorialPrincipal(client,call.principal) : null;
      if (options.filter !== 'target' && !principal) throw new AdmissionDenied('Sign in to select this queue');
      if (options.filter === 'review-requested') await editorialController(client,principal!,call.actingSubject);
      rows = (await client.query<{ id: string; target: EditorialTarget; kind: string; created_at: string }>(`SELECT p.id,p.target,p.kind,p.created_at::text
        FROM access.editorial_proposal p WHERE ($1 <> 'mine' OR p.proposer_principal = $2)
          AND ($1 <> 'target' OR p.resource = $3)
          AND ($1 <> 'review-requested' OR NOT EXISTS (SELECT 1 FROM access.editorial_decision d WHERE d.proposal = p.id))
          AND ($4::timestamptz IS NULL OR (p.created_at,p.id) < ($4,$5::uuid))
        ORDER BY p.created_at DESC,p.id DESC LIMIT $6`,[options.filter,principal,options.target ?? null,
        after?.time ?? null,after?.id ?? null,limit + 1])).rows;
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const items: Array<{ id: string; kind: string; target: EditorialTarget }> = [];
    for (const row of rows.slice(0,limit)) {
      try {
        await this.resolveTarget(call,row.target.resource,row.target.context);
        if (options.filter === 'review-requested') {
          const check = await this.pool.connect();
          try {
            await this.begin(check);
            const principal = await editorialPrincipal(check,call.principal!);
            const proposal = rowToProposal(await this.proposal(check,row.id));
            const viewer = await viewerFor(check,proposal,principal,call.actingSubject,call.work.environment.fuseki);
            await check.query('COMMIT');
            if (!viewer.eligibleReviewer || viewer.principalKey === proposal.proposerKey) continue;
          } finally { await check.query('ROLLBACK').catch(() => {}); check.release(); }
        }
        items.push({ id: row.id,kind: row.kind,target: row.target });
      } catch (error) {
        if (error instanceof AdmissionDenied || error && typeof error === 'object' && 'status' in error && error.status === 404) continue;
        throw error;
      }
    }
    const last = rows.slice(0,limit).at(-1);
    return { items,nextCursor: rows.length > limit && last ? cursorEncode(binding,{ time: last.created_at,id: last.id }) : null };
  }
  async eventsAfter(after: string, limit = 50): Promise<EditorialEvent[]> {
    if (!/^(0|[1-9][0-9]*)$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new EditorialInvalid('Invalid editorial event page');
    return controlRead(this.pool,async client => (await client.query<EditorialEvent>(`SELECT e.sequence::text,e.id,e.proposal,e.revision,e.kind,e.actor,e.created_at::text AS "occurredAt"
      FROM access.editorial_event e WHERE e.sequence > $1 ORDER BY e.sequence LIMIT $2`,[after,limit])).rows);
  }
}
