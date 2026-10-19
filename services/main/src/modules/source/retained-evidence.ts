import type { Pool } from 'pg';
import { canonicalJson } from '../../../../../scripts/lib/canonical-json.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import { ControlDenied } from '../access/topology-control.ts';
import { captureDisclosure, fenceDisclosure, resolveDisclosureSelections } from '../disclosure/read.ts';
import type { ExportBasis, VerifiedExportMember } from '../export/planner.ts';
import { RightsDenied, type RightsStore } from '../rights/store.ts';
import { ANONYMOUS_VIEWER } from '../suitability/policy.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readCurrentSourceObservation } from './cover-evidence.ts';
import { coordinateInvalid, sourceNotFound, supportChanged, supportUnavailable,
  type SuppliedLanguage } from './field-support-contract.ts';
import type { SourceIntakeStore, StagedSourceObservation } from './intake.ts';
import type { SourceRetainedRecordStore } from './retained-record.ts';

/** Only the conversion owner produces this private, byte-verified composition.
 * No request body, observation pointer or full-record pointer is an alias. */
export type VerifiedRetainedRecordEvidence = NonNullable<Awaited<ReturnType<SourceRetainedRecordStore['evidence']>>>;
export interface PublicRetainedFieldEvidence {
  /** Actual Source record identity; this is not a manufactured Wiki citation. */
  id: string;
  sourceWork: null;
  representationSha256: string;
  locator: { pointer: string };
  attribution: { sourceName: string; sourceUrl: string | null; licence: string | null };
  rightsBasis: ExportBasis;
  quote: string | null;
  quoteWithheld: boolean;
  language: SuppliedLanguage;
}

function atPointer(document: Record<string, unknown>, pointer: string): unknown {
  if (pointer.length > 2048 || !pointer.startsWith('/') || /~(?![01])/.test(pointer)) return coordinateInvalid();
  let value: unknown = document;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)
      || Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function suppliedLanguage(language: SuppliedLanguage): SuppliedLanguage {
  if ((language.state === 'omitted' || language.state === 'null') && Object.keys(language).length === 1) return { ...language };
  if (language.state === 'value' && Object.keys(language).length === 2
    && typeof language.value === 'string' && language.value.length > 0 && language.value.length <= 35) return { ...language };
  return coordinateInvalid();
}

/** Evidence projection is not admission/publication. The support read owner
 * must select an otherwise public, currently admitted support before using it.
 * This owner separately fences current anonymous Source disclosure and rights. */
export class SourceRetainedRecordEvidenceOwner {
  constructor(private readonly pool: Pool,
    private readonly intake: Pick<SourceIntakeStore, 'read'>,
    private readonly access: Pick<AccessAdmissionRegistry, 'activePrincipalId' | 'hasNonBaselineWorkCreateAuthority'>,
    private readonly rights: Pick<RightsStore, 'retainedFieldReusePermitted' | 'exportScope'>,
    private readonly records: Pick<SourceRetainedRecordStore, 'evidence'>,
    private readonly env: WorkActivationEnvironment) {}

  async authorizeRetainedFieldReuse(principal: VerifiedPrincipal, actingSubject: string,
    sourceRecord: string, observations: readonly StagedSourceObservation[]): Promise<void> {
    const principalId = await this.access.activePrincipalId(principal);
    if (!principalId || !await this.access.hasNonBaselineWorkCreateAuthority(principal, actingSubject)) {
      throw new ControlDenied('Source import authority is unavailable');
    }
    // The Rights owner sees the claimed scope before any private custody,
    // record/value/binding mismatch can be disclosed. It sees current scope too.
    const authorize = async (items: readonly StagedSourceObservation[]) => {
      if (!await this.rights.retainedFieldReusePermitted(sourceRecord, items)) {
        throw new RightsDenied('Source field reuse is restricted');
      }
    };
    await authorize(observations);
    const current = await Promise.all(observations.map(item =>
      readCurrentSourceObservation(this.pool, this.intake, principalId, item.observation)));
    await authorize(current.filter((item): item is StagedSourceObservation => item !== null).length
      ? current.filter((item): item is StagedSourceObservation => item !== null) : observations);
    if (await this.access.activePrincipalId(principal) !== principalId
      || !await this.access.hasNonBaselineWorkCreateAuthority(principal, actingSubject)) {
      throw new ControlDenied('Source import authority is unavailable');
    }
    if (current.some(item => item === null)) return sourceNotFound();
    if (canonicalJson(current) !== canonicalJson(observations)) return supportChanged('evidence');
  }

  async projectPublicRetainedField(principal: VerifiedPrincipal, actingSubject: string,
    evidence: VerifiedRetainedRecordEvidence, payloadPointer: string,
    language: SuppliedLanguage): Promise<PublicRetainedFieldEvidence | null> {
    const sourceRecord = evidence.conversion.retainedRecord.sourceRecord;
    await this.authorizeRetainedFieldReuse(principal, actingSubject, sourceRecord, evidence.observations);
    const principalId = await this.access.activePrincipalId(principal);
    if (!principalId) return sourceNotFound();
    const current = await this.records.evidence(principalId, evidence.conversion.conversion);
    if (!current) return sourceNotFound();
    // Resolve the persisted binding before checking private differences, then
    // authorize its actual record/parts as well as the caller-selected scope.
    await this.authorizeRetainedFieldReuse(principal, actingSubject,
      current.conversion.retainedRecord.sourceRecord, current.observations);
    if (canonicalJson(current) !== canonicalJson(evidence)) return supportChanged('evidence');
    const value = atPointer(current.payload, payloadPointer);
    if (value === undefined) return null;
    const retainedLanguage = suppliedLanguage(language);
    const binding = current.conversion.retainedRecord;
    const targets = [{ owner: 'source' as const, resource: sourceRecord, component: 'record' as const,
      revision: current.conversion.conversion }, ...current.observations.map(item => ({
      owner: 'source' as const, resource: item.record, component: 'record' as const, revision: item.observation }))];
    const selections = await resolveDisclosureSelections(this.env, targets);
    const cuts = await captureDisclosure(this.env, selections, ANONYMOUS_VIEWER, 'read');
    if (cuts.some(cut => cut.decision !== 'visible')) return null;
    const member: VerifiedExportMember = { sourceOwner: 'source', sourceNamespace: binding.identity.namespace,
      sourceGrain: 'evidence', exactRef: current.conversion.conversion, contentRevisionId: null,
      refDigest: binding.payload.byteDigest, ownerDataEpoch: 'source-retained-record-conversion-v1',
      ownerSequence: '0', sourcePosition: null, targetGrain: 'evidence', mapping: 'exact',
      data: { rightsIdentity: {
        material: { scopeKind: 'source_record', provider: null, namespace: null, sourceRecordId: sourceRecord.slice(-36),
          contentVariantId: null, mediaAsset: null, component: 'record' },
        target: { owner: 'source', resource: sourceRecord, component: 'record', revision: current.conversion.conversion },
      } } };
    const assess = async () => {
      const bases = await this.rights.exportScope([member], 'quotation');
      if (bases.length !== 1 || canonicalJson(bases[0]!.memberOrdinals) !== '[1]') return supportUnavailable();
      return bases[0]!;
    };
    const basis = await assess();
    if (basis.obligations.includes('access_restriction')) return null;
    await this.authorizeRetainedFieldReuse(principal, actingSubject, sourceRecord, current.observations);
    const after = await this.records.evidence(principalId, current.conversion.conversion);
    const finalBasis = await assess();
    if (!after || canonicalJson(after) !== canonicalJson(current)
      || canonicalJson(basis) !== canonicalJson(finalBasis)) return null;
    if ((await fenceDisclosure(this.env, cuts, ANONYMOUS_VIEWER, 'read')).some(decision => decision !== 'visible')) return null;
    const quoteWithheld = basis.result !== 'supported' || typeof value !== 'string';
    return { id: sourceRecord, sourceWork: null, representationSha256: binding.payload.byteDigest,
      locator: { pointer: payloadPointer }, attribution: { sourceName: binding.identity.provider,
        sourceUrl: current.record.sourceUrl ?? null, licence: basis.licenseExpression }, rightsBasis: basis,
      language: retainedLanguage, quoteWithheld, quote: quoteWithheld ? null : value as string };
  }
}
