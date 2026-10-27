/**
 * Derived access-path ABI, deliberately unimplemented. This is private owner storage, never membership or Access.
 * Native acceptance and exact prospective DDL/SQL live in test/library/canonical-source-fixture.ts.
 * No production migration, writer, scheduler, identity resolver or public cursor is installed here.
 */
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import type { ListingStamp } from './listing-freshness-contract.ts';

/** Reserved by the caller BEFORE dispatch; raw keys hard <=100, shared Zone aggregate <=256 including final use. */
export interface CanonicalAllowance {
  readonly reservationId: string;
  readonly rawKeys: number;
  readonly nativePoints: number;
  readonly emptySeeks: number;
  readonly statements: number;
  readonly bytes: number;
  /** TWO released 4096-home sweeps per basis read; independently reserved before dispatch. */
  readonly identityMetadataRows: number;
}

export interface CanonicalWork {
  readonly reservationId: string;
  /** Disjoint categories; their sum <= allowance.rawKeys. Repeated encounters are charged again. */
  readonly candidateKeys: number;
  readonly aliasKeys: number;
  readonly duplicateKeys: number;
  readonly lookaheadKeys: number;
  readonly internalDriverKeys: number;
  readonly nativePoints: number;
  readonly emptySeeks: number;
  readonly statements: number;
  readonly bytes: number;
  /** Actual metadata rows, including both sweeps; core-home observations also consume nativePoints. */
  readonly identityMetadataRows: number;
}

export type CanonicalAuthority =
  | { readonly kind: 'curated' }
  | { readonly kind: 'private_builtin'; readonly curatorAccountId: string }
  | { readonly kind: 'activated_output'; readonly generation: string }
  | { readonly kind: 'frozen_output'; readonly generation: string };

/**
 * References ACTUAL selected owner authority and Semantic structural digest, not partition position or readiness.
 * The digest is the SAME commitment admitted by collection-source.ts, never a store-local substitute.
 * Semantic readIdentityBasis returns {digest:string}; actual code remains an independent dependency.
 * Never derive identity digest from labels, observations, fabricated epochs, positions or a local hash of fake data.
 */
export interface CanonicalBasis {
  /** Commitment to ALL actual references below, also bound into trusted continuation. */
  readonly digest: string;
  readonly incarnation: string;
  readonly authority: CanonicalAuthority;
  /** Membership/authority fence changed atomically by source mutations; editorial-only writes do not change it. */
  readonly sourceFence: string;
  readonly identity: Readonly<{ digest: string }>;
  /** Actual admitted meaning/profile/projection commitment, null for curated. */
  readonly meaning: string | null;
}

export interface CanonicalSourceRef {
  readonly route: number;
  readonly collectionId: string;
}
export interface CanonicalCall extends CanonicalSourceRef {
  readonly deadline: number;
  readonly allowance: CanonicalAllowance;
}
export interface CanonicalBoundCall extends CanonicalCall {
  readonly basis: CanonicalBasis;
}

/** One fixed-width driver and two UUID keys; never notes, permissions, predicates or a set of visited IDs. */
export interface CanonicalRawKey {
  readonly driver: 'member' | 'entry' | 'label' | 'session' | 'copy' | 'output';
  readonly storedSubjectId: string;
  readonly factId: string;
}
/**
 * Exact owner sourceAfter handoff, 77 ASCII bytes after validation of lowercase UUIDs.
 * Ordinals 0..5 are member, entry, label, session, copy, output. Decode before SQL: encoded lexical order is
 * NOT the native (stored subject, driver, fact) order. No new public codec or nested token is defined here.
 */
export type CanonicalSourceAfter = `1:${0 | 1 | 2 | 3 | 4 | 5}:${string}:${string}`;
export interface CanonicalDerivedRow {
  readonly canonicalSubjectId: string;
  readonly key: CanonicalRawKey;
}

/** Single pending group. The canonical settled floor remains BEFORE pendingSubjectId until terminally decided. */
export interface CanonicalGroupProgress {
  readonly pendingSubjectId: string;
  readonly after: CanonicalRawKey | null;
  /** Last actually settled Semantic original, ONLY when a native alias window was consumed; absent means none. */
  readonly aliasAfter?: string | null;
  readonly generation: string;
  readonly basis: CanonicalBasis;
}

export type CanonicalNotReady = {
  readonly state: 'not_ready';
  readonly reason: 'source' | 'identity' | 'unbuilt' | 'incomplete' | 'stale' | 'allowance';
  readonly work: CanonicalWork;
};
export type CanonicalAuthorityRead =
  | CanonicalNotReady
  | {
      readonly state: 'admitted';
      readonly basis: CanonicalBasis;
      readonly observation: ListingStamp;
      readonly work: CanonicalWork;
    };
export type CanonicalReadyRead =
  | CanonicalNotReady
  | {
      readonly state: 'ready';
      readonly basis: CanonicalBasis;
      readonly generation: string;
      readonly work: CanonicalWork;
    };

/** Raw indexed candidates, not an authorized positive, complete negative, or public DTO. */
export type CanonicalGroupWindow =
  | CanonicalNotReady
  | {
      readonly state: 'ready';
      readonly rows: readonly CanonicalDerivedRow[];
      readonly examinedThrough: CanonicalRawKey | null;
      readonly exhausted: boolean;
      readonly progress: CanonicalGroupProgress;
      readonly work: CanonicalWork;
    };
export type CanonicalCandidateSeek =
  | CanonicalNotReady
  | {
      readonly state: 'ready';
      readonly subjectId: string | null;
      /** Every candidate in (afterSubjectId, coveredThrough] represented; never the raw source floor. */
      readonly coveredThrough: string | null;
      readonly exhausted: boolean;
      readonly work: CanonicalWork;
    };

export interface CanonicalRepair {
  readonly generation: string;
  readonly basis: CanonicalBasis;
  /** Durable last EXAMINED source key, including pending/rejected rows, committed with derived rows. */
  readonly after: CanonicalRawKey | null;
  readonly sourceExhausted: boolean;
}
export type CanonicalRepairRead =
  | CanonicalNotReady
  | { readonly state: 'working'; readonly repair: CanonicalRepair; readonly work: CanonicalWork };
export type CanonicalRepairStep =
  | CanonicalNotReady
  | {
      readonly state: 'working' | 'complete' | 'basis_changed';
      readonly repair: CanonicalRepair;
      readonly examined: readonly CanonicalRawKey[];
      readonly work: CanonicalWork;
    };
export type CanonicalPublication =
  | CanonicalNotReady
  | { readonly state: 'published' | 'basis_changed' | 'incomplete'; readonly work: CanonicalWork };

/**
 * Source/identity observation precedes repair. It does not authorize source or subject disclosure.
 * Reserve 8192 metadata rows PLUS core-home points per readIdentityBasis, including prepare/final/continuation.
 * Caller instrumentation settles actual statements/points/bytes/empty seeks even when the call throws;
 * neither unused reservation nor failed/partial sweeps may be reported as invented successful work/readiness.
 */
export async function observeCanonicalSource(_pool: Pool, _input: CanonicalCall): Promise<CanonicalAuthorityRead> {
  throw new ProblemError('dependency_unavailable');
}
/** Admit only a complete current generation at the actual selected source + structural identity basis. */
export async function readCanonicalSourceState(_pool: Pool, _input: CanonicalCall): Promise<CanonicalReadyRead> {
  throw new ProblemError('dependency_unavailable');
}
/** Strict > canonical seek, LIMIT 1; skips an entire equivalence range by B-tree, not DISTINCT/GROUP BY. */
export async function seekCanonicalSourceGroup(
  _pool: Pool,
  _input: CanonicalBoundCall & { generation: string; afterSubjectId: string | null },
): Promise<CanonicalCandidateSeek> {
  throw new ProblemError('dependency_unavailable');
}
/**
 * Strict (stored subject, driver, fact) seek within ONE group; limit before residual/Access, no hidden +1.
 * Every encountered raw row is charged, including duplicates. An exact-sized window may conservatively need
 * an empty seek on resume to prove EOF. No unreserved lookahead is permitted, even at quota one.
 */
export async function readCanonicalSourceGroup(
  _pool: Pool,
  _input: CanonicalBoundCall & { progress: CanonicalGroupProgress },
): Promise<CanonicalGroupWindow> {
  throw new ProblemError('dependency_unavailable');
}
/** Idempotently recover a same-basis working generation/checkpoint, or boundedly abandon the incompatible build. */
export async function beginCanonicalSourceRepair(
  _pool: Pool,
  _input: CanonicalBoundCall,
): Promise<CanonicalRepairRead> {
  throw new ProblemError('dependency_unavailable');
}
/** Read source raw keyset BEFORE residual/pending filtering; rows and checkpoint commit atomically by expected CAS. */
export async function repairCanonicalSourceStep(
  _pool: Pool,
  _input: CanonicalBoundCall & { repair: CanonicalRepair },
): Promise<CanonicalRepairStep> {
  throw new ProblemError('dependency_unavailable');
}
/**
 * Bounded CAS of a COMPLETE build. Recheck actual selected authority/fence and independently read identity digest.
 * Lock the source fence at publication; readers re-admit identity digest (no impossible cross-home SQL snapshot).
 * A membership/delete race changes that fence in its own native transaction; stale repair cannot resurrect facts.
 * Identity can change after a digest read: ready pointers alone grant no readiness; read/final-use fencing is required.
 */
export async function publishCanonicalSourceRepair(
  _pool: Pool,
  _input: CanonicalBoundCall & { repair: CanonicalRepair },
): Promise<CanonicalPublication> {
  throw new ProblemError('dependency_unavailable');
}

/**
 * Implementation handoff: each slice <=400 production lines and <=8 paths, independent exports above.
 * Paths are relative to services/kernel. Native tests remain the two acceptance files and fixture in test/library.
 * Unqualified production filenames within each list continue its src/library directory.
 * 1. Curated fence/schema (8): db/library/schema.sql, db/library/migrations/<timestamp>_canonical_source.sql,
 *    src/library/collection-store-collection-member-insert.sql, collection-store-collection-member-delete.sql,
 *    collection-store-collection-tombstone.sql, canonical-source-store.ts, and the two acceptance test files.
 * 2. Range DAO (7): src/library/canonical-source-store.ts, canonical-source-state.sql,
 *    canonical-source-candidate.sql, canonical-source-group.sql, canonical-source-observe.sql, and both test files.
 * 3. Repair DAO (8): src/library/canonical-source-repair.ts, canonical-source-repair-source.sql,
 *    canonical-source-repair-checkpoint.sql, canonical-source-repair-begin.sql, canonical-source-repair-publish.sql,
 *    canonical-source-store.ts, and both test files. No workflow in this slice.
 * 4. Durable orchestration (4): src/library/canonical-source-work.ts, work-module.ts, work.ts,
 *    test/library/canonical-source-work.test.ts; invoke existing native durable workflows, no local scheduler.
 * 5. Entry driver (5): src/library/canonical-source-entry.ts, canonical-source-entry.sql,
 *    canonical-source-store.ts, and both acceptance files. Requires the native entry owner's actual fact fence.
 * 6. Copy driver (5): src/library/canonical-source-copy.ts, canonical-source-copy.sql,
 *    canonical-source-store.ts, and both acceptance files. Requires native copy fence and subject/copy repair index.
 * 7. Session driver (5): src/library/canonical-source-session.ts, canonical-source-session.sql,
 *    canonical-source-store.ts, and both acceptance files. Requires native session fence and subject/session index.
 * 8. Label driver (5): src/library/canonical-source-label.ts, canonical-source-label.sql,
 *    canonical-source-store.ts, and both acceptance files. Blocked until the independent-label owner exists.
 * 9. Published/frozen reader (5): src/library/canonical-source-output.ts, canonical-source-output.sql,
 *    canonical-source-store.ts, and both acceptance files. Requires complete activation/freeze authority first.
 * Each driver uses its owner's native fact/generation authority; these slices create no new fact authority.
 * Builtin raw repair visits drivers serially, with a strict (stored subject,fact) range in each driver. The durable
 * driver identifies the current source, so EOF switches sources boundedly; it never restarts previous history.
 * Group reads instead use the single derived (stored subject,driver,fact) index. Every source/empty seek is charged.
 * Actual independent Semantic prerequisites (no runtime imports until their real code lands):
 * identity-basis.ts readIdentityBasis(pool,{deadline}) -> ready{basis:{digest}} | not_ready, two 4096-home sweeps;
 * identity-maintenance.ts readSealedSubjectIdentity(client,original) -> ready{terminal,home} | not_ready | null.
 * The sealed point is actor-neutral trusted metadata on the supplied source-home RR client, no Access/pool/walk.
 * Map hidden/denied originals too; missing/unsealed metadata is NEVER canonical=self or permission to drop a key.
 * Read the actual full ready basis before repair and independently re-admit it before publication/continuation.
 * terminal-identity.ts readTerminalSubjectIdentity(pool,id,{access,actor,deadline,nativeT?}) -> ready{id,components}
 * | not_ready | null; nativeT is the SAME actual opaque core T, with original AND terminal Access.
 * alias-group.ts readSubjectAliasGroup(pool,{terminal,basis:{digest},after,limit,deadline}) -> not_ready |
 * basis_changed | ready{originals,after,exhausted,examined,points}. Raw originals confer no permission.
 * Limit 100 can examine 101 including lookahead: reserve that work or request a smaller native alias window so
 * ALL source/alias/internal/re-read/final keys still fit owner <=100 and shared Zone <=256. A fetched suffix is
 * not settled: preserve aliasAfter before unchecked originals and charge their reread. sourceAfter is independent.
 * Structural write hooks are prerequisites too. Existing reference/version/type helpers remain unchanged.
 * The public owner ABI remains collection-source.ts; no second adapter is defined here.
 *
 * Mutation/convergence: every membership/authority change atomically fences the working and ready bases. Restart
 * uses a new generation and raw keyset from the start; no scan/delete of previous generations on the mutation path.
 * At finite quiescence, finite indexed source keys advance until EOF, then one admissible CAS publishes. Pending
 * mappings keep incomplete explicit until native maintenance settles; neither skipping pending keys nor fake EOF
 * proves completeness. An EOF build with pending mappings must restart boundedly after readiness recovers, even
 * if the admitted digest is unchanged: abandon its generation in O(1), then examine raw keys again in bounded steps.
 * Private source purge erases its derived generations/progress with the private source;
 * public freeze selects last COMPLETELY published A, never private working B. No account restore protocol.
 *
 * Exact shared after: [basisDigest,settledCanonicalId,groupId,sourceOrdinal,aliasAfter,sourceAfter,
 * ownerBasisDigest,formatVersion]. Format is 1, absent strings are ''. The owner digest is this SAME basis.digest;
 * bind Collection/incarnation/authority/generation/query meaning in it, not a ninth field or fake position.
 * Owner/Zone encrypt and bind with tokens/list-cursor.ts. No browser raw IDs, permissions, seen sets, nested tokens
 * or permanent negative cache. Direct containsSubject resumes this same group. Native source/original/terminal
 * Access and actual positive fact are revalidated at FINAL use; late grants behind progress require fresh traversal.
 */
