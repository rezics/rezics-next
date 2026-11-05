/** Static limits for the retained whole-query Collection publication adapter.
 * These values describe work only; native admission, transaction lifetime and dispatch remain in Library.
 */
import {
  declareBound,
  repeatBound,
  sumBounds,
  withinCeiling,
  type Bound,
} from '@rezics/bounds';
import type { WorkDimensions } from './collection-source.ts';

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
export const COLLECTION_PUBLICATION_STEP_CEILING = privateBound({
  candidateKeys: 100,
  nativeRows: 262_144,
  identityMetadataRows: 16_384,
  emptySeeks: 4_096,
  nativePoints: 4_096,
  witnessKeys: 8_192,
  statements: 8_192,
  bytes: 64 * 1024 * 1024,
});

/** Convert only the statically private-only plan into the existing eight-axis execution receipt.
 * `engineRequests` is exactly zero because the admitted plan contains owner leaves only; a public catalogue
 * leaf is refused before scope preparation, so no engine request can be hidden by this adapter.
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
 * Necessary work for a first-prefix/one-subject staging branch, before accounting for its other fixed costs.
 * The source prefix admits at most sixteen canonical candidates. One whole owner closure admits up to one
 * one hundred original/fact keys. The branch with fifty originals can contain forty-nine raw canonical keys and
 * forty-nine fact keys, for ninety-eight owner-closure keys total; each original's retained identity disclosure
 * reserves 8,192 rows. The native fact query reserves `32 * remaining + 32` rows per original.
 * This lower bound is deliberately not presented as a complete staging plan.
 */
export function collectionPublicationFrontierLowerBound() {
  const prefixCandidates = privateBound({
    candidateKeys: 16,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  });
  const wholeOwnerClosure = privateBound({
    candidateKeys: 98,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  });
  const disclosurePerOriginal = privateBound({
    candidateKeys: 0,
    nativeRows: 8_192,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  });
  const factQueryPerRemainingKey = privateBound({
    candidateKeys: 0,
    nativeRows: 32,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  });
  const factQueryFixed = privateBound({
    candidateKeys: 0,
    nativeRows: 32,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  });
  const factQueryRows = sumPrivateBounds(
    repeatPrivateBound(factQueryPerRemainingKey, (50 * 51) / 2),
    repeatPrivateBound(factQueryFixed, 50),
  );
  const required = sumPrivateBounds(
    prefixCandidates,
    wholeOwnerClosure,
    repeatPrivateBound(disclosurePerOriginal, 50),
    factQueryRows,
  );
  return Object.freeze({
    required,
    ceiling: COLLECTION_PUBLICATION_STEP_CEILING,
    withinExistingCeiling: withinCeiling(required, COLLECTION_PUBLICATION_STEP_CEILING),
  });
}

