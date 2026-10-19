import {
  AdmissionDenied,
  type AccessAdmissionRegistry,
  type VerifiedPrincipal,
} from '../access/admission.ts';
import type { WorkEditAuthorityProof } from '../access/work-edit-authority.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { isNativeCreditRole, type NativeCreditRole } from '../work/credit-roles.ts';
import {
  readCreditOwnerHead,
  readCreditOwnerWitness,
  type CreditOwnerWitness,
} from '../work/credit-verification.ts';
import type { SourceAuthorCreditStore, SourceAuthorCreditSupport } from './author-credit.ts';

const NATIVE =
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECEIPT = /^urn:rezics:receipt:[0-9a-f]{64}$/;
export type CreditNativeProperty =
  | 'provider'
  | 'namespace'
  | 'key'
  | 'role'
  | 'ordinal'
  | 'participant'
  | 'sourceRoleKey'
  | 'creditedName'
  | 'alias'
  | 'eid'
  | 'note';
export type CreditNativeParticipant =
  | { kind: 'agent'; agent: string }
  | { kind: 'external-reference'; provider: string; namespace: string; key: string };
export interface CreditNativeQualifications {
  role: NativeCreditRole;
  participant: CreditNativeParticipant;
  ordinal: number | null;
  sourceRoleKey: string | null;
  workRevision: string;
  /** These are explicit absence for the bounded v1 owner. A generic qualified
   * participation needs its actual occurrence/Statement/acceptance owner. */
  participation: string | null;
  statement: string | null;
  acceptance: string | null;
}
export interface CreditNativeSourceBasis {
  support: string;
  proposal: string;
  conversion: string;
  record: string;
  observation: string;
  sourceOccurrence: string;
  sourceOrdinal: number;
}
export interface CreditNativeBasis {
  target: string;
  component: string;
  revision: string;
  receipt: string;
  workHead: string;
  occurrence: string;
  property: CreditNativeProperty;
  qualifications: CreditNativeQualifications;
  /** Required for an original Source adoption. Native creation does not attest
   * retained provenance; an additional support must resolve independently. */
  source: CreditNativeSourceBasis | null;
}
export interface CreditNativeVerificationInput {
  principal: VerifiedPrincipal;
  actingSubject: string;
  basis: CreditNativeBasis;
  selected: { value: unknown; language: string | null };
}
export interface CreditNativeVerifierDependencies {
  environment: WorkActivationEnvironment;
  access: Pick<AccessAdmissionRegistry, 'withWorkEditAuthority'>;
  sourceCredits?: Pick<SourceAuthorCreditStore, 'read'>;
}
export type CreditNativeVerificationResult =
  | {
      disposition: 'verified';
      receipt: string;
      revision: string;
      commandReceipt: CreditOwnerWitness['receipt'];
      nativeBasis: CreditNativeBasis;
      value: unknown;
      language: null;
      headGuarantee: 'verified-before-commit';
    }
  | {
      disposition:
        | 'unavailable'
        | 'target-mismatch'
        | 'value-mismatch'
        | 'head-mismatch'
        | 'authority-denied';
      reason: string;
    };
export type CreditNativeVerifier = (
  dependencies: CreditNativeVerifierDependencies,
  input: CreditNativeVerificationInput,
) => Promise<CreditNativeVerificationResult>;

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function qualifications(witness: CreditOwnerWitness): CreditNativeQualifications {
  const value = witness.value;
  return {
    role: value.role!,
    participant: value.agent
      ? { kind: 'agent', agent: value.agent }
      : {
          kind: 'external-reference',
          provider: value.provider!,
          namespace: value.namespace!,
          key: value.sourceKey,
        },
    ordinal: value.agent ? null : value.nativeOrdinal,
    sourceRoleKey: value.sourceRoleKey,
    workRevision: value.expectedHead,
    participation: null,
    statement: null,
    acceptance: null,
  };
}

function sameParticipant(a: CreditNativeParticipant, b: CreditNativeParticipant): boolean {
  return a.kind === 'agent'
    ? b.kind === 'agent' && a.agent === b.agent
    : b.kind === 'external-reference' &&
        a.provider === b.provider &&
        a.namespace === b.namespace &&
        a.key === b.key;
}

function sameQualifications(a: CreditNativeQualifications, b: CreditNativeQualifications) {
  return (
    a.role === b.role &&
    a.ordinal === b.ordinal &&
    a.sourceRoleKey === b.sourceRoleKey &&
    a.workRevision === b.workRevision &&
    sameParticipant(a.participant, b.participant) &&
    a.participation === b.participation &&
    a.statement === b.statement &&
    a.acceptance === b.acceptance
  );
}

function valueFor(witness: CreditOwnerWitness, property: CreditNativeProperty): unknown {
  const value = witness.value;
  switch (property) {
    case 'provider':
      return value.agent ? undefined : value.provider;
    case 'namespace':
      return value.agent ? undefined : value.namespace;
    case 'key':
      return value.agent ? undefined : value.sourceKey;
    case 'role':
      return value.role;
    case 'ordinal':
      return value.agent ? undefined : value.nativeOrdinal;
    case 'participant':
      return qualifications(witness).participant;
    // An absent predicate does not attest an explicitly absent source value.
    case 'sourceRoleKey':
      return value.sourceRoleKey ?? undefined;
    default:
      return undefined;
  }
}

function sameValue(actual: unknown, selected: unknown, property: CreditNativeProperty) {
  if (property !== 'participant') return actual === selected;
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return false;
  const participant = selected as CreditNativeParticipant;
  const keys =
    participant.kind === 'agent' ? ['kind', 'agent'] : ['kind', 'provider', 'namespace', 'key'];
  return (
    Object.keys(participant).length === keys.length &&
    keys.every((key) => Object.hasOwn(participant, key)) &&
    sameParticipant(actual as CreditNativeParticipant, participant)
  );
}

function sourceMatches(
  source: CreditNativeSourceBasis,
  support: SourceAuthorCreditSupport,
  witness: CreditOwnerWitness,
) {
  return (
    support.state === 'recorded' &&
    support.withdrawal === null &&
    support.support === source.support &&
    support.proposal === source.proposal &&
    support.conversion === source.conversion &&
    support.record === source.record &&
    support.observation === source.observation &&
    support.sourceOccurrence === source.sourceOccurrence &&
    support.sourceOrdinal === source.sourceOrdinal &&
    support.work === witness.value.work &&
    support.credit.credit === witness.value.credit &&
    support.credit.revision === witness.value.revision &&
    support.nativeReceipt === witness.receipt.receipt &&
    (support.baseSupport ?? support.support) === witness.receipt.sourceIntent &&
    support.credit.provider === witness.value.provider &&
    support.credit.namespace === witness.value.namespace &&
    support.credit.role === witness.value.role &&
    support.sourceKey === witness.value.sourceKey &&
    support.sourceRoleKey === witness.value.sourceRoleKey &&
    support.credit.nativeOrdinal === witness.value.nativeOrdinal
  );
}

/** Native-side verification only. The Source registry owns retained-byte,
 * mapping, selection, language and rights admission and its v2 certificate.
 * This function never adopts a source, invents a receipt or interprets a role.
 * At most twelve bounded native queries, plus the existing Source support read
 * when selected. Access callbacks perform no graph IO or graph admission. */
export async function verifyCreditNativeBasis(
  deps: CreditNativeVerifierDependencies,
  input: CreditNativeVerificationInput,
): Promise<CreditNativeVerificationResult> {
  // Copy before awaits: neither caller mutation nor toJSON can change a checked
  // field into a different acknowledgement in the successful result.
  let basis: CreditNativeBasis, selected: CreditNativeVerificationInput['selected'];
  try {
    basis = structuredClone(input.basis);
    selected = structuredClone(input.selected);
  } catch {
    return { disposition: 'unavailable', reason: 'invalid-credit-basis' };
  }
  const actingSubject = input.actingSubject;
  if (
    !exactKeys(basis, [
      'target',
      'component',
      'revision',
      'receipt',
      'workHead',
      'occurrence',
      'property',
      'qualifications',
      'source',
    ]) ||
    !exactKeys(selected, ['value', 'language']) ||
    ![
      basis.target,
      basis.component,
      basis.revision,
      basis.workHead,
      basis.occurrence,
      actingSubject,
    ].every((value) => typeof value === 'string' && NATIVE.test(value)) ||
    !RECEIPT.test(basis.receipt) ||
    !basis.qualifications ||
    !isNativeCreditRole(basis.qualifications.role) ||
    !exactKeys(basis.qualifications, [
      'role',
      'participant',
      'ordinal',
      'sourceRoleKey',
      'workRevision',
      'participation',
      'statement',
      'acceptance',
    ]) ||
    !basis.qualifications.participant ||
    !exactKeys(
      basis.qualifications.participant,
      basis.qualifications.participant.kind === 'agent'
        ? ['kind', 'agent']
        : ['kind', 'provider', 'namespace', 'key'],
    ) ||
    ![
      'provider',
      'namespace',
      'key',
      'role',
      'ordinal',
      'participant',
      'sourceRoleKey',
      'creditedName',
      'alias',
      'eid',
      'note',
    ].includes(basis.property) ||
    selected.language === undefined
  ) {
    return { disposition: 'unavailable', reason: 'invalid-credit-basis' };
  }
  const q = basis.qualifications;
  if (q.participation !== null || q.statement !== null || q.acceptance !== null) {
    return { disposition: 'unavailable', reason: 'qualified-credit-owner-required' };
  }
  try {
    // Current authority is checked before owner reads and again afterwards. This
    // is deliberately not called transaction-guarded or a settlement authority.
    const authority = () =>
      deps.access.withWorkEditAuthority(
        input.principal,
        actingSubject,
        basis.target,
        async (proof) => proof,
      );
    const beforeAuthority = await authority();
    const witness = await readCreditOwnerWitness(deps.environment, basis.component);
    if (!witness) return { disposition: 'unavailable', reason: 'credit-owner-unavailable' };
    if (witness.value.work !== basis.target || basis.occurrence !== witness.value.credit) {
      return { disposition: 'target-mismatch', reason: 'credit-target-differs' };
    }
    if (witness.value.revision !== basis.revision) {
      return { disposition: 'head-mismatch', reason: 'credit-head-differs' };
    }
    if (witness.receipt.receipt !== basis.receipt) {
      return { disposition: 'target-mismatch', reason: 'credit-receipt-target-differs' };
    }
    if (!sameQualifications(qualifications(witness), q)) {
      return { disposition: 'target-mismatch', reason: 'credit-participation-differs' };
    }
    const head = await readCreditOwnerHead(deps.environment, witness);
    if (!head) return { disposition: 'unavailable', reason: 'credit-owner-inactive' };
    if (head.workHead !== basis.workHead || head.creditHead !== basis.revision) {
      return { disposition: 'head-mismatch', reason: 'native-head-differs' };
    }
    if (basis.source === null && witness.receipt.sourceIntent !== witness.value.credit) {
      return { disposition: 'unavailable', reason: 'source-credit-binding-required' };
    }
    const source = async () =>
      basis.source && deps.sourceCredits
        ? deps.sourceCredits.read(beforeAuthority.principalId, basis.source.support.slice(-36))
        : null;
    let support: SourceAuthorCreditSupport | null = null;
    if (basis.source !== null) {
      if (
        !exactKeys(basis.source, [
          'support',
          'proposal',
          'conversion',
          'record',
          'observation',
          'sourceOccurrence',
          'sourceOrdinal',
        ]) ||
        !basis.source ||
        ![
          basis.source.support,
          basis.source.proposal,
          basis.source.conversion,
          basis.source.record,
          basis.source.observation,
        ].every((value) => NATIVE.test(value)) ||
        !/^urn:rezics:source-occurrence:[0-9a-f]{64}$/.test(basis.source.sourceOccurrence) ||
        !Number.isInteger(basis.source.sourceOrdinal) ||
        basis.source.sourceOrdinal < 0 ||
        basis.source.sourceOrdinal > 127
      ) {
        return { disposition: 'unavailable', reason: 'invalid-source-credit-basis' };
      }
      support = await source();
      if (!support || !sourceMatches(basis.source, support, witness)) {
        return { disposition: 'unavailable', reason: 'source-credit-binding-unavailable' };
      }
    }
    const value = valueFor(witness, basis.property);
    if (value === undefined)
      return { disposition: 'unavailable', reason: 'credit-field-not-authored' };
    if (selected.language !== null || !sameValue(value, selected.value, basis.property)) {
      return { disposition: 'value-mismatch', reason: 'credit-value-or-language-differs' };
    }
    const afterAuthority = await authority();
    if (!sameAuthority(beforeAuthority, afterAuthority)) {
      return { disposition: 'authority-denied', reason: 'credit-authority-changed' };
    }
    const current = await readCreditOwnerWitness(deps.environment, basis.component);
    if (!current) return { disposition: 'unavailable', reason: 'credit-owner-inactive' };
    if (
      current.value.revision !== basis.revision ||
      !sameQualifications(qualifications(current), q) ||
      JSON.stringify(current.receipt) !== JSON.stringify(witness.receipt)
    ) {
      return { disposition: 'head-mismatch', reason: 'credit-owner-changed' };
    }
    if (basis.source !== null) {
      const currentSupport = await source();
      if (
        !currentSupport ||
        !sourceMatches(basis.source, currentSupport, current) ||
        currentSupport.sourceGraphReceipt !== support!.sourceGraphReceipt
      ) {
        return { disposition: 'unavailable', reason: 'source-credit-binding-changed' };
      }
    }
    const currentHead = await readCreditOwnerHead(deps.environment, current);
    if (!currentHead) return { disposition: 'unavailable', reason: 'credit-owner-inactive' };
    if (currentHead.workHead !== basis.workHead || currentHead.creditHead !== basis.revision) {
      return { disposition: 'head-mismatch', reason: 'native-head-changed' };
    }
    return {
      disposition: 'verified',
      receipt: current.receipt.receipt,
      revision: current.value.revision,
      commandReceipt: current.receipt,
      nativeBasis: basis,
      value,
      language: null,
      headGuarantee: 'verified-before-commit',
    };
  } catch (error) {
    return error instanceof AdmissionDenied
      ? { disposition: 'authority-denied', reason: 'credit-authority-denied' }
      : { disposition: 'unavailable', reason: 'credit-owner-evidence-unavailable' };
  }
}

function sameAuthority(a: WorkEditAuthorityProof, b: WorkEditAuthorityProof) {
  const { validUntil: _before, ...before } = a,
    { validUntil: _after, ...after } = b;
  return JSON.stringify(before) === JSON.stringify(after);
}

function providerVerifier(provider: string, namespace: string): CreditNativeVerifier {
  return async (deps, input) => {
    const participant = input.basis?.qualifications?.participant;
    // A source person never supplies an authenticated Agent identity. The
    // registry needs a separate admitted correspondence for native participants.
    if (!participant || participant.kind !== 'external-reference') {
      return { disposition: 'unavailable', reason: 'provider-participant-correspondence-required' };
    }
    if (participant.provider !== provider || participant.namespace !== namespace) {
      return { disposition: 'target-mismatch', reason: 'credit-provider-or-namespace-differs' };
    }
    return verifyCreditNativeBasis(deps, input);
  };
}

/** Explicit registry entries; no fallback from another provider's verifier. */
export const verifyVndbCreditNativeBasis: CreditNativeVerifier = providerVerifier('vndb', 'staff');
export const verifyBangumiCreditNativeBasis: CreditNativeVerifier = providerVerifier(
  'bangumi',
  'person',
);
export const verifyMusicBrainzCreditNativeBasis: CreditNativeVerifier = providerVerifier(
  'musicbrainz',
  'artist',
);
