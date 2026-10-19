import { canonicalJson } from '../../../../../scripts/lib/canonical-json.ts';
import type { DatasetNativeField } from '../../../../../scripts/datasets/native/fields.ts';
import type { SourceRetainedRecordStore } from './retained-record.ts';
import { canonicalDigest } from './retained-record-normalization.ts';
import { suppliedLanguage } from './field-control-language.ts';
import { coordinateInvalid, mappingUnverified, supportChanged, type RetainedSupportRequest,
  supportUnavailable, type RetainedFieldCoordinate, type RetainedSupportAdmission } from './field-support-contract.ts';

export type RetainedEvidence = NonNullable<Awaited<ReturnType<SourceRetainedRecordStore['evidence']>>>;
export interface VerifiedRetainedField {
  candidate: DatasetNativeField;
  correspondence: RetainedSupportAdmission['correspondence'];
  value: unknown;
}

/** Strict RFC 6901. Missing object members are observations; malformed paths,
 * noncanonical array indexes and walking through a scalar are invalid coordinates. */
export function retainedValueAt(root: unknown, pointer: string): { present: boolean; value?: unknown } {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 4096
    || pointer.split('/').length > 33 || /~(?![01])/.test(pointer)) return coordinateInvalid();
  let value = root;
  for (const token of pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]{0,8})$/.test(token) || Number(token) >= value.length) return coordinateInvalid();
      value = value[Number(token)];
    } else if (value !== null && typeof value === 'object') {
      if (!Object.hasOwn(value, token)) return { present: false };
      value = (value as Record<string, unknown>)[token];
    } else return coordinateInvalid();
  }
  return { present: true, value };
}
function fieldPresence(value: ReturnType<typeof retainedValueAt>): RetainedFieldCoordinate['presence'] {
  return !value.present ? 'omitted' : value.value === null ? 'null' : value.value === '' ? 'empty-string'
    : Array.isArray(value.value) && value.value.length === 0 ? 'empty-array'
      : value.value && typeof value.value === 'object' && Object.keys(value.value).length === 0 ? 'empty-object' : 'value';
}
/** Field keys follow the registered normalized record, without pretending /data
 * is a provider response member. Repeated owner adapters retain their own grain. */
export function retainedFieldKey(pointer: string): string {
  return pointer.startsWith('/data/') ? pointer.slice(6) : pointer.slice(1);
}
function payloadPointers(evidence: RetainedEvidence, pointer: string): string[] {
  if (evidence.rule === 'dataset-record-envelope-v1') return [`/record${pointer}`];
  if (pointer.startsWith('/data/')) return [pointer.slice(5)];
  const data = evidence.record.data;
  if (pointer === '/title') {
    if (evidence.record.provider === 'musicbrainz') return [typeof data.title === 'string' ? '/title' : '/name'];
    if (evidence.record.provider === 'vndb') return ['/name'];
  }
  if (pointer === '/language') {
    if (evidence.record.provider === 'musicbrainz') return ['/text-representation/language'];
    if (evidence.record.provider === 'vndb') return [data.olang !== undefined ? '/olang' : '/lang'];
  }
  return mappingUnverified();
}
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

/** Check custody/reuse before calling this helper: these private mismatch bases
 * intentionally disclose nothing to a principal who cannot use the evidence. */
export async function verifyRetainedField(input: RetainedSupportRequest,
  evidence: RetainedEvidence): Promise<VerifiedRetainedField> {
  const binding = evidence.conversion.retainedRecord, field = input.evidence.field;
  if (input.sourceRecord !== binding.sourceRecord) return supportChanged('record');
  if (input.evidence.recordDigest !== binding.recordDigest) return supportChanged('record-digest');
  if (input.conversion !== binding.conversion || input.evidence.binding !== binding.binding
    || input.evidence.mappingRevision !== binding.mappingRevision) return supportChanged('conversion');
  const selected = retainedValueAt(evidence.record, field.pointer);
  if (fieldPresence(selected) !== field.presence) return coordinateInvalid();
  if (!selected.present) {
    if (field.valueDigest !== undefined) return supportChanged('value-digest');
    return coordinateInvalid(); // An absent field cannot support a positive native value.
  }
  const digest = canonicalDigest(selected.value);
  if (field.valueDigest !== digest) return supportChanged('value-digest');
  const component = input.native.kind === 'component-property'
    && (input.native.owner === 'release' || input.native.owner === 'realization') ? input.native.component : null;
  if (input.sourceOccurrence !== null) return coordinateInvalid();
  if (input.occurrence !== component) return supportChanged('native-target');
  const plan = evidence.fieldPlan;
  if (!plan) return supportUnavailable();
  const candidates = plan.fields.filter(candidate => candidate.evidence.some(item =>
    item.path === field.pointer && item.ordinal === field.ordinal
    && Object.hasOwn(item, 'language') === Object.hasOwn(field, 'language')
    && item.language === field.language));
  if (!candidates.length) {
    // A real other field is a binding mismatch, while an absent path or invalid
    // alias ordinal is an unresolvable coordinate.
    if (field.ordinal !== undefined || !plan.fields.some(candidate => candidate.evidence.some(item => item.path === field.pointer))) {
      return coordinateInvalid();
    }
    return supportChanged('evidence-binding');
  }
  if (input.grain !== evidence.record.kind || input.sourceField !== retainedFieldKey(field.pointer)) {
    return supportChanged('evidence-binding');
  }
  const predicate = input.native.kind === 'statement' ? input.native.predicate : input.native.property.predicate;
  const candidate = candidates.find(item => item.native?.predicate === predicate && item.native.owner === input.native.owner)
    ?? candidates.find(item => item.native?.predicate === predicate);
  if (!candidate) return candidates.some(item => item.native) ? supportChanged('evidence-binding') : mappingUnverified();
  if (!candidate.native || candidate.disposition !== 'candidate') return mappingUnverified();
  if (candidate.native.owner === 'work-metadata') return mappingUnverified();
  if ((candidate.native.owner === 'release' || candidate.native.owner === 'realization')
    && candidate.native.owner !== input.native.owner) return mappingUnverified();
  if (component && (evidence.record.native !== 'release' || evidence.record.kind !== 'release')) return mappingUnverified();
  if (candidate.native.owner === 'work-editorial') {
    if (input.native.kind !== 'component-property' || input.native.owner !== 'work-editorial') return mappingUnverified();
    if (!same(input.native.language,suppliedLanguage(candidate.evidence[0]!))) return supportChanged('native-value');
  }
  const expected = input.native.kind === 'statement' ? candidate.native.statementValue : candidate.native.property?.value;
  const actual = input.native.kind === 'statement' ? input.native.value : input.native.property.value;
  if (expected === undefined || !same(expected, actual)) return supportChanged('native-value');
  const pointers = payloadPointers(evidence, field.pointer);
  for (const pointer of pointers) {
    const value = retainedValueAt(evidence.payload, pointer);
    if (!value.present || canonicalDigest(value.value) !== digest) return supportChanged('evidence-binding');
  }
  return { candidate, value: selected.value, correspondence: {
    normalizationRevision: binding.normalizationRevision, rule: evidence.rule,
    payloadPointers: pointers, selectedValueDigest: digest } };
}
