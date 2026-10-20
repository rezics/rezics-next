import { canonicalJson } from '../../../../../scripts/lib/canonical-json.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { readNativeFieldControl, readNativeFieldReceipt, synopsisSlot } from './field-control-native.ts';
import { synopsisPropertyValue } from './field-control-language.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { NativeBasisVerificationInput } from '../semantic/native-basis.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { RetainedEvidence } from './field-support-evidence.ts';
import { verifyReleaseSourceNative } from '../release/source-verifier.ts';
import { verifyRealizationSourceNative } from '../realization/source-verifier.ts';
import { mappingUnverified, supportChanged, supportUnavailable, SourceFieldProblem,
  type RetainedSupportRequest, type VerifiedNativeAcknowledgement } from './field-support-contract.ts';

export interface SourceNativeVerificationContext {
  principal: VerifiedPrincipal; selected: NativeBasisVerificationInput['selected'];
  session?: WorkReadSession;
  evidence?: RetainedEvidence;
}
export type NativeSupportVerifier = (input: RetainedSupportRequest,
  requireCurrent: boolean, context?: SourceNativeVerificationContext) => Promise<VerifiedNativeAcknowledgement>;
export interface SourceNativeVerifiers { semantic?: NativeSupportVerifier; statement?: NativeSupportVerifier; structure?: NativeSupportVerifier }
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const RECEIPT = /^urn:rezics:receipt:[0-9a-f]{64}$/;

/** Resolve real owner receipts. No Source ID, revision or component can serve as
 * a receipt. Current-owner verification precedes the Source commit; it does not
 * provide an atomic transaction across the native graph and Source database. */
export async function verifySourceNative(env: WorkActivationEnvironment, input: RetainedSupportRequest,
  owners: SourceNativeVerifiers = {}, requireCurrent = true,
  context?: SourceNativeVerificationContext): Promise<VerifiedNativeAcknowledgement> {
  try { return await resolveSourceNative(env,input,owners,requireCurrent,context); }
  catch (error) {
    if (error instanceof SourceFieldProblem || error instanceof WorkReadMoved || error instanceof WorkReadUnavailable) throw error;
    return supportUnavailable();
  }
}
async function resolveSourceNative(env: WorkActivationEnvironment, input: RetainedSupportRequest,
  owners: SourceNativeVerifiers, requireCurrent: boolean,
  context?: SourceNativeVerificationContext): Promise<VerifiedNativeAcknowledgement> {
  const native = input.native;
  if (native.target !== input.target) return supportChanged('native-target');
  if (native.revision !== input.expectedHead || !RECEIPT.test(native.receipt)) return supportChanged('native-head');
  if (native.kind === 'structure-occurrence') {
    if (input.context !== native.structure || input.occurrence !== native.occurrence) return supportChanged('native-target');
    if (!owners.structure) return supportUnavailable();
    return owners.structure(input,requireCurrent,context);
  }
  if (native.kind === 'statement') {
    if (input.context !== native.context || input.slot !== 'statement-v1#value') return supportChanged('native-target');
    if (!owners.statement) return supportUnavailable();
    return owners.statement(input, requireCurrent, context);
  }
  if (native.owner === 'release' || native.owner === 'realization') {
    if (!context) return supportUnavailable();
    if (input.context !== 'global' || input.occurrence !== native.component
      || input.slot !== `component-property-v1#${native.property.predicate}`) return supportChanged('native-target');
    const selected = { value: native.property.value,
      ...(Object.hasOwn(input.evidence.field,'language') ? { language: input.evidence.field.language } : {}) };
    const result = native.owner === 'release'
      ? await verifyReleaseSourceNative(env,{ principal: context.principal,actingSubject: input.actingSubject,native,selected })
      : await verifyRealizationSourceNative(env,{ principal: context.principal,actingSubject: input.actingSubject,native,selected });
    if (result.status === 'target-mismatch') return supportChanged('native-target');
    if (result.status === 'value-mismatch') return supportChanged('native-value');
    if (result.status === 'head-mismatch') return supportChanged('native-head');
    if (result.status !== 'verified') return supportUnavailable();
    const receipt = result.receipt;
    return { receipt: receipt.receipt,admissionId: receipt.admissionId,dataEpoch: receipt.dataEpoch,
      sequence: receipt.sequence,scope: receipt.scope,action: 'work.edit',component: native.component,
      revision: result.revision,release: { currentHeads: result.currentHeads,correspondence: result.correspondence } };
  }
  if (native.owner === 'semantic') {
    if (native.component !== native.target) return supportChanged('native-target');
    if (input.context !== 'global' || input.slot !== `component-property-v1#${native.property.predicate}`) return mappingUnverified();
    if (!owners.semantic) return supportUnavailable();
    return owners.semantic(input,requireCurrent,context);
  }
  if (native.owner !== 'work-editorial' || native.field !== 'synopsis'
    || input.context !== 'global' || input.slot !== 'work-editorial-field-v1#synopsis') return mappingUnverified();
  if (native.component !== synopsisSlot(input.target)) return supportChanged('native-target');
  const found = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?admission ?workHead ?protection ?epoch WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(native.receipt)} rv:admissionId ?admission ;
      rv:workRevision ?workHead ; rv:expectedProtection ?protection ; rv:fieldControl ?control . }
    GRAPH ${iri(GRAPHS.revisions)} { ?control rv:controlEpoch ?epoch . } } LIMIT 2`, 4096);
  const rows = found.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.admission || !rows[0].workHead || !rows[0].protection
    || !rows[0].epoch) return supportChanged('native-head');
  const acknowledged = rows[0];
  const protection = acknowledged.protection!.value === `${RV}Absent` ? null : acknowledged.protection!.value;
  const receipt = await readNativeFieldReceipt(env, rows[0].admission.value);
  if (!receipt || receipt.outcome !== 'succeeded' || receipt.receipt !== native.receipt
    || receipt.work !== input.target || receipt.slot !== native.component
    || receipt.content !== native.revision || !receipt.control) return supportChanged('native-head');
  const state = await readNativeFieldControl(env, input.target);
  if (requireCurrent && (state.contentHead !== native.revision || state.controlHead !== receipt.control
    || state.workHead !== acknowledged.workHead!.value || state.controlEpoch !== acknowledged.epoch!.value
    || state.protectionHead !== protection)) {
    return supportChanged('native-head');
  }
  if (!requireCurrent && state.contentHead !== native.revision) {
    // The immutable receipt/Source certificate remains readable; its historic
    // exact value is checked against the value revision below.
    const revision = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?value ?state ?language WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(native.revision)} a rv:EditorialFieldRevision ;
        rv:component ${iri(native.component)} ; rv:fieldValue ?value .
        OPTIONAL { ${iri(native.revision)} rv:sourceLanguageState ?state }
        OPTIONAL { ${iri(native.revision)} rv:sourceLanguage ?language } } } LIMIT 2`, 8_400_000);
    const r = revision.results?.bindings ?? [];
    if (r.length !== 1 || !r[0]?.value) return supportUnavailable();
    const language = r[0].state?.value === 'value' ? { state: 'value', value: r[0].language?.value }
      : { state: r[0].state?.value ?? 'omitted' };
    if (!equal(language, native.language) || !equal(synopsisPropertyValue(r[0].value.value, native.language), native.property.value)
      || native.property.predicate !== 'https://schema.org/description') return supportChanged('native-value');
  } else if (state.value === null || !equal(state.language ?? { state: 'omitted' }, native.language)
    || !equal(synopsisPropertyValue(state.value, native.language), native.property.value)
    || native.property.predicate !== 'https://schema.org/description') return supportChanged('native-value');
  return { receipt: receipt.receipt, admissionId: receipt.admissionId, dataEpoch: receipt.dataEpoch,
    sequence: receipt.sequence, scope: `work:edit:${input.target}`, action: 'work.edit',
    component: native.component, revision: native.revision,
    editorial: { workHead: acknowledged.workHead!.value, controlHead: receipt.control,
      controlEpoch: acknowledged.epoch!.value, protectionHead: protection } };
}
