/** Closed work vector for one Rating identity-repair native step. Engine MVCC is outside this claim. */
export type IdentityRepairWork = Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_PAGE_SIZE = 64;
export declare const IDENTITY_REPAIR_MEMBERSHIP_CAP = 100;
export declare const IDENTITY_REPAIR_EFFECTS_PER_VOTE = 3;
export declare const IDENTITY_REPAIR_WINNER_PROBES_PER_VOTE = 2;
export declare const IDENTITY_REPAIR_MAX_EVENTS_PER_PAGE: number;
export declare const IDENTITY_REPAIR_MAX_CONTINUATION_EVENTS = 8;
export declare const IDENTITY_REPAIR_SELECTION_BYTES = 65536;
export declare const IDENTITY_REPAIR_MAPPING_ORIGINALS = 64;
/** One keyed point read or write, including an expected empty seek. */
export declare const IDENTITY_REPAIR_POINT: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_WRITE: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_CONTROL: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
/**
 * Library own-account envelope on the original actor, request and deadline.
 * BEGIN, lock timeout, statement timeout, authoritative time, account SHARE,
 * account state, receipt probe, partition fence and COMMIT, plus one cleanup ROLLBACK
 * held for a failed attempt. Access preparation stays outside the resource connection.
 */
export declare const IDENTITY_REPAIR_COMMAND_ENVELOPE: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_NO_EFFECT_ENVELOPE: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
/** Frame, upper-key and selected-page leaves. */
export declare const IDENTITY_REPAIR_FRAME_LOCK: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_FRAME_SAVE: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_LIMIT: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_PAGE_VOTES: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_EMPTY_PAGE_VOTES: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_RECEIPT_READ: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_RECEIPT_INSERT: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_ELIGIBILITY: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_MEMBERSHIPS: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
/** Same-home Semantic hold: owner lock, page obligation, owners, sources, one-home control, insert. */
export declare const IDENTITY_REPAIR_HOLD_OWNER: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_HOLD_OBLIGATION_PAGE: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_HOLD_OWNERS: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_HOLD_SOURCES: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_HOLD_CONTROL_OWNERS: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_HOLD_CONTROL_PENDING: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_HOLD_CONTROL_CURRENT: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_HOLD_INSERT: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_SAME_HOME_HOLD: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_EMPTY_HOLD: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_PREPARING_HOLD: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_COMPLETE: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_VOTE_LOCK: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_WINNER_LOCK: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_COUNTED_SET: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_ONE_VOTE: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_PAGE_WRITES: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_ADMIT: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_SELECT: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_SELECT_EMPTY: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_COMMIT_NONEMPTY: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_COMMIT_EMPTY: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_COMMIT_REPLAY: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_COMMIT_ROLLBACK: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_COMMIT_PENDING_EVENTS: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_CANCEL: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_WITHDRAWAL_COMMIT: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const IDENTITY_REPAIR_UNAVAILABLE: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export type IdentityRepairOperation = 'admit' | 'select' | 'select-empty' | 'commit' | 'commit-empty' | 'replay' | 'rollback' | 'pending-events' | 'cancel' | 'withdrawal' | 'unavailable';
export declare const IDENTITY_REPAIR_OPERATIONS: Readonly<Record<IdentityRepairOperation, IdentityRepairWork>>;
export declare function identityRepairWork(operation: IdentityRepairOperation): IdentityRepairWork;
/** Anchors that stay fixed while unrelated voters, receipts or later input grow. */
export declare const IDENTITY_REPAIR_GROWTH_ANCHORS: Readonly<{
    pageSize: 64;
    memberships: 100;
    effectsPerVote: 3;
    winnerProbesPerVote: 2;
    scales: readonly [256, 1024, 4096];
    axes: readonly ["voters", "receipts", "input"];
}>;
