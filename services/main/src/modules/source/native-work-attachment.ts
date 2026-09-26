import type { Pool, PoolClient } from 'pg';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { WorkEditAuthorityProof } from '../access/work-edit-authority.ts';
import { readExactWorkRevision } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { SourceAdoptionConflict, SourceAdoptionInvalid, SourceAdoptionUnavailable,
  SourceSupportConflict, type NativeWorkSourceSupport, type NativeWorkSourceSupportWithdrawal,
  type SourceNativeWorkAdoptionStore } from './native-work-adoption.ts';
import type { NativeWorkSourceProposal, SourceNativeWorkProposalStore } from './native-work-proposal.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const id = (value: string): string => value.split('/').at(-1)!;
const url = (value: string): string => `https://rezics.com/id/${value}`;

export interface NativeWorkSourceAttachment {
  profile: 'native-work-source-title-attachment-v2'; state: 'attached';
  binding: string; supportIdentity: string; originalBinding: string; work: string;
  proposal: string; sourceRecord: string; sourceObservation: string; sourceConversion: string;
  sourceGraphReceipt: string; title: string; titleLanguage: 'en';
  verifiedHead: string; headGuarantee: 'verified-before-commit';
  authority: WorkEditAuthorityProof; rightsEvidence: NativeWorkSourceProposal['rightsEvidence'];
  rightsStatus: 'undetermined'; createdAt: string;
}

export interface NativeWorkAttachmentWithdrawal {
  profile: 'native-work-source-support-withdrawal-v2'; state: 'withdrawn';
  withdrawal: string; binding: string; supportIdentity: string; work: string;
  proposal: string; verifiedHead: string; reason: string; createdAt: string;
}

export interface NativeWorkAttachedSupport {
  profile: 'native-work-source-title-support-v2'; state: 'recorded' | 'withdrawn';
  attachment: NativeWorkSourceAttachment; currentHead: string;
  verifiedRevisionIsHead: boolean; withdrawal: NativeWorkAttachmentWithdrawal | null;
}
export type NativeWorkSupportEntry = { kind: 'adoption'; support: NativeWorkSourceSupport }
  | { kind: 'attachment'; support: NativeWorkAttachedSupport };
export interface NativeWorkSupportCollection {
  profile: 'native-work-source-supports-v2'; work: string; currentHead: string;
  supports: NativeWorkSupportEntry[];
}
export type NativeWorkSupportWithdrawalResult = {
  kind: 'adoption'; withdrawal: NativeWorkSourceSupportWithdrawal; replayed: boolean;
} | { kind: 'attachment'; withdrawal: NativeWorkAttachmentWithdrawal; replayed: boolean };

interface AttachmentRow {
  id: string; binding_id: string; proposal_id: string; record_id: string;
  principal_id: string; work: string; work_revision: string; title: string;
  acting_subject: string; authority_proof: WorkEditAuthorityProof;
  idempotency_key: string; created_at: Date;
}
interface WithdrawalRow {
  id: string; attachment_id: string; principal_id: string;
  idempotency_key: string; reason: string; created_at: Date;
}
export interface AttachSourceTitleInput {
  proposal: string; expectedHead: string; confirmedTitle: string;
  titleLanguage: 'en'; actingSubject: string;
}

export function attachmentConstraint(error: unknown): never {
  const pg = error as { code?: string; constraint?: string };
  if (pg.code === '23514' && pg.constraint === 'native_work_attachment_pending') {
    throw new SourceSupportConflict('source_support_pending');
  }
  if ((pg.code === '23514' || pg.code === '23505')
    && pg.constraint?.startsWith('native_work_')) {
    throw new SourceAdoptionConflict('source attachment identity or intent conflicts');
  }
  throw error;
}

function sameIntent(row: AttachmentRow, principalId: string, work: string,
  key: string, input: AttachSourceTitleInput): void {
  if (row.principal_id !== principalId || row.work !== work
    || url(row.proposal_id) !== input.proposal || row.work_revision !== input.expectedHead
    || row.title !== input.confirmedTitle || row.acting_subject !== input.actingSubject
    || row.idempotency_key !== key) throw new SourceAdoptionConflict('source attachment intent changed');
}

export class SourceNativeWorkAttachmentStore {
  constructor(private readonly pool: Pool, private readonly proposals: SourceNativeWorkProposalStore,
    private readonly adoptions: SourceNativeWorkAdoptionStore,
    private readonly env: WorkActivationEnvironment,
    private readonly access: Pick<AccessAdmissionRegistry, 'withWorkEditAuthority'>) {}

  private async receipt(row: AttachmentRow, originalBinding: string): Promise<NativeWorkSourceAttachment> {
    const proposal = await this.proposals.read(row.principal_id, row.proposal_id);
    const proof = row.authority_proof;
    if (!proposal || proposal.record !== url(row.record_id) || proposal.candidateTitle !== row.title
      || url(row.binding_id) !== originalBinding || proof.principalId !== row.principal_id
      || proof.actingSubject !== row.acting_subject || proof.scope !== `work:edit:${row.work}`
      || proof.action !== 'work.edit' || !UUID.test(proof.grantId)
      || !UUID.test(proof.representationId)) {
      throw new SourceAdoptionUnavailable('attachment differs from retained evidence');
    }
    const revision = await readExactWorkRevision(this.env, row.work_revision,
      async work => work === row.work).catch(() => {
      throw new SourceAdoptionUnavailable('attachment native revision is unavailable');
    });
    if (revision.title !== row.title || revision.language !== 'en') {
      throw new SourceAdoptionUnavailable('attachment differs from native revision');
    }
    return { profile: 'native-work-source-title-attachment-v2', state: 'attached',
      binding: url(row.id), supportIdentity: url(row.id), originalBinding,
      work: row.work, proposal: proposal.proposal, sourceRecord: proposal.record,
      sourceObservation: proposal.observation, sourceConversion: proposal.conversion,
      sourceGraphReceipt: proposal.graphReceipt, title: row.title, titleLanguage: 'en',
      verifiedHead: row.work_revision, headGuarantee: 'verified-before-commit', authority: proof,
      rightsEvidence: proposal.rightsEvidence, rightsStatus: 'undetermined',
      createdAt: row.created_at.toISOString() };
  }

  async attach(principal: VerifiedPrincipal, principalId: string, work: string,
    key: string, input: AttachSourceTitleInput):
    Promise<{ attachment: NativeWorkSourceAttachment; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !NATIVE.test(work) || !KEY.test(key)
      || ![input.proposal, input.expectedHead, input.actingSubject].every(value => NATIVE.test(value))
      || input.titleLanguage !== 'en') throw new SourceAdoptionInvalid('invalid attachment intent');
    const original = await this.adoptions.readSupport(principalId, work);
    const proposal = await this.proposals.read(principalId, id(input.proposal));
    if (!original || !proposal) return null;
    const prior = (await this.pool.query<AttachmentRow>(
      'SELECT * FROM source.native_work_support_attachment WHERE work = $1 AND principal_id = $2',
      [work, principalId])).rows[0];
    if (prior) {
      sameIntent(prior, principalId, work, key, input);
      return { attachment: await this.receipt(prior, original.binding), replayed: true };
    }
    if (original.currentHead !== input.expectedHead || proposal.record === original.sourceRecord
      || proposal.candidateTitle !== input.confirmedTitle) {
      throw new SourceAdoptionConflict('attachment source or observed Work head differs');
    }
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const revision = await readExactWorkRevision(this.env, input.expectedHead, async target => target === work);
    if (revision.title !== input.confirmedTitle || revision.language !== input.titleLanguage) {
      throw new SourceAdoptionConflict('source title differs from native Work revision');
    }
    // All Jena/object reads finish before Access locks. This receipt describes
    // the exact preflight revision, never a native compare-and-swap or edit.
    // Acquire the Source connection before taking Access locks: pool contention
    // cannot consume the Access idle lease while a commit is still possible.
    const client = await this.pool.connect();
    let saved: { row: AttachmentRow; replayed: boolean };
    try {
    saved = await this.access.withWorkEditAuthority(principal, input.actingSubject, work,
      async proof => {
        if (proof.principalId !== principalId) throw new SourceAdoptionConflict('source principal changed');
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL transaction_timeout = '5s'");
          await client.query("SET LOCAL lock_timeout = '2s'");
          await client.query("SET LOCAL statement_timeout = '3s'");
          const deadline = await client.query<{ valid: boolean }>(
            "SELECT $1::timestamptz > clock_timestamp() + interval '6 seconds' AS valid", [proof.validUntil]);
          if (!deadline.rows[0]?.valid) throw new SourceAdoptionConflict('attachment mandate expires too soon');
          await client.query('SELECT binding_id FROM source.native_work_support_head WHERE binding_id = $1 FOR UPDATE',
            [id(original.binding)]);
          const existing = (await client.query<AttachmentRow>(
            'SELECT * FROM source.native_work_support_attachment WHERE binding_id = $1',
            [id(original.binding)])).rows[0];
          if (existing) {
            sameIntent(existing, principalId, work, key, input);
            await client.query('COMMIT');
            return { row: existing, replayed: true };
          }
          const inserted = await client.query<AttachmentRow>(`INSERT INTO source.native_work_support_attachment
            (id, binding_id, proposal_id, record_id, principal_id, work, work_revision,
             title, acting_subject, authority_proof, idempotency_key)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [Bun.randomUUIDv7(), id(original.binding), id(proposal.proposal), id(proposal.record),
            principalId, work, input.expectedHead, input.confirmedTitle, input.actingSubject,
            JSON.stringify(proof), key]);
          await client.query('COMMIT');
          return { row: inserted.rows[0]!, replayed: false };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          attachmentConstraint(error);
        }
      });
    } finally { client.release(); }
    return { attachment: await this.receipt(saved.row, original.binding), replayed: saved.replayed };
  }

  private withdrawal(row: WithdrawalRow, attachment: NativeWorkSourceAttachment): NativeWorkAttachmentWithdrawal {
    if (url(row.attachment_id) !== attachment.binding) throw new SourceAdoptionUnavailable('withdrawal identity differs');
    return { profile: 'native-work-source-support-withdrawal-v2', state: 'withdrawn',
      withdrawal: url(row.id), binding: attachment.binding, supportIdentity: attachment.binding,
      work: attachment.work, proposal: attachment.proposal, verifiedHead: attachment.verifiedHead,
      reason: row.reason, createdAt: row.created_at.toISOString() };
  }

  async read(principalId: string, work: string): Promise<NativeWorkSupportCollection | null> {
    if (!UUID.test(principalId) || !NATIVE.test(work)) throw new SourceAdoptionInvalid('invalid support identity');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL transaction_timeout = '15s'");
      const locked = await client.query(`SELECT h.binding_id FROM source.native_work_support_head h
        JOIN source.native_work_binding b ON b.id = h.binding_id
        WHERE b.work = $1 AND b.principal_id = $2 FOR SHARE OF h`, [work, principalId]);
      if (!locked.rowCount) { await client.query('COMMIT'); return null; }
      const row = (await client.query<AttachmentRow>(`SELECT * FROM source.native_work_support_attachment
        WHERE work = $1 AND principal_id = $2 FOR SHARE`, [work, principalId])).rows[0];
      const original = await this.adoptions.readSupport(principalId, work);
      if (!original) throw new SourceAdoptionUnavailable('original support is unavailable');
      const supports: NativeWorkSupportEntry[] = [{ kind: 'adoption', support: original }];
      if (row) {
        const attachment = await this.receipt(row, original.binding);
        const withdrawn = await this.withdrawalRow(client, row.id, principalId);
        supports.push({ kind: 'attachment', support: { profile: 'native-work-source-title-support-v2',
          state: withdrawn ? 'withdrawn' : 'recorded', attachment, currentHead: original.currentHead,
          verifiedRevisionIsHead: row.work_revision === original.currentHead,
          withdrawal: withdrawn ? this.withdrawal(withdrawn, attachment) : null } });
      }
      await client.query('COMMIT');
      return { profile: 'native-work-source-supports-v2', work, currentHead: original.currentHead, supports };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async readBinding(principalId: string, work: string, binding: string): Promise<NativeWorkSupportEntry | null> {
    if (!NATIVE.test(binding)) throw new SourceAdoptionInvalid('invalid binding identity');
    const collection = await this.read(principalId, work);
    return collection?.supports.find(entry => (entry.kind === 'adoption'
      ? entry.support.binding : entry.support.attachment.binding) === binding) ?? null;
  }

  private async withdrawalRow(client: Pick<PoolClient, 'query'>, attachment: string,
    principalId: string): Promise<WithdrawalRow | undefined> {
    return (await client.query<WithdrawalRow>(`SELECT * FROM source.native_work_attachment_withdrawal
      WHERE attachment_id = $1 AND principal_id = $2`, [attachment, principalId])).rows[0];
  }

  async withdraw(principalId: string, work: string, binding: string, key: string,
    input: { expectedSupport: string; reason: string }): Promise<NativeWorkSupportWithdrawalResult | null> {
    if (!KEY.test(key) || !NATIVE.test(input.expectedSupport) || !input.reason
      || input.reason.length > 500 || input.reason !== input.reason.trim()
      || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new SourceAdoptionInvalid('invalid withdrawal intent');
    const entry = await this.readBinding(principalId, work, binding);
    if (!entry) return null;
    if (entry.kind === 'adoption') {
      const result = await this.adoptions.withdrawSupport(principalId, work, key, { ...input, binding });
      return result ? { kind: 'adoption', ...result } : null;
    }
    if (binding !== input.expectedSupport) throw new SourceSupportConflict('source_support_changed');
    const existing = await this.withdrawalRow(this.pool, id(binding), principalId);
    let inserted = false;
    if (!existing) inserted = (await this.pool.query(`INSERT INTO source.native_work_attachment_withdrawal
      (id, attachment_id, principal_id, idempotency_key, reason) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING`, [Bun.randomUUIDv7(), id(binding), principalId, key, input.reason])
      .catch(attachmentConstraint)).rowCount === 1;
    const row = existing ?? await this.withdrawalRow(this.pool, id(binding), principalId);
    if (!row || row.idempotency_key !== key || row.reason !== input.reason) {
      throw new SourceSupportConflict('source_withdrawal_intent_conflict');
    }
    return { kind: 'attachment', withdrawal: this.withdrawal(row, entry.support.attachment), replayed: !inserted };
  }
}
