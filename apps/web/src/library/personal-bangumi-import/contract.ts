import type { KernelClient, PersonalEntrySourceAdmission } from '@rezics/client';
import type { SourceAdmissionCustody } from '../rich-private-entry/admission';
import type { SourceAdmissionOutcome, SourceAdmissionPreview } from '../rich-private-entry/admission';

type GeneratedBangumi = NonNullable<KernelClient['libraryImports']['bangumi']>;
type GeneratedBangumiUpload = ReturnType<GeneratedBangumi>;
type GeneratedBangumiRow = ReturnType<GeneratedBangumiUpload['rows']>;
type GeneratedBangumiTagCall = ReturnType<GeneratedBangumiRow['tags']['get']>;
type GeneratedBangumiReviewCall = GeneratedBangumiUpload['$review']['post'];
type GeneratedBangumiApplyCall = GeneratedBangumiUpload['$apply']['post'];
type GeneratedBangumiReviewLabelsCall = GeneratedBangumiUpload['$reviewLabels']['post'];
type GeneratedBangumiApplyLabelsCall = GeneratedBangumiUpload['$applyLabels']['post'];
type GeneratedLibraryLabels = NonNullable<
  Awaited<ReturnType<KernelClient['libraryLabels']['get']>>['data']
>['labels'][number];

// The installed client does not re-export its Bangumi model, so these names are derived from the mounted routes.
type GeneratedBangumiTagPage = NonNullable<Awaited<GeneratedBangumiTagCall>['data']>;
type GeneratedBangumiReviewBody = Parameters<GeneratedBangumiReviewCall>[0];
type GeneratedBangumiApplyBody = Parameters<GeneratedBangumiApplyCall>[0];
type GeneratedBangumiReviewResponse = NonNullable<Awaited<ReturnType<GeneratedBangumiReviewCall>>['data']>;
type GeneratedBangumiApplyResponse = NonNullable<Awaited<ReturnType<GeneratedBangumiApplyCall>>['data']>;
type GeneratedBangumiLabelState = NonNullable<
  NonNullable<Awaited<ReturnType<GeneratedBangumiReviewLabelsCall>>['data']>['labels']
>;
export type BangumiScoreSelection = NonNullable<GeneratedBangumiReviewBody['score']>;
export type BangumiChoice = GeneratedBangumiApplyBody['rows'][number];
export type BangumiOutcome = GeneratedBangumiApplyResponse['outcomes'][number];
export type BangumiLabelReviewBody = Parameters<GeneratedBangumiReviewLabelsCall>[0];
export type BangumiLabelMapping = BangumiLabelReviewBody['mappings'][number];
/** Label source values are JSON: the native reader validates them before they reach the web. */
export type BangumiLabelItem = Omit<GeneratedBangumiLabelState['review']['items'][number], 'source'> & {
  source: BangumiJson;
};
export type BangumiLabelReview = Omit<GeneratedBangumiLabelState['review'], 'items'> & { items: BangumiLabelItem[] };
export type BangumiLabelState = Omit<GeneratedBangumiLabelState, 'review'> & { review: BangumiLabelReview };
export type BangumiLabelApplyData = NonNullable<Awaited<ReturnType<GeneratedBangumiApplyLabelsCall>>['data']>;
export type BangumiLabelOutcome = BangumiLabelState['outcomes'][number];
/** Tag values are JSON: the native reader validates them before they reach the web. */
export type BangumiTag = Omit<GeneratedBangumiTagPage['tags'][number], 'value'> & { value: BangumiJson };
export type BangumiTagPage = Omit<GeneratedBangumiTagPage, 'tags' | 'labels'> & {
  tags: BangumiTag[];
  labels: BangumiLabelState | null;
};
export type BangumiLabelOption = Pick<GeneratedLibraryLabels, 'id' | 'name' | 'revision'>;
export type BangumiLabelAssignment = { id: string; labelId: string; name: string; revision: number };
export type BangumiCredentialCustody = Readonly<{ viewer: string; csrfToken: string; credential: string }>;

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
export type BangumiOutcomeStatus = BangumiOutcome['status'];
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
type KernelBangumiReview = NonNullable<GeneratedBangumiReviewResponse['review']>;
type KernelBangumiScoreReview = NonNullable<KernelBangumiReview['score']>;
export type BangumiScoreCurrentVote = NonNullable<KernelBangumiScoreReview['native']['currentVote']>;
export type BangumiGuard = NonNullable<KernelBangumiReview['guard']>;
export type BangumiCurrent = NonNullable<KernelBangumiReview['current']>;
type KernelScoreAdmission = KernelBangumiScoreReview['native']['admission'];
export type BangumiScoreAdmission = KernelScoreAdmission | { status: 'reviewed'; reason: 'native_review_observed' };
export type BangumiScoreReview = Omit<KernelBangumiScoreReview, 'native'> & {
  native: Omit<KernelBangumiScoreReview['native'], 'admission'> & { admission: BangumiScoreAdmission };
};
export type BangumiReview = Omit<KernelBangumiReview, 'score'> & { score?: BangumiScoreReview };
export type BangumiScoreChoice = NonNullable<BangumiChoice['score']>;
export type BangumiScoreOutcome = NonNullable<BangumiOutcome['score']>;
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
  scoreReview: BangumiScoreReview | null;
  scoreConsent: boolean;
  outcome: BangumiOutcome | null;
  entryReadback: BangumiEntryReadback | null;
  voteReadback: BangumiVoteReadback | null;
  sourcePreview: SourceAdmissionPreview;
  sourceAdmission: SourceAdmissionOutcome | null;
};

export type BangumiEntryReadback =
  | { status: 'present'; state: string; revision: number; incarnationId?: string | null }
  | { status: 'absent' }
  | { status: 'stale' | 'unavailable'; reason: string };

export type BangumiVoteReadback =
  | { status: 'current'; vote: BangumiScoreCurrentVote }
  | { status: 'stale' | 'unavailable'; reason: string };

export type BangumiInspectionCommand = { subjectId: string; questionId: string | null };
export type BangumiInspectionResult = { entry: BangumiEntryReadback; vote: BangumiVoteReadback | null };

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
  | { kind: 'review'; key: string; uploadId: string; ordinal: number; target?: string; score?: BangumiScoreSelection }
  | { kind: 'apply'; uploadId: string; body: BangumiApplyBody }
  | {
      kind: 'admit-source';
      key: string;
      subjectId: string;
      ordinal: number;
      body: PersonalEntrySourceAdmission;
      custody?: SourceAdmissionCustody;
    }
  | { kind: 'cancel'; key: string; uploadId: string }
  | { kind: 'delete'; key: string; uploadId: string }
  | {
      kind: 'tags';
      uploadId: string;
      ordinal: number;
      after: number;
      custody?: BangumiCredentialCustody;
    }
  | {
      kind: 'review-labels';
      uploadId: string;
      ordinal: number;
      rowRevision: string;
      mappings: BangumiLabelMapping[];
      key: string;
      custody: BangumiCredentialCustody;
    }
  | {
      kind: 'apply-labels';
      uploadId: string;
      ordinal: number;
      reviewToken: string;
      custody: BangumiCredentialCustody;
    };

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
export type BangumiAdmitResult = { kind: 'admitted' } | { kind: 'conflict' } | BangumiFailure | BangumiUnknown;
export type BangumiTagPageResult =
  | { kind: 'tags'; page: BangumiTagPage; custody?: BangumiCredentialCustody }
  | BangumiFailure
  | BangumiUnknown;
export type BangumiLabelOptionsResult = { kind: 'label-options'; labels: BangumiLabelOption[] } | BangumiFailure;
export type BangumiLabelReviewResult =
  | { kind: 'labels-reviewed'; ordinal: number; labels: BangumiLabelState }
  | BangumiFailure
  | BangumiUnknown;
export type BangumiLabelApplyResult =
  | { kind: 'labels-applied'; result: BangumiLabelApplyData }
  | BangumiFailure
  | BangumiUnknown;
export type BangumiLabelAssignmentsResult =
  | { kind: 'assignments'; subjectId: string; assignments: BangumiLabelAssignment[] }
  | BangumiFailure;

export type BangumiImportPort = {
  preview(command: Extract<BangumiCommand, { kind: 'preview' }>): Promise<BangumiPreviewResult>;
  page(command: Extract<BangumiCommand, { kind: 'page' }>): Promise<BangumiPageResult>;
  review(command: Extract<BangumiCommand, { kind: 'review' }>): Promise<BangumiReviewResult>;
  apply(command: Extract<BangumiCommand, { kind: 'apply' }>): Promise<BangumiApplyCallResult>;
  admitSource(command: Extract<BangumiCommand, { kind: 'admit-source' }>): Promise<BangumiAdmitResult>;
  inspect(command: BangumiInspectionCommand): Promise<BangumiInspectionResult>;
  cancel(command: Extract<BangumiCommand, { kind: 'cancel' }>): Promise<BangumiMutateResult>;
  delete(command: Extract<BangumiCommand, { kind: 'delete' }>): Promise<BangumiMutateResult>;
  tags(command: Extract<BangumiCommand, { kind: 'tags' }>): Promise<BangumiTagPageResult>;
  searchLabels(query: string): Promise<BangumiLabelOptionsResult>;
  reviewLabels(command: Extract<BangumiCommand, { kind: 'review-labels' }>): Promise<BangumiLabelReviewResult>;
  applyLabels(command: Extract<BangumiCommand, { kind: 'apply-labels' }>): Promise<BangumiLabelApplyResult>;
  readAssignments(subjectId: string): Promise<BangumiLabelAssignmentsResult>;
};

export type BangumiLabelPanelState = {
  rowRevision: string | null;
  pages: BangumiTagPage[];
  pageIndex: number;
  custody: BangumiCredentialCustody | null;
  mappings: Record<number, BangumiLabelMapping['target']>;
  reviewedMappings: BangumiLabelMapping[] | null;
  newNames: Record<number, string>;
  queries: Record<number, string>;
  options: Record<number, BangumiLabelOption[]>;
  searchState: Record<number, 'idle' | 'loaded' | 'unavailable'>;
  labels: BangumiLabelState | null;
  result: BangumiLabelApplyData | null;
  assignments: BangumiLabelAssignment[] | null;
  assignmentState: 'idle' | 'loading' | 'loaded' | 'unavailable';
  command: Extract<BangumiCommand, { kind: 'tags' | 'review-labels' | 'apply-labels' }> | null;
  notice: BangumiFailure | null;
  busy: boolean;
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
