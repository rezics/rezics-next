/** Native Bangumi personal-list caps, verified at Commerce delivery. */
export const BANGUMI_UPLOAD_BYTES = 262_144;
export const BANGUMI_ROWS = 100;
export const BANGUMI_ROW_BYTES = 8_192;
export const BANGUMI_EVIDENCE_BYTES = 32_768;
export const BANGUMI_PAGE = 10;
export const BANGUMI_APPLY = 5;
export const BANGUMI_DEPTH = 16;
export const BANGUMI_FORMAT = 'rezics.bangumi-collection.v1';
export const SUBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const BANGUMI_MEDIA = {
  book: 'book',
  anime: 'anime',
  music: 'music',
  game: 'game',
  live_action: 'live_action',
  unknown: 'unknown',
} as const;
export const BANGUMI_ROLES = {
  planned: 'planned',
  completed: 'completed',
  active: 'active',
  paused: 'paused',
  dropped: 'dropped',
} as const;

export type BangumiMedium = (typeof BANGUMI_MEDIA)[keyof typeof BANGUMI_MEDIA];
export type BangumiStateRole = (typeof BANGUMI_ROLES)[keyof typeof BANGUMI_ROLES];
export type BangumiMatch = 'matched' | 'already_matched' | 'ambiguous' | 'unmatched' | 'unavailable' | 'chosen';
export type BangumiApplyState = 'preserve' | 'replace' | 'omit';
export type BangumiOutcomeStatus = 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed';
export type BangumiFieldMeaning = 'known' | 'unknown' | 'invalid';

export type BangumiJson = string | number | boolean | null | BangumiJson[] | { readonly [key: string]: BangumiJson };
export type BangumiRecord = { readonly [key: string]: BangumiJson };
export type BangumiRetainedField = {
  field: string;
  value: BangumiJson;
  meaning: BangumiFieldMeaning;
  reason: string;
};
export type BangumiEvidence = {
  source: BangumiRecord;
  fields: BangumiRetainedField[];
  medium: string;
  stateRole: string | null;
};
export type BangumiGuard = { subjectId: string; releaseDigest: string; identityEpoch: string };
export type BangumiCurrent = { state: string; revision: number; incarnationId?: string | null };
export type BangumiReview = {
  token: string;
  match: BangumiMatch;
  candidates: string[];
  target: string | null;
  guard: BangumiGuard | null;
  proposedState: string | null;
  current: BangumiCurrent | null;
  conflict: boolean;
};
export type BangumiChoice = {
  ordinal: number;
  reviewToken: string;
  state: BangumiApplyState;
  skip: boolean;
};
export type BangumiOutcome = {
  ordinal: number;
  status: BangumiOutcomeStatus;
  applied: string[];
  retained: string[];
};
export type BangumiRow = {
  ordinal: number;
  evidence: BangumiEvidence;
  review: BangumiReview | null;
  outcome: BangumiOutcome | null;
};
export type BangumiPage = {
  uploadId: string;
  cancelled: boolean;
  rows: BangumiRow[];
  next: number | null;
};
export type BangumiPreviewBody = { uploadId: string; count: number };
export type BangumiApplyBody = { rows: BangumiChoice[] };
export type BangumiApplyResult = { uploadId: string; outcomes: BangumiOutcome[]; remaining: number[] };

export type BangumiRowMeta = {
  ordinal: number;
  title: string;
  medium: string;
  stateRole: string | null;
  match: BangumiMatch | null;
  target: string | null;
  proposedState: string | null;
  current: BangumiCurrent | null;
  conflict: boolean;
  reviewToken: string | null;
  choice: { state: BangumiApplyState; skip: boolean };
  outcome: BangumiOutcome | null;
};

export type BangumiFailureKind =
  | 'denied'
  | 'unavailable'
  | 'malformed'
  | 'too-large'
  | 'conflict'
  | 'not-found'
  | 'idempotency';
export type BangumiFailure = { kind: BangumiFailureKind; detail?: string };

export type BangumiCommand =
  | { kind: 'preview'; key: string; upload: string }
  | { kind: 'page'; uploadId: string; after: number }
  | { kind: 'review'; key: string; uploadId: string; ordinal: number; target?: string }
  | { kind: 'apply'; uploadId: string; body: BangumiApplyBody }
  | { kind: 'cancel'; key: string; uploadId: string }
  | { kind: 'delete'; key: string; uploadId: string };

export type BangumiUnknown = { kind: 'unknown'; command: BangumiCommand };
export type BangumiPreviewResult =
  | { kind: 'previewed'; uploadId: string; count: number }
  | BangumiFailure
  | BangumiUnknown;
export type BangumiPageResult = { kind: 'page'; page: BangumiPage } | BangumiFailure | BangumiUnknown;
export type BangumiReviewResult =
  | { kind: 'reviewed'; ordinal: number; review: BangumiReview }
  | BangumiFailure
  | BangumiUnknown;
export type BangumiApplyCallResult = { kind: 'applied'; result: BangumiApplyResult } | BangumiFailure | BangumiUnknown;
export type BangumiMutateResult =
  | { kind: 'cancelled'; uploadId: string }
  | { kind: 'deleted' }
  | BangumiFailure
  | BangumiUnknown;

export type BangumiImportPort = {
  preview(command: Extract<BangumiCommand, { kind: 'preview' }>): Promise<BangumiPreviewResult>;
  page(command: Extract<BangumiCommand, { kind: 'page' }>): Promise<BangumiPageResult>;
  review(command: Extract<BangumiCommand, { kind: 'review' }>): Promise<BangumiReviewResult>;
  apply(command: Extract<BangumiCommand, { kind: 'apply' }>): Promise<BangumiApplyCallResult>;
  cancel(command: Extract<BangumiCommand, { kind: 'cancel' }>): Promise<BangumiMutateResult>;
  delete(command: Extract<BangumiCommand, { kind: 'delete' }>): Promise<BangumiMutateResult>;
};

export function newCommandKey(): string {
  return crypto.randomUUID();
}

export function quotedIdempotencyKey(key: string): string {
  return JSON.stringify(key);
}

export function sameCommand(left: BangumiCommand, right: BangumiCommand): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

export function chunkChoices(rows: BangumiChoice[], size = BANGUMI_APPLY): BangumiChoice[][] {
  const batches: BangumiChoice[][] = [];
  for (let index = 0; index < rows.length; index += size) batches.push(rows.slice(index, index + size));
  return batches;
}
