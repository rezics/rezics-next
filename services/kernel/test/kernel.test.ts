import { afterAll, beforeAll, expect, test } from 'bun:test';
import { testReceiptKeys } from './support/receipt-keys.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../src/database/pool.ts';
import { createKernel, type Kernel } from '../src/http/kernel.ts';
import { openApiDocument } from '../src/http/openapi.ts';
import { actionCatalogue } from '../src/http/request.ts';
import { bootstrapRelease } from '../src/semantic/definitions.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
beforeAll(() => bootstrapRelease(pool, bundledRelease));
afterAll(() => pool.end());

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Name<Key extends string, Path extends string> = `${Uppercase<Key>} ${Path extends '' ? '/' : Path}`;
/** Every `METHOD /path` in the route tree Eden builds its client from. */
type TypedRoutes<Tree, Path extends string = ''> = {
  [Key in keyof Tree & string]: Key extends Method ? Name<Key, Path> : TypedRoutes<Tree[Key], `${Path}/${Key}`>;
}[keyof Tree & string];
type Success<Route> = Route extends { response: infer Responses }
  ? Responses[Extract<keyof Responses, 200 | 201 | 202 | 204>]
  : never;
/** Routes whose success response type is an open record: its schema was lost on the way into the route. */
type LooseRoutes<Tree, Path extends string = ''> = {
  [Key in keyof Tree & string]: Key extends Method
    ? [Success<Tree[Key]>] extends [never]
      ? never
      : string extends keyof Success<Tree[Key]>
        ? Name<Key, Path>
        : never
    : LooseRoutes<Tree[Key], `${Path}/${Key}`>;
}[keyof Tree & string];
type Routes = TypedRoutes<Kernel['~Routes']>;

// Type-checking proves that each entry is a typed route, that no typed route is missing, and that every success
// response keeps its schema's type. An error names the offending routes.
const typed = [
  'POST /v1/libraryCopyArchives',
  'GET /v1/threads/:id/watch',
  'PUT /v1/threads/:id/watch',
  'DELETE /v1/threads/:id/watch',
  'GET /v1/libraryCopyArchives/:id',
  'POST /v1/libraryCopyArchives/:id/$cancel',
  'DELETE /v1/libraryCopyArchives/:id',
  'POST /v1/libraryImports/anilist/$preview',
  'GET /v1/libraryImports/anilist/:importId',
  'POST /v1/libraryImports/anilist/:importId/$review',
  'POST /v1/libraryImports/anilist/:importId/$apply',
  'POST /v1/libraryImports/anilist/:importId/$reviewLabels',
  'POST /v1/libraryImports/anilist/:importId/$applyLabels',
  'POST /v1/libraryImports/anilist/:importId/$cancel',
  'POST /v1/libraryImports/vndb/$preview',
  'GET /v1/libraryImports/vndb/:uploadId',
  'GET /v1/libraryImports/vndb/:uploadId/source',
  'POST /v1/libraryImports/vndb/:uploadId/$review',
  'POST /v1/libraryImports/vndb/:uploadId/$apply',
  'POST /v1/libraryImports/vndb/:uploadId/$cancel',
  'DELETE /v1/libraryImports/vndb/:uploadId',
  'GET /health',
  'GET /v1/commerceMoney',
  'GET /v1/commerceSales',
  'POST /v1/libraryImports/mal/$preview',
  'GET /v1/libraryImports/mal/:id',
  'GET /v1/libraryImports/mal/:id/source',
  'POST /v1/libraryImports/mal/:id/review',
  'POST /v1/libraryImports/mal/:id/apply',
  'POST /v1/libraryImports/mal/:id/cancel',
  'DELETE /v1/libraryImports/mal/:id',
  'GET /v1/libraryEntries/:subjectId/state-history',
  'GET /v1/libraryEntries/:subjectId/state-history/:changeRevision',
  'POST /v1/libraryEntries/:subjectId/state-history/:changeRevision/$restore',
  'POST /v1/viewerActions',
  'POST /v1/webhooks/stripe',
  'GET /v1/subjects/:id/offers',
  'GET /v1/offers/:offerId',
  'GET /v1/offers',
  'POST /v1/offers',
  'PATCH /v1/offers/:offerId',
  'POST /v1/offers/:offerId/$delist',
  'POST /v1/orders',
  'GET /v1/orders',
  'GET /v1/orders/:orderId',
  'POST /v1/orders/:orderId/$reconcile',
  'GET /v1/entitlements',
  'GET /v1/entitlements/:entitlementId',
  'POST /v1/progressSessions',
  'GET /v1/progressSessions',
  'GET /v1/progressSessions/:sessionId',
  'GET /v1/progressSessions/:sessionId/journal',
  'PATCH /v1/progressSessions/:sessionId/journal',
  'POST /v1/progressSessions/:sessionId/$record',
  'POST /v1/progressSessions/:sessionId/$complete',
  'POST /v1/progressSessions/:sessionId/$abandon',
  'POST /v1/progressSessions/:sessionId/$reopen',
  'POST /v1/progressSessions/:sessionId/$retire',
  'GET /v1/progressSessions/:sessionId/completedUnits',
  'GET /v1/progressSessions/:sessionId/changes',
  'GET /v1/progressSessions/:sessionId/episodes',
  'POST /v1/progressSessions/:sessionId/$recordEpisodes',
  'POST /v1/publishedLogs',
  'GET /v1/publishedLogs/:logId',
  'GET /v1/publishedLogs',
  'DELETE /v1/publishedLogs/:logId',
  'POST /v1/publishedLogs/:logId/$restore',
  'POST /v1/subjects',
  'POST /v1/subjects/$batchWrite',
  'POST /v1/source-records/$setMetadata',
  'PUT /v1/realms/:realmId/boardScheme',
  'POST /v1/subjects/$facets',
  'POST /v1/spaces',
  'GET /v1/spaces/:spaceId/lifecycle',
  'POST /v1/spaces/:spaceId/removal',
  'POST /v1/spaces/:spaceId/restoration',
  'GET /v1/realms/:realmId/lifecycle',
  'POST /v1/realms/:realmId/removal',
  'POST /v1/realms/:realmId/restoration',
  'POST /v1/realms/:realmId/claimRequests/:requestId/$approve',
  'POST /v1/realms/:realmId/publications/:subjectId/$withdraw',
  'POST /v1/realms/:realmId/publications/:subjectId/$reject',
  'POST /v1/realms/:realmId/publications',
  'POST /v1/realms',
  'POST /v1/realms/:realmId/claimRequests',
  'GET /v1/realms/:realmId/claimRequests/mine',
  'GET /v1/realms/:realmId/claimRequests/:requestId',
  'GET /v1/realms/:realmId/claimRequests',
  'POST /v1/presentation/profiles/:digest/$activate',
  'POST /v1/presentation/profiles',
  'POST /v1/pages/$read',
  'POST /v1/accounts/:accountId/lifecycleReview',
  'POST /v1/accounts/:accountId/$suspend',
  'POST /v1/accounts/:accountId/$reinstate',
  'POST /v1/accounts/:accountId/$setRateTier',
  'POST /v1/accounts/:accountId/$requestVerification',
  'GET /v1/accounts/:accountId/verification',
  'POST /v1/accounts/:accountId/$withdrawVerification',
  'POST /v1/accounts/:accountId/$revokeVerification',
  'POST /v1/accounts/:accountId/$releaseVerification',
  'GET /v1/verification-requests',
  'POST /v1/verification-requests/:requestId/$approve',
  'POST /v1/verification-requests/:requestId/$reject',
  'GET /v1/agent-pages',
  'GET /v1/accounts',
  'GET /v1/me/managedAccounts',
  'GET /v1/accounts/:accountId/management',
  'GET /v1/accounts/:accountId/profile',
  'GET /v1/accounts/:accountId/erasureStatus',
  'PATCH /v1/accounts/:accountId',
  'GET /v1/accounts/:accountId/speakers',
  'GET /v1/accounts/:accountId/preferences',
  'GET /v1/accounts/:accountId/editions',
  'PATCH /v1/accounts/:accountId/preferences',
  'GET /v1/me/realms',
  'GET /v1/platform/exposure',
  'GET /v1/platform/exposure/management',
  'POST /v1/platform/exposure/:group/$close',
  'POST /v1/platform/exposure/:group/$open',
  'PATCH /v1/spaces/:spaceId',
  'PATCH /v1/realms/:realmId',
  'GET /v1/spaces/:spaceId',
  'GET /v1/realms/discovery',
  'GET /v1/realms/:realmId/publications/:subjectId',
  'GET /v1/realms/:realmId/publications',
  'GET /v1/realms/:realmId',
  'GET /v1/realms/:realmId/presentation',
  'GET /v1/realms/:realmId/participation',
  'POST /v1/realms/:realmId/membership',
  'DELETE /v1/realms/:realmId/membership',
  'POST /v1/realms/:realmId/members',
  'GET /v1/realms/:realmId/members/me',
  'PUT /v1/realms/:realmId/bans/:accountId',
  'DELETE /v1/realms/:realmId/bans/:accountId',
  'GET /v1/realms/:realmId/bans',
  'GET /v1/presentation/profiles/:digest',
  'GET /v1/presentation/active',
  'DELETE /v1/posts/:id',
  'POST /v1/subjects/$merge',
  'GET /v1/subjects/:id',
  'PATCH /v1/subjects/:id/terms',
  'GET /v1/subject-pages',
  'POST /v1/subjects/:id/$hide',
  'POST /v1/subjects/:id/$takedown',
  'POST /v1/subjects/:id/$restore',
  'POST /v1/contexts',
  'GET /v1/contexts',
  'GET /v1/contexts/:id',
  'GET /v1/contexts/:id/lifecycle',
  'DELETE /v1/contexts/:id',
  'POST /v1/contexts/:id/$restore',
  'POST /v1/subjects/$search',
  'GET /v1/subjects/$suggest',
  'GET /v1/trendingSearches',
  'GET /v1/payoutStatements',
  'GET /v1/payoutStatements/:statementId',
  'GET /v1/payoutStatements/:statementId/lines',
  'POST /v1/payoutStatements/:statementId/$markPaid',
  'POST /v1/subjects/:id/candidates',
  'DELETE /v1/subjects/:id/candidates/:candidate',
  'POST /v1/subjects/:id/candidates/:candidate/$restoreDeleted',
  'POST /v1/subjects/:id/candidates/:candidate/$accept',
  'POST /v1/subjects/:id/candidates/:candidate/$reject',
  'POST /v1/subjects/:id/candidates/:candidate/$hide',
  'POST /v1/subjects/:id/candidates/:candidate/$takedown',
  'POST /v1/subjects/:id/candidates/:candidate/$restore',
  'POST /v1/subjects/:id/$adopt',
  'GET /v1/subjects/:id/candidates',
  'GET /v1/review-candidates',
  'POST /v1/review-candidates/$prepare',
  'GET /v1/subjects/:id/revisions',
  'GET /v1/subjects/:id/revisions/:revision',
  'GET /v1/subjects/:id/links',
  'GET /v1/subjects/:id/counts',
  'GET /v1/subjects/:id/figure',
  'GET /v1/subjects/:id/relations',
  'GET /v1/subjects/graph',
  'GET /v1/subjects/:id/graph',
  'POST /v1/definitions/releases',
  'GET /v1/definitions/releases/:digest',
  'GET /v1/definitions/active',
  'GET /v1/definitionTypes',
  'GET /v1/definitionTypes/:typeId',
  'POST /v1/definitions/releases/:digest/$activate',
  'POST /v1/definitions/catalogue/artifacts',
  'POST /v1/definitions/catalogues',
  'POST /v1/definitions/catalogues/:root/$step',
  'POST /v1/definitions/catalogues/:root/$activate',
  'GET /v1/definitions/catalogue',
  'GET /v1/definitions/catalogues/:root/build',
  'POST /v1/definitions/catalogues/:root/kinds/$resolve',
  'GET /v1/definitions/catalogues/:root/kinds',
  'GET /v1/definitions/catalogues/:root/candidates',
  'POST /v1/contexts/:id/definitions/extensions',
  'POST /v1/contexts/:id/definitions/extensions/:digest/$activate',
  'GET /v1/contexts/:id/definitions',
  'GET /v1/sourceFences/$check',
  'POST /v1/sourceFences/$takedown',
  'POST /v1/media/:id/$takeDown',
  'POST /v1/media/$importFromUrl',
  'GET /v1/media/:id/$importStatus',
  'GET /v1/documents/:id',
  'DELETE /v1/documents/:id',
  'POST /v1/reports',
  'GET /v1/reports/me',
  'GET /v1/reports/:id',
  'POST /v1/reports/:id/$dismiss',
  'POST /v1/contentEditions',
  'POST /v1/contentEditions/:id/$publish',
  'POST /v1/contentEditions/:id/$unpublish',
  'GET /v1/contentEditions/:id',
  'GET /v1/contentEditions/:id/revision',
  'POST /v1/threads',
  'GET /v1/threads/:id',
  'POST /v1/threads/:id/posts',
  'GET /v1/threads/:id/posts',
  'GET /v1/threads/:id/posts/:postId/location',
  'GET /v1/posts/:id',
  'POST /v1/posts/:id/$restore',
  'POST /v1/posts/:id/revisions',
  'GET /v1/posts/:id/revisions',
  'GET /v1/posts/:id/revisions/:revisionId',
  'GET /v1/boards/:id/threads',
  'POST /v1/boards/:id/threads/:threadId/pin',
  'GET /v1/sitemap/boards',
  'GET /v1/sitemap/threads',
  'GET /v1/sitemap/realms',
  'GET /v1/sitemap/spaces',
  'GET /v1/sitemap/collections',
  'GET /v1/boards/:id',
  'GET /v1/boards/:id/watch',
  'PUT /v1/boards/:id/watch',
  'GET /v1/accounts/:accountId/watches',
  'DELETE /v1/accounts/:accountId/watches/:watchId',
  'GET /v1/boards',
  'GET /v1/boards/:id/slowMode',
  'PUT /v1/boards/:id/slowMode',
  'POST /v1/boards',
  'GET /v1/boards/:id/reports',
  'GET /v1/moderation-decisions/:id',
  'POST /v1/moderation-decisions/:id/$appeal',
  'POST /v1/moderation-appeals/:id/$resolve',
  'GET /v1/boards/:id/appeals',
  'GET /v1/boards/:id/moderation-history',
  'GET /v1/threads/:id/appeals',
  'GET /v1/threads/:id/reports',
  'GET /v1/posts/:id/reports',
  'GET /v1/subjects/:id/reports',
  'GET /v1/spaces/:spaceId/reports',
  'GET /v1/realms/:realmId/reports',
  'GET /v1/catalogue/reports',
  'POST /v1/boards/:id/$takeDown',
  'POST /v1/threads/:id/$takeDown',
  'POST /v1/posts/:id/$takeDown',
  'POST /v1/posts/:id/$erase',
  'POST /v1/threads/:id/$erase',
  'GET /v1/openapi.json',
  'GET /v1/operations/:id',
  'POST /v1/media',
  'POST /v1/media/presentations',
  'POST /v1/realms/:realmId/media',
  'GET /v1/media',
  'GET /v1/media/:id',
  'POST /v1/media/:id/$complete',
  'DELETE /v1/media/:id',
  'GET /v1/media/:id/$authorizeDownload',
  'GET /v1/grants',
  'POST /v1/grants',
  'POST /v1/grants/$change',
  'POST /v1/grants/$revoke',
  'POST /v1/roleGrants',
  'POST /v1/roleGrants/$transferRealmOwner',
  'POST /v1/roleGrants/$change',
  'POST /v1/roleGrants/$revoke',
  'POST /v1/realms/:realmId/boards',
  'GET /v1/realms/:realmId/boards',
  'PUT /v1/threads/:id/reaction',
  'DELETE /v1/threads/:id/reaction',
  'PUT /v1/posts/:id/reaction',
  'DELETE /v1/posts/:id/reaction',
  'PUT /v1/spaces/:spaceId/address',
  'GET /v1/spaceAddresses/:address',
  'GET /v1/recentSearches',
  'POST /v1/recentSearches',
  'DELETE /v1/recentSearches/:id',
  'POST /v1/recentSearches/$clear',
  'POST /v1/libraryImports/anilist/:importId/$reviewLabels',
  'POST /v1/libraryImports/anilist/:importId/$applyLabels',
  'POST /v1/libraryImports/bangumi/$preview',
  'GET /v1/libraryImports/bangumi/:uploadId',
  'POST /v1/libraryImports/bangumi/:uploadId/$review',
  'POST /v1/libraryImports/bangumi/:uploadId/$apply',
  'GET /v1/libraryImports/bangumi/:uploadId/rows/:ordinal/tags',
  'POST /v1/libraryImports/bangumi/:uploadId/$reviewLabels',
  'POST /v1/libraryImports/bangumi/:uploadId/$applyLabels',
  'POST /v1/libraryImports/bangumi/:uploadId/$cancel',
  'DELETE /v1/libraryImports/bangumi/:uploadId',
  'GET /v1/libraryEntries',
  'POST /v1/libraryExports',
  'GET /v1/libraryExports/:id',
  'GET /v1/libraryExports/:id/pages',
  'DELETE /v1/libraryExports/:id',
  'POST /v1/libraryArchiveCollectionRecoveries',
  'GET /v1/libraryArchiveCollectionRecoveries/:id',
  'GET /v1/libraryArchiveCollectionRecoveries/:id/collections',
  'GET /v1/libraryArchiveCollectionRecoveries/:id/collections/:collectionId/occurrences',
  'POST /v1/libraryArchiveCollectionRecoveries/:id/review',
  'POST /v1/libraryArchiveCollectionRecoveries/:id/apply',
  'GET /v1/libraryArchiveCollectionRecoveries/:id/outcomes',
  'DELETE /v1/libraryArchiveCollectionRecoveries/:id',
  'GET /v1/libraryContinue',
  'GET /v1/libraryDiary',
  'POST /v1/libraryDiary/$cancel',
  'GET /v1/feedItems',
  'GET /v1/libraryShelfSummary',
  'GET /v1/libraryShelfTypes',
  'GET /v1/libraryEntries/:subjectId',
  'PUT /v1/libraryEntries/:subjectId',
  'POST /v1/libraryEntries/:subjectId/$restore',
  'DELETE /v1/libraryEntries/:subjectId',
  'GET /v1/libraryLabels',
  'POST /v1/libraryLabels',
  'PATCH /v1/libraryLabels/:id',
  'DELETE /v1/libraryLabels/:id',
  'POST /v1/libraryLabels/:id/$restore',
  'POST /v1/libraryLabels/:id/$assign',
  'POST /v1/libraryLabels/:id/$reviewConsolidation',
  'POST /v1/libraryLabels/:id/$confirmConsolidation',
  'POST /v1/libraryLabels/:id/$applyConsolidation',
  'POST /v1/libraryLabels/:id/$retryConsolidation',
  'POST /v1/libraryLabels/:id/$cancelConsolidation',
  'GET /v1/libraryLabels/:id/consolidations/:confirmationId',
  'POST /v1/libraryLabels/:id/$unassign',
  'POST /v1/libraryLabels/:id/$restoreAssignment',
  'POST /v1/libraryLabels/:id/$reviewConsolidation',
  'POST /v1/libraryLabels/:id/$confirmConsolidation',
  'POST /v1/libraryLabels/:id/$applyConsolidation',
  'POST /v1/libraryLabels/:id/$retryConsolidation',
  'POST /v1/libraryLabels/:id/$cancelConsolidation',
  'GET /v1/libraryLabels/:id/consolidations/:confirmationId',
  'GET /v1/libraryLabelAssignments',
  'POST /v1/copies',
  'GET /v1/copies',
  'GET /v1/copies/:copyId',
  'PATCH /v1/copies/:copyId',
  'DELETE /v1/copies/:copyId',
  'POST /v1/copies/:copyId/$restore',
  'PUT /v1/follows/:targetId',
  'DELETE /v1/follows/:targetId',
  'GET /v1/follows/:targetId',
  'GET /v1/follows',
  'GET /v1/followCounts/outgoing',
  'GET /v1/followCounts/:targetType/:targetId',
  'POST /v1/collections',
  'GET /v1/collections',
  'GET /v1/accounts/:accountId/collections',
  'GET /v1/collections/:collectionId',
  'PATCH /v1/collections/:collectionId',
  'GET /v1/collections/:collectionId/rule',
  'PUT /v1/collections/:collectionId/rule',
  'POST /v1/collections/:collectionId/$publishSelected',
  'POST /v1/collections/:collectionId/$publish',
  'GET /v1/collectionPublications/:id',
  'DELETE /v1/collections/:collectionId',
  'POST /v1/collections/:collectionId/$restore',
  'GET /v1/collections/:collectionId/members',
  'POST /v1/collections/:collectionId/members',
  'PATCH /v1/collections/:collectionId/members/:memberId',
  'DELETE /v1/collections/:collectionId/members/:memberId',
  'POST /v1/collections/:collectionId/members/:memberId/$restore',
  'POST /v1/collections/:collectionId/members/:memberId/$move',
  'POST /v1/collections/:collectionId/members/$batchRemove',
  'POST /v1/collections/:collectionId/members/$move',
  'GET /v1/subjects/:id/collections',
  'POST /v1/libraryOperations',
  'GET /v1/libraryOperations/:operationId',
  'GET /v1/libraryOperations/:operationId/outcomes',
  'POST /v1/libraryOperations/:operationId/$confirm',
  'POST /v1/libraryOperations/:operationId/$cancel',
  'GET /v1/libraryPins',
  'PUT /v1/libraryPins/:collectionId',
  'DELETE /v1/libraryPins/:collectionId',
  'POST /v1/statements/:id/disclose',
  'POST /v1/statements/:id/retract',
  'GET /v1/subjects/:id/reactions',
  'GET /v1/subjects/:id/reaction',
  'PUT /v1/subjects/:id/reaction',
  'DELETE /v1/subjects/:id/reaction',
  'POST /v1/realms/:realmId/rating-questions',
  'POST /v1/rating-questions/:questionId/$retire',
  'POST /v1/rating-questions/:questionId/$restore',
  'PUT /v1/rating-questions/:questionId/label',
  'GET /v1/rating-questions/:questionId/labels',
  'GET /v1/rating-questions/:questionId/labels/:labelRevision',
  'GET /v1/rating-questions',
  'GET /v1/rating-questions/:questionId',
  'GET /v1/subjects/:id/ratings',
  'GET /v1/subjects/:id/ratings/populations',
  'PUT /v1/subjects/:id/ratings/:questionId/vote',
  'DELETE /v1/subjects/:id/ratings/:questionId/vote',
  'GET /v1/subjects/:id/ratings/:questionId/vote',
  'GET /v1/me/rating-votes',
  'GET /v1/subjects/:id/threads',
  'GET /v1/accounts/:accountId/threads',
  'GET /v1/accounts/:accountId/drafts',
  'GET /v1/accounts/:accountId/drafts/:id',
  'GET /v1/accounts/:accountId/posts',
  'GET /v1/accounts/:accountId/realms',
  'POST /v1/subjects/:id/source-classifications/$read',
  'POST /v1/subjects/:id/source-classifications/$put',
  'POST /v1/subjects/:id/source-classifications/$clear',
  'GET /v1/subjects/:id/source-statistics',
  'PUT /v1/subjects/:id/source-statistics/:source',
  'POST /v1/subjects/:id/source-statistics/:source/$clear',
  'POST /v1/zones',
  'GET /v1/zones',
  'GET /v1/zones/:id',
  'POST /v1/zones/:id/$readPage',
  'GET /v1/zones/:id/configuration',
  'PUT /v1/zones/:id/configuration',
  'POST /v1/zones/:id/$publish',
  'DELETE /v1/zones/:id',
  'POST /v1/zones/:id/$restore',
  'GET /v1/accounts/:accountId/notifications',
  'GET /v1/libraryConsumptionSummary',
  'GET /v1/libraryReportedYearSummary',
  'GET /v1/accounts/:accountId/notifications/count',
  'POST /v1/accounts/:accountId/notifications/$markSeen',
] as const satisfies readonly Routes[];
type Missing = Exclude<Routes, (typeof typed)[number]>;
const complete: [Missing] extends [never] ? true : Missing = true;
type Loose = LooseRoutes<Kernel['~Routes']>;
const precise: [Loose] extends [never] ? true : Loose = true;

test("the kernel app's type, which is the Eden contract, carries exactly the routes it serves and their responses", () => {
  const app = createKernel({ receiptKeys: testReceiptKeys(), pool, routeKey: new Uint8Array(32) });
  const served = app.routes.map(({ method, path }) => `${method} ${path}`);
  const paths = openApiDocument(app).paths;
  const journal = paths['/v1/progressSessions/{sessionId}/journal'];
  expect(journal?.get?.operationId).toBe('progress_session_journal.read');
  expect(journal?.patch?.operationId).toBe('progress_session_journal.update');
  expect(paths['/v1/libraryImports/anilist/{importId}:reviewLabels']?.post?.operationId).toBe(
    'library_import_anilist.review_labels',
  );
  expect(paths['/v1/libraryImports/anilist/{importId}:applyLabels']?.post?.operationId).toBe(
    'library_import_anilist.apply_labels',
  );
  expect([complete, precise]).toEqual([true, true]);
  expect(served.sort()).toEqual([...typed].sort());
});

test('semantic editorial listings document their default page size', () => {
  const paths = openApiDocument(
    createKernel({ receiptKeys: testReceiptKeys(), pool, routeKey: new Uint8Array(32) }),
  ).paths;
  for (const path of ['/v1/subjects/{id}/candidates', '/v1/subjects/{id}/revisions', '/v1/subjects/{id}/links']) {
    expect(paths[path]!.get!.parameters).toContainEqual(
      expect.objectContaining({ name: 'limit', in: 'query', schema: expect.objectContaining({ default: 20 }) }),
    );
  }
  expect(paths['/v1/subjects/{id}/relations']!.get!.parameters).toContainEqual(
    expect.objectContaining({ name: 'limit', in: 'query', schema: expect.objectContaining({ default: 25 }) }),
  );
});

test('question lifecycle commands publish their native Realm management authority', () => {
  const paths = openApiDocument(
    createKernel({ receiptKeys: testReceiptKeys(), pool, routeKey: new Uint8Array(32) }),
  ).paths;
  for (const operationId of ['rating.question_retire', 'rating.question_restore'] as const) {
    const operation = Object.values(paths)
      .map((item) => item.post)
      .find((item) => item?.operationId === operationId);
    expect(operation).toMatchObject({
      operationId,
      'x-action': 'realm:manage',
      'x-exposure': 'public',
      'x-resource-types': ['community.realm'],
    });
  }
});

test('mounted action catalogues contain only their declared actions and never infer account management', () => {
  const mounted = actionCatalogue(createKernel({ receiptKeys: testReceiptKeys(), pool, routeKey: new Uint8Array(32) }));
  expect(mounted.has('account:manage')).toBe(false);
  for (const action of new Set(['account:update', 'custom:write', 'account:manage', ...mounted.keys()])) {
    const catalogue = actionCatalogue({
      routes: [
        {
          method: 'PATCH',
          path: '/custom',
          hooks: {
            detail: { operationId: 'custom.write', 'x-action': action, security: [{ bearerAuth: [] }] },
          },
        },
      ],
    });
    expect([...catalogue.keys()]).toEqual([action]);
  }
});

test('known-order reconciliation declares its exact own-account action and ordinary write policy', () => {
  const app = createKernel({ receiptKeys: testReceiptKeys(), pool, routeKey: new Uint8Array(32) });
  expect(actionCatalogue(app).get('order:reconcile')).toEqual({ anonymous: false, authority: 'own-account' });
  expect(openApiDocument(app).paths['/v1/orders/{orderId}:reconcile']?.post).toMatchObject({
    operationId: 'order.reconcile',
    'x-action': 'order:reconcile',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': ['access.account'],
    'x-exposure': 'gate:purchases',
    'x-rate-limit': { family: 'write', units: 1 },
    security: [{ bearerAuth: [] }],
  });
});

test('subject HTTP refuses an unlicensed document and any media value before attempting storage', async () => {
  const kernel = createKernel({
    receiptKeys: testReceiptKeys(),
    pool,
    routeKey: new Uint8Array(32),
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
    access: {
      async authenticate() {
        return {
          kind: 'account',
          accountId: '019a1b2c-3d4e-7f00-8a00-5b0000000061',
          clientId: 'web',
          scopes: ['subject:create'],
          requestedBy: null,
          authnEpoch: 1,
        };
      },
      async authorize() {
        throw new Error('Invalid contents must be refused before a command runs');
      },
    },
  });
  for (const [property, content, expectedError] of [
    [
      'schema:abstract',
      {
        language: 'en',
        document: {
          version: 'rezics-document-v1',
          profile: 'text',
          doc: { type: 'doc', content: [{ type: 'paragraph' }] },
        },
      },
      { pointer: '/statements/schema:abstract/0/value/content/licence', code: 'required' },
    ],
    [
      'schema:image',
      '019a1b2c-3d4e-7f00-8a00-3ed1a0000062',
      { pointer: '/statements/schema:image/0/value/content', code: 'unsupported' },
    ],
  ] as const) {
    const response = await kernel.handle(
      new Request('http://kernel.test/v1/subjects', {
        method: 'POST',
        headers: {
          authorization: 'Bearer writer',
          'idempotency-key': '"content-refused"',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'schema:Book',
          labels: { en: 'Example' },
          statements: {
            [property]: [{ property: { id: property }, value: { type: 'value', content } }],
          },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'invalid_request',
      errors: [expectedError],
    });
  }
});

test('trending Search keeps the adopted Search exposure group', () => {
  const operation = openApiDocument(
    createKernel({ receiptKeys: testReceiptKeys(), pool, routeKey: new Uint8Array(32) }),
  ).paths['/v1/trendingSearches']?.get;
  expect(operation).toMatchObject({ 'x-exposure': 'gate:search', 'x-action': 'subject:read' });
});

test('creator offer listing declares exact own-account authority', () => {
  const kernel = createKernel({ receiptKeys: testReceiptKeys(), pool, routeKey: new Uint8Array(32) });
  expect(openApiDocument(kernel).paths['/v1/offers']?.get).toMatchObject({
    operationId: 'offer.list',
    'x-action': 'offer:list',
    'x-exposure': 'gate:selling',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': ['access.account'],
    security: [{ bearerAuth: [] }],
  });
  expect(actionCatalogue(kernel).get('offer:list')).toMatchObject({ anonymous: false, authority: 'own-account' });
});

test('commerce money schema publishes only closed static configured money facts through the existing selling exposure', () => {
  const document = openApiDocument(
    createKernel({ receiptKeys: testReceiptKeys(), pool, routeKey: new Uint8Array(32) }),
  );
  const operation = document.paths['/v1/commerceMoney']!.get!;
  expect(operation.operationId).toBe('commerce.money_schema');
  expect(operation['x-exposure']).toBe('gate:selling');
  expect(operation['x-action']).toBe('offer:read');
  expect(operation.security).toEqual([{ bearerAuth: [] }, {}]);
  const schema = operation.responses!['200']!.content!['application/json']!.schema as {
    additionalProperties: boolean;
    properties: Record<string, unknown>;
    required: string[];
  };
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties).sort()).toEqual(['configuredSaleCurrencies', 'factsVersion', 'taxBehavior']);
  expect(schema.required).toEqual(['factsVersion', 'taxBehavior', 'configuredSaleCurrencies']);
});

test('subject offer discovery declares its native read action, purchase gate and bounded raw page', () => {
  const kernel = createKernel({ receiptKeys: testReceiptKeys(), pool, routeKey: new Uint8Array(32) });
  const operation = openApiDocument(kernel).paths['/v1/subjects/{id}/offers']?.get;
  expect(operation).toMatchObject({
    operationId: 'subject_offers.list',
    'x-action': 'subject:read',
    'x-exposure': 'gate:purchases',
    security: [{ bearerAuth: [] }, {}],
  });
  expect(operation?.parameters).toContainEqual(
    expect.objectContaining({
      name: 'limit',
      in: 'query',
      schema: expect.objectContaining({ default: 10, minimum: 1, maximum: 20 }),
    }),
  );
});
