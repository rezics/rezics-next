import type { PersonalEntrySourceAdmission, KernelClient } from '@rezics/client';
import type { SourceAdmissionCustody } from '../rich-private-entry/admission';
import type { SourceAdmissionOutcome, SourceAdmissionPreview } from '../rich-private-entry/admission';
import type { HomeQuestion } from '../../features/pages/home-feed-questions';

type NativeAniList = NonNullable<KernelClient['libraryImports']['anilist']>;
type NativeAniListItem = ReturnType<NativeAniList>;
type NativeAniListPage = NonNullable<Awaited<ReturnType<NativeAniListItem['get']>>['data']>;
type NativeAniListReviewBody = Parameters<NonNullable<NativeAniListItem['$review']>['post']>[0];
type NativeAniListApplyBody = Parameters<NonNullable<NativeAniListItem['$apply']>['post']>[0];
type NativeAniListApplyResult = NonNullable<
  Awaited<ReturnType<NonNullable<NativeAniListItem['$apply']>['post']>>['data']
>;
export type AniListLabelReviewBody = Parameters<NonNullable<NativeAniListItem['$reviewLabels']>['post']>[0];
export type AniListLabelApplyBody = Parameters<NonNullable<NativeAniListItem['$applyLabels']>['post']>[0];
export type AniListLabelApplyResult = NonNullable<
  Awaited<ReturnType<NonNullable<NativeAniListItem['$applyLabels']>['post']>>['data']
>;
export type AniListLabelReview = NonNullable<NativeAniListRow['labelReview']>;
export type AniListLabelSelection = AniListLabelReviewBody['selections'][number];
export type AniListLabelEvidence = NativeAniListRow['labelEvidence'];
export type AniListLabelWork = NativeAniListRow['labelWork'];
export type AniListLabelTarget = import('../subject-labels').LibraryLabelSummary;
export type AniListCurrentLabel = import('../subject-labels').SubjectLabel;
export type AniListLabelCustody = import('../../session/expected-reader').ExpectedReader & { sender?: string };
export type AniListLabelMeta = {
  subjectId: string | null;
  selections: AniListLabelSelection[];
  review: AniListLabelReview | null;
  invalidated: boolean;
  outcomes: AniListLabelApplyResult['outcomes'][number] | null;
};
type NativeAniListRow = NativeAniListPage['rows'][number];
type NativeAniListReview = NonNullable<NativeAniListRow['review']>;
type NativeAniListOutcome = NonNullable<NativeAniListRow['outcome']>;
type NativeAniListObservation = NonNullable<NativeAniListRow['proposal']>;
type NativeAniListSource = NativeAniListRow['source'];

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
export type AniListFieldValidity = 'valid' | 'unknown' | 'invalid';
export type AniListWrapper = 'array' | 'lists' | 'MediaListCollection' | 'data' | 'unknown';
export type AniListJson = string | number | boolean | null | AniListJson[] | { readonly [key: string]: AniListJson };
export type AniListRecord = { readonly [key: string]: AniListJson };
export type AniListIdentifier = NativeAniListRow['source']['identifiers'][number];
export type AniListSourceField = NativeAniListRow['source']['fields'][number];
export type AniListSource = Omit<NativeAniListSource, 'evidence' | 'group'> & {
  evidence: AniListRecord;
  group: AniListRecord | null;
};
export type AniListMatch = NativeAniListRow['match'];
export type AniListCurrent = NonNullable<NonNullable<NativeAniListRow['proposal']>['current']>;
export type AniListObservation = Omit<NativeAniListObservation, 'pin'> & { pin: AniListJson | null };
export type AniListReviewInput = NativeAniListReview['input'];
// Native DTOs stay derived from the installed client; only values validated as JSON are narrowed
// for the Web server-function serialization boundary.
export type AniListReview = Omit<NativeAniListReview, 'observation' | 'score'> & {
  observation: AniListObservation | null;
  score?: AniListRecord;
};
export type AniListOutcome = Omit<NativeAniListOutcome, 'score'> & { score?: AniListRecord };
export type AniListOutcomeStatus = AniListOutcome['status'];
export type AniListHeader = Omit<NativeAniListPage['header'], 'document' | 'scoreFormat'> & {
  document: AniListJson | null;
  scoreFormat: AniListScoreFormat | null;
};
export type AniListRow = Pick<NativeAniListRow, 'ordinal' | 'match'> & {
  source: AniListSource;
  proposal: AniListObservation | null;
  review: AniListReview | null;
  started: boolean;
  outcome: AniListOutcome | null;
  currentScore?: AniListJson;
  scoreLexeme?: string;
  labelEvidence?: AniListLabelEvidence;
  labelReview?: AniListLabelReview;
  labelWork?: AniListLabelWork;
  currentLabels?: AniListCurrentLabel[];
};
export type AniListCompleteness = {
  wrapper: AniListWrapper;
  hasNextChunk: boolean;
  listedGroups: number;
};
export type AniListPage = Omit<NativeAniListPage, 'header' | 'rows'> & {
  importId: string;
  header: AniListHeader;
  completeness: AniListCompleteness;
  rows: AniListRow[];
};
export type AniListConfirmation = NativeAniListApplyBody['confirmations'][number];
export type AniListApplyBody = NativeAniListApplyBody;
export type AniListApplyResult = Omit<NativeAniListApplyResult, 'outcomes'> & { outcomes: AniListOutcome[] };
export type AniListQuestion = HomeQuestion;

export type AniListRowMeta = {
  ordinal: number;
  labels?: AniListLabelMeta;
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
  reviewInvalidated: boolean;
  scoreSource: {
    value: AniListJson;
    lexeme: string | null;
    scale: string | null;
    validity: AniListFieldValidity;
    reason: string;
  } | null;
  scoreAction: 'keep' | 'vote' | 'clear';
  scoreUnits: number | null;
  scoreReview: {
    reviewId: string;
    commandKey: string | null;
    consentKey: string | null;
    action: 'vote' | 'clear';
    units: number | null;
    questionId: string | null;
    questionRevision: number | null;
    questionLabel: string | null;
    questionMeaning: string | null;
    questionGrain: string | null;
    minimumUnits: number | null;
    maximumUnits: number | null;
    stepUnits: number | null;
    questionLifecycleState: string | null;
    questionLifecycleRevision: number | null;
    targetId: string | null;
    identityEpoch: string | null;
    matchFingerprint: string | null;
    currentVoteUnits: number | null;
    currentVote: 'present' | 'absent' | 'unavailable';
    currentVoteReason: string | null;
    availability: 'available' | 'unavailable';
    availabilityReason: string | null;
    guard: unknown;
    nativeEvidence: unknown;
  } | null;
  currentScore: unknown;
  nativeVoteConsent: { reviewId: string; consentKey: string } | null;
  identifiers: AniListIdentifier[];
  groupLabel: string | null;
  repeating: boolean;
  sourcePreview: SourceAdmissionPreview;
  sourceAdmission: SourceAdmissionOutcome | null;
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
      score?: NativeAniListReviewBody['score'];
    }
  | { kind: 'apply'; importId: string; body: AniListApplyBody }
  | {
      kind: 'admit-source';
      key: string;
      subjectId: string;
      ordinal: number;
      body: PersonalEntrySourceAdmission;
      custody?: SourceAdmissionCustody;
    }
  | { kind: 'review-labels'; key: string; importId: string; body: AniListLabelReviewBody; custody: AniListLabelCustody }
  | { kind: 'apply-labels'; importId: string; body: AniListLabelApplyBody; custody: AniListLabelCustody }
  | { kind: 'read-labels'; importId: string; ordinal: number; subjectId: string; custody: AniListLabelCustody }
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
export type AniListAdmitResult = { kind: 'admitted' } | { kind: 'conflict' } | AniListFailure | AniListUnknown;
export type AniListQuestionResult = { kind: 'question'; question: AniListQuestion } | AniListFailure;

export type AniListLabelReviewResult =
  | { kind: 'labels-reviewed'; ordinal: number; review: AniListLabelReview }
  | AniListFailure
  | AniListUnknown;
export type AniListLabelApplyCallResult =
  | { kind: 'labels-applied'; result: AniListLabelApplyResult }
  | AniListFailure
  | AniListUnknown;
export type AniListLabelReadResult =
  | { kind: 'labels-read'; labels: AniListCurrentLabel[] }
  | AniListFailure
  | AniListUnknown;
export type AniListLabelTargetsResult =
  | { kind: 'label-targets'; labels: AniListLabelTarget[]; next: string | null }
  | AniListFailure;

export type AniListImportPort = {
  reviewLabels(command: Extract<AniListCommand, { kind: 'review-labels' }>): Promise<AniListLabelReviewResult>;
  applyLabels(command: Extract<AniListCommand, { kind: 'apply-labels' }>): Promise<AniListLabelApplyCallResult>;
  readLabels(command: Extract<AniListCommand, { kind: 'read-labels' }>): Promise<AniListLabelReadResult>;
  labelTargets(
    query: string,
    cursor: string | undefined,
    custody: AniListLabelCustody,
  ): Promise<AniListLabelTargetsResult>;
  preview(command: Extract<AniListCommand, { kind: 'preview' }>): Promise<AniListPreviewResult>;
  page(command: Extract<AniListCommand, { kind: 'page' }>): Promise<AniListPageResult>;
  review(command: Extract<AniListCommand, { kind: 'review' }>): Promise<AniListReviewResult>;
  apply(command: Extract<AniListCommand, { kind: 'apply' }>): Promise<AniListApplyCallResult>;
  admitSource(command: Extract<AniListCommand, { kind: 'admit-source' }>): Promise<AniListAdmitResult>;
  cancel(command: Extract<AniListCommand, { kind: 'cancel' }>): Promise<AniListMutateResult>;
  question(): Promise<AniListQuestionResult>;
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
