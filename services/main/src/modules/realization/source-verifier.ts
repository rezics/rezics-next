import type { SemanticValue } from '../semantic/value.ts';
import { RV, type WorkActivationEnvironment } from '../work/activate.ts';
import { verifyReleaseRealizationCorrespondence } from '../release/source-verifier.ts';
import type { RealizationRecord } from './schema.ts';
import {
  releaseNativeFailure,
  releaseNativeValueMatches,
  type RealizationSourceNativeBasis,
  type ReleaseSourceVerification,
  type ReleaseSourceVerificationInput,
} from '../source/release-native-verifier.ts';

export function realizationSourceProperty(
  basis: RealizationSourceNativeBasis,
  record: RealizationRecord,
): SemanticValue | undefined {
  const string = (lexical: string): SemanticValue => ({ kind: 'string', lexical });
  switch (basis.property.predicate) {
    case `${RV}contentLanguage`:
      return string(record.language);
    case `${RV}realizationKind`:
      return string(record.kind);
    case `${RV}realizationStatus`:
      return string(record.status);
    case `${RV}verification`:
      return string(record.verification);
    case `${RV}translator`:
      return basis.property.value.kind === 'resource' &&
        record.translators.includes(basis.property.value.ref)
        ? basis.property.value
        : undefined;
    default:
      return undefined;
  }
}

/** The supporting release and covered exact revision are mandatory, including
 * their own actual receipts and independently expected current heads. */
export async function verifyRealizationSourceNative(
  env: WorkActivationEnvironment,
  input: ReleaseSourceVerificationInput<RealizationSourceNativeBasis>,
): Promise<ReleaseSourceVerification<RealizationSourceNativeBasis, 'realization'>> {
  const native = structuredClone(input.native),
    selected = structuredClone(input.selected);
  if (native.owner !== 'realization' || native.kind !== 'component-property') {
    return releaseNativeFailure('target-mismatch', 'realization-property-basis-required');
  }
  const proof = await verifyReleaseRealizationCorrespondence(env, {
    principal: input.principal,
    actingSubject: input.actingSubject,
    target: native.target,
    release: native.release,
    realization: native,
    completeness: native.completeness,
  });
  if (proof.status !== 'available') return proof;
  if (
    !releaseNativeValueMatches(
      native.property,
      selected,
      realizationSourceProperty(native, proof.realization.record),
    )
  ) {
    return releaseNativeFailure(
      'value-mismatch',
      'realization-selected-property-differs-or-is-unrepresented',
    );
  }
  return {
    status: 'verified',
    receipt: proof.realization.receipt,
    revision: native.revision,
    native,
    selected,
    headGuarantee: 'verified-before-commit',
    currentHeads: { release: proof.release.head, realization: proof.realization.head },
    correspondence: {
      work: native.target,
      release: native.release,
      realization: {
        component: native.component,
        revision: native.revision,
        receipt: native.receipt,
        expectedHead: native.expectedHead,
      },
      completeness: native.completeness,
      language: proof.realization.record.language,
    },
  };
}
