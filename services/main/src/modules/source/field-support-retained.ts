import type { Pool } from 'pg';
import type { SemanticProperty } from '../semantic/change.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { canonicalJson } from '../../../../../scripts/lib/canonical-json.ts';
import { canonicalDigest, sourceId, sourceIri } from './retained-record-normalization.ts';
import { verifyRetainedField, type RetainedEvidence, type VerifiedRetainedField } from './field-support-evidence.ts';
import { verifySourceNative, type SourceNativeVerifiers } from './field-support-native.ts';
import type { SourceRetainedRecordStore, RetainedFieldCustody } from './retained-record.ts';
import type { FieldSupportResult } from './withdrawal.ts';
import type { NativeFieldControlIntent } from './field-control-native.ts';
import { suppliedLanguage } from './field-control-language.ts';
import { currentWorkReadSession, WorkReadMoved, type WorkReadSession } from '../work/read-session.ts';
import type { PublicRetainedFieldEvidence, SourceRetainedRecordEvidenceOwner } from './retained-evidence.ts';
import { coordinateInvalid, sourceNotFound, supportChanged, supportUnavailable,
  type RetainedSupportRequest, type RetainedSupportAdmission, type FieldAttachmentCertificate,
  type VerifiedNativeAcknowledgement } from './field-support-contract.ts';

export type RetainedPublicEvidence = PublicRetainedFieldEvidence;
/** These functions are supplied by the existing rights/evidence owners. Their
 * absence is unavailable admission, never an implicit factual or expression grant. */
export interface RetainedFieldOwners extends SourceNativeVerifiers {
  authorizeReuse(principal: VerifiedPrincipal, actingSubject: string, evidence: RetainedFieldCustody,
    claimedSourceRecord?: string): Promise<void>;
  publicEvidence(evidence: RetainedEvidence, field: VerifiedRetainedField,
    input: RetainedSupportRequest, context?: { principal: VerifiedPrincipal | null }): Promise<RetainedPublicEvidence | null>;
}
export interface SourceEvidenceSelection {
  target: string; slot: string; occurrence: string | null; context: string;
  component: string; revision: string;
  /** Exact typed property, so evidence for another value of this predicate is excluded. */
  property?: SemanticProperty;
}
/** Owner-private frontier. The query owner seals it with its existing cursor;
 * neither this position nor private support identities are public citation data. */
export interface SourceEvidenceFrontier { generation: string; after: string }
export interface SourceEvidenceWindow {
  items: RetainedPublicEvidence[];
  generation: string; next: SourceEvidenceFrontier | null; more: boolean;
}
/** Server-owned support coordinates, including withheld physical positions.
 * A record can have several independent supports; its ID is never their ID. */
export interface SourceEvidenceSupport {
  support: string; supportIdentity: string; record: string;
  evidence: RetainedPublicEvidence | null;
}
export interface SourceEvidenceSupportWindow extends Omit<SourceEvidenceWindow, 'items'> {
  items: SourceEvidenceSupport[];
}
/** Compose the existing evidence and Rights owner without substituting import
 * authority for a public-read identity or inventing a SourceWork binding. */
export function retainedFieldEvidenceOwners(owner: Pick<SourceRetainedRecordEvidenceOwner,
  'authorizeRetainedFieldReuse' | 'projectPublicRetainedFieldForReader'>): Pick<RetainedFieldOwners,'authorizeReuse' | 'publicEvidence'> {
  return {
    authorizeReuse: async (principal,actor,custody,claimedSourceRecord = custody.sourceRecord) => {
      await owner.authorizeRetainedFieldReuse(principal,actor,claimedSourceRecord,custody.observations);
      if (claimedSourceRecord !== custody.sourceRecord) {
        await owner.authorizeRetainedFieldReuse(principal,actor,custody.sourceRecord,custody.observations);
      }
    },
    publicEvidence: (evidence,field,input,context) => {
      if (!context || field.correspondence.payloadPointers.length !== 1) return supportUnavailable();
      return owner.projectPublicRetainedFieldForReader({ principal: context.principal },evidence,
        field.correspondence.payloadPointers[0]!,suppliedLanguage(input.evidence.field));
    },
  };
}
export interface RetainedFieldSupportResult extends FieldSupportResult {
  admission: RetainedSupportAdmission; attachment: FieldAttachmentCertificate;
  publicEvidence: RetainedPublicEvidence | null;
}
interface SavedAttachment {
  support_id: string; step_id: string; request: RetainedSupportRequest; request_digest: string;
  retained_admission: RetainedSupportAdmission; native_acknowledgement: VerifiedNativeAcknowledgement;
  certificate: FieldAttachmentCertificate; created_at: Date;
  withdrawal_id: string | null; reason: string | null; withdrawn_at: Date | null;
}
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const DIGEST_DOMAIN = 'rezics:source-field-support-attachment:v2:canonical-json-sha256';
export function retainedAttachmentDigest(principalId: string, input: RetainedSupportRequest,
  admission: RetainedSupportAdmission, native: VerifiedNativeAcknowledgement): string {
  return canonicalDigest({ domain: DIGEST_DOMAIN, principalId,
    action: 'source.field-support.attach', scope: { target: input.target, slot: input.slot,
      occurrence: input.occurrence, context: input.context }, request: input,
    mapping: { revision: input.evidence.mappingRevision,
      normalization: admission.correspondence }, nativeAcknowledgement: native });
}
const savedSql = `SELECT s.id AS support_id,st.id AS step_id,a.request,a.request_digest,
  st.retained_admission,st.native_acknowledgement,a.certificate,a.created_at,
  w.id AS withdrawal_id,w.reason,w.created_at AS withdrawn_at
  FROM source.field_support s JOIN source.field_support_head h ON h.support_id=s.id
  JOIN source.field_support_step st ON st.support_id=s.id
  JOIN source.field_support_attachment a ON a.step_id=st.id AND a.principal_id=s.principal_id
  LEFT JOIN source.field_support_withdrawal w ON w.support_id=s.id
  WHERE s.id=$1 AND s.principal_id=$2 AND st.id=COALESCE($3::uuid,h.settled_step_id)`;

export class SourceRetainedFieldSupportStore {
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment,
    private readonly access: Pick<AccessAdmissionRegistry, 'withOwnerAuthority'>,
    private readonly conversions: SourceRetainedRecordStore, private readonly owners: Partial<RetainedFieldOwners> = {}) {}

  private async evidence(principalId: string, input: { sourceRecord: string; evidence: { binding: string } },
    authorize?: (custody: RetainedFieldCustody) => Promise<void>): Promise<RetainedEvidence> {
    const record = sourceId(input.sourceRecord), binding = sourceId(input.evidence.binding);
    if (!record || !binding) return coordinateInvalid();
    const custody = (await this.pool.query(`SELECT 1 FROM source.retained_record_binding
      WHERE principal_id=$1 AND record_id=$2 UNION ALL SELECT 1 FROM source.observation
      WHERE principal_id=$1 AND record_id=$2 LIMIT 1`, [principalId, record])).rowCount;
    if (!custody) return sourceNotFound();
    const row = (await this.pool.query<{ principal_id: string; conversion_id: string }>(
      'SELECT principal_id,conversion_id FROM source.retained_record_binding WHERE id=$1', [binding])).rows[0];
    if (!row) return supportUnavailable();
    if (row.principal_id !== principalId) return sourceNotFound();
    if (authorize) {
      const custody = await this.conversions.custody(principalId,row.conversion_id);
      if (!custody) return supportUnavailable();
      await authorize(custody);
    }
    const evidence = await this.conversions.evidence(principalId, row.conversion_id);
    if (!evidence) return supportUnavailable();
    return evidence;
  }

  /** Native editorial admission verifies lossless expression/language and real
   * reuse authority. It issues no Source support; attachment requires the later
   * native command's actual acknowledgement. */
  async admitSynopsis(principal: VerifiedPrincipal, principalId: string,
    intent: NativeFieldControlIntent & { actingSubject: string }): Promise<void> {
    if (intent.origin !== 'source' || !intent.source) return coordinateInvalid();
    const source = intent.source, conversion = sourceId(source.conversion);
    if (!conversion) return coordinateInvalid();
    const row = (await this.pool.query<{ id: string }>(
      'SELECT id FROM source.retained_record_binding WHERE conversion_id=$1 AND principal_id=$2',
      [conversion,principalId])).rows[0];
    if (!row) return sourceNotFound();
    const evidence = await this.evidence(principalId,{ sourceRecord: source.record,
      evidence: { binding: sourceIri(row.id) } },async custody => {
      if (!this.owners.authorizeReuse) return supportUnavailable();
      await this.owners.authorizeReuse(principal,intent.actingSubject,custody,source.record);
    });
    const binding = evidence.conversion.retainedRecord;
    if (source.record !== binding.sourceRecord) return supportChanged('record');
    if (source.mapping !== binding.mappingRevision || source.observation !== binding.intakes[0]?.observation) {
      return supportChanged('conversion');
    }
    const plan = evidence.fieldPlan;
    if (!plan) return supportUnavailable();
    const candidate = plan.fields.find(field => field.role === 'description' && field.disposition === 'candidate'
      && field.native?.owner === 'work-editorial'
      && (field.native.property?.value.kind === 'string' || field.native.property?.value.kind === 'language-string')
      && field.native.property.value.lexical === intent.value
      && canonicalJson(suppliedLanguage(field.evidence[0]!)) === canonicalJson(intent.language ?? { state: 'omitted' }));
    if (!candidate) return supportChanged('native-value');
  }

  async attach(principal: VerifiedPrincipal, principalId: string, key: string, raw: RetainedSupportRequest,
    session = currentWorkReadSession()):
    Promise<{ support: string; replayed: boolean; step: string }> {
    if (!sourceId(principalId) || !KEY.test(key) || raw.profile !== 'source-field-support-attachment-v2'
      || raw.slot.length < 1 || raw.slot.length > 512
      || ![raw.target,raw.expectedHead,raw.actingSubject].every(value => sourceId(value))) return coordinateInvalid();
    const input: RetainedSupportRequest = JSON.parse(canonicalJson(raw));
    const evidence = await this.evidence(principalId, input, async custody => {
      if (!this.owners.authorizeReuse) return supportUnavailable();
      await this.owners.authorizeReuse(principal,input.actingSubject,custody,input.sourceRecord);
    });
    const field = await verifyRetainedField(input, evidence);
    const admission: RetainedSupportAdmission = { profile: 'source-field-support-admission-v1',
      sourceRecord: input.sourceRecord, conversion: input.conversion, evidence: input.evidence,
      correspondence: field.correspondence, native: input.native, headGuarantee: 'verified-before-commit' };
    // Exact replays use the persisted native acknowledgement, so moving a native
    // head cannot turn a committed operation into a new write or a new receipt.
    const prior = (await this.pool.query<{ support_id: string; step_id: string; request: RetainedSupportRequest }>(`
      SELECT st.support_id,st.id AS step_id,a.request FROM source.field_support_step st
      JOIN source.field_support_attachment a ON a.step_id=st.id
      WHERE st.principal_id=$1 AND st.idempotency_key=$2`, [principalId,key])).rows[0];
    if (prior) {
      if (canonicalJson(prior.request) !== canonicalJson(input)) return supportChanged('conversion');
      const saved = await this.read(principalId, prior.support_id, prior.step_id, principal, session);
      if (!saved) return supportUnavailable();
      return { support: saved.support, replayed: true, step: sourceIri(prior.step_id) };
    }
    if (input.native.kind === 'structure-occurrence'
      && (!session || currentWorkReadSession() !== session || session.options.actingSubject !== input.actingSubject)) {
      return supportUnavailable();
    }
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const native = await verifySourceNative(this.env, input, this.owners,true,{ principal,selected: field.selected,session,evidence });
    const requestDigest = retainedAttachmentDigest(principalId,input,admission,native);
    return this.access.withOwnerAuthority({ principal, actingSubject: input.actingSubject,
      scope: native.scope, action: native.action }, async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='2s'");
        await client.query("SET LOCAL statement_timeout='5s'");
        const supportId = Bun.randomUUIDv7();
        await client.query(`INSERT INTO source.field_support(id,principal_id,target,slot,occurrence,context,record_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [supportId,principalId,input.target,input.slot,input.occurrence,input.context,sourceId(input.sourceRecord)]);
        const head = (await client.query<{ id: string; step_count: number; pending_step_id: string | null }>(`
          SELECT s.id,h.step_count,h.pending_step_id FROM source.field_support s
          JOIN source.field_support_head h ON h.support_id=s.id
          WHERE s.principal_id=$1 AND s.target=$2 AND s.slot=$3
            AND s.occurrence IS NOT DISTINCT FROM $4 AND s.context=$5 AND s.record_id=$6 FOR UPDATE OF h`,
        [principalId,input.target,input.slot,input.occurrence,input.context,sourceId(input.sourceRecord)])).rows[0];
        if (!head) return supportUnavailable();
        const raced = (await client.query<{ support_id: string; id: string; request_digest: string }>(`
          SELECT support_id,id,request_digest FROM source.field_support_step
          WHERE principal_id=$1 AND idempotency_key=$2`, [principalId,key])).rows[0];
        if (raced) {
          if (raced.request_digest !== requestDigest || raced.support_id !== head.id) return supportChanged('conversion');
          await client.query('COMMIT');
          return { support: sourceIri(head.id), replayed: true, step: sourceIri(raced.id) };
        }
        if (head.pending_step_id) return supportUnavailable();
        if ((await client.query('SELECT 1 FROM source.field_support_withdrawal WHERE support_id=$1', [head.id])).rowCount) {
          return supportChanged('native-head');
        }
        const stepId = Bun.randomUUIDv7();
        // Source mints and persists its own settlement receipt, independently of
        // support/component/revision identities and the acknowledged native receipt.
        const receipt = `urn:rezics:receipt:${canonicalDigest({ domain: 'source-settlement-v2', nonce: Bun.randomUUIDv7() })}`;
        const certificate: FieldAttachmentCertificate = { profile: 'source-field-attachment-certificate-v1',
          receipt, requestDigest, nativeReceipt: native.receipt };
        await client.query(`INSERT INTO source.field_support_step
          (id,support_id,ordinal,principal_id,action,conversion_id,mapping_revision,grain,source_field,
            source_occurrence,value_digest,expected_head,acting_subject,authority_proof,idempotency_key,
            request_digest,retained_binding_id,retained_admission,native_acknowledgement)
          VALUES ($1,$2,$3,$4,'attach',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [stepId,head.id,head.step_count+1,principalId,sourceId(input.conversion),input.evidence.mappingRevision,
          input.grain,input.sourceField,input.sourceOccurrence,input.evidence.field.valueDigest,input.expectedHead,
          input.actingSubject,JSON.stringify({ principalId,actingSubject: input.actingSubject,
            scope: native.scope, action: native.action }),key,requestDigest,sourceId(input.evidence.binding),
          JSON.stringify(admission),JSON.stringify(native)]);
        await client.query(`INSERT INTO source.field_support_outcome
          (step_id,outcome,native_revision,graph_receipt,admission_id,data_epoch,sequence,head_guarantee,receipt,attachment_profile)
          VALUES ($1,'attached',$2,$3,$4,$5,$6,'verified-before-commit',$7,'source-field-support-attachment-v2')`,
        [stepId,native.revision,native.receipt,native.admissionId,native.dataEpoch,native.sequence,JSON.stringify(certificate)]);
        await client.query(`INSERT INTO source.field_support_attachment
          (step_id,principal_id,receipt,request_digest,request,certificate) VALUES ($1,$2,$3,$4,$5,$6)`,
        [stepId,principalId,receipt,requestDigest,JSON.stringify(input),JSON.stringify(certificate)]);
        if (input.native.kind === 'structure-occurrence') {
          if (!session || currentWorkReadSession() !== session) return supportUnavailable();
          // Recheck custody/reuse while the owner-authority transaction surrounds settlement.
          await this.evidence(principalId,input,async custody => {
            if (!this.owners.authorizeReuse) return supportUnavailable();
            await this.owners.authorizeReuse(principal,input.actingSubject,custody,input.sourceRecord);
          });
          await session.fenceDependencies();
          await session.fenceAuthority();
          session.checkDeadline();
        }
        await client.query('COMMIT');
        return { support: sourceIri(head.id), replayed: false, step: sourceIri(stepId) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (['23505','23514','55P03','57014'].includes((error as { code?: string }).code ?? '')) return supportChanged('conversion');
        throw error;
      } finally { client.release(); }
    });
  }

  async read(principalId: string, support: string, step?: string,
    principal?: VerifiedPrincipal, session = currentWorkReadSession()): Promise<RetainedFieldSupportResult | null> {
    return this.readProjection(principalId,support,step,principal,session,'direct');
  }

  private async readProjection(principalId: string, support: string, step: string | undefined,
    principal: VerifiedPrincipal | undefined, session: WorkReadSession | undefined,
    mode: 'direct' | 'window'): Promise<RetainedFieldSupportResult | null> {
    const id = sourceId(support), stepId = step === undefined ? null : sourceId(step);
    if (!sourceId(principalId) || !id || (step !== undefined && !stepId)) return coordinateInvalid();
    const row = (await this.pool.query<SavedAttachment>(savedSql,[id,principalId,stepId])).rows[0];
    if (!row) return null;
    const input = row.request, admission = row.retained_admission;
    const evidence = await this.evidence(principalId,input);
    const field = await verifyRetainedField(input,evidence);
    if (canonicalJson(field.correspondence) !== canonicalJson(admission.correspondence)
      || retainedAttachmentDigest(principalId,input,admission,row.native_acknowledgement) !== row.request_digest
      || row.certificate.requestDigest !== row.request_digest
      || row.certificate.nativeReceipt !== input.native.receipt) return supportUnavailable();
    // The immutable Source settlement retains the verified acknowledgement.
    // Historical receipt custody does not require the native head to stay current.
    let publicEvidence: RetainedPublicEvidence | null = null;
    const structure = input.native.kind === 'structure-occurrence';
    if (!row.withdrawal_id && (!structure || session?.principal && session.options.actingSubject)) {
      try {
        const current = mode === 'window' && session && input.native.kind === 'component-property'
          && input.native.owner === 'semantic' && this.owners.semanticRead
          ? await this.owners.semanticRead(input,field.selected,session)
          : await verifySourceNative(this.env,input,this.owners,true,
            principal ? { principal,selected: field.selected,session,evidence } : undefined);
        if (canonicalJson(current) === canonicalJson(row.native_acknowledgement)) {
          if (!this.owners.publicEvidence) return supportUnavailable();
          publicEvidence = await this.owners.publicEvidence(evidence,field,input,{ principal: principal ?? null });
          if (structure && session) {
            session.observeDependency(`source-structure-support:${id}:${row.step_id}`,row,
              async () => (await this.pool.query<SavedAttachment>(savedSql,[id,principalId,stepId])).rows[0]);
            session.observeDependency(`source-structure-rights:${id}:${row.step_id}`,publicEvidence,async () => {
              if (!this.owners.publicEvidence) return supportUnavailable();
              return this.owners.publicEvidence(await this.evidence(principalId,input),field,input,
                { principal: principal ?? null });
            });
            // A window projection is itself an owner-dependency reread. It
            // registers these checks on the same session; only its enclosing
            // reader may run the final fence without reentering that window.
            if (mode === 'direct') {
              await session.fenceDependencies();
              await session.fenceAuthority();
            }
            session.checkDeadline();
          }
        }
      } catch (error) {
        // A stale native head is historical custody, not current public evidence.
        if (!(error instanceof Error && 'code' in error && error.code === 'source_support_changed')) throw error;
      }
    }
    const supportIdentity = sourceIri(row.step_id), supportIri = sourceIri(row.support_id);
    return { profile: 'source-field-support-v1',state: row.withdrawal_id ? 'withdrawn' : 'recorded',
      support: supportIri,supportIdentity,target: input.target,slot: input.slot,occurrence: input.occurrence,
      context: input.context,sourceRecord: input.sourceRecord,conversion: input.conversion,
      mappingRevision: input.evidence.mappingRevision,grain: input.grain,sourceField: input.sourceField,
      sourceOccurrence: input.sourceOccurrence,valueDigest: input.evidence.field.valueDigest!,
      nativeRevision: input.native.revision,graphReceipt: input.native.receipt,headGuarantee: admission.headGuarantee,
      outcome: 'attached',createdAt: row.created_at.toISOString(),admission,attachment: row.certificate,publicEvidence,
      withdrawal: row.withdrawal_id && row.withdrawn_at ? { profile: 'source-field-withdrawal-v1',state: 'withdrawn',
        withdrawal: sourceIri(row.withdrawal_id),support: supportIri,supportIdentity,reason: row.reason!,
        createdAt: row.withdrawn_at.toISOString(),nativeEffect: 'none' } : null };
  }

  async evidenceGeneration(selection: Pick<SourceEvidenceSelection,'target' | 'slot' | 'occurrence' | 'context'>): Promise<string> {
    const row = (await this.pool.query<{ generation: string }>(
      `SELECT generation::text FROM source.field_support_generation
       WHERE target=$1 AND slot=$2 AND occurrence IS NOT DISTINCT FROM $3 AND context=$4`,
      [selection.target,selection.slot,selection.occurrence,selection.context])).rows[0];
    if (row && !/^[1-9][0-9]{0,18}$/.test(row.generation)) return supportUnavailable();
    return row?.generation ?? '0';
  }

  /** One bounded physical frontier, including withheld records. The existing
   * Work session accounts for native/evidence reads and rechecks this selected
   * Source dependency at its final fence. There is no independent read budget. */
  async readEvidenceWindow(session: WorkReadSession, selection: SourceEvidenceSelection,
    frontier?: SourceEvidenceFrontier, limit = 16): Promise<SourceEvidenceWindow> {
    return this.evidenceWindow(session, selection, frontier, limit,
      support => support.publicEvidence ?? undefined, 'public');
  }

  /** The same current native/Source/Rights reader, retaining actual independent
   * support and settled-step identities for the association evidence adapter. */
  async readEvidenceSupportWindow(session: WorkReadSession, selection: SourceEvidenceSelection,
    frontier?: SourceEvidenceFrontier, limit = 16): Promise<SourceEvidenceSupportWindow> {
    return this.evidenceWindow(session, selection, frontier, limit, support => ({
      support: support.support, supportIdentity: support.supportIdentity,
      record: support.sourceRecord, evidence: support.publicEvidence,
    }), 'supports');
  }

  private async evidenceWindow<T>(session: WorkReadSession, selection: SourceEvidenceSelection,
    frontier: SourceEvidenceFrontier | undefined, limit: number,
    project: (support: RetainedFieldSupportResult) => T | undefined, projection: string):
    Promise<{ items: T[]; generation: string; next: SourceEvidenceFrontier | null; more: boolean }> {
    if (currentWorkReadSession() !== session) return supportUnavailable();
    if (!sourceId(selection.target) || !sourceId(selection.revision)
      || !selection.component || selection.component.length > 200
      || selection.slot.length < 1 || selection.slot.length > 512
      || selection.context.length < 1 || selection.context.length > 2048
      || selection.occurrence !== null && !sourceId(selection.occurrence)
      || !Number.isInteger(limit) || limit < 1 || limit > 16
      || frontier && (!sourceId(frontier.after) || !/^(0|[1-9][0-9]{0,18})$/.test(frontier.generation))) {
      return coordinateInvalid();
    }
    const generation = frontier?.generation ?? await this.evidenceGeneration(selection);
    const load = async () => {
      if (await this.evidenceGeneration(selection) !== generation) throw new WorkReadMoved('Source support position changed');
      const rows = (await this.pool.query<{ id: string; principal_id: string }>(`
        SELECT s.id,s.principal_id FROM source.field_support s
        JOIN source.field_support_head h ON h.support_id=s.id
        JOIN source.field_support_step st ON st.id=h.settled_step_id
        JOIN source.field_support_attachment a ON a.step_id=st.id
        WHERE s.target=$1 AND s.slot=$2 AND s.occurrence IS NOT DISTINCT FROM $3 AND s.context=$4
          AND st.native_acknowledgement->>'component'=$5 AND st.native_acknowledgement->>'revision'=$6
          AND ($7::uuid IS NULL OR s.id>$7::uuid)
          AND ($9::jsonb IS NULL OR a.request#>'{native,property}'=$9::jsonb)
        ORDER BY s.id LIMIT $8`, [selection.target,selection.slot,selection.occurrence,selection.context,
        selection.component,selection.revision,frontier ? sourceId(frontier.after) : null,limit+1,
        selection.property ? JSON.stringify(selection.property) : null])).rows;
      const items: T[] = [];
      for (const row of rows.slice(0,limit)) {
        const support = await this.readProjection(row.principal_id,row.id,undefined,session.principal ?? undefined,session,'window');
        if (!support) return supportUnavailable();
        const selected = project(support);
        if (selected !== undefined) items.push(selected);
      }
      if (await this.evidenceGeneration(selection) !== generation) throw new WorkReadMoved('Source support position changed');
      const more = rows.length > limit, last = rows[Math.min(rows.length,limit)-1];
      return { items,generation,more,next: more && last ? { generation,after: sourceIri(last.id) } : null };
    };
    // The full current evidence projection is fenced, including rights changes
    // that do not themselves settle or withdraw a Source support.
    let result: Awaited<ReturnType<typeof load>> | undefined;
    await session.dependency(`source-field-evidence:${canonicalDigest({ selection,frontier: frontier ?? null,limit,projection })}`,
      async () => (result = await load()));
    return result!;
  }
}
