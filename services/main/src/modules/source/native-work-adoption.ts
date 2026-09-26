import type { Pool } from 'pg';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { createAdmittedMetadataWork } from '../work/create-admitted.ts';
import { changeTitleControl, readTitleControl, readTitleControlReceipt, titleControlDigest, TitleControlConflict,
  type TitleControlBasis, type TitleControlIntent, type TitleControlReceipt } from '../work/title-control.ts';
import { metadataWorkEditDigest, readWorkEditTerminalReceipt } from '../work/edit.ts';
import { metadataWorkRequestDigest, type WorkActivationEnvironment,
} from '../work/activate.ts';
import { GRAPHS, RV, iri, hash } from '../work/activate.ts';
import { readWorkTerminalReceipt } from '../work/receipt.ts';
import type { SourceNativeWorkProposalStore } from './native-work-proposal.ts';

export class SourceAdoptionInvalid extends Error {}
export class SourceAdoptionConflict extends Error {}
export class SourceAdoptionUnavailable extends Error {}
export class SourceSupportConflict extends SourceAdoptionConflict {
  constructor(readonly code: 'source_support_changed' | 'source_support_pending'
    | 'source_support_withdrawn' | 'source_withdrawal_intent_conflict') { super(code); }
}

function supportConstraint(error: unknown): never {
  const pg = error as { code?: string; constraint?: string };
  if (pg.code === '23514' && pg.constraint?.startsWith('native_work_support_')) {
    throw new SourceSupportConflict(pg.constraint === 'native_work_support_settled'
      ? 'source_support_pending' : pg.constraint === 'native_work_support_active'
        ? 'source_support_withdrawn' : 'source_support_changed');
  }
  throw error;
}

export interface NativeWorkSourceAdoption {
  profile: 'source-native-work-adoption-v1';
  state: 'adopted';
  binding: string;
  proposal: string;
  sourceRecord: string;
  sourceConversion: string;
  adoptedFields: ['title'];
  title: string;
  titleLanguage: 'en';
  rightsStatus: 'undetermined';
  work: string;
  mainVersion: string;
  workRevision: string;
  mainRevision: string;
  receipt: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  createdAt: string;
}

export interface NativeWorkSourceSupport {
  profile: 'native-work-source-support-v1';
  state: 'recorded' | 'withdrawn';
  work: string;
  field: 'title';
  sourceValue: string;
  sourceRecord: string;
  sourceObservation: string;
  sourceConversion: string;
  sourceProposal: string;
  sourceGraphReceipt: string;
  binding: string;
  adoptionReceipt: string;
  adoptedAtRevision: string;
  currentHead: string;
  appliedRevisionIsHead: boolean;
  supportIdentity: string;
  latestApplication: NativeWorkSourceTitleApplication | null;
  withdrawal: NativeWorkSourceSupportWithdrawal | null;
  rightsEvidence: { basis: 'unknown' | 'facts' | 'original' | 'license'
    | 'permission' | 'exception'; note: string };
  rightsStatus: 'undetermined';
}

export interface NativeWorkSourceSupportWithdrawal {
  profile: 'native-work-source-support-withdrawal-v1';
  state: 'withdrawn';
  withdrawal: string;
  binding: string;
  work: string;
  supportIdentity: string;
  proposal: string;
  workRevision: string;
  receipt: string;
  adoptionReceipt: string;
  adoptedAtRevision: string;
  reason: string;
  createdAt: string;
}

export interface NativeWorkSourceRefreshAssessment {
  profile: 'native-work-source-refresh-assessment-v1';
  state: 'assessed';
  work: string;
  record: string;
  adoptedProposal: string;
  candidateProposal: string;
  adoptedConversion: string;
  candidateConversion: string;
  adoptedTitle: string;
  candidateTitle: string;
  sourceTitleChanged: boolean;
  representationChanged: boolean;
  adoptedRevision: string;
  currentHead: string;
  targetHeadChanged: boolean;
  rightsStatus: 'undetermined';
}

export interface NativeWorkSourceTitleApplication {
  profile: 'native-work-source-title-application-v1';
  state: 'applied';
  application: string;
  work: string;
  proposal: string;
  sourceRecord: string;
  title: string;
  predecessor: string;
  workRevision: string;
  receipt: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  rightsStatus: 'undetermined';
  createdAt: string;
}

interface IntentRow {
  id: string; proposal_id: string; principal_id: string; acting_subject: string;
  authority_path: 'represented-agent' | 'direct-principal'; confirmed_title: string;
  title_language: 'en'; work_idempotency_key: string;
}

interface BindingRow {
  id: string; intent_id: string; proposal_id: string; principal_id: string;
  work: string; main_version: string; work_revision: string; main_revision: string;
  graph_receipt: string; admission_id: string; data_epoch: string; sequence: string;
  created_at: Date;
}

interface TitleIntentRow {
  id: string; proposal_id: string; principal_id: string; work: string;
  expected_head: string; acting_subject: string; confirmed_title: string;
  work_idempotency_key: string; control_intent: TitleControlIntent | null;
}

interface TitleApplicationRow {
  id: string; intent_id: string; proposal_id: string; principal_id: string;
  work: string; expected_head: string; work_revision: string; graph_receipt: string;
  admission_id: string; data_epoch: string; sequence: string; created_at: Date;
}

interface WithdrawalRow {
  id: string; binding_id: string; principal_id: string; application_id: string | null;
  idempotency_key: string; reason: string; created_at: Date;
}

function withdrawalResult(row: WithdrawalRow, adoption: NativeWorkSourceAdoption,
  application: NativeWorkSourceTitleApplication | null): NativeWorkSourceSupportWithdrawal {
  if (url(row.binding_id) !== adoption.binding
    || (row.application_id ? url(row.application_id) : null) !== (application?.application ?? null)) {
    throw new SourceAdoptionUnavailable('withdrawal differs from retained support');
  }
  return { profile: 'native-work-source-support-withdrawal-v1', state: 'withdrawn',
    withdrawal: url(row.id), binding: adoption.binding, work: adoption.work,
    supportIdentity: application?.application ?? adoption.binding,
    proposal: application?.proposal ?? adoption.proposal,
    workRevision: application?.workRevision ?? adoption.workRevision,
    receipt: application?.receipt ?? adoption.receipt,
    adoptionReceipt: adoption.receipt, adoptedAtRevision: adoption.workRevision,
    reason: row.reason, createdAt: row.created_at.toISOString() };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTOR = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const url = (id: string): string => `https://rezics.com/id/${id}`;

export class SourceNativeWorkAdoptionStore {
  constructor(private readonly pool: Pool, private readonly proposals: SourceNativeWorkProposalStore,
    private readonly env: WorkActivationEnvironment,
    private readonly account: Pick<AccountAssertionVerifier, 'verify'>,
    private readonly access: Pick<AccessAdmissionRegistry,
      'register' | 'claim' | 'recordGraphOutcome' | 'issueTitleAdmission'>) {}

  private async verifiedBinding(row: BindingRow, intent: IntentRow): Promise<void> {
    const receipt = await readWorkTerminalReceipt(this.env.fuseki, row.admission_id);
    if (!receipt || receipt.outcome !== 'succeeded'
      || receipt.receipt !== row.graph_receipt || receipt.admissionId !== row.admission_id
      || receipt.requestDigest !== metadataWorkRequestDigest(intent.confirmed_title)
      || receipt.scope !== 'work:create:root' || receipt.work !== row.work
      || receipt.mainVersion !== row.main_version || receipt.workRevision !== row.work_revision
      || receipt.mainRevision !== row.main_revision || receipt.dataEpoch !== row.data_epoch
      || receipt.sequence !== row.sequence) {
      throw new SourceAdoptionUnavailable('native Work receipt differs from source binding');
    }
  }

  private result(row: BindingRow, intent: IntentRow,
    proposal: { proposal: string; record: string; conversion: string }): NativeWorkSourceAdoption {
    return { profile: 'source-native-work-adoption-v1', state: 'adopted',
      binding: url(row.id), proposal: proposal.proposal, sourceRecord: proposal.record,
      sourceConversion: proposal.conversion, adoptedFields: ['title'],
      title: intent.confirmed_title, titleLanguage: 'en', rightsStatus: 'undetermined',
      work: row.work, mainVersion: row.main_version, workRevision: row.work_revision,
      mainRevision: row.main_revision, receipt: row.graph_receipt,
      sourcePosition: { datasetId: 'product', dataEpoch: row.data_epoch,
        sequence: row.sequence }, createdAt: row.created_at.toISOString() };
  }

  async adopt(principalId: string, request: Request, proposalId: string,
    input: { actingSubject: string; authorityPath: 'represented-agent' | 'direct-principal';
      confirmedTitle: string; titleLanguage: 'en' }):
    Promise<{ adoption: NativeWorkSourceAdoption; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !UUID.test(proposalId) || !ACTOR.test(input.actingSubject)
      || !['represented-agent', 'direct-principal'].includes(input.authorityPath)
      || input.titleLanguage !== 'en') {
      throw new SourceAdoptionInvalid('invalid source adoption intent');
    }
    const proposal = await this.proposals.read(principalId, proposalId);
    if (!proposal) return null;
    if (input.confirmedTitle !== proposal.candidateTitle) {
      throw new SourceAdoptionConflict('confirmed title differs from the source proposal');
    }
    await this.pool.query<{ id: string }>(`INSERT INTO source.native_work_adoption_intent
      (id, proposal_id, principal_id, acting_subject, authority_path, confirmed_title,
       title_language, work_idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,'en',$7)
      ON CONFLICT (proposal_id) DO NOTHING RETURNING id`,
    [Bun.randomUUIDv7(), proposalId, principalId, input.actingSubject, input.authorityPath,
      input.confirmedTitle, `source-adopt-${Bun.randomUUIDv7()}`]).catch(error => {
      if (error.code === '23514' && error.constraint === 'native_work_attachment_proposal') {
        throw new SourceAdoptionConflict('proposal is already attached to a Work');
      }
      throw error;
    });
    const intent = (await this.pool.query<IntentRow>(`SELECT * FROM source.native_work_adoption_intent
      WHERE proposal_id = $1 AND principal_id = $2`, [proposalId, principalId])).rows[0];
    if (!intent || intent.acting_subject !== input.actingSubject
      || intent.authority_path !== input.authorityPath
      || intent.confirmed_title !== input.confirmedTitle || intent.title_language !== 'en') {
      throw new SourceAdoptionConflict('proposal is reserved for another adoption intent');
    }
    const existing = (await this.pool.query<BindingRow>(`SELECT * FROM source.native_work_binding
      WHERE proposal_id = $1 AND principal_id = $2`, [proposalId, principalId])).rows[0];
    if (existing) {
      if (existing.intent_id !== intent.id) {
        throw new SourceAdoptionUnavailable('source binding differs from adoption intent');
      }
      await this.verifiedBinding(existing, intent);
      return { adoption: this.result(existing, intent, proposal), replayed: true };
    }
    const work = await createAdmittedMetadataWork(this.env, this.account, this.access, request,
      { title: intent.confirmed_title, actingSubject: intent.acting_subject,
        authorityPath: intent.authority_path, idempotencyKey: intent.work_idempotency_key });
    const bound = await this.pool.query<{ id: string }>(`INSERT INTO source.native_work_binding
      (id, intent_id, proposal_id, principal_id, work, main_version, work_revision,
       main_revision, graph_receipt, admission_id, data_epoch, sequence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (proposal_id) DO NOTHING RETURNING id`,
    [Bun.randomUUIDv7(), intent.id, proposalId, principalId, work.work, work.mainVersion,
      work.workRevision, work.mainRevision, work.receipt, work.admissionId,
      work.dataEpoch, work.sequence]);
    const row = (await this.pool.query<BindingRow>(`SELECT * FROM source.native_work_binding
      WHERE proposal_id = $1 AND principal_id = $2`, [proposalId, principalId])).rows[0];
    if (!row || row.intent_id !== intent.id || row.work !== work.work
      || row.main_version !== work.mainVersion || row.work_revision !== work.workRevision
      || row.main_revision !== work.mainRevision || row.graph_receipt !== work.receipt
      || row.admission_id !== work.admissionId || row.data_epoch !== work.dataEpoch
      || row.sequence !== work.sequence) {
      throw new SourceAdoptionUnavailable('source binding differs from committed Work');
    }
    await this.verifiedBinding(row, intent);
    return { adoption: this.result(row, intent, proposal),
      replayed: bound.rowCount === 0 || work.replayed };
  }

  async read(principalId: string, proposalId: string): Promise<NativeWorkSourceAdoption | null> {
    if (!UUID.test(principalId) || !UUID.test(proposalId)) {
      throw new SourceAdoptionInvalid('invalid source adoption identity');
    }
    const proposal = await this.proposals.read(principalId, proposalId);
    if (!proposal) return null;
    const rows = await this.pool.query<BindingRow & IntentRow>(`SELECT b.*, i.acting_subject,
      i.authority_path, i.confirmed_title, i.title_language, i.work_idempotency_key
      FROM source.native_work_binding b
      JOIN source.native_work_adoption_intent i ON i.id = b.intent_id
      WHERE b.proposal_id = $1 AND b.principal_id = $2`, [proposalId, principalId]);
    const row = rows.rows[0];
    if (!row) return null;
    await this.verifiedBinding(row, row);
    return this.result(row, row, proposal);
  }

  async readSupport(principalId: string, work: string): Promise<NativeWorkSourceSupport | null> {
    if (!UUID.test(principalId) || !ACTOR.test(work)) {
      throw new SourceAdoptionInvalid('invalid native Work identity');
    }
    const binding = await this.pool.query<{ proposal_id: string; support_binding: string | null;
      application_id: string | null; application_proposal_id: string | null;
      withdrawal_id: string | null }>(
      `SELECT b.proposal_id, h.binding_id AS support_binding, h.application_id,
        a.proposal_id AS application_proposal_id, w.id AS withdrawal_id
       FROM source.native_work_binding b
       LEFT JOIN source.native_work_support_head h ON h.binding_id = b.id
       LEFT JOIN source.native_work_title_application a ON a.id = h.application_id
       LEFT JOIN source.native_work_support_withdrawal w ON w.binding_id = b.id
       WHERE b.work = $1 AND b.principal_id = $2`, [work, principalId]);
    const saved = binding.rows[0];
    const proposalId = saved?.proposal_id;
    if (!proposalId) return null;
    if (!saved?.support_binding) throw new SourceAdoptionUnavailable('source support head is unavailable');
    const adoption = await this.read(principalId, proposalId);
    const proposal = await this.proposals.read(principalId, proposalId);
    if (!adoption || !proposal || adoption.work !== work) {
      throw new SourceAdoptionUnavailable('native Work source support is unavailable');
    }
    const application = saved.application_proposal_id
      ? await this.readTitleApplication(principalId, work, saved.application_proposal_id) : null;
    if ((saved.application_id ? url(saved.application_id) : null)
      !== (application?.application ?? null)
      || (application && application.sourceRecord !== proposal.record)) {
      throw new SourceAdoptionUnavailable('source application head is unavailable');
    }
    const withdrawn = saved.withdrawal_id ? (await this.pool.query<WithdrawalRow>(
      `SELECT * FROM source.native_work_support_withdrawal WHERE id = $1 AND principal_id = $2`,
      [saved.withdrawal_id, principalId])).rows[0] : null;
    if (saved.withdrawal_id && !withdrawn) {
      throw new SourceAdoptionUnavailable('source withdrawal receipt is unavailable');
    }
    const current = await this.env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(work)} a schema:CreativeWork ; rv:head ?head .
      } } LIMIT 2`);
    const heads = current.results?.bindings ?? [];
    if (heads.length !== 1 || !ACTOR.test(heads[0]?.head?.value ?? '')) {
      throw new SourceAdoptionUnavailable('current Work head is unavailable');
    }
    const head = heads[0]!.head!.value;
    return { profile: 'native-work-source-support-v1', state: withdrawn ? 'withdrawn' : 'recorded',
      work, field: 'title', sourceValue: proposal.candidateTitle,
      sourceRecord: proposal.record, sourceObservation: proposal.observation,
      sourceConversion: proposal.conversion, sourceProposal: proposal.proposal,
      sourceGraphReceipt: proposal.graphReceipt, binding: adoption.binding,
      adoptionReceipt: adoption.receipt, adoptedAtRevision: adoption.workRevision,
      currentHead: head, appliedRevisionIsHead: head === adoption.workRevision,
      supportIdentity: application?.application ?? adoption.binding,
      latestApplication: application,
      withdrawal: withdrawn ? withdrawalResult(withdrawn, adoption, application) : null,
      rightsEvidence: proposal.rightsEvidence, rightsStatus: 'undetermined' };
  }

  async withdrawSupport(principalId: string, work: string, idempotencyKey: string,
    input: { binding: string; expectedSupport: string; reason: string }):
    Promise<{ withdrawal: NativeWorkSourceSupportWithdrawal; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !ACTOR.test(work) || !ACTOR.test(input.binding)
      || !ACTOR.test(input.expectedSupport) || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)
      || !input.reason || input.reason.length > 500 || input.reason !== input.reason.trim()
      || /[\u0000-\u001f\u007f]/.test(input.reason)) {
      throw new SourceAdoptionInvalid('invalid source support withdrawal');
    }
    const support = await this.readSupport(principalId, work);
    if (!support) return null;
    if (support.binding !== input.binding || support.supportIdentity !== input.expectedSupport) {
      throw new SourceSupportConflict('source_support_changed');
    }
    const bindingId = support.binding.split('/').at(-1)!;
    const applicationId = support.latestApplication?.application.split('/').at(-1) ?? null;
    const existing = (await this.pool.query<WithdrawalRow>(
      `SELECT * FROM source.native_work_support_withdrawal WHERE binding_id = $1`,
      [bindingId])).rows[0];
    let inserted = false;
    if (!existing) {
      try {
        inserted = (await this.pool.query(`INSERT INTO source.native_work_support_withdrawal
          (id, binding_id, principal_id, application_id, idempotency_key, reason)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [Bun.randomUUIDv7(), bindingId, principalId, applicationId, idempotencyKey,
          input.reason])).rowCount === 1;
      } catch (error) { supportConstraint(error); }
    }
    const row = existing ?? (await this.pool.query<WithdrawalRow>(
      `SELECT * FROM source.native_work_support_withdrawal WHERE binding_id = $1`,
      [bindingId])).rows[0];
    if (!row || row.principal_id !== principalId || row.application_id !== applicationId
      || row.idempotency_key !== idempotencyKey || row.reason !== input.reason) {
      throw new SourceSupportConflict('source_withdrawal_intent_conflict');
    }
    const adoption = await this.read(principalId, support.sourceProposal.split('/').at(-1)!);
    if (!adoption) throw new SourceAdoptionUnavailable('withdrawal adoption evidence is unavailable');
    return { withdrawal: withdrawalResult(row, adoption, support.latestApplication),
      replayed: !inserted };
  }

  async assessRefresh(principalId: string, work: string, candidateProposalId: string):
    Promise<NativeWorkSourceRefreshAssessment | null> {
    if (!UUID.test(candidateProposalId)) {
      throw new SourceAdoptionInvalid('invalid candidate proposal identity');
    }
    const support = await this.readSupport(principalId, work);
    if (!support) return null;
    const candidate = await this.proposals.read(principalId, candidateProposalId);
    if (!candidate) return null;
    if (candidate.record !== support.sourceRecord) {
      throw new SourceAdoptionConflict('candidate belongs to a different SourceRecord');
    }
    const adopted = await this.proposals.read(principalId,
      support.sourceProposal.split('/').at(-1)!);
    if (!adopted) throw new SourceAdoptionUnavailable('adopted source proposal is unavailable');
    return { profile: 'native-work-source-refresh-assessment-v1', state: 'assessed',
      work, record: support.sourceRecord, adoptedProposal: support.sourceProposal,
      candidateProposal: candidate.proposal, adoptedConversion: support.sourceConversion,
      candidateConversion: candidate.conversion, adoptedTitle: support.sourceValue,
      candidateTitle: candidate.candidateTitle,
      sourceTitleChanged: candidate.candidateTitle !== support.sourceValue,
      representationChanged: candidate.sourceDigest !== adopted.sourceDigest,
      adoptedRevision: support.adoptedAtRevision, currentHead: support.currentHead,
      targetHeadChanged: !support.appliedRevisionIsHead,
      rightsStatus: 'undetermined' };
  }

  private async verifiedTitleApplication(row: TitleApplicationRow, intent: TitleIntentRow):
    Promise<void> {
    if (intent.control_intent) {
      const receipt = await readTitleControlReceipt(this.env, row.admission_id);
      if (!receipt || receipt.outcome !== 'succeeded' || receipt.action !== 'work.title.apply'
        || receipt.requestDigest !== titleControlDigest(intent.control_intent)
        || receipt.receipt !== row.graph_receipt || receipt.work !== row.work
        || receipt.revision !== row.work_revision || receipt.dataEpoch !== row.data_epoch || receipt.sequence !== row.sequence) {
        throw new SourceAdoptionUnavailable('native title control receipt differs from Source application');
      }
      return;
    }
    const receipt = await readWorkEditTerminalReceipt(this.env, row.admission_id);
    if (!receipt || receipt.outcome !== 'succeeded'
      || receipt.receipt !== row.graph_receipt || receipt.admissionId !== row.admission_id
      || receipt.requestDigest !== metadataWorkEditDigest(intent.work,
        intent.expected_head, intent.confirmed_title)
      || receipt.scope !== `work:edit:${intent.work}` || receipt.work !== row.work
      || receipt.predecessor !== row.expected_head || receipt.revision !== row.work_revision
      || receipt.dataEpoch !== row.data_epoch || receipt.sequence !== row.sequence) {
      throw new SourceAdoptionUnavailable('native Work edit receipt differs from source application');
    }
  }

  private titleApplicationResult(row: TitleApplicationRow, intent: TitleIntentRow,
    proposal: { proposal: string; record: string }): NativeWorkSourceTitleApplication {
    return { profile: 'native-work-source-title-application-v1', state: 'applied',
      application: url(row.id), work: row.work, proposal: proposal.proposal,
      sourceRecord: proposal.record, title: intent.confirmed_title,
      predecessor: row.expected_head, workRevision: row.work_revision,
      receipt: row.graph_receipt, sourcePosition: { datasetId: 'product',
        dataEpoch: row.data_epoch, sequence: row.sequence },
      rightsStatus: 'undetermined', createdAt: row.created_at.toISOString() };
  }

  async applyTitle(principalId: string, request: Request, work: string,
    candidateProposalId: string, input: { expectedHead: string; actingSubject: string;
      confirmedTitle: string; titleControl: TitleControlBasis }):
    Promise<{ application: NativeWorkSourceTitleApplication; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !UUID.test(candidateProposalId)
      || !ACTOR.test(work) || !ACTOR.test(input.expectedHead)
      || !ACTOR.test(input.actingSubject)) {
      throw new SourceAdoptionInvalid('invalid source title application intent');
    }
    const support = await this.readSupport(principalId, work);
    if (!support) return null;
    if (support.state === 'withdrawn') throw new SourceSupportConflict('source_support_withdrawn');
    const candidate = await this.proposals.read(principalId, candidateProposalId);
    if (!candidate) return null;
    if (candidate.record !== support.sourceRecord
      || candidate.candidateTitle !== input.confirmedTitle) {
      throw new SourceAdoptionConflict('candidate source title or record differs');
    }
    const existingIntent = (await this.pool.query<TitleIntentRow>(
      `SELECT * FROM source.native_work_title_intent
       WHERE work = $1 AND proposal_id = $2 AND principal_id = $3`,
      [work, candidateProposalId, principalId])).rows[0];
    if (!existingIntent) {
      if (support.currentHead !== input.expectedHead) {
        throw new SourceAdoptionConflict('target Work head has changed');
      }
      const control = await readTitleControl(this.env, work);
      if (JSON.stringify(control.basis) !== JSON.stringify(input.titleControl)
        || control.mode === 'human-controlled'
        || (control.mode === 'unestablished' && input.expectedHead !== support.adoptedAtRevision)) {
        throw new SourceAdoptionConflict('title is not source-controlled at the expected basis');
      }
      const baseProposalId = (control.source?.proposal ?? support.sourceProposal).split('/').at(-1)!;
      const base = await this.proposals.read(principalId, baseProposalId);
      if (!base) throw new SourceAdoptionUnavailable('source control base is unavailable');
      if (candidate.candidateTitle === base.candidateTitle
        || candidate.graphPosition.dataEpoch !== base.graphPosition.dataEpoch
        || BigInt(candidate.graphPosition.sequence) <= BigInt(base.graphPosition.sequence)) {
        throw new SourceAdoptionConflict('candidate is not a later title change in this source epoch');
      }
      const nativeIntent: TitleControlIntent = { work, expectedHead: input.expectedHead, basis: input.titleControl,
        action: 'work.title.apply', title: input.confirmedTitle, source: { binding: support.binding,
          record: candidate.record, observation: candidate.observation, conversion: candidate.conversion,
          proposal: candidate.proposal, mapping: 'open-library-work-map-v1', initialHead: support.adoptedAtRevision } };
      const keyDigest = hash(`${work}\0${candidateProposalId}`);
      const key = `source-title-${keyDigest.slice(0,8)}-${keyDigest.slice(8,12)}-${keyDigest.slice(12,16)}-${keyDigest.slice(16,20)}-${keyDigest.slice(20,32)}`;
      const principal = await this.account.verify(request, ['source:adopt', 'work:edit']);
      await this.access.register({ principal, actingSubject: input.actingSubject,
        scope: `work:title:apply:${work}`, action: 'work.title.apply', idempotencyKey: key,
        requestDigest: titleControlDigest(nativeIntent) });
      await this.pool.query(`INSERT INTO source.native_work_title_intent
        (id, proposal_id, principal_id, work, expected_head, acting_subject,
         confirmed_title, work_idempotency_key, control_intent)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (work, proposal_id) DO NOTHING`,
      [Bun.randomUUIDv7(), candidateProposalId, principalId, work, input.expectedHead,
        input.actingSubject, input.confirmedTitle, key, JSON.stringify(nativeIntent)])
        .catch(supportConstraint);
    }
    const intent = (await this.pool.query<TitleIntentRow>(
      `SELECT * FROM source.native_work_title_intent
       WHERE work = $1 AND proposal_id = $2 AND principal_id = $3`,
      [work, candidateProposalId, principalId])).rows[0];
    if (!intent || intent.expected_head !== input.expectedHead
      || intent.acting_subject !== input.actingSubject
      || intent.confirmed_title !== input.confirmedTitle || !intent.control_intent
      || titleControlDigest({ ...intent.control_intent, basis: input.titleControl }) !== titleControlDigest(intent.control_intent)) {
      throw new SourceAdoptionConflict('proposal is reserved for another title application');
    }
    const existing = (await this.pool.query<TitleApplicationRow>(
      `SELECT * FROM source.native_work_title_application WHERE intent_id = $1`,
      [intent.id])).rows[0];
    if (existing) {
      await this.verifiedTitleApplication(existing, intent);
      return { application: this.titleApplicationResult(existing, intent, candidate),
        replayed: true };
    }
    let edit: TitleControlReceipt;
    try {
      edit = await changeTitleControl(this.env, this.account, this.access, request,
        { ...intent.control_intent, actingSubject: intent.acting_subject, idempotencyKey: intent.work_idempotency_key });
    } catch (error) {
      if (error instanceof TitleControlConflict && error.terminal?.outcome === 'cancelled') {
        await this.pool.query('DELETE FROM source.native_work_title_pending WHERE intent_id = $1', [intent.id]);
      }
      throw error;
    }
    const inserted = await this.pool.query(`INSERT INTO source.native_work_title_application
      (id, intent_id, proposal_id, principal_id, work, expected_head, work_revision,
       graph_receipt, admission_id, data_epoch, sequence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (intent_id) DO NOTHING`,
    [Bun.randomUUIDv7(), intent.id, candidateProposalId, principalId, work,
      intent.expected_head, edit.revision, edit.receipt, edit.admissionId,
      edit.dataEpoch, edit.sequence]);
    const row = (await this.pool.query<TitleApplicationRow>(
      `SELECT * FROM source.native_work_title_application WHERE intent_id = $1`,
      [intent.id])).rows[0];
    if (!row || row.proposal_id !== candidateProposalId || row.work !== work
      || row.expected_head !== edit.intent?.expectedHead || row.work_revision !== edit.revision
      || row.graph_receipt !== edit.receipt || row.admission_id !== edit.admissionId
      || row.data_epoch !== edit.dataEpoch || row.sequence !== edit.sequence) {
      throw new SourceAdoptionUnavailable('source application differs from committed Work edit');
    }
    await this.verifiedTitleApplication(row, intent);
    return { application: this.titleApplicationResult(row, intent, candidate),
      replayed: inserted.rowCount === 0 || edit.replayed };
  }

  async returnTitleControl(principalId: string, request: Request, work: string, key: string,
    input: { proposal: string; expectedHead: string; titleControl: TitleControlBasis; actingSubject: string }):
    Promise<TitleControlReceipt | null> {
    if (!UUID.test(principalId) || !ACTOR.test(work) || !ACTOR.test(input.proposal)
      || !ACTOR.test(input.expectedHead) || !ACTOR.test(input.actingSubject)
      || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) throw new SourceAdoptionInvalid('invalid source control return');
    const support = await this.readSupport(principalId, work);
    if (!support) return null;
    if (support.state !== 'recorded') throw new SourceSupportConflict('source_support_withdrawn');
    const candidate = await this.proposals.read(principalId, input.proposal.split('/').at(-1)!);
    if (!candidate || candidate.record !== support.sourceRecord) throw new SourceAdoptionConflict('return source differs from support');
    const existing = (await this.pool.query<{ id: string; acting_subject: string; control_intent: TitleControlIntent }>(
      'SELECT * FROM source.native_work_title_return_intent WHERE principal_id = $1 AND idempotency_key = $2', [principalId, key])).rows[0];
    const label = existing ? existing.control_intent.title : (await this.env.fuseki.query(
      `SELECT ?title WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} <${RV}head> ${iri(input.expectedHead)} ;
        <http://www.w3.org/2000/01/rdf-schema#label> ?title . } } LIMIT 2`, 2048)).results?.bindings;
    const title = typeof label === 'string' ? label : label?.length === 1 ? label[0]?.title?.value : undefined;
    if (!title) throw new SourceAdoptionConflict('return target head is unavailable');
    const intent: TitleControlIntent = { work, expectedHead: input.expectedHead, basis: input.titleControl,
      action: 'work.title.return', title, source: { binding: support.binding, record: candidate.record,
        observation: candidate.observation, conversion: candidate.conversion, proposal: candidate.proposal,
        mapping: 'open-library-work-map-v1', initialHead: support.adoptedAtRevision } };
    const digest = titleControlDigest(intent);
    const principal = await this.account.verify(request, ['source:adopt', 'work:edit']);
    // Current, separate authority precedes the Source reservation, including replay.
    await this.access.register({ principal, actingSubject: input.actingSubject, scope: `work:title:return:${work}`,
      action: 'work.title.return', idempotencyKey: key, requestDigest: digest });
    if (existing && (existing.acting_subject !== input.actingSubject || titleControlDigest(existing.control_intent) !== digest)) {
      throw new SourceAdoptionConflict('source control return key changed');
    }
    await this.pool.query(`INSERT INTO source.native_work_title_return_intent
      (id,principal_id,binding_id,proposal_id,work,acting_subject,idempotency_key,control_intent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (principal_id,idempotency_key) DO NOTHING`,
    [Bun.randomUUIDv7(), principalId, support.binding.split('/').at(-1), input.proposal.split('/').at(-1),
      work, input.actingSubject, key, JSON.stringify(intent)]).catch(supportConstraint);
    const row = (await this.pool.query<{ id: string; acting_subject: string; control_intent: TitleControlIntent }>(
      'SELECT * FROM source.native_work_title_return_intent WHERE principal_id = $1 AND idempotency_key = $2', [principalId, key])).rows[0];
    if (!row || row.acting_subject !== input.actingSubject || titleControlDigest(row.control_intent) !== digest) {
      throw new SourceAdoptionConflict('source control return intent changed');
    }
    let terminal: TitleControlReceipt;
    try { terminal = await changeTitleControl(this.env, this.account, this.access, request,
      { ...intent, actingSubject: input.actingSubject, idempotencyKey: key }); }
    catch (error) {
      if (error instanceof TitleControlConflict && error.terminal) {
        await this.pool.query('INSERT INTO source.native_work_title_return_outcome (intent_id,receipt) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [row.id, JSON.stringify(error.terminal)]);
      }
      throw error;
    }
    await this.pool.query('INSERT INTO source.native_work_title_return_outcome (intent_id,receipt) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [row.id, JSON.stringify(terminal)]);
    return terminal;
  }

  async readTitleApplication(principalId: string, work: string,
    candidateProposalId: string): Promise<NativeWorkSourceTitleApplication | null> {
    if (!UUID.test(principalId) || !UUID.test(candidateProposalId) || !ACTOR.test(work)) {
      throw new SourceAdoptionInvalid('invalid source title application identity');
    }
    const proposal = await this.proposals.read(principalId, candidateProposalId);
    if (!proposal) return null;
    const row = (await this.pool.query<TitleApplicationRow & TitleIntentRow>(
      `SELECT a.*, i.acting_subject, i.confirmed_title, i.work_idempotency_key, i.control_intent
       FROM source.native_work_title_application a
       JOIN source.native_work_title_intent i ON i.id = a.intent_id
       WHERE a.work = $1 AND a.proposal_id = $2 AND a.principal_id = $3`,
      [work, candidateProposalId, principalId])).rows[0];
    if (!row) return null;
    await this.verifiedTitleApplication(row, row);
    return this.titleApplicationResult(row, row, proposal);
  }
}
