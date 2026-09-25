import type { Pool } from 'pg';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { createAdmittedMetadataWork } from '../work/create-admitted.ts';
import { metadataWorkRequestDigest, type WorkActivationEnvironment,
} from '../work/activate.ts';
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
}
