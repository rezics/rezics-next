import { checkedSemanticValue } from '../semantic/value.ts';
import { SemanticChangeRejected } from '../semantic/command.ts';
import type { CreditAttributionField, CreditAttributionSupport, RetainedCreditParticipation } from '../work/credit-association-state.ts';
import { checkedParticipations, InvalidRelationOccurrence, type Participation, type RelationRoleDefinition } from './schema.ts';

export const RELATION_V2_PROFILE = 'https://rezics.com/definition/relation-occurrence-v2';
export const RELATION_ATTRIBUTION_LIMITS = { supports: 16, bases: 32, evidence: 64, perSupportEvidence: 16 } as const;
export type SourceIdentity = NonNullable<RetainedCreditParticipation['sourceIdentity']>;
export type AttributedParticipation = Participation & { sourceIdentity?: SourceIdentity; attributionSupports: CreditAttributionSupport[] };
const fields: CreditAttributionField[] = ['creditedName', 'provider', 'namespace', 'key', 'alias', 'eid', 'note'];
const native = (value: unknown): value is string => typeof value === 'string'
  && /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export const canonicalAttribution = (value: unknown): string => JSON.stringify(value, (_key, member) =>
  object(member) ? Object.fromEntries(Object.entries(member).sort(([a], [b]) => a.localeCompare(b))) : member);
const invalid = (message: string): never => { throw new InvalidRelationOccurrence(message); };

export class UnsupportedRelationModel extends SemanticChangeRejected {
  readonly modelRevision = RELATION_V2_PROFILE;
  readonly schema = RELATION_V2_PROFILE;
  constructor() { super('unsupported-model-revision', 'Select relation-change-v2 for this authored occurrence'); }
}

export class InvalidParticipationAttribution extends SemanticChangeRejected {
  constructor(message: string) { super('invalid', message); }
}

/** Explicit nulls are source-reported absence; omitted or empty fields never acquire that meaning. */
export function checkedSourceIdentity(value: unknown): SourceIdentity {
  if (!object(value) || !keys(value, ['provider', 'namespace', 'key', 'alias', 'eid', 'note'])) return invalid('source identity is a closed complete attribution');
  try { checkedSemanticValue({ kind: 'external', provider: value.provider, namespace: value.namespace, key: value.key }); }
  catch { return invalid('source identity requires a qualified provider/namespace/key'); }
  if (!text(value.key, 200) || ![value.alias, value.eid].every(item => item === null || text(item, 200))
    || !(value.note === null || text(value.note, 2000))) return invalid('source identity field is outside its admitted bound');
  return { provider: value.provider as string, namespace: value.namespace as string, key: value.key,
    alias: value.alias as string | null, eid: value.eid as string | null, note: value.note as string | null };
}

export function checkedAttributionSupports(value: unknown): CreditAttributionSupport[] {
  if (!Array.isArray(value) || value.length > RELATION_ATTRIBUTION_LIMITS.supports) return invalid('attribution support count is outside its admitted bound');
  const result = value.map(item => {
    if (!object(item) || !keys(item, ['basis', 'fields', 'evidence']) || !object(item.basis)) return invalid('attribution support is closed');
    const basis = item.basis;
    const basisKeys = ({ 'source-credit': ['kind', 'support'], 'native-credit': ['kind', 'credit', 'revision'],
      'source-binding': ['kind', 'binding'], 'selected-publication': ['kind', 'decision'] } as Record<string, string[]>)[String(basis.kind)];
    if (!basisKeys || !keys(basis, basisKeys) || basisKeys.filter(key => key !== 'kind').some(key => !native(basis[key]))) return invalid('attribution basis must name its exact existing owner');
    if (!Array.isArray(item.fields) || item.fields.length < 1 || item.fields.length > 7
      || new Set(item.fields).size !== item.fields.length || item.fields.some(field => !fields.includes(field))) return invalid('attribution fields are distinct admitted field names');
    if (!Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > RELATION_ATTRIBUTION_LIMITS.perSupportEvidence
      || new Set(item.evidence).size !== item.evidence.length || item.evidence.some(ref => !text(ref, 2048)
        || !/^(https:\/\/[^\s<>"{}|\\^`]+|urn:rezics:[a-z0-9-]+:[^\s<>"{}|\\^`]+)$/.test(ref))) return invalid('attribution evidence must identify exact bounded citations');
    return { basis: structuredClone(basis), fields: [...item.fields].sort(), evidence: [...item.evidence].sort() } as CreditAttributionSupport;
  });
  if (new Set(result.map(canonicalAttribution)).size !== result.length) return invalid('attribution support repeats');
  return result.sort((a, b) => canonicalAttribution(a).localeCompare(canonicalAttribution(b)));
}

/** V2 extends the existing role/cardinality validator, with no name or key based identity inference. */
export function checkedParticipationsV2(roles: readonly RelationRoleDefinition[], values: readonly unknown[]): AttributedParticipation[] {
  if (!Array.isArray(values)) return invalid('participations must be an array');
  const metadata = values.map(value => {
    if (!object(value) || !keys(value, ['role', 'participant'], ['position', 'creditedName', 'sourceIdentity', 'attributionSupports'])) return invalid('participation has unsupported fields');
    const sourceIdentity = value.sourceIdentity === undefined ? undefined : checkedSourceIdentity(value.sourceIdentity);
    const attributionSupports = checkedAttributionSupports(value.attributionSupports ?? []);
    for (const support of attributionSupports) for (const field of support.fields) {
      if (field === 'creditedName' ? value.creditedName === undefined : sourceIdentity?.[field] === undefined || sourceIdentity[field] === null) {
        return invalid('attribution support names an absent field');
      }
    }
    if (sourceIdentity && fields.filter(field => field !== 'creditedName' && sourceIdentity[field] !== null)
      .some(field => !attributionSupports.some(support => support.fields.includes(field)))) return invalid('every asserted source identity field requires exact admitted support');
    return { ...(sourceIdentity ? { sourceIdentity } : {}), attributionSupports };
  });
  const base = checkedParticipations(roles, values.map(value => {
    const row = value as Record<string, unknown>;
    return { role: row.role, participant: row.participant, ...(row.position === undefined ? {} : { position: row.position }),
      ...(row.creditedName === undefined ? {} : { creditedName: row.creditedName }) };
  }));
  const result = base.map((value, index) => ({ ...value, ...metadata[index]! }));
  const supports = result.flatMap(item => item.attributionSupports);
  if (new Set(supports.map(support => canonicalAttribution(support.basis))).size > RELATION_ATTRIBUTION_LIMITS.bases
    || new Set(supports.flatMap(support => support.evidence)).size > RELATION_ATTRIBUTION_LIMITS.evidence) return invalid('attribution command exceeds its distinct basis or evidence budget');
  return result;
}
