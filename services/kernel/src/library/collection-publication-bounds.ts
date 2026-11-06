import { memoizedValue } from '../memoized.ts';
/** Static limits for the retained whole-query Collection publication adapter.
 * These values describe work only; native admission, transaction lifetime and dispatch remain in Library.
 */
import { declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './contract/work-dimensions.ts';

type PrivatePublicationBound = Omit<Bound, 'engineRequests'> & Readonly<{ engineRequests: 0 }>;

const privateBound = (value: Omit<Bound, 'engineRequests'>): PrivatePublicationBound => {
  const declared = declareBound({ ...value, engineRequests: 0 });
  return Object.freeze({ ...declared, engineRequests: 0 });
};

const sumPrivateBounds = (...parts: readonly PrivatePublicationBound[]): PrivatePublicationBound => {
  const total = sumBounds(...parts);
  return Object.freeze({ ...total, engineRequests: 0 });
};

const repeatPrivateBound = (value: PrivatePublicationBound, count: number): PrivatePublicationBound => {
  const repeated = repeatBound(value, count);
  return Object.freeze({ ...repeated, engineRequests: 0 });
};

/** The existing one-attempt staging envelope, stated with every public bound axis. */
export function COLLECTION_PUBLICATION_STEP_CEILING() {
  return memoizedValue(COLLECTION_PUBLICATION_STEP_CEILING, () =>
    privateBound({
      candidateKeys: 100,
      nativeRows: 262_144,
      identityMetadataRows: 16_384,
      emptySeeks: 4_096,
      nativePoints: 4_096,
      witnessKeys: 8_192,
      statements: 8_192,
      bytes: 64 * 1024 * 1024,
    }),
  );
}

/** Convert the step envelope into the existing eight-axis execution receipt.
 * `engineRequests` is exactly zero here because an owner-source step issues no engine request. A catalogue-source
 * publication stages through Search's public producer, which reserves its statements, points, lookahead candidates
 * and bytes from this same compose allowance and reports its own `engineRequests` on the page. The Library never
 * declares those Search requests as owner work.
 */
export function collectionPublicationWorkDimensions(bound: PrivatePublicationBound): WorkDimensions {
  return Object.freeze({
    candidateKeys: bound.candidateKeys,
    nativeRows: bound.nativeRows,
    identityMetadataRows: bound.identityMetadataRows,
    emptySeeks: bound.emptySeeks,
    nativePoints: bound.nativePoints,
    witnessKeys: bound.witnessKeys,
    statements: bound.statements,
    bytes: bound.bytes,
  });
}

/**
 * Necessary work for one complete native owner closure in a first-prefix/one-subject staging branch,
 * before its canonical queries, fact probes, Search evaluation, second closure read or settlement costs.
 * The staging Search path takes the non-deferred closure. A closure with fifty originals (possible with
 * forty-nine raw canonical keys under the closure's 100-key structural fence) reserves two resolveSubject
 * disclosures for each original. This lower bound is deliberately not presented as a complete staging plan.
 */
export function collectionPublicationFrontierLowerBound() {
  const disclosurePerOriginal = privateBound({
    candidateKeys: 1,
    nativeRows: 8_192,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 128,
    witnessKeys: 0,
    statements: 128,
    bytes: 1024 * 1024,
  });
  const initialDisclosurePass = repeatPrivateBound(disclosurePerOriginal, 50);
  const finalDisclosurePass = repeatPrivateBound(disclosurePerOriginal, 50);
  const required = sumPrivateBounds(initialDisclosurePass, finalDisclosurePass);
  return Object.freeze({
    required,
    ceiling: COLLECTION_PUBLICATION_STEP_CEILING(),
    withinExistingCeiling: withinCeiling(required, COLLECTION_PUBLICATION_STEP_CEILING()),
  });
}
