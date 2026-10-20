import { parseLanguage } from '../display-language/select.ts';
import { hash } from './activate.ts';
import { isNativeCreditRole, type NativeCreditRole } from './credit-roles.ts';

export const RETAINED_CREDIT_ASSOCIATIONS = 'retained-credit-associations-v1';
export const RETAINED_CREDIT_ASSOCIATIONS_PROFILE =
  'https://rezics.com/definition/retained-credit-associations-v1';
export type RetainedCreditProfile =
  | 'work-author-credit-v1'
  | 'native-agent-credit-v1'
  | 'source-reported-credit-v1';
export type RetainedCreditParticipant =
  | { kind: 'resource'; ref: string }
  | { kind: 'external'; provider: string; namespace: string; key: string };
export type RetainedCreditOrigin =
  | { kind: 'stored-credit'; revision: string }
  | {
      kind: 'source-binding';
      binding: string;
      proposal: string;
      conversion: string;
      record: string;
      observation: string;
      sourceOccurrence: string;
      sourceOrdinal: number;
    }
  | {
      kind: 'selected-publication';
      decision: string;
      source: string;
      record: string;
      observation: string;
    };
export type CreditAttributionField =
  | 'creditedName'
  | 'provider'
  | 'namespace'
  | 'key'
  | 'alias'
  | 'eid'
  | 'note';
export type CreditAttributionBasis =
  | { kind: 'native-credit'; credit: string; revision: string }
  | { kind: 'source-credit'; support: string }
  | { kind: 'source-binding'; binding: string }
  | { kind: 'selected-publication'; decision: string };
export interface CreditAttributionSupport {
  basis: CreditAttributionBasis;
  fields: CreditAttributionField[];
  evidence: string[];
}
export interface RetainedCreditParticipation {
  id: string;
  role: string;
  participant: RetainedCreditParticipant;
  position?: number;
  creditedName?: { lexical: string; language: string };
  sourceIdentity?: {
    provider: string;
    namespace: string;
    key: string;
    alias: string | null;
    eid: string | null;
    note: string | null;
  };
  attributionSupports: CreditAttributionSupport[];
}
export interface RetainedCreditMapping {
  revision: string;
  definition: string;
  workRole: string;
  subjectRole: string;
  originProfile: RetainedCreditProfile;
  originRole: NativeCreditRole | 'transcriber';
  externalNamespace: { provider: string; namespace: string } | null;
}
/** An immutable compatibility view of the original credit component, never a
 * second occurrence. The binding owner allocates these IDs once, at admission. */
export interface RetainedCreditAssociationState {
  profile: typeof RETAINED_CREDIT_ASSOCIATIONS;
  credit: string;
  creditRevision: string;
  retainedProfile: RetainedCreditProfile;
  work: string;
  workRevision: string;
  role: NativeCreditRole | 'transcriber';
  origin: RetainedCreditOrigin;
  mapping: RetainedCreditMapping;
  workParticipation: string;
  subjectParticipation: string;
  participations: RetainedCreditParticipation[];
  context: 'global' | { realm: string };
  applicability: string[];
  qualification: 'asserted' | 'uncertain' | 'conflicting';
}

export const creditNativeId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
export const creditReceiptId = (value: unknown): value is string =>
  typeof value === 'string' && /^urn:rezics:receipt:[0-9a-f]{64}$/.test(value);
const slug = (value: unknown) =>
  typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64;
const text = (value: unknown, max = 200) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: unknown, required: string[], optional: string[] = []) =>
  object(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const unique = (
  value: unknown,
  max: number,
  check: (item: unknown) => boolean,
): value is unknown[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every(check) &&
  new Set(value.map(canonicalCreditValue)).size === value.length;
const ordinal = (value: unknown) =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1023;
const profile = (value: unknown) =>
  ['work-author-credit-v1', 'native-agent-credit-v1', 'source-reported-credit-v1'].includes(
    String(value),
  );
const role = (value: unknown) =>
  typeof value === 'string' && (value === 'transcriber' || isNativeCreditRole(value));
const roleIri = (value: unknown) =>
  typeof value === 'string' &&
  /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}\/role\/[a-z][a-z0-9-]{0,31}$/.test(value);
const fields: CreditAttributionField[] = [
  'creditedName',
  'provider',
  'namespace',
  'key',
  'alias',
  'eid',
  'note',
];

function participant(value: unknown) {
  if (!object(value)) return false;
  return value.kind === 'resource'
    ? keys(value, ['kind', 'ref']) && creditNativeId(value.ref)
    : value.kind === 'external' &&
        keys(value, ['kind', 'provider', 'namespace', 'key']) &&
        slug(value.provider) &&
        slug(value.namespace) &&
        text(value.key);
}
function origin(value: unknown) {
  if (!object(value)) return false;
  if (value.kind === 'stored-credit')
    return keys(value, ['kind', 'revision']) && creditNativeId(value.revision);
  if (value.kind === 'source-binding')
    return (
      keys(value, [
        'kind',
        'binding',
        'proposal',
        'conversion',
        'record',
        'observation',
        'sourceOccurrence',
        'sourceOrdinal',
      ]) &&
      [value.binding, value.proposal, value.conversion, value.record, value.observation].every(
        creditNativeId,
      ) &&
      typeof value.sourceOccurrence === 'string' &&
      /^urn:rezics:source-occurrence:[0-9a-f]{64}$/.test(value.sourceOccurrence) &&
      ordinal(value.sourceOrdinal) &&
      Number(value.sourceOrdinal) <= 127
    );
  return (
    value.kind === 'selected-publication' &&
    keys(value, ['kind', 'decision', 'source', 'record', 'observation']) &&
    [value.decision, value.source, value.record, value.observation].every(creditNativeId)
  );
}
function attributionSupport(value: unknown) {
  if (!keys(value, ['basis', 'fields', 'evidence']) || !object(value) || !object(value.basis))
    return false;
  const basis = value.basis;
  const validBasis =
    basis.kind === 'native-credit'
      ? keys(basis, ['kind', 'credit', 'revision']) &&
        creditNativeId(basis.credit) &&
        creditNativeId(basis.revision)
      : basis.kind === 'source-credit'
        ? keys(basis, ['kind', 'support']) && creditNativeId(basis.support)
        : basis.kind === 'source-binding'
          ? keys(basis, ['kind', 'binding']) && creditNativeId(basis.binding)
          : basis.kind === 'selected-publication' &&
            keys(basis, ['kind', 'decision']) &&
            creditNativeId(basis.decision);
  return (
    validBasis &&
    unique(value.fields, 7, (field) => fields.includes(field as CreditAttributionField)) &&
    value.fields.length > 0 &&
    unique(
      value.evidence,
      64,
      (evidence) =>
        typeof evidence === 'string' && /^(https:\/\/|urn:rezics:)[^\s<>"{}|\\^`]+$/.test(evidence),
    )
  );
}
function participation(value: unknown) {
  if (
    !keys(
      value,
      ['id', 'role', 'participant', 'attributionSupports'],
      ['position', 'creditedName', 'sourceIdentity'],
    ) ||
    !object(value)
  )
    return false;
  if (
    !creditNativeId(value.id) ||
    !roleIri(value.role) ||
    !participant(value.participant) ||
    !unique(value.attributionSupports, 64, attributionSupport) ||
    (Object.hasOwn(value, 'position') && !ordinal(value.position))
  )
    return false;
  if (
    Object.hasOwn(value, 'creditedName') &&
    (!keys(value.creditedName, ['lexical', 'language']) ||
      !object(value.creditedName) ||
      !text(value.creditedName.lexical) ||
      typeof value.creditedName.language !== 'string' ||
      !parseLanguage(value.creditedName.language))
  )
    return false;
  if (Object.hasOwn(value, 'sourceIdentity')) {
    const identity = value.sourceIdentity;
    if (
      !keys(identity, ['provider', 'namespace', 'key', 'alias', 'eid', 'note']) ||
      !object(identity) ||
      !slug(identity.provider) ||
      !slug(identity.namespace) ||
      !text(identity.key) ||
      ![identity.alias, identity.eid].every((item) => item === null || text(item)) ||
      !(
        identity.note === null ||
        (typeof identity.note === 'string' &&
          identity.note.length <= 2000 &&
          !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(identity.note))
      )
    )
      return false;
  }
  const supplied = [
    Object.hasOwn(value, 'creditedName') ? 'creditedName' : null,
    ...(value.sourceIdentity ? fields.filter((field) => field !== 'creditedName') : []),
  ].filter(Boolean);
  const supports = value.attributionSupports as CreditAttributionSupport[];
  return (
    supports.every((support) => support.fields.every((field) => supplied.includes(field))) &&
    supplied.every((field) =>
      supports.some((support) => support.fields.includes(field as CreditAttributionField)),
    )
  );
}

/** Stable object ordering for immutable view/receipt comparisons; array order
 * remains meaningful, including repeated participations and retained supports. */
export function canonicalCreditValue(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      object(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
    ) ?? 'undefined'
  );
}

export function checkedRetainedCreditAssociationState(
  value: unknown,
): RetainedCreditAssociationState {
  const required = [
    'profile',
    'credit',
    'creditRevision',
    'retainedProfile',
    'work',
    'workRevision',
    'role',
    'origin',
    'mapping',
    'workParticipation',
    'subjectParticipation',
    'participations',
    'context',
    'applicability',
    'qualification',
  ];
  if (!keys(value, required) || !object(value)) throw new Error('invalid retained credit view');
  const mapping = value.mapping;
  if (
    value.profile !== RETAINED_CREDIT_ASSOCIATIONS ||
    ![
      value.credit,
      value.creditRevision,
      value.work,
      value.workRevision,
      value.workParticipation,
      value.subjectParticipation,
    ].every(creditNativeId) ||
    !profile(value.retainedProfile) ||
    !role(value.role) ||
    !origin(value.origin) ||
    !keys(mapping, [
      'revision',
      'definition',
      'workRole',
      'subjectRole',
      'originProfile',
      'originRole',
      'externalNamespace',
    ]) ||
    !object(mapping) ||
    !creditNativeId(mapping.revision) ||
    !creditNativeId(mapping.definition) ||
    !roleIri(mapping.workRole) ||
    !roleIri(mapping.subjectRole) ||
    mapping.workRole === mapping.subjectRole ||
    mapping.originProfile !== value.retainedProfile ||
    mapping.originRole !== value.role ||
    !(
      mapping.externalNamespace === null ||
      (keys(mapping.externalNamespace, ['provider', 'namespace']) &&
        object(mapping.externalNamespace) &&
        slug(mapping.externalNamespace.provider) &&
        slug(mapping.externalNamespace.namespace))
    ) ||
    !unique(value.participations, 64, participation) ||
    value.participations.length < 2 ||
    !unique(value.applicability, 8, creditNativeId) ||
    !(
      value.context === 'global' ||
      (keys(value.context, ['realm']) &&
        object(value.context) &&
        creditNativeId(value.context.realm))
    ) ||
    !['asserted', 'uncertain', 'conflicting'].includes(String(value.qualification))
  )
    throw new Error('invalid retained credit view');
  const state = value as unknown as RetainedCreditAssociationState;
  const work = state.participations.find((item) => item.id === state.workParticipation);
  const subject = state.participations.find((item) => item.id === state.subjectParticipation);
  if (
    new Set(state.participations.map((item) => item.id)).size !== state.participations.length ||
    state.workParticipation === state.subjectParticipation ||
    !work ||
    !subject ||
    work.role !== state.mapping.workRole ||
    work.participant.kind !== 'resource' ||
    work.participant.ref !== state.work ||
    subject.role !== state.mapping.subjectRole ||
    (state.origin.kind === 'stored-credit' && state.origin.revision !== state.creditRevision) ||
    (state.role === 'transcriber' &&
      (state.origin.kind !== 'selected-publication' || state.credit !== state.origin.decision))
  )
    throw new Error('invalid retained credit allocations');
  return structuredClone(state);
}

export function retainedCreditAssociationDigest(
  state: RetainedCreditAssociationState,
  expectedAssociationHead: string | null,
): string {
  if (expectedAssociationHead !== null && !creditNativeId(expectedAssociationHead))
    throw new Error('invalid expected association head');
  return hash(
    canonicalCreditValue({
      profile: RETAINED_CREDIT_ASSOCIATIONS,
      state: checkedRetainedCreditAssociationState(state),
      expectedAssociationHead,
    }),
  );
}
