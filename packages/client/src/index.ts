import { treaty, type Treaty } from '@elysia/eden';
import type { DefaultMetadata, DefaultSingleton, Elysia } from 'elysia';
import type { SESSION_HEADER as KernelSessionHeader } from './kernel/http/request.ts';
import type { ClientKernel as KernelType } from './kernel/http/kernel.ts';
import type { subjectRoutes } from './kernel/semantic/http/subjects.ts';

export type { ClientKernel as Kernel } from './kernel/http/kernel.ts';
export {
  decodePreferenceAdvice,
  decodePreferencePage,
  decodePreferenceShelfAdvice,
  decodePreferenceValues,
  PREFERENCE_READING_DEFAULTS,
  PREFERENCE_SHELF_LIMITS,
  type PreferenceActionAdvice,
  type PreferencePageAdvice,
  type PreferencePageValues,
  type PreferenceReadingPage,
  type PreferenceShelfAdvice,
  type PreferenceSpoilerLevel,
  type PreferenceSuitability,
} from './preference-page.ts';
export type {
  PersonalEntry,
  PersonalEntryAnnotationWrite,
  PersonalEntryFieldChange,
  PersonalEntryGuard,
  PersonalEntryObservation,
  PersonalEntryPrivacy,
  PersonalEntryPrivacyValue,
  PersonalEntrySourceAdmission,
  PersonalEntrySourceCorrection,
  PersonalEntryTimestampValue,
  PersonalEntryTimestamp,
  PersonalEntryTimestampInput,
} from './kernel/library/entry-personal-model';
export type {
  EntryAnnotationCorrectionCancelResult,
  EntryAnnotationCorrectionInput,
  EntryAnnotationCorrectionItem,
  EntryAnnotationCorrectionOperation,
  EntryAnnotationCorrectionPage,
  EntryAnnotationCorrectionSelection,
} from './kernel/library/entry-annotation-correction';
export type {
  WatchManagementAdvice,
  WatchManagementActions,
  WatchManagementCommand,
  WatchManagementItem,
  WatchManagementKind,
  WatchManagementPage,
  WatchManagementViewer,
} from './kernel/content/schemas';
export type { PreferencePage, PreferencePageAction, PreferencePageKind } from './kernel/access/preferences';
export type {
  RealmClaimReviewApprovalAdvice,
  RealmClaimReviewClaimant,
  RealmClaimReviewInspection,
  RealmClaimReviewItem,
  RealmClaimReviewOperation,
  RealmClaimReviewPage,
  RealmClaimReviewPresentation,
  RealmClaimReviewQuery,
} from './kernel/community/claim-review-page';
export type { PublicationCommand, RealmPublicationPreparation } from './kernel/community/publication-preparation.ts';

type Routes = KernelType['~Routes']['v1'];
export type RatingQuestionDirectoryQuery = Routes['rating-questions']['get']['query'];
export type RatingQuestionDirectory = Routes['rating-questions']['get']['response'][200];
export type RatingQuestion = RatingQuestionDirectory['ratingQuestions'][number];
type QuestionLabelHistoryResponse = Routes['rating-questions'][':questionId']['labels']['get']['response'][200];

export type QuestionLabel = QuestionLabelHistoryResponse['labels'][number];
export type QuestionLabelHistory = QuestionLabelHistoryResponse;
export type { BanReviewPageQuery, BanReviewIdentity, BanReviewPageItem, BanReviewPage } from './kernel/community/ban-review-page-schemas';

/** Reuse each shared method's original declaration; retain every other mounted path and method. */
type SharedRoutes<Mounted, Original> = Original extends { body: unknown; response: unknown }
  ? Original
  : {
      [Path in keyof Mounted]: Path extends keyof Original
        ? SharedRoutes<Mounted[Path], Original[Path]>
        : Mounted[Path];
    };

// Many modules inherit subjectRoutes. Intersecting their repeated anonymous 422 unions grows exponentially.
type SubjectRoutes = SharedRoutes<Routes['subjects'], ReturnType<typeof subjectRoutes>['~Routes']['v1']['subjects']>;

// Eden derives the wire client from `~Routes`; the remaining Elysia generics
// describe server composition and are not part of the client's type surface.
type ClientApp = Elysia<
  KernelType['~Prefix'],
  'local',
  DefaultSingleton,
  { typebox: {}; error: [] },
  DefaultMetadata,
  {
    [Prefix in keyof KernelType['~Routes']]: Prefix extends 'v1'
      ? Omit<Routes, 'subjects'> & { subjects: SubjectRoutes }
      : KernelType['~Routes'][Prefix];
  }
>;

/** Each group is derived from the complete mounted kernel, including routes contributed by other modules. */
type GeneratedKernelClient = ReturnType<typeof treaty<ClientApp>>['v1'];
type ReadingPageCall = ReturnType<ReturnType<GeneratedKernelClient['threads']>['reading-page']['get']>;
/** Response declared by the mounted thread reading route. */
export type ReadingPageResponse = NonNullable<Awaited<ReadingPageCall>['data']>;

type BoardPageCall = ReturnType<ReturnType<GeneratedKernelClient['boards']>['page']['get']>;
/** Response declared by the mounted GET /v1/boards/:id/page route. */
export type BoardPageResponse = NonNullable<Awaited<BoardPageCall>['data']>;
export type {
  OwnCountedVoteAccountObservation,
  OwnCountedVoteIdentity,
  OwnCountedVoteObservation,
  OwnCountedVotePrepareResult,
  OwnCountedVotePreparedTarget,
  OwnCountedVotePreparation,
  OwnCountedVoteQuestionObservation,
  OwnCountedVoteReader,
  OwnCountedVoteReaderDependencies,
  OwnCountedVoteReadResult,
  OwnCountedVoteRequest,
  OwnCountedVoteResult,
  OwnCountedVoteRow,
  StandardRatingMeasurement,
} from './kernel/rating/own-votes-counted';
type SubjectsClient = Treaty.Sign<{ subjects: SubjectRoutes }>['subjects'];
// These aliases become usable only when the mounted declaration publisher installs the actual methods.
// No hand-maintained transport supplies a missing mounted route.
type ClassificationMethod<Verb extends string> = SubjectRoutes extends {
  ':id': { 'source-classifications': infer Methods };
}
  ? Methods extends Record<Verb, { post: infer Method }>
    ? Method
    : never
  : never;
type MethodBody<Method> = Method extends { body: infer Body } ? Body : never;
type MethodResult<Method> = Method extends { response: { 200: infer Result } } ? Result : never;
export type SourceClassificationBatchInput = MethodBody<ClassificationMethod<'$read'>>;
export type SourceClassificationBatch = MethodResult<ClassificationMethod<'$read'>>;
export type SourceClassificationPutInput = MethodBody<ClassificationMethod<'$put'>>;
export type SourceClassificationPutResult = MethodResult<ClassificationMethod<'$put'>>;
export type SourceClassificationClearInput = MethodBody<ClassificationMethod<'$clear'>>;
export type SourceClassificationClearResult = MethodResult<ClassificationMethod<'$clear'>>;

export type KernelClient = GeneratedKernelClient;
export type { PostHistoryPage } from './kernel/content/history-page.ts';
export type {
  DecisionPageAppeal,
  DecisionPageAppealAdvice,
  DecisionPageTargetContext,
  ModerationDecisionPage,
} from './kernel/content/decision-page.ts';
type NoticeInboxClient = ReturnType<KernelClient['accounts']>['notifications'];
type NoticeInboxRead = Awaited<ReturnType<NoticeInboxClient['get']>>;
type UnreadNoticeRead = Awaited<ReturnType<NoticeInboxClient['count']['get']>>;
export type NoticeInboxPage = NonNullable<NoticeInboxRead['data']>;
export type NoticeInboxItem = NoticeInboxPage['items'][number];
export type UnreadNoticeSummary = NonNullable<UnreadNoticeRead['data']>;
export type { InboxSelection as InboxNoticeSelection } from './kernel/content/notice-inbox.ts';
export type KernelSubjectsClient = SubjectsClient;
export type SubjectRead = SubjectRoutes[':id']['get']['response'][200];

type SubjectSourceStatisticsRoute = Routes['subjects'][':id']['source-statistics'];
export type SourceStatisticListResponse = SubjectSourceStatisticsRoute['get']['response'][200];
export type SourceStatistic = SourceStatisticListResponse[number];
export type SourceStatisticWriteInput = SubjectSourceStatisticsRoute[':source']['put']['body'];
export type SourceStatisticWriteResult = SubjectSourceStatisticsRoute[':source']['put']['response'][200];
export type SourceStatisticClearInput = SubjectSourceStatisticsRoute[':source']['$clear']['post']['body'];
export type SourceStatisticClearResult = SubjectSourceStatisticsRoute[':source']['$clear']['post']['response'][204];
export type SourceStatisticFigures = NonNullable<SourceStatistic['figures']>;

/** Home and Following share the installed feedItems response declaration. */
export type FeedPage = Routes['feedItems']['get']['response'][200];
export type FeedItem = FeedPage['feedItems'][number];
export type FeedContentItem = Extract<FeedItem, { source: 'following'; key: { owner: 'content' } }>;

type RealmHomeCall = ReturnType<ReturnType<GeneratedKernelClient['realms']>['home']['get']>;
export type RealmHomePage = NonNullable<Awaited<RealmHomeCall>['data']>;
export type RealmHomeViewer = RealmHomePage['viewer'];
export type RealmHomeActions = RealmHomePage['actions'];

export const SESSION_HEADER: typeof KernelSessionHeader = 'rezics-session-token';

export type KernelClientOptions = {
  /** Fetch implementation used for requests. */
  fetch?: typeof fetch;
  /** Additional headers sent with each request. */
  headers?: Record<string, string>;
  /** Session token to send with the first request. */
  session?: string;
  /** Called when the kernel returns a different session token. */
  onSession?: (token: string) => void;
};

/** Creates one viewer's client and keeps its session token so the viewer's reads see its own writes. */
export function createKernelClient(origin: string, options: KernelClientOptions = {}): KernelClient {
  let session = options.session;
  const fetcher = options.fetch ?? globalThis.fetch;
  const config = {
    fetcher: ((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname.replace(/\/\$([a-z][A-Za-z0-9]*)$/, ':$1');
      if (path === url.pathname) return fetcher(input, init);
      url.pathname = path;
      return fetcher(input instanceof Request ? new Request(url, input) : url.href, init);
    }) as typeof fetch,
    parseDate: false,
    headers: () => ({
      ...options.headers,
      ...(session === undefined ? {} : { [SESSION_HEADER]: session }),
    }),
    onResponse(response: Response) {
      const token = response.headers.get(SESSION_HEADER);
      if (token !== null && token !== session) {
        session = token;
        options.onSession?.(token);
      }
    },
  };
  return treaty<ClientApp>(origin, config).v1;
}

export type QuestionLabelInput = Routes['rating-questions'][':questionId']['label']['put']['body'];
export type QuestionLabelResult = Routes['rating-questions'][':questionId']['label']['put']['response'][200];
export type QuestionLabelHistoryQuery = Routes['rating-questions'][':questionId']['labels']['get']['query'];
type ClassificationBallotOwnPageRoute = Routes['me']['classification-assessments']['get'];
export type ClassificationBallotOwnPageQuery = ClassificationBallotOwnPageRoute['query'];
export type ClassificationBallotOwnPage = ClassificationBallotOwnPageRoute['response'][200];
export type ClassificationBallotOwnPageItem = ClassificationBallotOwnPage['items'][number];

type LibraryExportStatus = NonNullable<Awaited<ReturnType<LibraryExportRead['get']>>['data']>;
export type { LibraryExportStatus };
type LibraryExportRead = ReturnType<KernelClient['libraryExports']>;
export type LibraryExportPage = NonNullable<Awaited<ReturnType<LibraryExportRead['pages']['get']>>['data']>;
export type LibraryExportState = LibraryExportStatus['state'];
export type { ShelfOrder } from './kernel/library/shelf-contract.ts';
type ShelfEntry = Routes['libraryEntries']['get']['response'][200]['libraryEntries'][number];
export type ShelfTitleCoverage = NonNullable<Extract<ShelfEntry, { titleCoverage?: unknown }>['titleCoverage']>;
export type { ViewerPersonalActionsPage, ViewerPersonalActionState } from './kernel/library/viewer-personal-actions.ts';
