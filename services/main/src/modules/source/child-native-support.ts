import type { Pool, PoolClient } from 'pg';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { WorkEditAuthorityProof } from '../access/work-edit-authority.ts';
import { GRAPHS, RV, hash, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { adoptNativeChild, nativeChildDigest, readNativeChild, readNativeChildReceipt,
  NativeChildConflict, NativeChildInvalid, NativeChildUnavailable,
  type NativeChildValue, type NativeChildReceipt } from './child-native.ts';
import { compareSourceChildren, sourceChildOccurrence } from './child-correspondence.ts';
import type { OpenLibraryConversionStore } from './open-library-conversion.ts';
import type { SourceNativeWorkProposalStore } from './native-work-proposal.ts';
import type { SourceChildCorrespondenceStore } from './record-child-correspondence.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OCCURRENCE = /^urn:rezics:source-occurrence:[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const id = (value: string) => value.split('/').at(-1)!;
const url = (value: string) => `https://rezics.com/id/${value}`;

export interface AdoptSourceNativeChildInput {
  profile: 'source-native-child-adoption-v1'; field: 'subjects'; proposal: string;
  conversion: string; occurrence: string;
  sourceOrdinal: number; confirmedSourceKey: string; nativeOrdinal: number;
  expectedHead: string; actingSubject: string; baseSupport: string | null;
  correspondence: string | null; confirmedUse: 'factual-reference-only';
}
export interface NativeChildIntentRow {
  id: string; principal_id: string; work: string; field_key: 'subjects';
  idempotency_key: string; request_digest: string; request: AdoptSourceNativeChildInput;
  proposal_id: string; conversion_id: string; record_id: string; occurrence: string;
  source_ordinal: number; source_key: string; native_ordinal: number;
  correspondence_id: string | null; base_support_id: string | null;
  child: string; child_revision: string; authority_proof: WorkEditAuthorityProof; created_at: Date;
}
interface ApplicationRow { intent_id: string; graph_receipt: string; admission_id: string;
  data_epoch: string; sequence: string; created_at: Date }
interface WithdrawalRow { id: string; intent_id: string; principal_id: string;
  idempotency_key: string; reason: string; created_at: Date }

export function nativeChildSupportDigest(work: string, input: AdoptSourceNativeChildInput): string {
  if (![work, input.proposal, input.conversion, input.expectedHead, input.actingSubject]
    .every(value => NATIVE.test(value)) || input.profile !== 'source-native-child-adoption-v1'
    || input.field !== 'subjects'
    || (input.baseSupport !== null && !NATIVE.test(input.baseSupport))
    || (input.correspondence !== null && !NATIVE.test(input.correspondence))
    || !OCCURRENCE.test(input.occurrence)
    || !Number.isInteger(input.sourceOrdinal) || input.sourceOrdinal < 0 || input.sourceOrdinal > 127
    || !Number.isInteger(input.nativeOrdinal) || input.nativeOrdinal < 0 || input.nativeOrdinal > 127
    || !input.confirmedSourceKey || input.confirmedSourceKey.length > 200
    || input.confirmedUse !== 'factual-reference-only') throw new NativeChildInvalid('invalid child support intent');
  return hash(JSON.stringify({ profile: 'source-native-child-adoption-v1', work,
    field: input.field, proposal: input.proposal, conversion: input.conversion,
    occurrence: input.occurrence, sourceOrdinal: input.sourceOrdinal,
    confirmedSourceKey: input.confirmedSourceKey, nativeOrdinal: input.nativeOrdinal,
    expectedHead: input.expectedHead, actingSubject: input.actingSubject,
    baseSupport: input.baseSupport, correspondence: input.correspondence,
    confirmedUse: input.confirmedUse }));
}

export function nativeChildValue(row: NativeChildIntentRow): NativeChildValue {
  return { work: row.work, child: row.child, revision: row.child_revision,
    field: row.field_key, sourceKey: row.source_key, nativeOrdinal: row.native_ordinal,
    expectedHead: row.request.expectedHead, actingSubject: row.request.actingSubject,
    sourceIntent: url(row.id) };
}

/** Field-keyed Source intents are reserved before dispatch; exact retry repairs the certificate.
 * Cost: one bounded conversion (at most 128 subjects), one source proposal and optional
 * base/correspondence by indexed ID, one Work-head read, one Access admission and one
 * constant-size graph command. Read and withdrawal use indexed support/certificate
 * lookups and one native child revision. Work is O(B + A + log N), where B is the
 * bounded source capture, A <= 128 children, and N is unrelated Source history.
 * The integration plan/read budgets and held recovery budget exercise these limits.
 */
export class SourceNativeChildStore {
  constructor(private readonly pool: Pool,
    private readonly proposals: SourceNativeWorkProposalStore,
    private readonly conversions: OpenLibraryConversionStore,
    private readonly correspondences: SourceChildCorrespondenceStore,
    private readonly env: WorkActivationEnvironment,
    private readonly account: Pick<AccountAssertionVerifier, 'verify'>,
    private readonly access: Pick<AccessAdmissionRegistry,
      'register' | 'claim' | 'recordGraphOutcome' | 'issueTitleAdmission' | 'withWorkEditAuthority'>) {}

  private async intent(principalId: string, supportId: string): Promise<NativeChildIntentRow | null> {
    return (await this.pool.query<NativeChildIntentRow>(`SELECT * FROM source.native_child_intent
      WHERE id = $1 AND principal_id = $2`, [supportId, principalId])).rows[0] ?? null;
  }

  private async evidence(principalId: string, input: AdoptSourceNativeChildInput) {
    const proposal = await this.proposals.read(principalId, id(input.proposal));
    if (!proposal) return null;
    if (proposal.conversion !== input.conversion) throw new NativeChildConflict('proposal/conversion pair differs');
    const verified = await this.conversions.verifiedRead(principalId, id(input.conversion));
    if (!verified || proposal.record !== verified.observation.record
      || proposal.observation !== verified.observation.observation) {
      throw new NativeChildUnavailable('source child evidence is unavailable');
    }
    const children = verified.conversion.projection.subjects;
    const child = children?.[input.sourceOrdinal];
    if (!children || child === undefined || child !== input.confirmedSourceKey
      || verified.conversion.fieldInventory.find(field => field.field === 'subjects')?.disposition !== 'source-terms'
      || sourceChildOccurrence(verified.observation.observation, 'subjects', input.sourceOrdinal)
        !== input.occurrence) {
      throw new NativeChildConflict('complete exact source child occurrence is required');
    }
    return { proposal, verified };
  }

  private async base(principalId: string, work: string,
    input: AdoptSourceNativeChildInput, record: string) {
    if (!input.baseSupport) {
      if (input.correspondence) throw new NativeChildConflict('initial occurrence has no correspondence');
      return { row: null, kind: 'initial' as const };
    }
    const row = await this.intent(principalId, id(input.baseSupport));
    if (!row || row.base_support_id || row.work !== work || row.field_key !== input.field
      || row.source_key !== input.confirmedSourceKey || row.native_ordinal !== input.nativeOrdinal) {
      throw new NativeChildConflict('base cannot rewrite a native child');
    }
    const baseEvidence = await this.evidence(principalId, row.request);
    if (!baseEvidence) throw new NativeChildUnavailable('base source evidence is missing');
    if (!await this.read(principalId, row.id)) throw new NativeChildUnavailable('base is not committed');
    if (url(row.record_id) !== record) {
      if (input.correspondence) throw new NativeChildConflict('cross-record correspondence is unsupported');
      return { row, kind: 'separate-source' as const };
    }
    const candidate = await this.proposals.read(principalId, id(input.proposal));
    if (!candidate || candidate.graphPosition.dataEpoch !== baseEvidence.proposal.graphPosition.dataEpoch
      || BigInt(candidate.graphPosition.sequence) <= BigInt(baseEvidence.proposal.graphPosition.sequence)) {
      throw new NativeChildConflict('candidate is not a later source proposal in this epoch');
    }
    const comparison = await compareSourceChildren(this.conversions, principalId,
      row.conversion_id, id(input.conversion));
    const assessed = comparison?.fields.find(field => field.field === input.field);
    const old = assessed?.base.find(child => child.occurrence === row.occurrence);
    const next = assessed?.candidate.find(child => child.occurrence === input.occurrence);
    if (assessed?.coverage !== 'complete' || !old || !next) {
      throw new NativeChildConflict('source child list is unavailable');
    }
    if (input.correspondence) {
      const decision = await this.correspondences.read(principalId, id(input.correspondence));
      if (!decision || decision.field !== input.field || decision.record !== record
        || decision.baseConversion !== url(row.conversion_id)
        || decision.candidateConversion !== input.conversion
        || decision.baseOccurrence !== row.occurrence
        || decision.candidateOccurrence !== input.occurrence) {
        throw new NativeChildConflict('explicit child correspondence differs');
      }
      return { row, kind: 'explicit' as const };
    }
    if (old.status !== 'matched' || next.status !== 'matched'
      || old.correspondence !== next.occurrence || next.correspondence !== old.occurrence) {
      throw new NativeChildConflict('reused child key needs explicit correspondence');
    }
    return { row, kind: 'unique-key' as const };
  }

  private async binding(client: PoolClient, principalId: string,
    work: string, record: string, proposal: string, refresh: boolean) {
    const original = (await client.query<{ record_id: string; proposal_id: string; withdrawn: boolean }>(`
      SELECT p.record_id, COALESCE(a.proposal_id,b.proposal_id) AS proposal_id,
        EXISTS (SELECT 1 FROM source.native_work_support_withdrawal w
          WHERE w.binding_id = b.id) AS withdrawn
      FROM source.native_work_binding b JOIN source.native_work_support_head h ON h.binding_id = b.id
      JOIN source.native_work_proposal p ON p.id = b.proposal_id
      LEFT JOIN source.native_work_title_application a ON a.id = h.application_id
      WHERE b.work = $1 AND b.principal_id = $2 FOR UPDATE OF h`, [work, principalId])).rows[0];
    if (!original) throw new NativeChildConflict('Work has no source binding');
    let selected = original;
    if (original.record_id !== record) {
      const attachment = (await client.query<typeof original>(`
        SELECT a.record_id,a.proposal_id,
          EXISTS (SELECT 1 FROM source.native_work_attachment_withdrawal w
            WHERE w.attachment_id = a.id) AS withdrawn
        FROM source.native_work_support_attachment a
        WHERE a.work = $1 AND a.principal_id = $2 AND a.record_id = $3 FOR UPDATE OF a`,
      [work, principalId, record])).rows[0];
      if (!attachment) throw new NativeChildConflict('SourceRecord is unrelated to Work');
      selected = attachment;
    }
    if (selected.withdrawn || (!refresh && selected.proposal_id !== proposal)) {
      throw new NativeChildConflict('source binding is withdrawn or proposal is stale');
    }
  }

  async adopt(principal: VerifiedPrincipal, principalId: string, request: Request,
    work: string, key: string, input: AdoptSourceNativeChildInput) {
    if (!UUID.test(principalId) || !KEY.test(key)) throw new NativeChildInvalid('invalid principal or key');
    const digest = nativeChildSupportDigest(work, input);
    const prior = (await this.pool.query<NativeChildIntentRow>(`SELECT * FROM source.native_child_intent
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
    if (prior && (prior.request_digest !== digest || prior.work !== work)) {
      throw new NativeChildConflict('child intent changed');
    }
    const evidence = await this.evidence(principalId, input);
    if (!evidence) return null;
    const base = await this.base(principalId, work, input, evidence.proposal.record);
    if (base.row && await this.isWithdrawn(base.row.id)) throw new NativeChildConflict('base support was withdrawn');
    if (base.row && (await readNativeChild(this.env, base.row.child, base.row.child_revision))?.state === 'retired') {
      throw new NativeChildConflict('native child was retired');
    }
    if (!prior) {
      const head = await this.env.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:head ${iri(input.expectedHead)} .
          FILTER NOT EXISTS { ${iri(work)} rv:protectionHead ?p } } }`);
      if (!head.boolean) throw new NativeChildConflict('Work head or protection changed');
    }
    const intentId = Bun.randomUUIDv7();
    const candidate: NativeChildValue = { work, field: input.field, sourceKey: input.confirmedSourceKey,
      nativeOrdinal: input.nativeOrdinal, expectedHead: input.expectedHead,
      actingSubject: input.actingSubject, sourceIntent: url(intentId),
      child: base.row?.child ?? url(Bun.randomUUIDv7()),
      revision: base.row?.child_revision ?? url(Bun.randomUUIDv7()) };
    nativeChildDigest(candidate);
    const client = await this.pool.connect();
    let row: NativeChildIntentRow;
    let inserted = false;
    try {
      row = await this.access.withWorkEditAuthority(principal, input.actingSubject, work, async proof => {
        if (proof.principalId !== principalId) throw new NativeChildConflict('Work authority principal differs');
        if (prior) return prior;
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout = '2s'");
          await client.query("SET LOCAL statement_timeout = '5s'");
          await this.binding(client, principalId, work, id(evidence.proposal.record),
            id(input.proposal), !!base.row && base.kind !== 'separate-source');
          const saved = await client.query(`INSERT INTO source.native_child_intent
            (id,principal_id,work,field_key,idempotency_key,request_digest,request,
             proposal_id,conversion_id,record_id,occurrence,source_ordinal,source_key,
             native_ordinal,correspondence_id,base_support_id,child,child_revision,authority_proof)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            ON CONFLICT DO NOTHING`,
          [intentId, principalId, work, input.field, key, digest, JSON.stringify(input),
            id(input.proposal), id(input.conversion), id(evidence.proposal.record),
            input.occurrence, input.sourceOrdinal, input.confirmedSourceKey,
            input.nativeOrdinal, input.correspondence ? id(input.correspondence) : null,
            base.row?.id ?? null, candidate.child, candidate.revision, JSON.stringify(proof)]);
          const selected = (await client.query<NativeChildIntentRow>(`SELECT * FROM source.native_child_intent
            WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
          if (!selected || selected.request_digest !== digest) {
            throw new NativeChildConflict('occurrence or child key is already reserved');
          }
          await client.query('COMMIT');
          inserted = saved.rowCount === 1;
          return selected;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          if (['23505', '23514', '55P03', '57014'].includes((error as { code?: string }).code ?? '')) {
            throw new NativeChildConflict('child source support changed concurrently');
          }
          throw error;
        }
      });
    } finally { client.release(); }
    let application = (await this.pool.query<ApplicationRow>(`SELECT * FROM source.native_child_application
      WHERE intent_id = $1`, [row.id])).rows[0];
    if (!application) {
      let receipt: NativeChildReceipt;
      if (base.row) {
        const origin = (await this.pool.query<ApplicationRow>(`SELECT * FROM source.native_child_application
          WHERE intent_id = $1`, [base.row.id])).rows[0];
        const checked = origin && await readNativeChildReceipt(this.env, origin.admission_id);
        if (!checked) throw new NativeChildUnavailable('original native receipt is unavailable');
        receipt = checked;
      } else {
        receipt = (await adoptNativeChild(this.env, this.account, this.access, request,
          nativeChildValue(row), `source-child-${row.id}`)).receipt;
      }
      await this.pool.query(`INSERT INTO source.native_child_application
        (intent_id,graph_receipt,admission_id,data_epoch,sequence)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [row.id, receipt.receipt, receipt.admissionId, receipt.dataEpoch, receipt.sequence]);
      application = (await this.pool.query<ApplicationRow>(`SELECT * FROM source.native_child_application
        WHERE intent_id = $1`, [row.id])).rows[0];
    }
    const support = await this.read(principalId, row.id);
    if (!application || !support) throw new NativeChildUnavailable('native child support did not complete');
    return { support, replayed: !inserted };
  }

  private async isWithdrawn(intentId: string): Promise<boolean> {
    return (await this.pool.query<{ withdrawn: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM source.native_child_withdrawal WHERE intent_id = $1) AS withdrawn`, [intentId]))
      .rows[0]?.withdrawn ?? false;
  }

  async read(principalId: string, supportId: string) {
    if (!UUID.test(principalId) || !UUID.test(supportId)) throw new NativeChildInvalid('invalid child support');
    const row = await this.intent(principalId, supportId);
    if (!row) return null;
    const application = (await this.pool.query<ApplicationRow>(`SELECT * FROM source.native_child_application
      WHERE intent_id = $1`, [row.id])).rows[0];
    if (!application) return null;
    const evidence = await this.evidence(principalId, row.request);
    if (!evidence) throw new NativeChildUnavailable('child source evidence is unavailable');
    const origin = row.base_support_id ? await this.intent(principalId, row.base_support_id) : row;
    if (!origin || origin.base_support_id) throw new NativeChildUnavailable('original child intent is unavailable');
    const proof = await readNativeChildReceipt(this.env, application.admission_id);
    const native = await readNativeChild(this.env, row.child, row.child_revision);
    if (!proof || !native || proof.receipt !== application.graph_receipt
      || proof.child !== row.child || proof.revision !== row.child_revision
      || proof.sourceIntent !== url(origin.id)
      || proof.requestDigest !== nativeChildDigest(nativeChildValue(origin))
      || proof.dataEpoch !== application.data_epoch || proof.sequence !== application.sequence
      || native.sourceKey !== row.source_key || native.nativeOrdinal !== row.native_ordinal
      || native.work !== row.work || native.field !== row.field_key) {
      throw new NativeChildUnavailable('native child certificate differs from retained evidence');
    }
    const withdrawal = (await this.pool.query<WithdrawalRow>(`SELECT * FROM source.native_child_withdrawal
      WHERE intent_id = $1`, [row.id])).rows[0];
    return { profile: 'source-native-child-support-v1',
      state: withdrawal ? 'withdrawn' : 'recorded', support: url(row.id), work: row.work,
      field: row.field_key, child: native, proposal: url(row.proposal_id),
      conversion: url(row.conversion_id), record: url(row.record_id),
      observation: evidence.verified.observation.observation,
      sourceOccurrence: row.occurrence, sourceOrdinal: row.source_ordinal,
      sourceKey: row.source_key, correspondence: row.correspondence_id ? url(row.correspondence_id) : null,
      baseSupport: row.base_support_id ? url(row.base_support_id) : null,
      nativeReceipt: proof.receipt, headGuarantee: row.base_support_id
        ? 'verified-before-commit' : 'transaction-guarded',
      rightsStatus: 'undetermined', withdrawal: withdrawal ? {
        withdrawal: url(withdrawal.id), reason: withdrawal.reason,
        createdAt: withdrawal.created_at.toISOString() } : null,
      createdAt: row.created_at.toISOString() };
  }

  async withdraw(principalId: string, key: string, supportId: string, reason: string) {
    if (!UUID.test(principalId) || !UUID.test(supportId) || !KEY.test(key)
      || !reason || reason.length > 500 || reason.trim() !== reason
      || /[\u0000-\u001f\u007f]/.test(reason)) throw new NativeChildInvalid('invalid child withdrawal');
    if (!await this.read(principalId, supportId)) return null;
    const inserted = await this.pool.query(`INSERT INTO source.native_child_withdrawal
      (id,intent_id,principal_id,idempotency_key,reason)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [Bun.randomUUIDv7(), supportId, principalId, key, reason]);
    const row = (await this.pool.query<WithdrawalRow>(`SELECT * FROM source.native_child_withdrawal
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
    if (!row || row.intent_id !== supportId || row.reason !== reason) {
      throw new NativeChildConflict('child withdrawal key differs');
    }
    return { support: await this.read(principalId, supportId), replayed: inserted.rowCount === 0 };
  }
}
