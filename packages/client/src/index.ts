import { treaty, type Treaty } from '@elysia/eden';
import type { DefaultMetadata, DefaultSingleton, Elysia } from 'elysia';
import type { SESSION_HEADER as KernelSessionHeader } from './kernel/http/request.ts';
import type { ClientKernel as KernelType } from './kernel/http/kernel.ts';
import type { subjectRoutes } from './kernel/semantic/http/subjects.ts';
import type { ModerationDecisionPage } from './kernel/content/decision-page.ts';
import type { PostHistoryPage as NativePostHistoryPage } from './kernel/content/history-page.ts';
import type { WatchManagementKind, WatchManagementPage } from './kernel/content/watch-management-contract';
import type { LibraryExportFinalManifest, LibraryExportManifest } from './kernel/library/library-export-format.ts';
import type { ExportRecord } from './kernel/library/library-export-source.ts';

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
} from './kernel/content/watch-management-contract';
export type { PreferencePage, PreferencePageAction, PreferencePageKind } from './kernel/access/preference-page';
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
export type BanReviewPageQuery = { limit?: number; cursor?: string; selectedAccountId?: string };
export type BanReviewIdentity =
  | {
      state: 'available';
      accountId: string;
      displayName: string | null;
      handle: string | null;
      label: string;
      destination: string | null;
    }
  | { state: 'concealed'; accountId: string; label: 'Account'; destination: null };
export type BanReviewPageItem = {
  accountId: string;
  reason: string;
  actor: string | null;
  at: string;
  account: BanReviewIdentity;
  moderator: BanReviewIdentity | null;
  unban: {
    state: 'permitted';
    realmId: string;
    accountId: string;
    observedAt: string;
    membershipRestored: false;
  };
  removal: { state: 'unavailable' };
};
export type BanReviewPage = {
  items: BanReviewPageItem[];
  next: string | null;
  context: { state: 'available'; realmTitle: string; spaceId: string; spaceTitle: string } | { state: 'concealed' };
  viewer: {
    accountId: string;
    clientId: string;
    requestedBy: string | null;
    authnEpoch: number;
    unban: {
      state: 'permitted';
      operationId: 'realm.unban';
      action: 'realm:ban';
      resource: { route: number; id: string };
      reauthorizes: true;
    };
  };
  selected:
    | { state: 'not-requested' }
    | { state: 'current'; ban: BanReviewPageItem }
    | { state: 'absent'; accountId: string; account: BanReviewIdentity };
};

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
type GeneratedAccountPath = ReturnType<GeneratedKernelClient['accounts']>;
type GeneratedAccountRead = GeneratedAccountPath['profile']['get'];
type WatchRequestOptions = Omit<NonNullable<Parameters<GeneratedAccountRead>[0]>, 'query'>;
type WatchListOptions = WatchRequestOptions & {
  query: { kind: WatchManagementKind; limit?: number; cursor?: string };
};
type WatchManagementRead = PersonalEntryCall<WatchManagementPage>;
type WatchRemovalPath = {
  delete(
    body: { expectedRevision: number },
    options: WatchRequestOptions & {
      query: { kind: WatchManagementKind };
      headers: Record<string, string> & { 'idempotency-key': string };
    },
  ): PersonalEntryCall<{ removed: true }>;
};
type WatchManagementPath = ((params: { watchId: string }) => WatchRemovalPath) & {
  get(options: WatchListOptions): WatchManagementRead;
};
type AccountsPath = Omit<GeneratedAccountPath, 'watches'> & { watches: WatchManagementPath };
type AccountsClient = Omit<GeneratedKernelClient['accounts'], keyof Function> &
  ((...args: Parameters<GeneratedKernelClient['accounts']>) => AccountsPath);
type GeneratedBoardsPath = ReturnType<GeneratedKernelClient['boards']>;
type BoardWatchState = { watching: boolean; revision: number };
type BoardWatchPath = {
  get(options?: WatchRequestOptions): PersonalEntryCall<BoardWatchState>;
  put(
    body: { watching: boolean; expectedRevision: number },
    options: PersonalWriteOptions,
  ): PersonalEntryCall<BoardWatchState>;
};
type BoardsPath = Omit<GeneratedBoardsPath, 'watch'> & { watch: BoardWatchPath };
type BoardsClient = Omit<GeneratedKernelClient['boards'], keyof Function> &
  ((...args: Parameters<GeneratedKernelClient['boards']>) => BoardsPath);
type GeneratedBanReviewGet = ReturnType<GeneratedKernelClient['realms']>['bans']['get'];
type GeneratedBanReviewRead = Awaited<ReturnType<GeneratedBanReviewGet>>;
type BanReviewRead = Omit<GeneratedBanReviewRead, 'data'> & { data: BanReviewPage | null };
type BanReviewGetOptions = Omit<NonNullable<Parameters<GeneratedBanReviewGet>[0]>, 'query'> & {
  query?: BanReviewPageQuery;
};
type BanReviewEndpoints = Omit<ReturnType<GeneratedKernelClient['realms']>['bans'], 'get'> & {
  get(options?: BanReviewGetOptions): Promise<BanReviewRead>;
};
type GeneratedRealmPath = ReturnType<GeneratedKernelClient['realms']>;
type RealmPath = Omit<GeneratedRealmPath, 'bans'> & { bans: BanReviewEndpoints };
type RealmsClient = Omit<GeneratedKernelClient['realms'], keyof Function> &
  ((...args: Parameters<GeneratedKernelClient['realms']>) => RealmPath);
type GeneratedPostPath = ReturnType<GeneratedKernelClient['posts']>;
type GeneratedPostHistoryPath = GeneratedPostPath['revisions'];
type GeneratedPostHistoryRead = Awaited<ReturnType<GeneratedPostHistoryPath['get']>>;
type NativeHistoryData = NonNullable<GeneratedPostHistoryRead['data']> & { page: NativePostHistoryPage };
type NativeHistoryRead = Omit<GeneratedPostHistoryRead, 'data'> & { data: NativeHistoryData | null };
type PostHistoryPath = Omit<GeneratedPostHistoryPath, 'get'> &
  ((...args: Parameters<GeneratedPostHistoryPath>) => ReturnType<GeneratedPostHistoryPath>) & {
    get: (...args: Parameters<GeneratedPostHistoryPath['get']>) => Promise<NativeHistoryRead>;
  };
type PostPath = Omit<GeneratedPostPath, 'revisions'> & { revisions: PostHistoryPath };
type PostsClient = Omit<GeneratedKernelClient['posts'], keyof Function> &
  ((...args: Parameters<GeneratedKernelClient['posts']>) => PostPath);

type ReadingPageCall = ReturnType<ReturnType<GeneratedKernelClient['threads']>['reading-page']['get']>;
/** Response declared by the mounted thread reading route. */
export type ReadingPageResponse = NonNullable<Awaited<ReadingPageCall>['data']>;

type BoardPageCall = ReturnType<ReturnType<GeneratedKernelClient['boards']>['page']['get']>;
/** Response declared by the mounted GET /v1/boards/:id/page route. */
export type BoardPageResponse = NonNullable<Awaited<BoardPageCall>['data']>;
type PersonalEntryPath = ReturnType<GeneratedKernelClient['libraryEntries']>;
type DecisionPagePath = ReturnType<GeneratedKernelClient['moderation-decisions']>;
type DecisionPageGet = DecisionPagePath['get'];
type DecisionPageRead = Awaited<ReturnType<DecisionPageGet>>;
type DecisionPageReadResult = Omit<DecisionPageRead, 'data'> & { data: ModerationDecisionPage | null };
type DecisionAppealPost = DecisionPagePath['$appeal']['post'];
type DecisionAppealOptions = Parameters<DecisionAppealPost>[1] & {
  headers: { authorization?: string };
};
type DecisionPageEndpoints = Omit<DecisionPagePath, 'get' | '$appeal'> & {
  get(...args: Parameters<DecisionPageGet>): Promise<DecisionPageReadResult>;
  $appeal: Omit<DecisionPagePath['$appeal'], 'post'> & {
    post(body: Parameters<DecisionAppealPost>[0], options: DecisionAppealOptions): ReturnType<DecisionAppealPost>;
  };
};
type DecisionPages = Omit<GeneratedKernelClient['moderation-decisions'], keyof Function> &
  ((...args: Parameters<GeneratedKernelClient['moderation-decisions']>) => DecisionPageEndpoints);
type PersonalEntryCall<T> = Promise<{
  data: T | null;
  error: { value: unknown; status?: number } | null;
  response: Response;
  status: number;
  headers: Headers;
}>;
type PersonalReadOptions = { headers?: Record<string, string>; fetch?: { signal?: AbortSignal } };
type PersonalWriteOptions = { headers: Record<string, string> & { 'idempotency-key': string } };
type PersonalEntryEndpoints = {
  personal: {
    get(
      options?: PersonalReadOptions,
    ): PersonalEntryCall<{ personalEntry: import('./kernel/library/entry-personal-model').PersonalEntry }>;
  };
  annotations: {
    put(
      body: import('./kernel/library/entry-personal-model').PersonalEntryAnnotationWrite,
      options: PersonalWriteOptions,
    ): PersonalEntryCall<{ personalEntry: import('./kernel/library/entry-personal-model').PersonalEntry }>;
  };
  sourceObservations: {
    post(
      body: import('./kernel/library/entry-personal-model').PersonalEntrySourceAdmission,
      options: PersonalWriteOptions,
    ): PersonalEntryCall<{
      sourceObservation: import('./kernel/library/entry-personal-model').PersonalEntryObservation;
    }>;
    patch(
      body: import('./kernel/library/entry-personal-model').PersonalEntrySourceCorrection,
      options: PersonalWriteOptions,
    ): PersonalEntryCall<{
      sourceObservation: import('./kernel/library/entry-personal-model').PersonalEntryObservation;
    }>;
  };
};
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
type PersonalLibraryEntries = Omit<GeneratedKernelClient['libraryEntries'], keyof Function> &
  ((...args: Parameters<GeneratedKernelClient['libraryEntries']>) => PersonalEntryPath & PersonalEntryEndpoints);

export type LibraryExportState = 'collecting' | 'ready' | 'stale' | 'cancelled' | 'expired' | 'limit';
export type LibraryExportStatus = LibraryExportManifest & {
  fullExport: false;
  state: LibraryExportState;
  first: string | null;
};
export type LibraryExportPage = {
  exportId: string;
  state: LibraryExportState;
  records: ExportRecord[];
  next: string | null;
  manifest: LibraryExportFinalManifest | null;
};
type LibraryExportPath = {
  get(options?: PersonalReadOptions): PersonalEntryCall<LibraryExportStatus>;
  delete(options?: PersonalReadOptions): PersonalEntryCall<LibraryExportStatus>;
  pages: {
    get(options: { query: { cursor: string } } & PersonalReadOptions): PersonalEntryCall<LibraryExportPage>;
  };
};
type LibraryExportsClient = ((params: { id: string }) => LibraryExportPath) & {
  post(options: PersonalWriteOptions): PersonalEntryCall<LibraryExportStatus>;
};

type SubjectsClient = Treaty.Sign<{ subjects: SubjectRoutes }>['subjects'];
type SubjectPath = ReturnType<SubjectsClient>;
type ProvisionalClassificationsClient = import('./kernel/rating/source-classifications.ts').SourceClassificationsClient;
// Preserve the existing consumer seam while publication is pending. Once installed, the mounted transport
// supplies its complete mutation unions without intersection with the provisional narrowing.
type ClassificationCompatibility<Path> = Path extends { 'source-classifications': unknown }
  ? Path
  : Path & { 'source-classifications': ProvisionalClassificationsClient };

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

export type KernelClient = Omit<
  GeneratedKernelClient,
  'accounts' | 'boards' | 'posts' | 'subjects' | 'libraryEntries' | 'libraryExports' | 'moderation-decisions' | 'realms'
> & {
  posts: PostsClient;
  libraryEntries: PersonalLibraryEntries;
  libraryExports: LibraryExportsClient;
  accounts: AccountsClient;
  boards: BoardsClient;
  subjects: KernelSubjectsClient;
  'moderation-decisions': DecisionPages;
  realms: RealmsClient;
};
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
export type { InboxNoticeSelection } from './kernel/content/notice-inbox-selection.ts';
export type KernelSubjectsClient = Omit<SubjectsClient, keyof Function> &
  ((...args: Parameters<SubjectsClient>) => ClassificationCompatibility<SubjectPath>);
export type SubjectRead = SubjectRoutes[':id']['get']['response'][200];
type SubjectPath = ReturnType<KernelClient['subjects']>;
export type SubjectLinksResponse = NonNullable<Awaited<ReturnType<SubjectPath['links']['get']>>['data']>;
export type WorkReleaseCards = NonNullable<SubjectLinksResponse['workReleaseCards']>;
export type WorkReleaseCard = Extract<WorkReleaseCards, { state: 'available' }>['cards'][number];

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
  return treaty<ClientApp>(origin, config).v1 as unknown as KernelClient;
}

export type QuestionLabelInput = Routes['rating-questions'][':questionId']['label']['put']['body'];
export type QuestionLabelResult = Routes['rating-questions'][':questionId']['label']['put']['response'][200];
export type QuestionLabelHistoryQuery = Routes['rating-questions'][':questionId']['labels']['get']['query'];
type ClassificationBallotOwnPageRoute = Routes['me']['classification-assessments']['get'];
export type ClassificationBallotOwnPageQuery = ClassificationBallotOwnPageRoute['query'];
export type ClassificationBallotOwnPage = ClassificationBallotOwnPageRoute['response'][200];
export type ClassificationBallotOwnPageItem = ClassificationBallotOwnPage['items'][number];
