/** Specification ABI only. No membership, identity, publication or Access implementation lives here. */
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import type { CollectionMemberRow, CollectionRow } from './collection-model.ts';
import type { ListingStamp } from './listing-freshness-contract.ts';

/** Shared caller-ledger dimensions. These types allocate no budget and implement no ledger. */
export interface WorkDimensions {
  readonly candidateKeys: number;
  /** Shared Source.rows unit: charged plan-proved row-work upper bound; observed physical rows are measured separately. */
  readonly nativeRows: number;
  /** TWO independently released 4096-home sweeps per full Semantic basis read; not candidate work. */
  readonly identityMetadataRows: number;
  readonly emptySeeks: number;
  readonly nativePoints: number;
  readonly witnessKeys: number;
  readonly statements: number;
  readonly bytes: number;
}

/** Reserved BEFORE dispatch, from the ONE Search/Zone request ledger; all dimensions are finite integers >= 0. */
export interface WorkAllowance {
  readonly reservationId: string;
  readonly remaining: WorkDimensions;
}

/**
 * Every used dimension <= its reservation. `used.nativeRows` sums charged per-operation plan bounds, not observed
 * physical tuples. Failures settle consumed dispatched work through caller instrumentation; unused reservation is
 * never reported as spent.
 */
export interface WorkReceipt {
  readonly reservationId: string;
  readonly used: WorkDimensions;
}

export interface CollectionSourceContext {
  readonly actor: Actor;
  /** Core-minted opaque T for this native read; never a request Date or a cast string. */
  readonly at: AuthoritativeTime;
  /** Existing absolute execution deadline, never renewed by an owner refill. */
  readonly deadline: number;
}

/** Exact structural reference assignable from Semantic's IdentityBasis; no second brand or identity authority. */
export type NativeIdentityBasis = Readonly<{ digest: string }>;

export interface CollectionSourceBasis {
  /** Commitment to the ACTUAL native query/meaning/profile/identity/projection compatibility inputs below. */
  readonly digest: string;
  readonly identity: NativeIdentityBasis;
  readonly query: string | null;
  readonly profilePins: readonly string[];
  readonly projection: string | null;
}

/** Authority references only; no query body, facts or permission claims. Private server-side evidence. */
export type CollectionSourceAuthority =
  | { readonly kind: 'curated' }
  | { readonly kind: 'private_builtin'; readonly curatorAccountId: CollectionRow['curatorAccountId'] }
  | { readonly kind: 'activated_output'; readonly generation: string }
  | { readonly kind: 'frozen_output'; readonly generation: string };

export interface CollectionSourceObservation {
  readonly collectionId: CollectionRow['collectionId'];
  readonly route: CollectionRow['route'];
  /** Actual owner incarnation reference, not a newly invented revision counter. */
  readonly incarnation: string;
  readonly revision: CollectionRow['revision'];
  readonly authority: CollectionSourceAuthority;
  /** Native partition observation, NOT structural meaning or a cross-page snapshot. */
  readonly stamp: ListingStamp;
  readonly basis: CollectionSourceBasis;
}

declare const preparedSource: unique symbol;
/** Not an allow capability. EVERY operation reauthorizes actor/source/required subject anchors currently. */
export interface PreparedCollectionSource {
  readonly [preparedSource]: true;
  readonly observation: CollectionSourceObservation;
}

declare const nativeEvidence: unique symbol;
/** Owner evidence reference; no public DTO/debug serialization. Not a fake Search Hit. */
export type CollectionSourceEvidence = { readonly [nativeEvidence]: true };

export interface CanonicalCollectionCandidate {
  /** Ascending canonical subject ID; independent of the stored evidence key(s). */
  readonly subjectId: string;
  /** Real native membership/alias evidence; does not assert current viewer readability. */
  readonly evidence: CollectionSourceEvidence;
}

export interface CanonicalCollectionPrefix {
  readonly kind: 'canonical_subject_prefix';
  readonly candidates: readonly CanonicalCollectionCandidate[];
  /** Every canonical candidate in (afterSubjectId, coveredThrough] is represented, BEFORE filtering. */
  readonly coveredThrough: string | null;
  readonly exhausted: boolean;
  readonly observation: CollectionSourceObservation;
  readonly work: WorkReceipt;
}

export interface RawStoredCollectionPrefix {
  readonly kind: 'raw_stored_subject_prefix';
  /** Strict stored-ID seeks or quota-bounded raw batches. Never canonical normalization. */
  readonly storedSubjectIds: readonly CollectionMemberRow['subjectId'][];
  readonly storedCoveredThrough: CollectionMemberRow['subjectId'] | null;
  readonly storedExhausted: boolean;
  readonly observation: CollectionSourceObservation;
  readonly work: WorkReceipt;
}

/** Fixed native drivers: member, entry, label, session, copy, output, respectively. No predicate/profile vector. */
export type CollectionSourceDriverOrdinal = 0 | 1 | 2 | 3 | 4 | 5;
/**
 * Format 1: driver + stored subject UUID + occurrence/fact UUID, exactly 77 ASCII bytes.
 * Validate canonical lowercase UUIDs and decode to the native tuple before seeking. SQL orders real columns
 * (canonical subject, stored subject, driver, fact), NEVER this encoded string. Store owns validation/SQL.
 */
export type CollectionSourceAfter = `1:${CollectionSourceDriverOrdinal}:${string}:${string}`;

/**
 * Trusted internal handoff for ONE unfinished canonical group, reconstructible after shared cursor decode.
 * Never a permission, public DTO, seen set or nested token. See the exact eight-key mapping in the owner contract.
 */
export interface CollectionAliasProgress {
  readonly subjectId: string;
  /** Collection/source incarnation, authority and structural compatibility commitment; compare before any seek. */
  readonly basisDigest: CollectionSourceBasis['digest'];
  /** Last actually SETTLED Semantic original key, never a fetched but unchecked suffix/lookahead. */
  readonly aliasAfter: string | null;
  /** Last settled native source tuple; independent from aliasAfter and retained while its alias is unfinished. */
  readonly sourceAfter: CollectionSourceAfter | null;
}

interface MembershipResultBase {
  readonly subjectId: string;
  readonly observation: CollectionSourceObservation;
  readonly work: WorkReceipt;
}

export type CollectionSubjectMembership = MembershipResultBase &
  (
    | {
        readonly result: true;
        /** Current native membership AND all required original/terminal subject Access; revalidate before disclosure. */
        readonly positiveEvidence: CollectionSourceEvidence;
      }
    | {
        readonly result: false;
        /** Complete negative at the admitted basis; an exact stored-ID miss alone is insufficient. */
        readonly negativeEvidence: CollectionSourceEvidence;
      }
    | {
        readonly result: 'not_proven';
        readonly reason: 'allowance' | 'identity' | 'native_evidence' | 'owner_repair';
        /** Non-null only after real raw keyset progress; null requires owner repair/readiness, not an empty loop. */
        readonly progress: CollectionAliasProgress | null;
      }
  );

export interface PrepareCollectionSource extends CollectionSourceContext {
  readonly collectionId: string;
  /** Preparation metadata/Access work also consumes admitted dimensions; no candidates before authorization. */
  readonly allowance: WorkAllowance;
}

export interface CollectionSourceCall extends CollectionSourceContext {
  readonly source: PreparedCollectionSource;
  readonly allowance: WorkAllowance;
}

export interface ContainsCollectionSubject extends CollectionSourceCall {
  readonly subjectId: string;
  /** Same group/source basis only. Current source, original and terminal authorization is always repeated. */
  readonly progress?: CollectionAliasProgress;
  /**
   * Optional previously observed witness key. The owner validates its subject/source/basis binding and treats it
   * as a lookup hint only: current Collection authorization and membership plus original/terminal Access are
   * reread at `at`.
   */
  readonly positiveEvidence?: CollectionSourceEvidence;
}

export interface CollectionSource {
  prepare(input: PrepareCollectionSource): Promise<{ source: PreparedCollectionSource; work: WorkReceipt }>;
  prefix(input: CollectionSourceCall & { readonly afterSubjectId: string | null }): Promise<CanonicalCollectionPrefix>;
  containsSubject(input: ContainsCollectionSubject): Promise<CollectionSubjectMembership>;
  readRawStoredPrefix(
    input: CollectionSourceCall & { readonly afterStoredSubjectId: string | null },
  ): Promise<RawStoredCollectionPrefix>;
}

/**
 * Explicit unimplemented factory. Export presence is NOT native readiness.
 * See docs/collection-source.md and the real-driver outcome suite. No queries, mutations or fake empty results.
 */
export function createCollectionSource(_dependencies: {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
}): CollectionSource {
  const unavailable = async (): Promise<never> => {
    throw new ProblemError('dependency_unavailable');
  };
  return {
    prepare: unavailable,
    prefix: unavailable,
    containsSubject: unavailable,
    readRawStoredPrefix: unavailable,
  };
}
