import { RATING_IDENTITY_PAGE_SIZE } from './identity-work-frame-limits.ts';

/** Closed work vector for one Rating identity-repair native step. Engine MVCC is outside this claim. */
export type IdentityRepairWork = Readonly<{
  rows: number;
  points: number;
  statements: number;
  bytes: number;
  emptySeeks: number;
}>;

export const IDENTITY_REPAIR_PAGE_SIZE = RATING_IDENTITY_PAGE_SIZE;
export const IDENTITY_REPAIR_MEMBERSHIP_CAP = 100;
export const IDENTITY_REPAIR_EFFECTS_PER_VOTE = 3;
export const IDENTITY_REPAIR_WINNER_PROBES_PER_VOTE = 2;
export const IDENTITY_REPAIR_MAX_EVENTS_PER_PAGE = IDENTITY_REPAIR_PAGE_SIZE * IDENTITY_REPAIR_EFFECTS_PER_VOTE + 1;
export const IDENTITY_REPAIR_MAX_CONTINUATION_EVENTS = 8;
export const IDENTITY_REPAIR_SELECTION_BYTES = 65_536;
export const IDENTITY_REPAIR_MAPPING_ORIGINALS = IDENTITY_REPAIR_PAGE_SIZE;

const zero: IdentityRepairWork = Object.freeze({
  rows: 0,
  points: 0,
  statements: 0,
  bytes: 0,
  emptySeeks: 0,
});

function work(rows: number, points: number, statements: number, bytes: number, emptySeeks: number): IdentityRepairWork {
  return Object.freeze({ rows, points, statements, bytes, emptySeeks });
}

function add(...parts: readonly IdentityRepairWork[]): IdentityRepairWork {
  return Object.freeze(
    parts.reduce(
      (total, part) => ({
        rows: total.rows + part.rows,
        points: total.points + part.points,
        statements: total.statements + part.statements,
        bytes: total.bytes + part.bytes,
        emptySeeks: total.emptySeeks + part.emptySeeks,
      }),
      { ...zero },
    ),
  );
}

function times(part: IdentityRepairWork, count: number): IdentityRepairWork {
  return work(
    part.rows * count,
    part.points * count,
    part.statements * count,
    part.bytes * count,
    part.emptySeeks * count,
  );
}

const sql = (text: string, result: number) => text.length + result;

/** One keyed point read or write, including an expected empty seek. */
export const IDENTITY_REPAIR_POINT = work(1, 1, 1, 256, 1);
export const IDENTITY_REPAIR_WRITE = work(1, 1, 1, 128, 0);
export const IDENTITY_REPAIR_CONTROL = work(0, 0, 1, 0, 0);

/**
 * Library own-account envelope on the original actor, request and deadline.
 * BEGIN, lock timeout, statement timeout, authoritative time, account SHARE,
 * account state, receipt probe, partition fence and COMMIT, plus one cleanup ROLLBACK
 * held for a failed attempt. Access preparation stays outside the resource connection.
 */
export const IDENTITY_REPAIR_COMMAND_ENVELOPE = add(
  IDENTITY_REPAIR_CONTROL,
  IDENTITY_REPAIR_CONTROL,
  IDENTITY_REPAIR_CONTROL,
  work(1, 0, 1, 40, 0),
  IDENTITY_REPAIR_POINT,
  IDENTITY_REPAIR_POINT,
  IDENTITY_REPAIR_POINT,
  work(2, 2, 1, 336, 1),
  IDENTITY_REPAIR_CONTROL,
  IDENTITY_REPAIR_CONTROL,
);

export const IDENTITY_REPAIR_NO_EFFECT_ENVELOPE = add(
  IDENTITY_REPAIR_CONTROL,
  IDENTITY_REPAIR_CONTROL,
  IDENTITY_REPAIR_CONTROL,
  work(1, 0, 1, 40, 0),
  IDENTITY_REPAIR_POINT,
  IDENTITY_REPAIR_POINT,
  IDENTITY_REPAIR_POINT,
  work(1, 1, 1, 105, 1),
  IDENTITY_REPAIR_CONTROL,
  IDENTITY_REPAIR_CONTROL,
);

/** Frame, upper-key and selected-page leaves. */
export const IDENTITY_REPAIR_FRAME_LOCK = work(1, 1, 1, sql('identity-work-frame-read', 2048), 1);
export const IDENTITY_REPAIR_FRAME_SAVE = work(1, 2, 1, sql('identity-work-frame-save', 0), 0);
export const IDENTITY_REPAIR_LIMIT = work(1, 1, 1, sql('identity-work-frame-limit', 80), 1);
export const IDENTITY_REPAIR_PAGE_VOTES = work(
  IDENTITY_REPAIR_PAGE_SIZE,
  IDENTITY_REPAIR_PAGE_SIZE,
  1,
  sql('segment-identity-page', IDENTITY_REPAIR_PAGE_SIZE * 160),
  1,
);
export const IDENTITY_REPAIR_EMPTY_PAGE_VOTES = work(0, 1, 1, sql('segment-identity-page', 0), 1);
export const IDENTITY_REPAIR_RECEIPT_READ = work(1, 1, 1, sql('identity-repair-receipt-read', 512), 1);
export const IDENTITY_REPAIR_RECEIPT_INSERT = work(1, 3, 1, sql('identity-repair-receipt-insert', 0), 0);
export const IDENTITY_REPAIR_ELIGIBILITY = work(1, 1, 1, sql('voter-state-read', 256), 1);
export const IDENTITY_REPAIR_MEMBERSHIPS = work(
  IDENTITY_REPAIR_MEMBERSHIP_CAP,
  IDENTITY_REPAIR_MEMBERSHIP_CAP,
  1,
  sql('voter-realms-capped', IDENTITY_REPAIR_MEMBERSHIP_CAP * 96),
  1,
);

/** Same-home Semantic hold: owner lock, page obligation, owners, sources, one-home control, insert. */
export const IDENTITY_REPAIR_HOLD_OWNER = work(1, 1, 1, sql('identity-rating-commit-participant-lock-owner', 96), 1);
export const IDENTITY_REPAIR_HOLD_OBLIGATION_PAGE = work(1, 1, 1, 512, 1);
export const IDENTITY_REPAIR_HOLD_OWNERS = work(1, 1, 1, sql('identity-epoch-read-owners', 96), 1);
export const IDENTITY_REPAIR_HOLD_SOURCES = work(
  IDENTITY_REPAIR_MAPPING_ORIGINALS * 4,
  IDENTITY_REPAIR_MAPPING_ORIGINALS * 4,
  1,
  sql('identity-epoch-read-sources', IDENTITY_REPAIR_MAPPING_ORIGINALS * 256),
  1,
);
export const IDENTITY_REPAIR_HOLD_CONTROL_OWNERS = work(1, 1, 1, sql('identity-epoch-read-owners', 96), 1);
export const IDENTITY_REPAIR_HOLD_CONTROL_PENDING = work(
  IDENTITY_REPAIR_MAPPING_ORIGINALS,
  IDENTITY_REPAIR_MAPPING_ORIGINALS,
  1,
  sql('identity-epoch-read-pending', IDENTITY_REPAIR_MAPPING_ORIGINALS * 96),
  1,
);
export const IDENTITY_REPAIR_HOLD_CONTROL_CURRENT = work(
  IDENTITY_REPAIR_MAPPING_ORIGINALS,
  IDENTITY_REPAIR_MAPPING_ORIGINALS,
  1,
  sql('identity-terminal-closure-current', IDENTITY_REPAIR_MAPPING_ORIGINALS * 256),
  1,
);
export const IDENTITY_REPAIR_HOLD_INSERT = work(1, 4, 1, 2048, 0);

export const IDENTITY_REPAIR_SAME_HOME_HOLD = add(
  IDENTITY_REPAIR_HOLD_OWNER,
  IDENTITY_REPAIR_HOLD_OBLIGATION_PAGE,
  IDENTITY_REPAIR_HOLD_OWNERS,
  IDENTITY_REPAIR_HOLD_SOURCES,
  IDENTITY_REPAIR_HOLD_CONTROL_OWNERS,
  IDENTITY_REPAIR_HOLD_CONTROL_PENDING,
  IDENTITY_REPAIR_HOLD_CONTROL_CURRENT,
  IDENTITY_REPAIR_HOLD_INSERT,
);

export const IDENTITY_REPAIR_EMPTY_HOLD = add(
  IDENTITY_REPAIR_HOLD_OWNER,
  IDENTITY_REPAIR_HOLD_OBLIGATION_PAGE,
  IDENTITY_REPAIR_HOLD_INSERT,
);

export const IDENTITY_REPAIR_PREPARING_HOLD = add(
  IDENTITY_REPAIR_HOLD_OWNER,
  IDENTITY_REPAIR_HOLD_OBLIGATION_PAGE,
  IDENTITY_REPAIR_HOLD_OWNERS,
  IDENTITY_REPAIR_HOLD_SOURCES,
  IDENTITY_REPAIR_HOLD_INSERT,
);

export const IDENTITY_REPAIR_COMPLETE = add(IDENTITY_REPAIR_POINT, IDENTITY_REPAIR_WRITE);

export const IDENTITY_REPAIR_VOTE_LOCK = work(1, 1, 1, sql('vote-lock', 256), 1);
export const IDENTITY_REPAIR_WINNER_LOCK = work(1, 1, 1, sql('vote-counted-target-lock', 256), 1);
export const IDENTITY_REPAIR_COUNTED_SET = work(1, 1, 1, sql('vote-counted-target-set', 256), 0);

export const IDENTITY_REPAIR_ONE_VOTE = add(
  IDENTITY_REPAIR_VOTE_LOCK,
  IDENTITY_REPAIR_WINNER_LOCK,
  times(IDENTITY_REPAIR_COUNTED_SET, IDENTITY_REPAIR_EFFECTS_PER_VOTE),
);

export const IDENTITY_REPAIR_PAGE_WRITES = add(
  IDENTITY_REPAIR_MEMBERSHIPS,
  times(IDENTITY_REPAIR_ONE_VOTE, IDENTITY_REPAIR_PAGE_SIZE),
);

export const IDENTITY_REPAIR_ADMIT = add(
  IDENTITY_REPAIR_COMMAND_ENVELOPE,
  IDENTITY_REPAIR_FRAME_LOCK,
  IDENTITY_REPAIR_LIMIT,
  IDENTITY_REPAIR_FRAME_SAVE,
);

export const IDENTITY_REPAIR_SELECT = add(
  IDENTITY_REPAIR_COMMAND_ENVELOPE,
  IDENTITY_REPAIR_FRAME_LOCK,
  IDENTITY_REPAIR_PAGE_VOTES,
  IDENTITY_REPAIR_FRAME_SAVE,
);

export const IDENTITY_REPAIR_SELECT_EMPTY = add(
  IDENTITY_REPAIR_COMMAND_ENVELOPE,
  IDENTITY_REPAIR_FRAME_LOCK,
  IDENTITY_REPAIR_EMPTY_PAGE_VOTES,
  IDENTITY_REPAIR_FRAME_SAVE,
);

export const IDENTITY_REPAIR_COMMIT_NONEMPTY = add(
  IDENTITY_REPAIR_COMMAND_ENVELOPE,
  IDENTITY_REPAIR_RECEIPT_READ,
  IDENTITY_REPAIR_FRAME_LOCK,
  IDENTITY_REPAIR_PAGE_VOTES,
  IDENTITY_REPAIR_ELIGIBILITY,
  IDENTITY_REPAIR_SAME_HOME_HOLD,
  IDENTITY_REPAIR_PAGE_WRITES,
  IDENTITY_REPAIR_RECEIPT_INSERT,
  IDENTITY_REPAIR_FRAME_SAVE,
  IDENTITY_REPAIR_COMPLETE,
);

export const IDENTITY_REPAIR_COMMIT_EMPTY = add(
  IDENTITY_REPAIR_COMMAND_ENVELOPE,
  IDENTITY_REPAIR_RECEIPT_READ,
  IDENTITY_REPAIR_FRAME_LOCK,
  IDENTITY_REPAIR_EMPTY_PAGE_VOTES,
  IDENTITY_REPAIR_ELIGIBILITY,
  IDENTITY_REPAIR_EMPTY_HOLD,
  IDENTITY_REPAIR_RECEIPT_INSERT,
  IDENTITY_REPAIR_FRAME_SAVE,
  IDENTITY_REPAIR_COMPLETE,
);

export const IDENTITY_REPAIR_COMMIT_REPLAY = add(IDENTITY_REPAIR_NO_EFFECT_ENVELOPE, IDENTITY_REPAIR_RECEIPT_READ);

export const IDENTITY_REPAIR_COMMIT_ROLLBACK = add(
  IDENTITY_REPAIR_COMMAND_ENVELOPE,
  IDENTITY_REPAIR_RECEIPT_READ,
  IDENTITY_REPAIR_FRAME_LOCK,
  IDENTITY_REPAIR_PAGE_VOTES,
  IDENTITY_REPAIR_ELIGIBILITY,
  IDENTITY_REPAIR_SAME_HOME_HOLD,
  IDENTITY_REPAIR_PAGE_WRITES,
  IDENTITY_REPAIR_RECEIPT_INSERT,
  IDENTITY_REPAIR_FRAME_SAVE,
  IDENTITY_REPAIR_COMPLETE,
);

export const IDENTITY_REPAIR_COMMIT_PENDING_EVENTS = add(
  IDENTITY_REPAIR_COMMAND_ENVELOPE,
  IDENTITY_REPAIR_RECEIPT_READ,
  IDENTITY_REPAIR_FRAME_LOCK,
  IDENTITY_REPAIR_PAGE_VOTES,
  IDENTITY_REPAIR_ELIGIBILITY,
  IDENTITY_REPAIR_PREPARING_HOLD,
);

export const IDENTITY_REPAIR_CANCEL = add(
  IDENTITY_REPAIR_COMMAND_ENVELOPE,
  IDENTITY_REPAIR_FRAME_LOCK,
  IDENTITY_REPAIR_ELIGIBILITY,
  IDENTITY_REPAIR_FRAME_SAVE,
);

export const IDENTITY_REPAIR_WITHDRAWAL_COMMIT = add(
  IDENTITY_REPAIR_COMMAND_ENVELOPE,
  IDENTITY_REPAIR_RECEIPT_READ,
  IDENTITY_REPAIR_FRAME_LOCK,
  IDENTITY_REPAIR_PAGE_VOTES,
  IDENTITY_REPAIR_ELIGIBILITY,
  IDENTITY_REPAIR_PAGE_WRITES,
  IDENTITY_REPAIR_RECEIPT_INSERT,
  IDENTITY_REPAIR_FRAME_SAVE,
);

export const IDENTITY_REPAIR_UNAVAILABLE = add(
  IDENTITY_REPAIR_COMMAND_ENVELOPE,
  IDENTITY_REPAIR_RECEIPT_READ,
  IDENTITY_REPAIR_FRAME_LOCK,
  IDENTITY_REPAIR_PAGE_VOTES,
  IDENTITY_REPAIR_ELIGIBILITY,
);

export type IdentityRepairOperation =
  | 'admit'
  | 'select'
  | 'select-empty'
  | 'commit'
  | 'commit-empty'
  | 'replay'
  | 'rollback'
  | 'pending-events'
  | 'cancel'
  | 'withdrawal'
  | 'unavailable';

export const IDENTITY_REPAIR_OPERATIONS: Readonly<Record<IdentityRepairOperation, IdentityRepairWork>> = Object.freeze({
  admit: IDENTITY_REPAIR_ADMIT,
  select: IDENTITY_REPAIR_SELECT,
  'select-empty': IDENTITY_REPAIR_SELECT_EMPTY,
  commit: IDENTITY_REPAIR_COMMIT_NONEMPTY,
  'commit-empty': IDENTITY_REPAIR_COMMIT_EMPTY,
  replay: IDENTITY_REPAIR_COMMIT_REPLAY,
  rollback: IDENTITY_REPAIR_COMMIT_ROLLBACK,
  'pending-events': IDENTITY_REPAIR_COMMIT_PENDING_EVENTS,
  cancel: IDENTITY_REPAIR_CANCEL,
  withdrawal: IDENTITY_REPAIR_WITHDRAWAL_COMMIT,
  unavailable: IDENTITY_REPAIR_UNAVAILABLE,
});

export function identityRepairWork(operation: IdentityRepairOperation): IdentityRepairWork {
  return IDENTITY_REPAIR_OPERATIONS[operation];
}

/** Anchors that stay fixed while unrelated voters, receipts or later input grow. */
export const IDENTITY_REPAIR_GROWTH_ANCHORS = Object.freeze({
  pageSize: IDENTITY_REPAIR_PAGE_SIZE,
  memberships: IDENTITY_REPAIR_MEMBERSHIP_CAP,
  effectsPerVote: IDENTITY_REPAIR_EFFECTS_PER_VOTE,
  winnerProbesPerVote: IDENTITY_REPAIR_WINNER_PROBES_PER_VOTE,
  scales: Object.freeze([256, 1024, 4096] as const),
  axes: Object.freeze(['voters', 'receipts', 'input'] as const),
});
