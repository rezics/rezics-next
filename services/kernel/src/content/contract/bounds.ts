/** Closed Content work bounds. These allocate no ledger and import no runtime. */

export const CONTENT_PARTITION_COUNT = 4_096;
export const CONTENT_ROUTE_MAX = 65_535;
export const CONTENT_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const CONTENT_BOARD_QUERY_MAX = 8_192;
export const CONTENT_CURSOR_PAGE_MAX = 100;
export const CONTENT_RANK_BATCH_MAX = 500;
export const CONTENT_RANK_HOT_HOURS = 168;
export const CONTENT_WORKER_STEP_MS = 30_000;
export const CONTENT_WORKER_LONG_STEP_MS = 120_000;
export const CONTENT_NOTICE_READ_MS = 3_000;
export const CONTENT_AUTHORED_LANGUAGE_MAX = 128;
export const CONTENT_COLLECTION_PARTITION_MAX = 4_096;
export const CONTENT_REACTION_SCORE_MIN = -2_147_483_648;
export const CONTENT_REACTION_SCORE_MAX = 2_147_483_647;
export const CONTENT_WORK_EVENT_INDEX_MAX = 1_000;
export const CONTENT_WORK_POSITION_MAX = 9_223_372_036_854_775_807n;
export const CONTENT_WORK_EPOCH_MAX = 2_147_483_647;

export const CONTENT_BOARD_SORTS = ['newest', 'oldest', 'active', 'hot'] as const;
export type ContentBoardSort = (typeof CONTENT_BOARD_SORTS)[number];

export const CONTENT_RANK_SORTS = ['active', 'hot'] as const;
export type ContentRankSort = (typeof CONTENT_RANK_SORTS)[number];

export const CONTENT_REACTION_KINDS = ['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'] as const;
export type ContentReactionKind = (typeof CONTENT_REACTION_KINDS)[number];

export type ContentRealmVoteWeight = 1 | -1;
export type ContentRealmVotes = Readonly<Partial<Record<ContentReactionKind, ContentRealmVoteWeight>>>;

export const CONTENT_DEFAULT_REALM_VOTES: ContentRealmVotes = Object.freeze({ upvote: 1, downvote: -1 });
