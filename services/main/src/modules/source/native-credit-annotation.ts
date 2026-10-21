import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { canonicalJson } from '../../../../../scripts/lib/canonical-json.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { RelationAttributionOwner, RelationAttributionProof } from '../relation/attribution.ts';
import { projectRetainedAssociationCitation } from '../relation/evidence-citation.ts';
import type { AssociationCitation } from '../relation/evidence-contract.ts';
import type { AttributedParticipation } from '../relation/v2-schema.ts';
import type { RetainedCreditOriginLoaders } from '../work/credit-association-origin.ts';
import type { Participation } from '../relation/schema.ts';
import { RightsDenied, type RightsStore } from '../rights/store.ts';
import type { VerifiedExportMember } from '../export/planner.ts';
import { captureDisclosure, fenceDisclosure, resolveDisclosureSelections } from '../disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../suitability/policy.ts';
import { hash, type WorkActivationEnvironment } from '../work/activate.ts';
import { creditOwnerGuard, creditOwnerParticipant } from '../work/credit-attribution.ts';
import type { CreditAttributionField, CreditAttributionSupport } from '../work/credit-association-state.ts';
import { readCreditOwnerHead, readCreditOwnerWitness, type CreditOwnerWitness } from '../work/credit-verification.ts';
import { currentWorkReadSession } from '../work/read-session.ts';
import { readCurrentSourceObservation } from './cover-evidence.ts';
import { coordinateInvalid, sourceNotFound, supportChanged, supportUnavailable, SourceFieldProblem, type SuppliedLanguage } from './field-support-contract.ts';
import { retainedValueAt } from './field-support-evidence.ts';
import type { SourceIntakeStore, StagedSourceObservation } from './intake.ts';
import { nativeCreditAnnotationRequest } from './native-credit-annotation-schema.ts';
import { canonicalDigest, sourceId, sourceIri } from './retained-record-normalization.ts';

export interface NativeCreditAnnotationRequest {
  profile: 'source-native-credit-annotation-v1'; actingSubject: string; expectedAnnotation: string | null;
  native: { work: string; workHead: string; credit: string; revision: string; receipt: string;
    participation: Pick<Participation, 'role' | 'participant' | 'position'> };
  field: CreditAttributionField;
  selected: { presence: 'value' | 'null' | 'empty-string'; value: string | null; language: SuppliedLanguage };
  source: { record: string; observation: string; byteDigest: string; recordDigest: string;
    pointer: string; valueDigest: string; languagePointer?: string };
}
export interface NativeCreditAnnotationResult {
  profile: 'source-native-credit-annotation-v1'; support: string; state: 'recorded' | 'withdrawn' | 'superseded';
  receipt: string; requestDigest: string; request: NativeCreditAnnotationRequest; createdAt: string;
  headGuarantee: 'verified-before-commit'; nativeEffect: 'none';
}
interface Saved {
  id: string; principal_id: string; request: NativeCreditAnnotationRequest; request_digest: string;
  native_witness: CreditOwnerWitness; receipt: string; created_at: Date; withdrawn: boolean; current: boolean;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const savedSql = `SELECT a.*,w.id IS NOT NULL AS withdrawn,h.head=a.id AS current
  FROM source.native_credit_annotation a
  JOIN source.native_credit_annotation_head h ON h.principal_id=a.principal_id AND h.slot_digest=a.slot_digest
  LEFT JOIN source.native_credit_annotation_withdrawal w ON w.annotation_id=a.id`;
const result = (row: Saved): NativeCreditAnnotationResult => ({ profile: 'source-native-credit-annotation-v1',
  support: sourceIri(row.id), state: row.withdrawn ? 'withdrawn' : row.current ? 'recorded' : 'superseded',
  receipt: row.receipt, requestDigest: row.request_digest, request: row.request,
  createdAt: row.created_at.toISOString(), headGuarantee: 'verified-before-commit', nativeEffect: 'none' });

/** Independent annotation of an existing credit. Source supplies only the named
 * participant field; identity, role, ordinal and command receipt remain native. */
export class SourceNativeCreditAnnotationStore {
  constructor(private readonly pool: Pool, private readonly intake: Pick<SourceIntakeStore, 'read'>,
    private readonly environment: WorkActivationEnvironment,
    private readonly access: Pick<AccessAdmissionRegistry, 'withWorkEditAuthority' | 'activePrincipalId'>,
    private readonly rights: Pick<RightsStore, 'retainedFieldReusePermitted' | 'exportScope'>) {}

  private async native(input: NativeCreditAnnotationRequest) {
    const witness = await readCreditOwnerWitness(this.environment, input.native.credit);
    const head = witness && await readCreditOwnerHead(this.environment, witness);
    const value = witness?.value, selected = input.native;
    if (!witness || !head || !value) return sourceNotFound();
    if (value.work !== selected.work || value.revision !== selected.revision
      || head.workHead !== selected.workHead || head.creditHead !== selected.revision
      || witness.receipt.receipt !== selected.receipt
      || value.role !== selected.participation.role
      || !same(creditOwnerParticipant(witness), selected.participation.participant)
      || selected.participation.position !== (value.agent ? undefined : value.nativeOrdinal)) return supportChanged('native-target');
    return { witness, head };
  }

  private async evidence(principalId: string, input: NativeCreditAnnotationRequest) {
    const observation = await readCurrentSourceObservation(this.pool, this.intake, principalId, input.source.observation);
    if (!observation) return sourceNotFound();
    // Check reuse before exposing any private coordinate mismatch.
    if (!await this.rights.retainedFieldReusePermitted(observation.record, [observation])) {
      throw new RightsDenied('Source field reuse is restricted');
    }
    if (observation.record !== input.source.record || observation.retention !== 'retained'
      || observation.mediaType !== 'application/json' || !observation.rawBytesBase64
      || observation.byteDigest !== input.source.byteDigest) return supportChanged('source-observation');
    const bytes = Buffer.from(observation.rawBytesBase64, 'base64');
    if (hash(bytes) !== input.source.byteDigest || bytes.length !== observation.byteLength) return supportUnavailable();
    let record: unknown;
    try { record = JSON.parse(bytes.toString('utf8')); } catch { return coordinateInvalid(); }
    if (canonicalDigest(record) !== input.source.recordDigest) return supportChanged('record-digest');
    const selected = retainedValueAt(record, input.source.pointer);
    if (!selected.present || !same(selected.value, input.selected.value)
      || canonicalDigest(selected.value) !== input.source.valueDigest) return supportChanged('source-field');
    const presence = selected.value === null ? 'null' : selected.value === '' ? 'empty-string' : 'value';
    if (presence !== input.selected.presence) return supportChanged('source-presence');
    const language = input.selected.language;
    if (language.state === 'omitted') {
      if (input.source.languagePointer !== undefined) return coordinateInvalid();
    } else {
      if (!input.source.languagePointer) return coordinateInvalid();
      const supplied = retainedValueAt(record, input.source.languagePointer);
      if (!supplied.present || supplied.value !== (language.state === 'null' ? null : language.value)) return supportChanged('source-language');
    }
    if (input.field !== 'creditedName' && language.state !== 'omitted') return coordinateInvalid();
    if (input.field === 'creditedName' && typeof input.selected.value !== 'string') return coordinateInvalid();
    const part = input.native.participation.participant;
    if (['provider', 'namespace', 'key'].includes(input.field)
      && (part.kind !== 'external' || part[input.field as 'provider' | 'namespace' | 'key'] !== selected.value)) {
      return supportChanged('native-participant');
    }
    return observation;
  }

  async attach(principal: VerifiedPrincipal, principalId: string, key: string, raw: NativeCreditAnnotationRequest) {
    if (!sourceId(principalId) || !key || key.length > 200 || /[\x00-\x1f\x7f]/.test(key)
      || !Value.Check(nativeCreditAnnotationRequest as never, raw)) return coordinateInvalid();
    const input: NativeCreditAnnotationRequest = JSON.parse(canonicalJson(raw));
    await this.access.withWorkEditAuthority(principal, input.actingSubject, input.native.work, async proof => {
      if (proof.principalId !== principalId) return sourceNotFound();
    });
    const replay = (await this.pool.query<Saved>(`${savedSql} WHERE a.principal_id=$1 AND a.idempotency_key=$2`, [principalId, key])).rows[0];
    if (replay && !same(replay.request, input)) return supportChanged('idempotency-key');
    if (replay) return this.access.withWorkEditAuthority(principal, input.actingSubject, input.native.work, async proof => {
      if (proof.principalId !== principalId) return sourceNotFound();
      return { support: result(replay), replayed: true };
    });
    const native = await this.native(input);
    await this.evidence(principalId, input);
    // This is the same honest cross-store guarantee as existing Source field
    // attachments: native heads are verified before the short SQL settlement.
    const finalNative = await this.native(input);
    if (!same(finalNative, native)) return supportChanged('native-target');
    // Work-head movement must not create a second independently writable slot.
    const slot = canonicalDigest({ credit: input.native.credit, revision: input.native.revision,
      participation: input.native.participation, field: input.field });
    const requestDigest = canonicalDigest({ principalId, input, witness: native.witness });
    return this.access.withWorkEditAuthority(principal, input.actingSubject, input.native.work, async authority => {
      if (authority.principalId !== principalId) return sourceNotFound();
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`native-credit-annotation:${principalId}:${key}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`native-credit-annotation-slot:${principalId}:${slot}`]);
        const prior = (await client.query<Saved>(`${savedSql} WHERE a.principal_id=$1 AND a.idempotency_key=$2`, [principalId, key])).rows[0];
        if (prior) {
          if (!same(prior.request, input)) return supportChanged('idempotency-key');
          await client.query('COMMIT'); return { support: result(prior), replayed: true };
        }
        const head = (await client.query<{ head: string }>(`SELECT head FROM source.native_credit_annotation_head
          WHERE principal_id=$1 AND slot_digest=$2 FOR UPDATE`, [principalId, slot])).rows[0]?.head ?? null;
        if (head !== (input.expectedAnnotation === null ? null : sourceId(input.expectedAnnotation))) return supportChanged('annotation-head');
        await this.fenceObservation(client, principalId, input);
        const annotation = randomUUID(), receipt = `urn:rezics:receipt:${hash(`source-native-credit-annotation-v1:${annotation}:${requestDigest}`)}`;
        await client.query(`INSERT INTO source.native_credit_annotation
          (id,principal_id,idempotency_key,slot_digest,request_digest,request,native_witness,authority,receipt,observation_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [annotation, principalId, key, slot, requestDigest,
          JSON.stringify(input), JSON.stringify(native.witness), JSON.stringify(authority), receipt, sourceId(input.source.observation)]);
        await client.query(`INSERT INTO source.native_credit_annotation_head (principal_id,slot_digest,head) VALUES ($1,$2,$3)
          ON CONFLICT (principal_id,slot_digest) DO UPDATE SET head=EXCLUDED.head`, [principalId, slot, annotation]);
        const saved = (await client.query<Saved>(`${savedSql} WHERE a.id=$1`, [annotation])).rows[0];
        if (!saved) return supportUnavailable();
        await client.query('COMMIT'); return { support: result(saved), replayed: false };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  }

  private async fenceObservation(client: PoolClient, principalId: string, input: NativeCreditAnnotationRequest) {
    const observation = (await client.query<{ byte_digest: string; erased: boolean }>(`SELECT byte_digest,
      source_erasure_id IS NOT NULL AS erased FROM source.observation WHERE id=$1 AND principal_id=$2 FOR SHARE`,
    [sourceId(input.source.observation), principalId])).rows[0];
    const disposition = (await client.query<{ state: string }>(`SELECT d.state FROM verification.observation_disposition_head h
      JOIN verification.observation_disposition d ON d.id=h.head WHERE h.observation_id=$1 FOR SHARE OF h`,
    [sourceId(input.source.observation)])).rows[0];
    if (!observation || observation.erased || observation.byte_digest !== input.source.byteDigest
      || disposition && disposition.state !== 'available') return sourceNotFound();
  }

  async read(principalId: string, support: string): Promise<NativeCreditAnnotationResult | null> {
    const annotation = sourceId(support);
    if (!sourceId(principalId) || !annotation) return null;
    const row = (await this.pool.query<Saved>(`${savedSql} WHERE a.id=$1 AND a.principal_id=$2`, [annotation, principalId])).rows[0];
    return row ? result(row) : null;
  }

  async withdraw(principalId: string, key: string, input: { support: string; expectedSupport: string; reason: string }) {
    const annotation = sourceId(input.support);
    if (!sourceId(principalId) || !annotation || !key || key.length > 200 || !input.reason || input.reason.length > 500) return coordinateInvalid();
    if (input.expectedSupport !== input.support) return supportChanged('annotation-head');
    const digest = canonicalDigest(input), client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`native-credit-withdrawal:${principalId}:${key}`]);
      const row = (await client.query<Saved>(`${savedSql} WHERE a.id=$1 AND a.principal_id=$2 FOR UPDATE OF h`, [annotation, principalId])).rows[0];
      if (!row) { await client.query('COMMIT'); return null; }
      const replay = (await client.query<{ request_digest: string }>(`SELECT request_digest FROM source.native_credit_annotation_withdrawal
        WHERE principal_id=$1 AND idempotency_key=$2`, [principalId, key])).rows[0];
      if (replay) {
        if (replay.request_digest !== digest) return supportChanged('idempotency-key');
        await client.query('COMMIT'); return { support: result(row), replayed: true };
      }
      if (row.withdrawn || !row.current) return supportChanged('annotation-head');
      const withdrawal = randomUUID(), receipt = `urn:rezics:receipt:${hash(`source-native-credit-withdrawal-v1:${withdrawal}:${digest}`)}`;
      await client.query(`INSERT INTO source.native_credit_annotation_withdrawal
        (id,annotation_id,principal_id,idempotency_key,reason,request_digest,receipt) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [withdrawal, annotation, principalId, key, input.reason, digest, receipt]);
      await client.query('COMMIT'); return { support: result({ ...row, withdrawn: true }), replayed: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  private field(input: NativeCreditAnnotationRequest) {
    if (input.field !== 'creditedName') return input.selected.value;
    const language = input.selected.language;
    // Existing attributed-participation contract requires its explicit nullable language.
    return { lexical: input.selected.value, language: language.state === 'value' ? language.value : null };
  }

  /** No invented principal: public readers must pass real Source disclosure and
   * quotation Rights. Private custody does not make an optional alias public. */
  private async publicEvidence(row: Saved, observation: StagedSourceObservation) {
    const target = { owner: 'source' as const, resource: observation.record, component: 'record' as const, revision: observation.observation };
    const selections = await resolveDisclosureSelections(this.environment, [target]);
    const cuts = await captureDisclosure(this.environment, selections, ANONYMOUS_VIEWER, 'read');
    if (cuts.some(cut => cut.decision !== 'visible')) return null;
    const member: VerifiedExportMember = { sourceOwner: 'source', sourceNamespace: observation.namespace,
      sourceGrain: 'source_observation', exactRef: observation.observation, contentRevisionId: null,
      refDigest: observation.byteDigest!, ownerDataEpoch: 'source-observation-v1', ownerSequence: '0',
      sourcePosition: null, targetGrain: 'evidence', mapping: 'exact', data: { rightsIdentity: {
        material: { scopeKind: 'source_record', provider: null, namespace: null, sourceRecordId: sourceId(observation.record),
          contentVariantId: null, mediaAsset: null, component: 'record' }, target,
      } } };
    const rights = await this.rights.exportScope([member], 'quotation');
    if (rights.length !== 1 || !same(rights[0]!.memberOrdinals, [1]) || rights[0]!.result !== 'supported'
      || rights[0]!.obligations.includes('access_restriction')) return null;
    if ((await fenceDisclosure(this.environment, cuts, ANONYMOUS_VIEWER, 'read')).some(value => value !== 'visible')) return null;
    return { annotation: row.id, receipt: row.receipt, source: observation, rights: rights[0] };
  }

  async proof(participation: Participation, support: CreditAttributionSupport): Promise<RelationAttributionProof | null> {
    try { return await this.readProof(participation, support); }
    catch (error) {
      // Refused optional evidence does not retract the independently proved native core.
      if (error instanceof RightsDenied || error instanceof SourceFieldProblem && [403, 404, 409].includes(error.status)) return null;
      throw error;
    }
  }

  /** The annotation remains the citation identity. Its retained Source record,
   * exact bytes, supplied language and current public reuse remain Source-owned. */
  async citations(participation: AttributedParticipation, support: CreditAttributionSupport): Promise<Array<{
    id: string; citation: AssociationCitation | null;
  }>> {
    const proof = await this.proof(participation, support);
    const supported = proof?.state === 'current' && support.fields.every(field => same(proof.fields[field],
      field === 'creditedName' ? participation.creditedName : participation.sourceIdentity?.[field]));
    return Promise.all(support.evidence.map(async id => {
      if (!supported) return { id, citation: null };
      const row = (await this.pool.query<Saved>(`${savedSql} WHERE a.id=$1`, [sourceId(id)])).rows[0];
      if (!row || !row.current || row.withdrawn) return { id, citation: null };
      const observation = await this.evidence(row.principal_id, row.request);
      const basis = await this.publicEvidence(row, observation);
      if (!basis) return { id, citation: null };
      const value = row.request.selected.value;
      return { id, citation: projectRetainedAssociationCitation({ support: id, supportIdentity: id,
        evidence: { id: observation.record, sourceWork: null, representationSha256: observation.byteDigest!,
          locator: { pointer: row.request.source.pointer }, attribution: { sourceName: observation.provider,
            sourceUrl: null, licence: basis.rights.licenseExpression }, rightsBasis: basis.rights,
          quote: typeof value === 'string' ? value : null, quoteWithheld: typeof value !== 'string',
          language: structuredClone(row.request.selected.language) } }) };
    }));
  }

  private async readProof(participation: Participation, support: CreditAttributionSupport): Promise<RelationAttributionProof | null> {
    if (support.basis.kind !== 'native-credit' || !support.evidence.length) return null;
    const fields: RelationAttributionProof['fields'] = {}, rows: Saved[] = [];
    const session = currentWorkReadSession();
    let withdrawn = false;
    for (const evidence of support.evidence) {
      const annotation = sourceId(evidence);
      if (!annotation) return null;
      const read = async () => (await this.pool.query<Saved>(`${savedSql} WHERE a.id=$1`, [annotation])).rows[0];
      const row = await read();
      const identity = { role: participation.role, participant: participation.participant,
        ...(participation.position === undefined ? {} : { position: participation.position }) };
      if (!row || !row.current || row.request.native.credit !== support.basis.credit
        || row.request.native.revision !== support.basis.revision || !same(row.request.native.participation, identity)) return null;
      const native = await this.native(row.request);
      if (!same(native.witness, row.native_witness)) return null;
      // A real withdrawal retains its original immutable proof for native
      // consumers to remove these optional fields. It supplies no current use.
      withdrawn ||= row.withdrawn;
      const observation = row.withdrawn ? null : await this.evidence(row.principal_id, row.request);
      const publicBasis = observation ? await this.publicEvidence(row, observation) : null;
      if (observation && !publicBasis) return null;
      const field = row.request.field, value = this.field(row.request);
      if (Object.hasOwn(fields, field) && !same(fields[field], value)) return null;
      fields[field] = value; rows.push(row);
      session?.observeDependency(`source-native-credit-annotation:${annotation}`, row, read);
      if (observation) session?.observeDependency(`source-native-credit-evidence:${annotation}`, observation,
        () => this.evidence(row.principal_id, row.request));
      if (observation) {
        session?.observeDependency(`source-native-credit-public:${annotation}`, publicBasis,
          async () => this.publicEvidence(row, await this.evidence(row.principal_id, row.request)));
      }
      session?.checkDeadline();
    }
    if (support.fields.some(field => !Object.hasOwn(fields, field))) return null;
    return { basis: support.basis, receipt: rows[0]!.receipt, revision: support.basis.revision,
      validationToken: hash(canonicalJson(rows)), state: withdrawn ? 'withdrawn' : 'current', fields,
      evidence: [...support.evidence], participant: participation.participant };
  }

  /** Existing pre-allocation native origin port. Only independently cited
   * fields are added; the native writer remains the tuple/identity authority. */
  nativeAttribution(): (input: Pick<Parameters<NonNullable<RetainedCreditOriginLoaders['nativeAttribution']>>[0],
    'nativeCredit' | 'attributionSupports'>) => ReturnType<NonNullable<RetainedCreditOriginLoaders['nativeAttribution']>> {
    return async ({ nativeCredit, attributionSupports }) => {
      const value = nativeCredit.value;
      const participation: Participation = { role: value.role!, participant: creditOwnerParticipant(nativeCredit),
        ...(value.agent ? {} : { position: value.nativeOrdinal }) };
      const fields: RelationAttributionProof['fields'] = {};
      for (const support of attributionSupports) {
        if (support.basis.kind !== 'native-credit' || support.basis.credit !== value.credit
          || support.basis.revision !== value.revision) return null;
        if (!support.evidence.length) {
          for (const field of support.fields) {
            if (participation.participant.kind !== 'external' || !['provider', 'namespace', 'key'].includes(field)) return null;
            fields[field] = participation.participant[field as 'provider' | 'namespace' | 'key'];
          }
          continue;
        }
        const proof = await this.proof(participation, support);
        if (!proof || proof.state !== 'current') return null;
        for (const field of support.fields) {
          if (!Object.hasOwn(proof.fields, field) || Object.hasOwn(fields, field) && !same(fields[field], proof.fields[field])) return null;
          fields[field] = proof.fields[field];
        }
      }
      const selected: NonNullable<Awaited<ReturnType<NonNullable<RetainedCreditOriginLoaders['nativeAttribution']>>>> = {};
      if (Object.hasOwn(fields, 'creditedName')) {
        const name = fields.creditedName as { lexical?: unknown; language?: unknown };
        if (!name || typeof name.lexical !== 'string' || typeof name.language !== 'string') return null;
        selected.creditedName = { lexical: name.lexical, language: name.language };
      }
      if (['alias', 'eid', 'note'].some(field => Object.hasOwn(fields, field))) {
        const participant = participation.participant;
        if (participant.kind !== 'external' || ['alias', 'eid', 'note'].some(field => !Object.hasOwn(fields, field)
          || fields[field as 'alias' | 'eid' | 'note'] !== null && typeof fields[field as 'alias' | 'eid' | 'note'] !== 'string')) return null;
        selected.sourceIdentity = { provider: participant.provider, namespace: participant.namespace, key: participant.key,
          alias: fields.alias as string | null, eid: fields.eid as string | null, note: fields.note as string | null };
      }
      return selected;
    };
  }

  /** Existing command verifier port; native graph guard is real. The caller
   * must retain its ordinary owner/session fence; this is no cross-store lock. */
  attributionOwner(): RelationAttributionOwner {
    return { verify: async input => {
      const principalId = await this.access.activePrincipalId(input.principal);
      if (!principalId) return null;
      const proofs: RelationAttributionProof[] = [], guards: string[] = [];
      for (const request of input.requests) {
        const mapping = input.definition.retainedCredit;
        if (!mapping || input.definition.roleKeys[request.participation.role] !== mapping.subjectRole) return null;
        const normalized = { ...request.participation, role: mapping.storedRole };
        const proof = await this.proof(normalized, request.support);
        if (!proof || request.support.basis.kind !== 'native-credit') return null;
        const witness = await readCreditOwnerWitness(this.environment, request.support.basis.credit);
        const head = witness && await readCreditOwnerHead(this.environment, witness);
        if (!witness || !head || witness.profile !== mapping.origin || witness.value.role !== mapping.storedRole) return null;
        proofs.push(proof); guards.push(creditOwnerGuard(witness, head));
      }
      return { proofs, guard: guards.join('\n') };
    } };
  }
}
