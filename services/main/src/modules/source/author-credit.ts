import type { Pool, PoolClient } from 'pg';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { WorkEditAuthorityProof } from '../access/work-edit-authority.ts';
import { GRAPHS, RV, hash, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { adoptAuthorCredit, authorCreditDigest, readAuthorCredit, readAuthorCreditReceipt,
  AuthorCreditInvalid, AuthorCreditConflict, AuthorCreditUnavailable,
  type AuthorCreditValue, type NativeAuthorCredit, type AuthorCreditReceipt } from '../work/author-credit.ts';
import { compareSourceChildren, sourceChildOccurrence } from './child-correspondence.ts';
import type { OpenLibraryConversionStore } from './open-library-conversion.ts';
import type { SourceNativeWorkProposalStore } from './native-work-proposal.ts';
import type { SourceChildCorrespondenceStore } from './record-child-correspondence.ts';
import type { StagedSourceObservation } from './intake.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NATIVE = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const id = (value: string) => value.split('/').at(-1)!;
const url = (value: string) => `https://rezics.com/id/${value}`;

export interface AdoptSourceAuthorCreditInput {
  proposal: string; conversion: string; occurrence: string; sourceOrdinal: number;
  confirmedSourceKey: string; confirmedRoleKey: string | null;
  nativeOrdinal: number; expectedHead: string; actingSubject: string;
  baseSupport: string | null; correspondence: string | null;
  confirmedUse: 'factual-reference-only';
}
export interface AuthorCreditIntentRow {
  id: string; principal_id: string; work: string; idempotency_key: string; request_digest: string;
  request: AdoptSourceAuthorCreditInput; proposal_id: string; conversion_id: string; record_id: string;
  occurrence: string; source_ordinal: number; source_key: string; source_role_key: string | null;
  correspondence_id: string | null; base_support_id: string | null; credit: string; credit_revision: string;
  authority_proof: WorkEditAuthorityProof; created_at: Date;
}
interface ApplicationRow { intent_id: string; graph_receipt: string; admission_id: string;
  data_epoch: string; sequence: string; created_at: Date }
interface WithdrawalRow { id: string; intent_id: string; principal_id: string;
  idempotency_key: string; reason: string; created_at: Date }
export interface SourceAuthorCreditSupport {
  profile: 'source-author-credit-support-v1'; state: 'recorded' | 'withdrawn';
  support: string; work: string; credit: NativeAuthorCredit;
  proposal: string; conversion: string; record: string; observation: string;
  sourceOccurrence: string; sourceOrdinal: number; sourceKey: string; sourceRoleKey: string | null;
  correspondence: string | null; correspondenceKind: 'initial' | 'unique-key' | 'explicit' | 'separate-source';
  baseSupport: string | null; sourceGraphReceipt: string; nativeReceipt: string;
  headGuarantee: 'transaction-guarded' | 'verified-before-commit';
  rightsEvidence: StagedSourceObservation['rightsEvidence'];
  rightsStatus: 'undetermined'; createdAt: string;
  withdrawal: { withdrawal: string; reason: string; createdAt: string } | null;
}

export function sourceAuthorCreditRequestDigest(work: string, input: AdoptSourceAuthorCreditInput): string {
  if (![work, input.proposal, input.conversion, input.expectedHead, input.actingSubject]
    .every(value => NATIVE.test(value)) || (input.baseSupport !== null && !NATIVE.test(input.baseSupport))
    || (input.correspondence !== null && !NATIVE.test(input.correspondence))
    || !/^urn:rezics:source-occurrence:[0-9a-f]{64}$/.test(input.occurrence)
    || !Number.isInteger(input.sourceOrdinal) || input.sourceOrdinal < 0 || input.sourceOrdinal > 127
    || !Number.isInteger(input.nativeOrdinal) || input.nativeOrdinal < 0 || input.nativeOrdinal > 127
    || input.confirmedUse !== 'factual-reference-only') throw new AuthorCreditInvalid('invalid source credit intent');
  return hash(JSON.stringify({ profile: 'source-author-credit-adoption-v1', work,
    proposal: input.proposal, conversion: input.conversion, occurrence: input.occurrence,
    sourceOrdinal: input.sourceOrdinal, confirmedSourceKey: input.confirmedSourceKey,
    confirmedRoleKey: input.confirmedRoleKey, nativeOrdinal: input.nativeOrdinal,
    expectedHead: input.expectedHead, actingSubject: input.actingSubject,
    baseSupport: input.baseSupport, correspondence: input.correspondence, confirmedUse: input.confirmedUse }));
}

export function creditValue(row: AuthorCreditIntentRow): AuthorCreditValue {
  return { work: row.work, credit: row.credit, revision: row.credit_revision,
    expectedHead: row.request.expectedHead, sourceKey: row.source_key, sourceRoleKey: row.source_role_key,
    nativeOrdinal: row.request.nativeOrdinal, actingSubject: row.request.actingSubject };
}

function conflict(error: unknown): never {
  if (['23505', '23514'].includes((error as { code?: string }).code ?? '')) {
    throw new AuthorCreditConflict('source occurrence, support or request conflicts');
  }
  throw error;
}

export class SourceAuthorCreditStore {
  constructor(private readonly pool: Pool, private readonly proposals: SourceNativeWorkProposalStore,
    private readonly conversions: OpenLibraryConversionStore,
    private readonly correspondences: SourceChildCorrespondenceStore,
    private readonly env: WorkActivationEnvironment,
    private readonly account: Pick<AccountAssertionVerifier, 'verify'>,
    private readonly access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'withWorkEditAuthority'>) {}

  async intent(principalId: string, supportId: string): Promise<AuthorCreditIntentRow | null> {
    const row = (await this.pool.query<AuthorCreditIntentRow>(
      'SELECT * FROM source.author_credit_intent WHERE id = $1 AND principal_id = $2', [supportId, principalId])).rows[0];
    return row ?? null;
  }

  private async evidence(principalId: string, input: AdoptSourceAuthorCreditInput) {
    const proposal = await this.proposals.read(principalId, id(input.proposal));
    if (!proposal) return null;
    if (proposal.conversion !== input.conversion) throw new AuthorCreditConflict('proposal/conversion pair differs');
    const evidence = await this.conversions.verifiedRead(principalId, id(input.conversion));
    if (!evidence || proposal.record !== evidence.observation.record
      || proposal.observation !== evidence.observation.observation) throw new AuthorCreditUnavailable('source evidence differs');
    const authors = evidence.conversion.projection.authorRefs;
    const child = authors?.[input.sourceOrdinal];
    if (!authors || !child || evidence.conversion.fieldInventory.find(field => field.field === 'authors')?.disposition !== 'source-reference'
      || sourceChildOccurrence(evidence.observation.observation, 'authors', input.sourceOrdinal) !== input.occurrence
      || child.sourceKey !== input.confirmedSourceKey || child.roleKey !== input.confirmedRoleKey) {
      throw new AuthorCreditConflict('complete exact author occurrence is required');
    }
    return { proposal, child };
  }

  private async base(principalId: string, input: AdoptSourceAuthorCreditInput, record: string) {
    if (!input.baseSupport) {
      if (input.correspondence) throw new AuthorCreditConflict('initial occurrence has no correspondence');
      return { row: null, kind: 'initial' as const };
    }
    const row = await this.intent(principalId, id(input.baseSupport));
    if (!row || row.base_support_id) throw new AuthorCreditConflict('base must be an original credit support');
    const evidence = await this.evidence(principalId, row.request);
    if (!evidence) throw new AuthorCreditUnavailable('base source proof is missing');
    if (row.source_key !== input.confirmedSourceKey || row.source_role_key !== input.confirmedRoleKey
      || row.request.nativeOrdinal !== input.nativeOrdinal) throw new AuthorCreditConflict('support cannot rewrite a native credit');
    if (url(row.record_id) !== record) {
      if (input.correspondence) throw new AuthorCreditConflict('cross-record correspondence is unsupported');
      return { row, kind: 'separate-source' as const };
    }
    const candidate = await this.proposals.read(principalId, id(input.proposal));
    if (!candidate || candidate.graphPosition.dataEpoch !== evidence.proposal.graphPosition.dataEpoch
      || BigInt(candidate.graphPosition.sequence) <= BigInt(evidence.proposal.graphPosition.sequence)) {
      throw new AuthorCreditConflict('candidate is not a later source proposal in this epoch');
    }
    const comparison = await compareSourceChildren(this.conversions, principalId, row.conversion_id, id(input.conversion));
    const authors = comparison?.fields.find(field => field.field === 'authors');
    const base = authors?.base.find(child => child.occurrence === row.occurrence);
    const child = authors?.candidate.find(item => item.occurrence === input.occurrence);
    if (authors?.coverage !== 'complete' || !base || !child) throw new AuthorCreditConflict('source author list is unavailable');
    if (input.correspondence) {
      const decision = await this.correspondences.read(principalId, id(input.correspondence));
      if (!decision || decision.field !== 'authors' || decision.record !== record
        || decision.baseConversion !== url(row.conversion_id) || decision.candidateConversion !== input.conversion
        || decision.baseOccurrence !== row.occurrence || decision.candidateOccurrence !== input.occurrence) {
        throw new AuthorCreditConflict('explicit correspondence differs from the selected pair');
      }
      return { row, kind: 'explicit' as const };
    }
    if (base.status !== 'matched' || child.status !== 'matched' || base.correspondence !== child.occurrence
      || child.correspondence !== base.occurrence) throw new AuthorCreditConflict('ambiguous or changed occurrence needs explicit resolution');
    return { row, kind: 'unique-key' as const };
  }

  private async binding(client: PoolClient, principalId: string, work: string, record: string,
    proposal: string, sameRecordRefresh: boolean) {
    // One Work-key lookup locks the same Source head as title application/withdrawal.
    const original = (await client.query<{ id: string; record_id: string; proposal_id: string; withdrawn: boolean }>(
      `SELECT b.id, p.record_id, COALESCE(a.proposal_id,b.proposal_id) AS proposal_id,
        EXISTS (SELECT 1 FROM source.native_work_support_withdrawal w WHERE w.binding_id = b.id) AS withdrawn
       FROM source.native_work_binding b JOIN source.native_work_support_head h ON h.binding_id = b.id
       JOIN source.native_work_proposal p ON p.id = b.proposal_id
       LEFT JOIN source.native_work_title_application a ON a.id = h.application_id
       WHERE b.work = $1 AND b.principal_id = $2 FOR UPDATE OF h`, [work, principalId])).rows[0];
    if (!original) throw new AuthorCreditConflict('Work has no source binding');
    let selected = original;
    if (original.record_id !== record) {
      const attachment = (await client.query<typeof original>(`SELECT a.id, a.record_id, a.proposal_id,
        EXISTS (SELECT 1 FROM source.native_work_attachment_withdrawal w WHERE w.attachment_id = a.id) AS withdrawn
        FROM source.native_work_support_attachment a
        WHERE a.work = $1 AND a.principal_id = $2 AND a.record_id = $3 FOR UPDATE OF a`,
      [work, principalId, record])).rows[0];
      if (!attachment) throw new AuthorCreditConflict('SourceRecord is unrelated to Work');
      selected = attachment;
    }
    if (selected.withdrawn || (!sameRecordRefresh && selected.proposal_id !== proposal)) {
      throw new AuthorCreditConflict('source binding is withdrawn or proposal is stale');
    }
  }

  async adopt(principal: VerifiedPrincipal, principalId: string, request: Request, work: string,
    key: string, input: AdoptSourceAuthorCreditInput): Promise<{ support: SourceAuthorCreditSupport; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !KEY.test(key)) throw new AuthorCreditInvalid('invalid source principal/key');
    const digest = sourceAuthorCreditRequestDigest(work, input);
    const prior = (await this.pool.query<AuthorCreditIntentRow>(
      'SELECT * FROM source.author_credit_intent WHERE principal_id = $1 AND idempotency_key = $2', [principalId, key])).rows[0];
    if (prior && (prior.request_digest !== digest || prior.work !== work)) throw new AuthorCreditConflict('credit intent changed');
    const evidence = await this.evidence(principalId, input);
    if (!evidence) return null;
    const base = await this.base(principalId, input, evidence.proposal.record);
    if (base.row && base.row.work !== work) throw new AuthorCreditConflict('base belongs to another Work');
    const original = base.row ? await this.read(principalId, base.row.id) : null;
    if (base.row && !original) throw new AuthorCreditUnavailable('base credit is not committed');
    if (!prior && original?.state === 'withdrawn') throw new AuthorCreditConflict('base support is withdrawn');
    if (!prior) {
      const observed = await this.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(work)} rv:head ${iri(input.expectedHead)} .
        FILTER NOT EXISTS { ${iri(work)} rv:protectionHead ?p } } }`);
      if (!observed.boolean) throw new AuthorCreditConflict('Work head or protection changed');
    }
    const generated: AuthorCreditValue = { work, credit: base.row?.credit ?? url(Bun.randomUUIDv7()),
      revision: base.row?.credit_revision ?? url(Bun.randomUUIDv7()), expectedHead: input.expectedHead,
      sourceKey: evidence.child.sourceKey, sourceRoleKey: evidence.child.roleKey,
      nativeOrdinal: input.nativeOrdinal, actingSubject: input.actingSubject };
    const intentId = Bun.randomUUIDv7();
    authorCreditDigest(generated, url(intentId));
    const client = await this.pool.connect();
    let row: AuthorCreditIntentRow;
    let inserted = false;
    try {
      row = await this.access.withWorkEditAuthority(principal, input.actingSubject, work, async proof => {
        if (proof.principalId !== principalId) throw new AuthorCreditConflict('source principal differs from Work authority');
        if (prior) return prior;
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout = '2s'");
          await client.query("SET LOCAL statement_timeout = '5s'");
          await this.binding(client, principalId, work, id(evidence.proposal.record), id(input.proposal),
            !!base.row && base.kind !== 'separate-source');
          const saved = await client.query(`INSERT INTO source.author_credit_intent
            (id,principal_id,work,idempotency_key,request_digest,request,proposal_id,conversion_id,record_id,
             occurrence,source_ordinal,source_key,source_role_key,correspondence_id,base_support_id,
             credit,credit_revision,authority_proof)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING`,
          [intentId, principalId, work, key, digest, JSON.stringify(input), id(input.proposal), id(input.conversion),
            id(evidence.proposal.record), input.occurrence, input.sourceOrdinal, evidence.child.sourceKey,
            evidence.child.roleKey, input.correspondence ? id(input.correspondence) : null, base.row?.id ?? null,
            generated.credit, generated.revision, JSON.stringify(proof)]);
          const selected = (await client.query<AuthorCreditIntentRow>(
            'SELECT * FROM source.author_credit_intent WHERE principal_id = $1 AND idempotency_key = $2', [principalId, key])).rows[0];
          if (!selected || selected.request_digest !== digest) throw new AuthorCreditConflict('occurrence or key is already reserved');
          await client.query('COMMIT');
          inserted = saved.rowCount === 1;
          return selected;
        } catch (error) { await client.query('ROLLBACK'); conflict(error); }
      });
    } finally { client.release(); }
    const application = (await this.pool.query<ApplicationRow>(
      'SELECT * FROM source.author_credit_application WHERE intent_id = $1', [row.id])).rows[0];
    if (!application) {
      let receipt: AuthorCreditReceipt;
      if (base.row) {
        const native = (await this.pool.query<ApplicationRow>(
          'SELECT * FROM source.author_credit_application WHERE intent_id = $1', [base.row.id])).rows[0];
        const checked = native && await readAuthorCreditReceipt(this.env, native.admission_id);
        if (!checked) throw new AuthorCreditUnavailable('base native receipt is unavailable');
        receipt = checked;
      } else {
        receipt = (await adoptAuthorCredit(this.env, this.account, this.access, request, creditValue(row),
          url(row.id), `source-credit-${row.id}`)).receipt;
      }
      await this.pool.query(`INSERT INTO source.author_credit_application
        (intent_id,graph_receipt,admission_id,data_epoch,sequence) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [row.id, receipt.receipt, receipt.admissionId, receipt.dataEpoch, receipt.sequence]);
    }
    const support = await this.read(principalId, row.id);
    if (!support) throw new AuthorCreditUnavailable('credit support did not complete');
    return { support, replayed: !inserted };
  }

  async read(principalId: string, supportId: string): Promise<SourceAuthorCreditSupport | null> {
    if (!UUID.test(principalId) || !UUID.test(supportId)) throw new AuthorCreditInvalid('invalid support identity');
    const row = await this.intent(principalId, supportId);
    if (!row) return null;
    const app = (await this.pool.query<ApplicationRow>('SELECT * FROM source.author_credit_application WHERE intent_id = $1', [row.id])).rows[0];
    if (!app) return null;
    const evidence = await this.evidence(principalId, row.request);
    if (!evidence) throw new AuthorCreditUnavailable('source credit evidence unavailable');
    const base = await this.base(principalId, row.request, evidence.proposal.record);
    const origin = base.row ?? row;
    const native = await readAuthorCredit(this.env, row.credit, row.credit_revision);
    const proof = await readAuthorCreditReceipt(this.env, app.admission_id);
    if (!native || !proof || proof.requestDigest !== authorCreditDigest(creditValue(origin), url(origin.id))
      || proof.receipt !== app.graph_receipt || proof.sourceIntent !== url(origin.id)
      || proof.credit !== row.credit || proof.revision !== row.credit_revision || proof.work !== row.work
      || proof.dataEpoch !== app.data_epoch || proof.sequence !== app.sequence
      || native.dataEpoch !== app.data_epoch || native.sequence !== app.sequence
      || native.sourceKey !== row.source_key || native.sourceRoleKey !== row.source_role_key
      || native.nativeOrdinal !== row.request.nativeOrdinal || native.expectedHead !== origin.request.expectedHead
      || native.actingSubject !== origin.request.actingSubject || native.work !== row.work
      || row.request_digest !== sourceAuthorCreditRequestDigest(row.work, row.request)
      || evidence.proposal.record !== url(row.record_id) || evidence.proposal.conversion !== url(row.conversion_id)
      || evidence.proposal.proposal !== url(row.proposal_id) || row.occurrence !== row.request.occurrence
      || row.source_ordinal !== row.request.sourceOrdinal || row.source_key !== row.request.confirmedSourceKey
      || row.source_role_key !== row.request.confirmedRoleKey
      || row.authority_proof.principalId !== principalId || row.authority_proof.scope !== `work:edit:${row.work}`
      || row.authority_proof.actingSubject !== row.request.actingSubject) {
      throw new AuthorCreditUnavailable('source certificate differs from native occurrence/proof');
    }
    const withdrawn = (await this.pool.query<WithdrawalRow>(
      'SELECT * FROM source.author_credit_withdrawal WHERE intent_id = $1', [row.id])).rows[0];
    return { profile: 'source-author-credit-support-v1', state: withdrawn ? 'withdrawn' : 'recorded',
      support: url(row.id), work: row.work, credit: native, proposal: evidence.proposal.proposal,
      conversion: evidence.proposal.conversion, record: evidence.proposal.record, observation: evidence.proposal.observation,
      sourceOccurrence: row.occurrence, sourceOrdinal: row.source_ordinal, sourceKey: row.source_key,
      sourceRoleKey: row.source_role_key, correspondence: row.request.correspondence,
      correspondenceKind: base.kind, baseSupport: row.request.baseSupport,
      sourceGraphReceipt: evidence.proposal.graphReceipt, nativeReceipt: proof.receipt,
      headGuarantee: row.base_support_id ? 'verified-before-commit' : 'transaction-guarded',
      rightsEvidence: evidence.proposal.rightsEvidence, rightsStatus: 'undetermined', createdAt: row.created_at.toISOString(),
      withdrawal: withdrawn ? { withdrawal: url(withdrawn.id), reason: withdrawn.reason,
        createdAt: withdrawn.created_at.toISOString() } : null };
  }

  async withdraw(principalId: string, supportId: string, key: string, reason: string) {
    if (!KEY.test(key) || !reason || reason !== reason.trim() || reason.length > 500
      || /[\u0000-\u001f\u007f]/.test(reason)) throw new AuthorCreditInvalid('invalid withdrawal');
    const support = await this.read(principalId, supportId);
    if (!support) return null;
    const inserted = await this.pool.query(`INSERT INTO source.author_credit_withdrawal
      (id,intent_id,principal_id,idempotency_key,reason) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [Bun.randomUUIDv7(), supportId, principalId, key, reason]).catch(conflict);
    const row = (await this.pool.query<WithdrawalRow>(
      'SELECT * FROM source.author_credit_withdrawal WHERE intent_id = $1', [supportId])).rows[0];
    if (!row || row.principal_id !== principalId || row.idempotency_key !== key || row.reason !== reason) {
      throw new AuthorCreditConflict('withdrawal intent changed');
    }
    return { support: { ...support, state: 'withdrawn' as const, withdrawal: {
      withdrawal: url(row.id), reason: row.reason, createdAt: row.created_at.toISOString() } }, replayed: inserted.rowCount === 0 };
  }
}
