import type { Pool } from 'pg';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { createAdmittedMetadataWork } from '../work/create-admitted.ts';
import { editAdmittedMetadataWork } from '../work/edit-admitted.ts';
import { metadataWorkEditDigest, readWorkEditTerminalReceipt } from '../work/edit.ts';
import { metadataWorkRequestDigest, type WorkActivationEnvironment,
} from '../work/activate.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { readWorkTerminalReceipt } from '../work/receipt.ts';
import type { SourceNativeWorkProposalStore } from './native-work-proposal.ts';

export class SourceAdoptionInvalid extends Error {}
export class SourceAdoptionConflict extends Error {}
export class SourceAdoptionUnavailable extends Error {}

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
  state: 'recorded';
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
  rightsEvidence: { basis: 'unknown' | 'facts' | 'original' | 'license'
    | 'permission' | 'exception'; note: string };
  rightsStatus: 'undetermined';
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
  work_idempotency_key: string;
}

interface TitleApplicationRow {
  id: string; intent_id: string; proposal_id: string; principal_id: string;
  work: string; expected_head: string; work_revision: string; graph_receipt: string;
  admission_id: string; data_epoch: string; sequence: string; created_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTOR = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const url = (id: string): string => `https://rezics.com/id/${id}`;

export class SourceNativeWorkAdoptionStore {
  constructor(private readonly pool: Pool, private readonly proposals: SourceNativeWorkProposalStore,
    private readonly env: WorkActivationEnvironment,
    private readonly account: Pick<AccountAssertionVerifier, 'verify'>,
    private readonly access: Pick<AccessAdmissionRegistry,
      'register' | 'claim' | 'recordGraphOutcome'>) {}

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
      input.confirmedTitle, `source-adopt-${Bun.randomUUIDv7()}`]);
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
    const binding = await this.pool.query<{ proposal_id: string }>(
      `SELECT proposal_id FROM source.native_work_binding
       WHERE work = $1 AND principal_id = $2`, [work, principalId]);
    const proposalId = binding.rows[0]?.proposal_id;
    if (!proposalId) return null;
    const adoption = await this.read(principalId, proposalId);
    const proposal = await this.proposals.read(principalId, proposalId);
    if (!adoption || !proposal || adoption.work !== work) {
      throw new SourceAdoptionUnavailable('native Work source support is unavailable');
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
    return { profile: 'native-work-source-support-v1', state: 'recorded',
      work, field: 'title', sourceValue: proposal.candidateTitle,
      sourceRecord: proposal.record, sourceObservation: proposal.observation,
      sourceConversion: proposal.conversion, sourceProposal: proposal.proposal,
      sourceGraphReceipt: proposal.graphReceipt, binding: adoption.binding,
      adoptionReceipt: adoption.receipt, adoptedAtRevision: adoption.workRevision,
      currentHead: head, appliedRevisionIsHead: head === adoption.workRevision,
      rightsEvidence: proposal.rightsEvidence, rightsStatus: 'undetermined' };
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
      confirmedTitle: string }):
    Promise<{ application: NativeWorkSourceTitleApplication; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !UUID.test(candidateProposalId)
      || !ACTOR.test(work) || !ACTOR.test(input.expectedHead)
      || !ACTOR.test(input.actingSubject)) {
      throw new SourceAdoptionInvalid('invalid source title application intent');
    }
    const support = await this.readSupport(principalId, work);
    if (!support) return null;
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
      let baseProposalId: string;
      if (input.expectedHead === support.adoptedAtRevision) {
        baseProposalId = support.sourceProposal.split('/').at(-1)!;
      } else {
        const prior = (await this.pool.query<{ proposal_id: string }>(
          `SELECT proposal_id FROM source.native_work_title_application
           WHERE work = $1 AND work_revision = $2 AND principal_id = $3`,
          [work, input.expectedHead, principalId])).rows[0];
        if (!prior) throw new SourceAdoptionConflict('human-controlled Work head');
        baseProposalId = prior.proposal_id;
      }
      const base = await this.proposals.read(principalId, baseProposalId);
      if (!base) throw new SourceAdoptionUnavailable('source control base is unavailable');
      if (candidate.candidateTitle === base.candidateTitle
        || candidate.graphPosition.dataEpoch !== base.graphPosition.dataEpoch
        || BigInt(candidate.graphPosition.sequence) <= BigInt(base.graphPosition.sequence)) {
        throw new SourceAdoptionConflict('candidate is not a later title change in this source epoch');
      }
      await this.pool.query(`INSERT INTO source.native_work_title_intent
        (id, proposal_id, principal_id, work, expected_head, acting_subject,
         confirmed_title, work_idempotency_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (work, proposal_id) DO NOTHING`,
      [Bun.randomUUIDv7(), candidateProposalId, principalId, work, input.expectedHead,
        input.actingSubject, input.confirmedTitle, `source-title-${Bun.randomUUIDv7()}`]);
    }
    const intent = (await this.pool.query<TitleIntentRow>(
      `SELECT * FROM source.native_work_title_intent
       WHERE work = $1 AND proposal_id = $2 AND principal_id = $3`,
      [work, candidateProposalId, principalId])).rows[0];
    if (!intent || intent.expected_head !== input.expectedHead
      || intent.acting_subject !== input.actingSubject
      || intent.confirmed_title !== input.confirmedTitle) {
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
    const edit = await editAdmittedMetadataWork(this.env, this.account, this.access, request,
      { work, expectedHead: intent.expected_head, title: intent.confirmed_title,
        actingSubject: intent.acting_subject, idempotencyKey: intent.work_idempotency_key });
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
      || row.expected_head !== edit.predecessor || row.work_revision !== edit.revision
      || row.graph_receipt !== edit.receipt || row.admission_id !== edit.admissionId
      || row.data_epoch !== edit.dataEpoch || row.sequence !== edit.sequence) {
      throw new SourceAdoptionUnavailable('source application differs from committed Work edit');
    }
    await this.verifiedTitleApplication(row, intent);
    return { application: this.titleApplicationResult(row, intent, candidate),
      replayed: inserted.rowCount === 0 || edit.replayed };
  }

  async readTitleApplication(principalId: string, work: string,
    candidateProposalId: string): Promise<NativeWorkSourceTitleApplication | null> {
    if (!UUID.test(principalId) || !UUID.test(candidateProposalId) || !ACTOR.test(work)) {
      throw new SourceAdoptionInvalid('invalid source title application identity');
    }
    const proposal = await this.proposals.read(principalId, candidateProposalId);
    if (!proposal) return null;
    const row = (await this.pool.query<TitleApplicationRow & TitleIntentRow>(
      `SELECT a.*, i.acting_subject, i.confirmed_title, i.work_idempotency_key
       FROM source.native_work_title_application a
       JOIN source.native_work_title_intent i ON i.id = a.intent_id
       WHERE a.work = $1 AND a.proposal_id = $2 AND a.principal_id = $3`,
      [work, candidateProposalId, principalId])).rows[0];
    if (!row) return null;
    await this.verifiedTitleApplication(row, row);
    return this.titleApplicationResult(row, row, proposal);
  }
}
