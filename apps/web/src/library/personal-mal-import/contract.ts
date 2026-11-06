import type { KernelClient, PersonalEntrySourceAdmission, RatingQuestion } from '@rezics/client';
import type {
  MalLabelOutcome,
  MalLabelReview,
  MalLabelSelection,
  MalTagEvidence,
} from '../../../../../packages/client/src/kernel/library/list-import-mal-tags';
import type { SourceAdmissionCustody } from '../rich-private-entry/admission';
import type { SourceAdmissionOutcome, SourceAdmissionPreview } from '../rich-private-entry/admission';
import type { OwnVoteReadback } from '../../ratings/own-votes/readback';

export type { MalLabelOutcome, MalLabelReview, MalLabelSelection, MalTagEvidence };

export const MAL_UPLOAD_BYTES = 2_097_152;
export const MAL_WIRE_BYTES = 4_194_304;
export const MAL_PAGE = 20;
export const MAL_ROWS = 500;
export const MAL_FIELD_CAP = 64;
export const MAL_UPLOADS = 3;
export const SUBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type NativeMal = KernelClient['libraryImports']['mal'];
type NativeMalId = ReturnType<NativeMal>;
type NativeMalPage = NonNullable<Awaited<ReturnType<NativeMalId['get']>>['data']>;
type NativeMalRow = NativeMalPage['rows'][number];
type NativeMalReview = NonNullable<NativeMalRow['review']>;
type NativeMalScoreReview = NonNullable<NativeMalReview['score']>;
type NativeMalOutcome = NonNullable<NativeMalRow['outcome']>;
type NativeMalScoreOutcome = NonNullable<NativeMalOutcome['score']>;
type NativeMalReviewInput = Parameters<NativeMalId['review']['post']>[0];
type NativeMalApplyPage = NonNullable<Awaited<ReturnType<NativeMalId['apply']['post']>>['data']>;
type NativeMalApplyBody = Parameters<NativeMalId['apply']['post']>[0];

export type MalValue = NativeMalRow['status'];
export type MalMatch = NativeMalRow['match'];
export type MalScoreReviewInput = NonNullable<NativeMalReviewInput['score']>;
export type MalScoreReview = Omit<NativeMalScoreReview, 'admission'> & {
  admission: NativeMalScoreReview['admission'] | { status: 'conditional'; reason: null };
  /** Keep the producer's versioned guard intact without interpreting or rebuilding it in Web. */
  guard?: unknown;
};
export type MalReview = Omit<NativeMalReview, 'score'> & { score?: MalScoreReview };
export type MalOutcome = Omit<NativeMalOutcome, 'score'> & {
  score?: Omit<NativeMalScoreOutcome, 'status'> & {
    status: NativeMalScoreOutcome['status'] | Extract<NativeMalOutcome['status'], 'applied'>;
  };
};
export type MalOutcomeStatus = MalOutcome['status'];
export type MalScoreOutcome = NonNullable<MalOutcome['score']>;
type NativeScoreBaseline = MalScoreReview['baseline'];
export type MalCurrentScoreVote = {
  units: NativeScoreBaseline['units'];
  revision: NonNullable<NativeScoreBaseline['revision']>;
  at: NonNullable<NativeScoreBaseline['at']>;
};

/** Preserve native rows and outcomes intact, adding only Web-owned source-admission presentation. */
export type MalPreviewRow = Omit<NativeMalRow, 'review' | 'outcome'> & {
  review: MalReview | null;
  outcome: MalOutcome | null;
  currentScoreVote?: MalCurrentScoreVote | null;
  selectedFields?: string[];
  sourcePreview?: SourceAdmissionPreview;
  sourceAdmission?: SourceAdmissionOutcome | null;
};

export type MalPage = Omit<NativeMalPage, 'rows'> & { rows: MalPreviewRow[] };
export type MalApplyBody = NativeMalApplyBody;
export type MalApplyPage = Omit<NativeMalApplyPage, 'outcomes'> & { outcomes: MalOutcome[] };
export type MalReviewInput = Omit<NativeMalReviewInput, 'score' | 'labels'> & {
  score?: MalScoreReviewInput;
  labels?: MalLabelSelection[];
};
export type MalQuestion = RatingQuestion;
export type MalOwnVoteReadback = OwnVoteReadback;

/** Score review accepts only the standard question at revision 1 (docs/library-import-mal.md). */
export const MAL_STANDARD_QUESTION_ID = '00000000-0000-7000-8000-000000000001' as const;
export const MAL_STANDARD_QUESTION_REVISION = 1 as const;

/** The review identity of a question, or null when the question is not the standard one and cannot be reviewed. */
export function standardMalQuestion(question: { id: string; revision: number }) {
  return question.id === MAL_STANDARD_QUESTION_ID && question.revision === MAL_STANDARD_QUESTION_REVISION
    ? { questionId: MAL_STANDARD_QUESTION_ID, questionRevision: MAL_STANDARD_QUESTION_REVISION }
    : null;
}

export type MalQuestionResult = { kind: 'question'; question: MalQuestion } | MalFailure;
export type MalVoteReadResult = { kind: 'vote'; value: MalOwnVoteReadback } | MalFailure;

export type MalCommand =
  | { kind: 'preview'; key: string; xml: string; custody?: SourceAdmissionCustody }
  | { kind: 'page'; id: string; after: number; custody?: SourceAdmissionCustody }
  | { kind: 'review'; key: string; id: string; input: MalReviewInput; custody?: SourceAdmissionCustody }
  | { kind: 'apply'; id: string; body: MalApplyBody; custody?: SourceAdmissionCustody }
  | {
      kind: 'admit-source';
      key: string;
      subjectId: string;
      ordinal: number;
      body: PersonalEntrySourceAdmission;
      custody?: SourceAdmissionCustody;
    }
  | { kind: 'cancel'; key: string; id: string; custody?: SourceAdmissionCustody }
  | { kind: 'delete'; key: string; id: string; custody?: SourceAdmissionCustody };

export type MalDeliveryCustody = {
  command: MalCommand;
  sender: { subject: string; csrfToken: string };
  sourceConsent: { privacy: boolean; timestamps: boolean };
  uploadId: string | null;
  /** An acknowledged bounded apply result may accompany an uncertain later source-admission command. */
  result?: MalApplyPage;
};

export type MalFailureKind =
  | 'denied'
  | 'unavailable'
  | 'malformed'
  | 'too-large'
  | 'security'
  | 'conflict'
  | 'not-found'
  | 'idempotency';

export type MalFailure = { kind: MalFailureKind; detail?: string };
export type MalUnknown = { kind: 'unknown'; command: MalCommand };

export type MalPreviewResult = { kind: 'previewed'; id: string } | MalFailure | MalUnknown;
export type MalPageResult = { kind: 'page'; page: MalPage } | MalFailure | MalUnknown;
export type MalReviewResult = { kind: 'reviewed'; id: string } | MalFailure | MalUnknown;
export type MalApplyResult = { kind: 'applied'; result: MalApplyPage } | MalFailure | MalUnknown;
export type MalMutateResult = { kind: 'done'; id: string } | MalFailure | MalUnknown;
export type MalAdmitResult = { kind: 'admitted' } | { kind: 'conflict' } | MalFailure | MalUnknown;
export type MalAssignment = { id: string; labelId: string; subjectId: string; revision: number };

export type MalImportPort = {
  source?(id: string): Promise<{ kind: 'source'; xml: string } | MalFailure>;
  assignments?(subjectId: string): Promise<{ kind: 'assignments'; assignments: MalAssignment[] } | MalFailure>;
  readQuestion(): Promise<MalQuestionResult>;
  readVote(input: { targetId: string; questionId: string }): Promise<MalVoteReadResult>;
  preview(command: Extract<MalCommand, { kind: 'preview' }>): Promise<MalPreviewResult>;
  page(command: Extract<MalCommand, { kind: 'page' }>): Promise<MalPageResult>;
  review(command: Extract<MalCommand, { kind: 'review' }>): Promise<MalReviewResult>;
  apply(command: Extract<MalCommand, { kind: 'apply' }>): Promise<MalApplyResult>;
  admitSource(command: Extract<MalCommand, { kind: 'admit-source' }>): Promise<MalAdmitResult>;
  cancel(command: Extract<MalCommand, { kind: 'cancel' }>): Promise<MalMutateResult>;
  delete(command: Extract<MalCommand, { kind: 'delete' }>): Promise<MalMutateResult>;
};

export function newCommandKey(): string {
  return crypto.randomUUID();
}

export function sameCommand(left: MalCommand, right: MalCommand): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
