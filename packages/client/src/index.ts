import { treaty, type Treaty } from '@elysia/eden';
import type { Static } from 'typebox';
import type { PublicationPreparationSchema } from './kernel/community/publication-preparation.ts';
import type { DecisionPageSchema } from './kernel/content/decision-page.ts';
import type { DefaultMetadata, DefaultSingleton, Elysia } from 'elysia';
import type { SESSION_HEADER as KernelSessionHeader } from './kernel/http/request.ts';
import type { ClientKernel as KernelType } from './kernel/http/kernel.ts';
import type { subjectRoutes } from './kernel/semantic/http/subjects.ts';
import type { ZoneSubjectListRoutes } from './kernel/zones/subjects.ts';

export type { ClientKernel as Kernel } from './kernel/http/kernel.ts';
export { zoneCollections, zoneReadPage, zoneSubjects } from './zones.ts';
export type {
  ZoneCollectionsCall,
  ZoneCollectionsClient,
  ZoneCollectionsPage,
  ZoneCollectionsQuery,
  ZoneReadPageBody,
  ZoneReadPageCall,
  ZoneReadPageClient,
  ZoneReadPageResult,
  ZoneSubjectListItem,
  ZoneSubjectListPage,
  ZoneSubjectListProgress,
  ZoneSubjectsCall,
  ZoneSubjectsClient,
  ZoneSubjectsQuery,
} from './zones.ts';
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
  EntryAnnotationCorrectionItem,
  EntryAnnotationOperation as EntryAnnotationCorrectionOperation,
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
  RealmClaimApprovalAdvice as RealmClaimReviewApprovalAdvice,
  RealmClaimantPresentation as RealmClaimReviewClaimant,
  RealmClaimReviewInspection,
  RealmClaimReviewItem,
  RealmClaimReviewPage,
  RealmClaimReviewPresentation,
} from './kernel/community/realm-claim-review';
export type RealmPublicationPreparation = Static<typeof PublicationPreparationSchema>;
export type PublicationCommand = RealmPublicationPreparation['commands']['publish'];
type AnnotationCorrectionRoute = Routes['libraryEntryAnnotationCorrections'];
export type EntryAnnotationCorrectionInput = AnnotationCorrectionRoute['post']['body'];
export type EntryAnnotationCorrectionCancelResult =
  AnnotationCorrectionRoute[':reviewId']['cancel']['post']['response'][200];

type NativePostHistoryPage = Routes['posts'][':id']['revisions']['get']['response'][200]['page'];
type Routes = KernelType['~Routes']['v1'];
export type RealmClaimReviewOperation = Routes['realms'][':realmId']['claimRequests']['get'];
export type RealmClaimReviewQuery = RealmClaimReviewOperation['query'];
export type RatingQuestionDirectoryQuery = Routes['rating-questions']['get']['query'];
export type RatingQuestionDirectory = Routes['rating-questions']['get']['response'][200];
export type RatingQuestion = RatingQuestionDirectory['ratingQuestions'][number];
type AccountProfileRoute = Routes['accounts'][':accountId']['profile']['get'];
export type AccountProfileResponse = AccountProfileRoute['response'][200];
export type AccountProfile = AccountProfileResponse['profile'];
export type AccountAvatar = NonNullable<AccountProfile['avatar']>;
type ManagedAccountsRoute = Routes['me']['managedAccounts']['get'];
export type ManagedAccountsPage = ManagedAccountsRoute['response'][200];
export type ManagedAccountOrganization = ManagedAccountsPage['organizations']['items'][number];
export type ManagedAccountResponsibility = ManagedAccountsPage['responsibilities']['items'][number];
type QuestionLabelHistoryResponse = Routes['rating-questions'][':questionId']['labels']['get']['response'][200];

export type QuestionLabel = QuestionLabelHistoryResponse['labels'][number];
export type QuestionLabelHistory = QuestionLabelHistoryResponse;
type BanReviewRoute = Routes['realms'][':realmId']['bans']['get'];
export type BanReviewPageQuery = BanReviewRoute['query'];
export type BanReviewPage = BanReviewRoute['response'][200];
export type BanReviewPageItem = BanReviewPage['items'][number];
export type BanReviewIdentity = BanReviewPageItem['account'];

/** Reuse each shared method's original declaration; retain every other mounted path and method. */
type SharedRoutes<Mounted, Original> = Original extends { body: unknown; response: unknown }
  ? Original
  : {
      [Path in keyof Mounted]: Path extends keyof Original
        ? SharedRoutes<Mounted[Path], Original[Path]>
        : Mounted[Path];
    };

// Many modules inherit subjectRoutes. Intersecting their repeated anonymous 422 unions grows exponentially.
type InstalledSubjectRoutes = SharedRoutes<
  Routes['subjects'],
  ReturnType<typeof subjectRoutes>['~Routes']['v1']['subjects']
>;
type SubjectRoutes = InstalledSubjectRoutes;
type InstalledZoneRoutes = SharedRoutes<Routes['zones'] & ZoneSubjectListRoutes, Routes['zones']>;

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
      ? Omit<Routes, 'subjects' | 'zones'> & { subjects: SubjectRoutes; zones: InstalledZoneRoutes }
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
type LibraryExportRoute = Routes['libraryExports'][':id'];
export type LibraryExportStatus = LibraryExportRoute['get']['response'][200];
export type LibraryExportState = LibraryExportStatus['state'];
export type LibraryExportPage = LibraryExportRoute['pages']['get']['response'][200];

type SubjectsClient = Treaty.Sign<{ subjects: SubjectRoutes }>['subjects'];
type SubjectPath = ReturnType<SubjectsClient>;
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
export type PostHistoryPage = NativePostHistoryPage;
export type ModerationDecisionPage = Static<ReturnType<typeof DecisionPageSchema>>;
export type DecisionPageAppeal = NonNullable<ModerationDecisionPage['appeal']>;
export type DecisionPageAppealAdvice = ModerationDecisionPage['viewer']['appeal'];
export type DecisionPageTargetContext = ModerationDecisionPage['targetContext'];
type NoticeInboxClient = ReturnType<KernelClient['accounts']>['notifications'];
type NoticeInboxRead = Awaited<ReturnType<NoticeInboxClient['get']>>;
type UnreadNoticeRead = Awaited<ReturnType<NoticeInboxClient['count']['get']>>;
export type NoticeInboxPage = NonNullable<NoticeInboxRead['data']>;
export type NoticeInboxItem = NoticeInboxPage['items'][number];
export type UnreadNoticeSummary = NonNullable<UnreadNoticeRead['data']>;
export type { InboxSelection as InboxNoticeSelection } from './kernel/content/notice-inbox.ts';
export type KernelSubjectsClient = Omit<SubjectsClient, keyof Function> &
  ((...args: Parameters<SubjectsClient>) => SubjectPath);
type MountedSubjectRead = SubjectRoutes[':id']['get']['response'][200];
export type SubjectReadQuery = SubjectRoutes[':id']['get']['query'];
export type SubjectRead = MountedSubjectRead;
type MountedSubjectLinksResponse = SubjectRoutes[':id']['links']['get']['response'][200];
export type SubjectLinksQuery = SubjectRoutes[':id']['links']['get']['query'];
export type SubjectLinksResponse = MountedSubjectLinksResponse;
export type WorkReleaseCards = NonNullable<SubjectLinksResponse['workReleaseCards']>;
export type WorkReleaseCard = Extract<WorkReleaseCards, { state: 'available' }>['cards'][number];
export type WorkReleaseCardProperty = keyof WorkReleaseCard['fields'];
export type WorkReleaseCardField = WorkReleaseCard['fields'][WorkReleaseCardProperty];

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
  const rawBody = Symbol('native-raw-body');
  const config = {
    // Eden calls this hook before and after serialization. Keep a top-level Blob request-local:
    // its JSON serializer would otherwise replace the original file bytes with {}.
    onRequest(_path: string, request: RequestInit & { [rawBody]?: Blob }) {
      const body = request[rawBody] ?? (request.body instanceof Blob ? request.body : undefined);
      if (body === undefined) return;
      return {
        [rawBody]: body,
        body,
        headers: { 'content-type': body.type || 'application/octet-stream' },
      };
    },
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

export {
  reviewedPersonRequests,
  reviewedPersonMergeInput,
  isReviewedPersonSource,
  isReviewedPersonEndpoint,
} from './reviewed-person-identity.ts';
export type {
  ReviewedPersonEndpoint,
  ReviewedPersonSource,
  ReviewedPersonRead,
  ReviewedPersonMerge,
  ReviewedPersonAdmission,
  ReviewedPersonOperation,
} from './reviewed-person-identity.ts';
export type {
  SubjectIdentityOperation,
  SubjectIdentityOperationAdmission,
  SubjectIdentityOperationRead,
  SubjectIdentityOperationRoutes,
} from './kernel/semantic/http/identity-operations.d.ts';
export type { ZoneSubjectListRoutes } from './kernel/zones/subjects.ts';

export type OwnVotesPage = Routes['me']['rating-votes']['get']['response'][200];
export type OwnVoteEntry = OwnVotesPage['votes'][number];
export type {
  ActivationReconciliation,
  EditorialHead,
  ExtensionComparison,
  PublicationDiagnostic,
  PublicationDocumentKind,
  PublicationIdentity,
  PublicationOperations,
  ReleaseComparison,
} from '@rezics/definitions';
export { PUBLICATION_GRANT, classifyImportedDocument, compareReleases, compareExtensions } from '@rezics/definitions';
