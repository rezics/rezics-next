export type IdentityRatingVisibility = 'visible' | 'hidden' | 'taken_down';

export type IdentityRatingRepairScope = Readonly<{
  subjectId: string;
  visibility: IdentityRatingVisibility;
  securityRevision: string;
}>;

export type IdentityRatingCursor = string | null;

/** Identity of retained native work, independent of a scheduler's delivery number. */
export type IdentityRatingNativeFrontier = Readonly<{
  frontier: string;
  phase: string;
  revision: string;
}>;

export type IdentityRatingWorkItem = Readonly<{
  id: string;
  revision: string;
  targetId: string;
  units: number | null;
}>;

/**
 * A page is an immutable selection. `ownerRevision` is monotonic across owner changes, including
 * an owner moving away and then back; comparing only ownerId would admit an ABA race.
 */
export type IdentityRatingSelectedPage = Readonly<{
  pageId: string;
  ownerId: string;
  ownerRevision: string;
  identityEpoch: string;
  after: IdentityRatingCursor;
  next: IdentityRatingCursor;
  terminal: boolean;
  items: readonly IdentityRatingWorkItem[];
  native?: IdentityRatingNativeFrontier;
}>;

export type IdentityRatingPageBinding = Readonly<{
  subjectId: string;
  pageId: string;
  digest: string;
  ownerId: string;
  ownerRevision: string;
  identityEpoch: string;
  after: IdentityRatingCursor;
  next: IdentityRatingCursor;
  terminal: boolean;
  native?: IdentityRatingNativeFrontier;
}>;

export type IdentityRatingCommitReceipt = Readonly<{
  pageId: string;
  selectionDigest: string;
  ownerId: string;
  ownerRevision: string;
  identityEpoch: string;
  transactionId: string;
  position: string;
  terminal: boolean;
}>;

export type IdentityRatingCommitResult =
  | Readonly<{ status: 'committed'; receipt: IdentityRatingCommitReceipt }>
  | Readonly<{ status: 'pending'; reason: 'owner-aba' | 'redirect-chain' | 'epoch-pending' | 'source-pending' }>;

export type IdentityRatingProvenanceResult =
  | 'reclaimed'
  | 'still-referenced'
  | 'already-reclaimed'
  | 'stale'
  | 'continuing';

/** Persist with the caller's continuation. These fields locate evidence, never authorize effects. */
export type IdentityRatingRepairCheckpoint = Readonly<{
  scope: IdentityRatingRepairScope;
  phase: 'repair' | 'reclamation' | 'complete';
  binding: IdentityRatingPageBinding & Readonly<{ native: IdentityRatingNativeFrontier }>;
  receipt: IdentityRatingCommitReceipt;
}>;

export const IDENTITY_RATING_PAGE_LIMIT = 64;
export const IDENTITY_RATING_REPAIR_PAGE_LIMIT = 8;
export const IDENTITY_RATING_TEXT_BYTES = 256;
export const IDENTITY_RATING_SELECTION_BYTES = 65_536;

/**
 * Native Performance boundary. Implementations persist selected-page receipts with the effect in
 * one transaction. A commit must recheck the selected owner revision, perform at most one indexed
 * redirect lookup, and stay pending on a second redirect or an open identity epoch. Receipt reads
 * and acknowledgement make a page safe to replay after a process interruption.
 */
export type IdentityRatingParent = Readonly<{
  /** Native checkpoint committed with acknowledgement, retained even after payload deletion. */
  readRepairCheckpoint?(input: IdentityRatingRepairScope): Promise<IdentityRatingRepairCheckpoint | null>;
  // A replay binding selects its exact retained page even if acknowledgement advanced the frontier.
  selectPage(
    input: IdentityRatingRepairScope,
    limit: number,
    replay?: IdentityRatingPageBinding,
  ): Promise<IdentityRatingSelectedPage>;
  readCommitReceipt(binding: IdentityRatingPageBinding): Promise<IdentityRatingCommitReceipt | null>;
  commitSelectedPage(
    input: IdentityRatingRepairScope,
    page: IdentityRatingSelectedPage,
    binding: IdentityRatingPageBinding,
  ): Promise<IdentityRatingCommitResult>;
  verifyCommitReceipt(
    input: IdentityRatingRepairScope,
    page: IdentityRatingSelectedPage,
    binding: IdentityRatingPageBinding,
    receipt: IdentityRatingCommitReceipt,
  ): Promise<boolean>;
  acknowledgeSelectedPage(
    input: IdentityRatingRepairScope,
    page: IdentityRatingSelectedPage,
    binding: IdentityRatingPageBinding,
    receipt: IdentityRatingCommitReceipt,
  ): Promise<boolean>;
  reclaimFinalProvenance(
    input: IdentityRatingRepairScope,
    terminalReceipt: IdentityRatingCommitReceipt,
  ): Promise<IdentityRatingProvenanceResult>;
  /** Full-key native tombstone verification after page payload reclamation. Recheck owner incarnation
   * and scope, digest and receipt. A serialized checkpoint alone is never a successful replay. */
  verifyReclaimedCheckpoint?(
    input: IdentityRatingRepairScope,
    checkpoint: IdentityRatingRepairCheckpoint,
  ): Promise<'current' | 'stale' | 'pending'>;
}>;
