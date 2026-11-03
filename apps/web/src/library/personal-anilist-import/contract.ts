/** Native AniList personal-list caps, verified at Commerce delivery. */
export const ANILIST_UPLOAD_BYTES = 1_048_576;
export const ANILIST_ROWS = 200;
export const ANILIST_PAGE = 20;
export const ANILIST_APPLY = 20;
export const ANILIST_DEPTH = 24;
export const ANILIST_ROW_BYTES = 65_536;
export const ANILIST_ROW_FIELDS = 128;
export const ANILIST_FIELD_NAME = 100;
export const ANILIST_GROUP_BYTES = 8_192;
export const ANILIST_UPLOADS = 5;
export const SUBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ANILIST_SCORE_FORMATS = ['POINT_100', 'POINT_10_DECIMAL', 'POINT_10', 'POINT_5', 'POINT_3'] as const;
export const ANILIST_STATUSES = ['CURRENT', 'PLANNING', 'COMPLETED', 'DROPPED', 'PAUSED', 'REPEATING'] as const;
export const ANILIST_ROLES = {
  CURRENT: 'active',
  PLANNING: 'planned',
  COMPLETED: 'completed',
  DROPPED: 'dropped',
  PAUSED: 'paused',
} as const;

export type AniListScoreFormat = (typeof ANILIST_SCORE_FORMATS)[number];
export type AniListStatus = (typeof ANILIST_STATUSES)[number];
export type AniListMatchState = 'matched' | 'ambiguous' | 'unmatched' | 'unavailable';
export type AniListOutcomeStatus = 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed';
export type AniListFieldValidity = 'valid' | 'unknown' | 'invalid';
export type AniListWrapper = 'array' | 'lists' | 'MediaListCollection' | 'data' | 'unknown';
export type AniListJson = string | number | boolean | null | AniListJson[] | { readonly [key: string]: AniListJson };
export type AniListRecord = { readonly [key: string]: AniListJson };

export type AniListIdentifier = { source: 'anilist' | 'myanimelist'; externalId: string };
export type AniListSourceField = { field: string; validity: AniListFieldValidity; reason: string };
export type AniListSource = {
  evidence: AniListRecord;
  group: AniListRecord | null;
  identifiers: AniListIdentifier[];
  fields: AniListSourceField[];
};
export type AniListMatch = {
  state: AniListMatchState;
  candidates: string[];
  fingerprint: string;
};
export type AniListCurrent = { state: string; revision: number; incarnationId: string | null };
export type AniListObservation = {
  subjectId: string;
  epoch: string;
  pin: AniListJson | null;
  proposedState: string | null;
  current: AniListCurrent | null;
  states: { id: string; role?: string }[];
};
export type AniListReviewInput = {
  subjectId?: string;
  skip?: boolean;
  fields: string[];
  replace?: boolean;
};
export type AniListReview = {
  id: string;
  match: AniListMatch;
  observation: AniListObservation | null;
  input: AniListReviewInput;
  commandKey: string;
  clientId: string;
  requestedBy: string | null;
};
export type AniListOutcome = {
  ordinal: number;
  status: AniListOutcomeStatus;
  retained: string[];
};
export type AniListHeader = {
  document: AniListJson | null;
  rawUpload: string;
  scoreFormat: AniListScoreFormat | null;
  count: number;
  cancelled: boolean;
};
export type AniListRow = {
  ordinal: number;
  source: AniListSource;
  match: AniListMatch;
  proposal: AniListObservation | null;
  review: AniListReview | null;
  started: boolean;
  outcome: AniListOutcome | null;
};
export type AniListCompleteness = {
  wrapper: AniListWrapper;
  hasNextChunk: boolean;
  listedGroups: number;
};
export type AniListPage = {
  importId: string;
  header: AniListHeader;
  completeness: AniListCompleteness;
  rows: AniListRow[];
  next: number | null;
};
export type AniListConfirmation = { ordinal: number; reviewId: string };
export type AniListApplyBody = { confirmations: AniListConfirmation[] };
export type AniListApplyResult = { outcomes: AniListOutcome[]; complete: boolean };

export type AniListRowMeta = {
  ordinal: number;
  title: string;
  mediaType: string | null;
  status: string | null;
  match: AniListMatchState | null;
  target: string | null;
  proposedState: string | null;
  current: AniListCurrent | null;
  reviewId: string | null;
  skip: boolean;
  replace: boolean;
  applyStatus: boolean;
  started: boolean;
  outcome: AniListOutcome | null;
  identifiers: AniListIdentifier[];
  groupLabel: string | null;
  repeating: boolean;
};

export type AniListFailureKind =
  | 'denied'
  | 'unavailable'
  | 'malformed'
  | 'too-large'
  | 'conflict'
  | 'not-found'
  | 'idempotency';
export type AniListFailure = { kind: AniListFailureKind; detail?: string };

export type AniListCommand =
  | { kind: 'preview'; key: string; upload: string; scoreFormat?: AniListScoreFormat }
  | { kind: 'page'; importId: string; after: number }
  | {
      kind: 'review';
      key: string;
      importId: string;
      ordinal: number;
      subjectId?: string;
      skip?: boolean;
      fields: string[];
      replace: boolean;
    }
  | { kind: 'apply'; importId: string; body: AniListApplyBody }
  | { kind: 'cancel'; key: string; importId: string; remove: boolean };

export type AniListUnknown = { kind: 'unknown'; command: AniListCommand };
export type AniListPreviewResult =
  | { kind: 'previewed'; importId: string; count: number }
  | AniListFailure
  | AniListUnknown;
export type AniListPageResult = { kind: 'page'; page: AniListPage } | AniListFailure | AniListUnknown;
export type AniListReviewResult =
  | { kind: 'reviewed'; ordinal: number; review: AniListReview }
  | AniListFailure
  | AniListUnknown;
export type AniListApplyCallResult = { kind: 'applied'; result: AniListApplyResult } | AniListFailure | AniListUnknown;
export type AniListMutateResult = { kind: 'cancelled'; removed: boolean } | AniListFailure | AniListUnknown;

export type AniListImportPort = {
  preview(command: Extract<AniListCommand, { kind: 'preview' }>): Promise<AniListPreviewResult>;
  page(command: Extract<AniListCommand, { kind: 'page' }>): Promise<AniListPageResult>;
  review(command: Extract<AniListCommand, { kind: 'review' }>): Promise<AniListReviewResult>;
  apply(command: Extract<AniListCommand, { kind: 'apply' }>): Promise<AniListApplyCallResult>;
  cancel(command: Extract<AniListCommand, { kind: 'cancel' }>): Promise<AniListMutateResult>;
};

export function newCommandKey(): string {
  return crypto.randomUUID();
}

export function quotedIdempotencyKey(key: string): string {
  return JSON.stringify(key);
}

export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

export function chunkConfirmations(rows: AniListConfirmation[], size = ANILIST_APPLY): AniListConfirmation[][] {
  const batches: AniListConfirmation[][] = [];
  for (let index = 0; index < rows.length; index += size) batches.push(rows.slice(index, index + size));
  return batches;
}

export function isScoreFormat(value: unknown): value is AniListScoreFormat {
  return typeof value === 'string' && (ANILIST_SCORE_FORMATS as readonly string[]).includes(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNextChunk(value: unknown): boolean {
  return record(value) && value.hasNextChunk === true;
}

/** Read wrapper and chunk flags from native header.document. Do not admit fields from it. */
export function completenessOf(document: unknown, rows: { source: AniListSource }[]): AniListCompleteness {
  const groups = new Set(rows.filter((row) => row.source.group).map((row) => JSON.stringify(row.source.group)));
  if (Array.isArray(document)) {
    return { wrapper: 'array', hasNextChunk: false, listedGroups: groups.size };
  }
  if (!record(document)) return { wrapper: 'unknown', hasNextChunk: false, listedGroups: groups.size };
  if (Object.hasOwn(document, 'data') && record(document.data)) {
    const collection = record(document.data.MediaListCollection) ? document.data.MediaListCollection : document.data;
    return {
      wrapper: 'data',
      hasNextChunk: hasNextChunk(document.data) || hasNextChunk(collection),
      listedGroups: groups.size,
    };
  }
  if (Object.hasOwn(document, 'MediaListCollection') && record(document.MediaListCollection)) {
    return {
      wrapper: 'MediaListCollection',
      hasNextChunk: hasNextChunk(document) || hasNextChunk(document.MediaListCollection),
      listedGroups: groups.size,
    };
  }
  if (Array.isArray(document.lists)) {
    return { wrapper: 'lists', hasNextChunk: hasNextChunk(document), listedGroups: groups.size };
  }
  return { wrapper: 'unknown', hasNextChunk: hasNextChunk(document), listedGroups: groups.size };
}

export function boundedHeader(header: AniListHeader): AniListHeader {
  return {
    document: null,
    rawUpload: '',
    scoreFormat: header.scoreFormat,
    count: header.count,
    cancelled: header.cancelled,
  };
}
