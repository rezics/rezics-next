import { AccessExposure } from './modules/access/exposure.ts';
import { MediaScreenStore } from './modules/media-screen/store.ts';
import { RequiredMediaMatchWorker } from './modules/media-screen/required-match-worker.ts';
import { requiredMatcherMode, requiredSafetyMatcher } from './modules/media-screen/required-matcher.ts';
import { MediaScreenWorker } from './modules/media-screen/worker.ts';
import { LocalImageClassifier } from './modules/media-screen/classifier.ts';
import { MediaRenditionWorker } from './modules/media-rendition/worker.ts';
import { LocalImageTransformer } from './modules/media-rendition/transform.ts';
import { Pool } from 'pg';
import { boundedPool } from './infrastructure/pg-pool.ts';
import { shutdownTelemetry, withWorkerTelemetry } from '@rezics/observability/runtime';
import { logWorkerFault, telemetryLog } from '@rezics/observability/log';
import { CatalogueIntakeStore, unverifiedWorks } from './modules/catalogue-intake/store.ts';
import { WikiQuotationStore } from './modules/wiki/quotation.ts';
import { WikiEvidenceStore } from './modules/wiki/evidence.ts';
import { AdmittedTypeStore } from './modules/types/store.ts';
import { ReadingPositionStore } from './modules/reading-position/store.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ContentComments, ContentCore, ContentProjectionCursor,
  migrateContent } from '../../content/src/index.ts';
import { createMainApp } from './app.ts';
import type { MainWorkDependencies } from './routes/dependencies.ts';
import { mainRateLimit } from './modules/rate-limit/config.ts';
import { openLibraryFixtureFetch } from '../../../scripts/dev/seed/open-library-fixtures.ts';
import { ContentProjectionWorker } from './content-projection-worker.ts';
import { LibraryImportRetentionWorker } from './modules/library-import/retention-worker.ts';
import { AuthorReaders } from './modules/author-page/readers.ts';
import { WorkReaderStats } from './modules/work/read-stats.ts';
import { DiscoveryProjection } from './modules/discovery/store.ts';
import { DiscoveryAudienceStore } from './modules/discovery/audience.ts';
import { AlsoEnjoyedStore } from './modules/also-enjoyed/store.ts';
import { FollowsStore } from './modules/follows/store.ts';
import { FeedStore } from './modules/feed/store.ts';
import { ReaderReviews } from './modules/review/store.ts';
import { FeedViewerStateReader } from './modules/feed/viewer-state.ts';
import { HomePersonalStore } from './modules/feed/personal.ts';
import { PersonPreferencesStore } from './modules/preferences/store.ts';
import { SuitabilityStore } from './modules/suitability/store.ts';
import { ProjectionStore } from './modules/projection/store.ts';
import { SavedFilterStore } from './modules/saved-filter/store.ts';
import { RankingHomeTrendingReader } from './modules/feed/trending.ts';
import { FeedRefreshWorker } from './modules/feed/refresh.ts';
import { DiscoveryRefreshWorker } from './modules/discovery/refresh.ts';
import { DiscoveryRefreshInputs } from './modules/discovery/source.ts';
import { DiscoveryRefreshStore } from './modules/discovery/refresh-store.ts';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { S3ImmutableObjects } from './infrastructure/immutable-objects.ts';
import { StructureProgressStore } from './modules/progress/store.ts';
import { SerialStatisticsProjection } from './modules/work/serial-projection.ts';
import { ZoneBrowseProjection } from './modules/zone-browse/store.ts';
import { ReadRankingProjection } from './modules/rankings/projection.ts';
import { ReadingSettingsStore } from './modules/reading-settings/store.ts';
import { StructureStageStore } from './modules/structure/stage.ts';
import { SemanticStageStore } from './modules/semantic/staging.ts';
import { AccessAdmissionRegistry } from './modules/access/admission.ts';
import { AccessPlatformAdministrators } from './modules/access/platform-administrator.ts';
import { AccessDownloadLeases } from './modules/access/download-leases.ts';
import { AgentProvisioning } from './modules/agent/provision.ts';
import { OnboardingPersons } from './modules/onboarding/persons.ts';
import { AgentVanityHandles } from './modules/agent/vanity.ts';
import { AliasRegistry } from './modules/address/registry.ts';
import { AgentPublicProfiles } from './modules/agent/profile.ts';
import { ProfilesAccess } from './modules/profiles/access.ts';
import { StudioAccess } from './modules/studio/access.ts';
import { OccurrenceLabelWorker } from './modules/structure/label-index-worker.ts';
import { configureNamePreferences } from './modules/search/name-preferences.ts';
import { configureLibraryShelves, prepareLibraryShelves } from './modules/library/backfill.ts';
import { prepareChapterPosts } from './modules/post/backfill.ts';
import { ReaderLibraryStatusStore } from './modules/library/status.ts';
import { ConsumptionSessionStore } from './modules/session/store.ts';
import { EditionPreferenceStore } from './modules/session/preference-store.ts';
import { SeriesSessionReader } from './modules/session/series-store.ts';
import { ReaderLibraryImportStore } from './modules/library-import/reader-import.ts';
import { LibraryFileStore } from './modules/library-import/file-store.ts';
import { LibraryBundleExporter } from './modules/library-export/bundle.ts';
import { LibraryCopyStore } from './modules/library/copies.ts';
import { LibraryLoanStore } from './modules/library/loans.ts';
import { ReaderLibraryRatings } from './modules/library/ratings.ts';
import { ProtectionAdmissionSigner } from './modules/access/protection-admission.ts';
import { ErasureService } from './modules/erasure/request.ts';
import { ContentProtectionStore } from './modules/protection/content-store.ts';
import { EditorialReviewStore } from './modules/editorial-review/store.ts';
import { PrivateSearchSettlement } from './modules/contribution/private-search-settlement.ts';
import { ContentSearchReadAccess } from './modules/search-disclosure/content-read-lease.ts';
import { ReleaseRatingInventoryStore } from './modules/access/rating-aggregate-inventory.ts';
import { TargetRatingInventoryStore } from './modules/rating/target-inventory.ts';
import { AccessActingContexts } from './modules/access/contexts.ts';
import { AccessSessionAgents } from './modules/access/session-agent.ts';
import { AccessGroups } from './modules/access/groups.ts';
import { AccessGrants } from './modules/access/grants.ts';
import { AccessMemberships } from './modules/access/memberships.ts';
import { AccessPrivateMemberships } from './modules/access/private-memberships.ts';
import { AccessPrivateRecipients } from './modules/access/private-recipients.ts';
import { AccessMembershipConsents } from './modules/access/membership-consents.ts';
import { AccessOrgRealmParticipation } from './modules/access/org-realm-participation.ts';
import { AccessOrganizationModeration } from './modules/access/organization-moderation.ts';
import { AccessManagedOrganizations } from './modules/access/managed-organizations.ts';
import { AccessRepresentations } from './modules/access/representations.ts';
import { AccessRepresentedMembershipAuthority } from './modules/access/represented-membership-authority.ts';
import { AccessEligibleOrgMemberSet } from './modules/access/eligible-org-member-set.ts';
import { AccessRoles } from './modules/access/roles.ts';
import { AccessPolicyOwner } from './modules/access/policy-owner.ts';
import { MediaAccessBatchReader } from './modules/media/access-batch.ts';
import { ExportStore } from './modules/export/store.ts';
import { VerificationStore } from './modules/verification/store.ts';
import { MediaStore } from './modules/media/store.ts';
import { AccessVotes } from './modules/vote/access.ts';
import { AccessJudgments } from './modules/judgment/access.ts';
import { ReaderVariantPreferenceStore } from './modules/work/native-variants.ts';
import { RealmVariantRecommendationStore } from './modules/work/realm-variant-recommendation.ts';
import { RealmReplyContentStore } from './modules/realm-reply/content-store.ts';
import { RealmReplyStore } from './modules/realm-reply/store.ts';
import { RealmReplyThreadStore } from './modules/realm-reply/thread-store.ts';
import { VerificationCorrectionPublisher, VerificationCorrectionWorker }
  from './modules/verification/correction-delivery.ts';
import { verificationCorrectionSubjectReader } from './modules/verification/correction-delivery.ts';
import { NotificationStore } from './modules/notification/store.ts';
import { SourceIntakeStore } from './modules/source/intake.ts';
import { SourceAuthorNameStore } from './modules/source/author-name.ts';
import { RecipeSourceConversionStore } from './modules/recipe/source-conversion.ts';
import { sourceAcquisitionServices } from './modules/source/acquisition.ts';
import { OpenLibraryConversionStore } from './modules/source/open-library-conversion.ts';
import { SourceChildCorrespondenceStore }
  from './modules/source/record-child-correspondence.ts';
import { GoMvsResolutionStore } from './modules/package/go-mvs.ts';
import { CargoResolutionStore } from './modules/package/cargo-resolution.ts';
import { NpmResolutionStore } from './modules/package/npm-resolution.ts';
import { NixResolutionStore } from './modules/package/nix-resolution.ts';
import { ModResolutionStore } from './modules/package/mod-resolution.ts';
import { PackageArtifactStore } from './modules/package/lock-artifacts.ts';
import { PackageLockStore } from './modules/package/lock.ts';
import { PackageInstallationStore } from './modules/package/install.ts';
import { DockerNodeHookExecutor } from './modules/package/install-hooks.ts';
import { HubStore } from './modules/hub/store.ts';
import { ConnectedAppStore } from './modules/connected-apps/store.ts';
import { GoProxyCaptureStore } from './modules/package/go-proxy-capture.ts';
import { GoSumdbTrustStore } from './modules/package/go-sumdb-trust.ts';
import { OpenLibrarySourceGraph } from './modules/source/graph-projection.ts';
import { SourceNativeWorkProposalStore } from './modules/source/native-work-proposal.ts';
import { SourceNativeWorkAdoptionStore } from './modules/source/native-work-adoption.ts';
import { SourceNativeWorkAttachmentStore } from './modules/source/native-work-attachment.ts';
import { SourceAuthorCreditStore } from './modules/source/author-credit.ts';
import { SourceFieldWithdrawalStore } from './modules/source/withdrawal.ts';
import { SourceFieldAttachmentStore } from './modules/source/support-attach.ts';
import { SourceFieldApplicationStore } from './modules/source/field-application.ts';
import { SourceNativeChildStore } from './modules/source/child-native-support.ts';
import { ProviderIdentityStore } from './modules/source/provider-identity.ts';
import { SourceScoreStore } from './modules/source/score.ts';
import { AccountAssertionVerifier } from './modules/account/verify-assertion.ts';
import { relayContentProjectionOnce } from './modules/content-publication/relay.ts';
import { OwnerPartitionRoutes } from './modules/partition/route.ts';
import { DATASET } from './modules/work/activate.ts';
import { RelayHandoffPositions } from './modules/outbox/relay-position.ts';
import { OwnerOperations } from './modules/owner/operations.ts';
import { governanceServices } from './modules/governance/composition.ts';
import { PublicReports } from './modules/public-report/store.ts';
import { publicReportOwners } from './modules/public-report/owners.ts';
import { AccessRealmManagement } from './modules/access/realm-management.ts';
import { RealmJoinRequests } from './modules/realm-admin/join-requests.ts';
import { RealmPolicyRecoveryWorker } from './modules/access/realm-management-recovery.ts';
import { ManagementReadStore } from './modules/management-reads/read-store.ts';
import { ManagementDecisionBasis } from './modules/management-reads/decision-basis.ts';
import { ownerTargetHeads } from './modules/governance/evidence.ts';
import { AccessRealmJoining } from './modules/access/realm-management-joining.ts';
import { AccessRealmRoster } from './modules/access/roster.ts';
import { AccessManagedRealms } from './modules/access/realm-management-managed.ts';
import { RealmSubmissionStore } from './modules/realm-submission/store.ts';
import { RealmSubmissionReads } from './modules/realm-submission/reads.ts';
import { AccessProposalExecutions } from './modules/proposal/access.ts';
import { currentContentSubjectReader, currentNotificationAgentReader } from './modules/notification/subjects.ts';
import { NotificationRealtimeHub } from './modules/notification/realtime.ts';
import { NotificationDispatcher } from './modules/notification/dispatcher.ts';
import { NotificationDeliveryWorker } from './modules/notification/delivery-worker.ts';
import { NotificationProducer, NotificationProducerWorker } from './modules/notification-producers/producer.ts';
import { configureFollowGraph } from './modules/follows/recovery.ts';
import { configureLibraryFollows } from './modules/library/follows.ts';
import { resourceNotificationSubjectReader } from './modules/notification-producers/resources.ts';
import { notificationProducerSubjectReader } from './modules/notification-producers/subjects.ts';
import { editorialNotificationSubjectReader } from './modules/notification-producers/editorial.ts';
import { feedNotificationSubjectReader } from './modules/notification-producers/feed-subjects.ts';
import { SavedViewNotifications, SAVED_VIEW_BASES } from './modules/notification-producers/saved-views.ts';
import { HttpDeliveryProvider } from './modules/notification/http-provider.ts';
import { NotificationDigestWorker } from './modules/notification/digest.ts';
import { SafetyAlerts, SAFETY_ALERT_BASIS, safetyResponders } from './modules/safety-alerts/store.ts';
import { SafetyAlertProvider } from './modules/safety-alerts/provider.ts';
import { SafetyDecisionMail, accountSafetyNoticeIntake } from './modules/governance/notices-mail.ts';
import { RightsStore } from './modules/rights/store.ts';
import { ThemeStore } from './modules/theme/store.ts';
import { ACCESS_OPERATIONAL_BOUNDS_V1, activateOperationalBounds } from './operations/bounds.ts';
import { RankingGenerations } from './modules/recommendation/ranking.ts';
import { RankingBuildWorker } from './modules/recommendation/build-worker.ts';
import { verifyRankingSemanticBasis } from './modules/recommendation/semantic-basis.ts';
import { graphZeroCandidates, graphZeroSnapshot } from './modules/recommendation/zero-candidates.ts';
import { EventTemporalQueries } from './modules/event/queries.ts';
import { PrivateContextSelections } from './modules/context/private-selection.ts';
import { mainConfig } from './config.ts';
import { WorkMaintainers } from './modules/work/maintainers.ts';

const config = mainConfig();
const fusekiUrl = config.FUSEKI_URL;
const port = config.MAIN_PORT;

const fuseki = new FusekiClient(fusekiUrl, config.FUSEKI_MAINTENANCE_TOKEN, config.FUSEKI_COMMAND_TOKEN);
const pool = boundedPool({ connectionString: config.ACCESS_DATABASE_URL });
const types = new AdmittedTypeStore(pool);
await types.refresh();
// IAM35: every Main enforces the Access-active profile; this release requests its own.
const bounds = await activateOperationalBounds(pool, ACCESS_OPERATIONAL_BOUNDS_V1);
if (bounds.status === 'restricted') {
  console.warn('Access operational bounds are restricted; saved records exceed',
    JSON.stringify(bounds.violations));
}
// OPS06: the broker lane observes the relay checkpoint through a read-only session.
const relayUrl = config.MAIN_RELAY_DATABASE_URL;
const relayConsumer = config.MAIN_RELAY_CONSUMER;
const relayPool = relayUrl ? boundedPool({ connectionString: relayUrl, max: 2,
  options: '-c default_transaction_read_only=on' }) : undefined;
const erasureRelayUrl = relayUrl ?? config.ACCOUNT_RELAY_DATABASE_URL;
const erasureRelayPool = erasureRelayUrl ? boundedPool({ connectionString: erasureRelayUrl, max: 2 }) : undefined;
const ownerRelayUrl = config.OWNER_RELAY_DATABASE_URL ?? relayUrl;
const ownerRelayPool = ownerRelayUrl
  ? boundedPool({ connectionString: ownerRelayUrl, max: 4 }) : undefined;
const recommendationRelayUrl = config.ACCOUNT_RELAY_DATABASE_URL ?? relayUrl;
const recommendationRelayPool = recommendationRelayUrl ? boundedPool({ connectionString: recommendationRelayUrl,
  max: 2, options: '-c default_transaction_read_only=on' }) : undefined;
const contentPool = boundedPool({ connectionString: config.CONTENT_DATABASE_URL });
// Production schemas are applied by the locked release job before writers start.
// A development start migrates on its own connection: DDL may wait on a peer
// that is migrating, which the request bounds would cut short.
if (process.env.NODE_ENV !== 'production') {
  const migration = new Pool({ connectionString: config.CONTENT_DATABASE_URL, max: 1 });
  try { await migrateContent(migration); } finally { await migration.end(); }
}
const content = new ContentCore(contentPool);
const readRankings = new ReadRankingProjection(pool, content, contentPool, {
  fuseki, lineage: { dataEpoch: config.MAIN_DATA_EPOCH, routingEpoch: config.MAIN_ROUTING_EPOCH },
  objectDirectory: config.MAIN_OBJECT_DIRECTORY,
});
const sourceIntake = new SourceIntakeStore(contentPool);
const rightsStore = new RightsStore(contentPool, pool);
sourceIntake.setRawRetentionGate((provider, namespace) => rightsStore.rawRetentionPermitted(provider, namespace));
const sourceConversions = new OpenLibraryConversionStore(contentPool, sourceIntake);
const packageCaptures = new GoProxyCaptureStore(contentPool);
const comments = new ContentComments(contentPool);
const cursor = new ContentProjectionCursor(contentPool);
const consumer = config.CONTENT_PROJECTION_CONSUMER;
await cursor.initialize(consumer);
const workObjects = config.MAIN_S3_ENDPOINT ? new S3ImmutableObjects({
  endpoint: config.MAIN_S3_ENDPOINT, bucket: config.MAIN_S3_BUCKET,
  region: config.MAIN_S3_REGION, accessKeyId: config.MAIN_S3_ACCESS_KEY,
  secretAccessKey: config.MAIN_S3_SECRET_KEY, prefix: 'semantic/work/',
}) : undefined;
if (workObjects) await workObjects.initialize();
const environment = {
  addresses: new AliasRegistry(pool),
  fuseki,
  lineage: { dataEpoch: config.MAIN_DATA_EPOCH, routingEpoch: config.MAIN_ROUTING_EPOCH },
  objectDirectory: config.MAIN_OBJECT_DIRECTORY,
  ...(workObjects ? { workObjects } : {}),
};
const serialStats = recommendationRelayPool
  ? new SerialStatisticsProjection(pool, recommendationRelayPool, contentPool, environment) : undefined;
const zoneBrowse = recommendationRelayPool
  ? new ZoneBrowseProjection(pool, recommendationRelayPool, environment) : undefined;
const partitionRoutes = new OwnerPartitionRoutes(pool);
const graphRouteLease = await partitionRoutes.initialize({ owner: 'graph', datasetId: DATASET,
  location: fusekiUrl, routingEpoch: environment.lineage.routingEpoch });
Object.assign(environment, { partitionLease: { routes: partitionRoutes,
  location: fusekiUrl, leaseEpoch: graphRouteLease.leaseEpoch } });
const sourceGraph = new OpenLibrarySourceGraph(fuseki, environment.lineage, sourceConversions);
const sourceProposals = new SourceNativeWorkProposalStore(contentPool, sourceGraph, sourceConversions);
const structureObjects = new S3ImmutableObjects({
  endpoint: config.MAIN_S3_ENDPOINT, bucket: config.MAIN_S3_BUCKET,
  region: config.MAIN_S3_REGION, accessKeyId: config.MAIN_S3_ACCESS_KEY,
  secretAccessKey: config.MAIN_S3_SECRET_KEY, prefix: 'semantic/structure/',
});
await structureObjects.initialize();
Object.assign(environment, { structureObjects });
const semanticStageObjects = new S3ImmutableObjects({
  endpoint: config.MAIN_S3_ENDPOINT, bucket: config.MAIN_S3_BUCKET,
  region: config.MAIN_S3_REGION, accessKeyId: config.MAIN_S3_ACCESS_KEY,
  secretAccessKey: config.MAIN_S3_SECRET_KEY, prefix: 'semantic/stage/',
});
await semanticStageObjects.initialize();
const mediaObjects = (prefix: string) => new S3ImmutableObjects({
  endpoint: config.MAIN_S3_ENDPOINT, bucket: config.MAIN_S3_BUCKET,
  region: config.MAIN_S3_REGION, accessKeyId: config.MAIN_S3_ACCESS_KEY,
  secretAccessKey: config.MAIN_S3_SECRET_KEY, prefix,
});
await mediaObjects('media/').initialize();
await mediaObjects('package/artifact/public/').initialize();
const packageArtifacts = new PackageArtifactStore(contentPool, mediaObjects);
const packageLocks = new PackageLockStore(contentPool, new NpmResolutionStore(contentPool), packageArtifacts);
packageLocks.registerResolutionOwners({ cargo: new CargoResolutionStore(contentPool),
  go: new GoMvsResolutionStore(contentPool, packageCaptures),
  sumdb: new GoSumdbTrustStore(contentPool, packageCaptures), captures: packageCaptures });
const packageInstallations = new PackageInstallationStore(contentPool, packageLocks,
  { rootDirectory: join(environment.objectDirectory, 'package-installations'),
    hookExecutor: new DockerNodeHookExecutor(join(environment.objectDirectory, 'package-installations'),
      process.env.PATH ?? '/usr/bin:/bin') });
const matcherMode = requiredMatcherMode(config.MAIN_REQUIRED_MEDIA_MATCHER, process.env.NODE_ENV === 'production');
const media = { store: new MediaStore(contentPool, content, matcherMode), content, objects: mediaObjects };
const requiredMatcher = requiredSafetyMatcher(matcherMode);
const account = new AccountAssertionVerifier({
  issuer: config.ACCOUNT_ISSUER, audience: config.ACCOUNT_MAIN_RESOURCE,
  jwksUrl: config.ACCOUNT_JWKS_URL, introspectUrl: config.ACCOUNT_INTROSPECT_URL,
  clientId: config.ACCOUNT_MAIN_CLIENT_ID, clientSecret: config.ACCOUNT_MAIN_CLIENT_SECRET,
});
const access = new AccessAdmissionRegistry(pool, config.FUSEKI_TITLE_ADMISSION_KEY);
await new AccessPlatformAdministrators(pool).designateFirst(config.ACCOUNT_ISSUER, config.PLATFORM_FIRST_ADMIN_ACCOUNT);
access.configureBaseline(fuseki);
const rankingContextSelections = new PrivateContextSelections(pool);
const recommendations = recommendationRelayPool ? new RankingGenerations({ access: pool,
  relay: recommendationRelayPool, dataEpoch: environment.lineage.dataEpoch,
  cursorKey: createHash('sha256').update('rezics-ranking-cursor-v1\0')
    .update(config.ACCOUNT_MAIN_CLIENT_SECRET).digest(),
  canReadWork: (principal, actingSubject, work) => access.canReadWork(principal, actingSubject, work),
  zeroSnapshot: () => graphZeroSnapshot(environment),
  zeroCandidates: graphZeroCandidates(environment),
  unverifiedWorks: works => unverifiedWorks(environment, works),
  verifySemantic: (viewer, basis) => verifyRankingSemanticBasis(environment, pool, rankingContextSelections,
    viewer, basis) }) : undefined;
const recommendationWorker = recommendations ? new RankingBuildWorker(pool, recommendations) : undefined;
const eventQueries = new EventTemporalQueries(pool, environment, createHash('sha256')
  .update('rezics-event-cursor-v1\0').update(config.ACCOUNT_MAIN_CLIENT_SECRET).digest());
const hub = new HubStore(contentPool, content, access, environment, packageArtifacts);
const downloadLeases = new AccessDownloadLeases(pool);
const notificationStore = new NotificationStore(pool);
const safetyRoster = safetyResponders(config.ACCOUNT_ISSUER, config.SAFETY_PRIMARY_ACCOUNT, config.SAFETY_BACKUP_ACCOUNT);
const safetyAlerts = safetyRoster ? new SafetyAlerts(pool, notificationStore, safetyRoster) : undefined;
if (safetyAlerts) {
  if (!relayPool) throw new Error('safety alert delivery requires the retained erasure relay');
  await safetyAlerts.initialize();
  notificationStore.registerReadSubjectReader(SAFETY_ALERT_BASIS, safetyAlerts);
} else console.warn('Safety responders are not configured; launch safety readiness is unclaimed');
notificationStore.setDefaultReadSubjectReader(currentContentSubjectReader(content, notificationStore, access));
notificationStore.setReadAgentReader(currentNotificationAgentReader(fuseki, environment.lineage, media.store,
  new AgentVanityHandles(pool)));
notificationStore.registerReadSubjectReader('verification-correction-subscription-v1',
  verificationCorrectionSubjectReader(new VerificationStore(contentPool)));
const notificationSourceReader = notificationProducerSubjectReader(pool, contentPool, environment);
const notificationResourceReader = resourceNotificationSubjectReader(pool, environment);
notificationStore.registerReadSubjectReader('relationship-resource-v1', notificationResourceReader);
notificationStore.registerReadSubjectReader('relationship-reply-v1', notificationSourceReader);
const notificationEditorialReader = editorialNotificationSubjectReader(pool, environment);
notificationStore.registerReadSubjectReader('editorial-proposal-v1', notificationEditorialReader);
const notificationFeedReader = feedNotificationSubjectReader(pool, environment, content, new ReaderReviews(pool));
for (const basis of ['realm-reply-v1', 'submission-decision-v1', 'moderation-outcome-v1',
  'realm-role-change-v1', 'review-created-v1', 'review-helpful-v1']) notificationStore.registerReadSubjectReader(basis, notificationSourceReader);
for (const basis of ['followed-chapter-v1', 'post-vote-v1']) notificationStore.registerReadSubjectReader(basis, notificationFeedReader);
if (relayPool) await notificationStore.reconcileRetainedErasures(relayPool);
const notificationProviderConfig = {
  url: config.MAIN_NOTIFICATION_PROVIDER_URL,
  token: config.MAIN_NOTIFICATION_PROVIDER_TOKEN,
  callbackSecret: config.MAIN_NOTIFICATION_CALLBACK_SECRET,
};
const notificationProviderConfigured = Object.values(notificationProviderConfig).some(Boolean);
if (notificationProviderConfigured && !Object.values(notificationProviderConfig).every(Boolean)) {
  throw new Error('MAIN_NOTIFICATION_PROVIDER_URL, MAIN_NOTIFICATION_PROVIDER_TOKEN and '
    + 'MAIN_NOTIFICATION_CALLBACK_SECRET must be configured together');
}
if (notificationProviderConfigured && !relayPool) {
  throw new Error('notification delivery requires the retained erasure relay');
}
const notificationProvider = notificationProviderConfigured ? new HttpDeliveryProvider({ name: 'http',
  baseUrl: notificationProviderConfig.url!, bearerToken: notificationProviderConfig.token! }) : undefined;
const deliveryProvider = safetyAlerts ? new SafetyAlertProvider(pool, config.ACCOUNT_ISSUER,
  config.ACCOUNT_INTROSPECT_URL, config.ACCOUNT_MAIN_CLIENT_SECRET, notificationProvider) : notificationProvider;
const notificationDispatcher = deliveryProvider
  ? new NotificationDispatcher(pool, deliveryProvider,
    currentContentSubjectReader(content, notificationStore, access),
    { disclosureBasis: notificationProvider ? undefined : SAFETY_ALERT_BASIS }) : undefined;
if (safetyAlerts) notificationDispatcher?.registerSubjectReader(SAFETY_ALERT_BASIS, safetyAlerts);
notificationDispatcher?.registerSubjectReader('verification-correction-subscription-v1',
  verificationCorrectionSubjectReader(new VerificationStore(contentPool)));
notificationDispatcher?.registerSubjectReader('editorial-proposal-v1', notificationEditorialReader);
notificationDispatcher?.registerSubjectReader('relationship-resource-v1', notificationResourceReader);
notificationDispatcher?.registerSubjectReader('relationship-reply-v1', notificationSourceReader);
for (const basis of ['realm-reply-v1', 'submission-decision-v1', 'moderation-outcome-v1',
  'realm-role-change-v1', 'review-created-v1', 'review-helpful-v1']) notificationDispatcher?.registerSubjectReader(basis, notificationSourceReader);
for (const basis of ['followed-chapter-v1', 'post-vote-v1']) notificationDispatcher?.registerSubjectReader(basis, notificationFeedReader);
const notificationProducerWorker = new NotificationProducerWorker(new NotificationProducer(
  pool, relayPool ? erasureRelayPool! : null, contentPool, fuseki,
  notificationStore, config.MAIN_RELAY_CONSUMER ?? null, relayPool ?? null, safetyAlerts));
notificationProducerWorker.setSafetyCorrespondence(new SafetyDecisionMail(pool, config.ACCOUNT_ISSUER,
  accountSafetyNoticeIntake(config.ACCOUNT_INTROSPECT_URL, config.ACCOUNT_MAIN_CLIENT_SECRET)));
const notificationDigestWorker = new NotificationDigestWorker(pool, notificationStore,
  config.ACCOUNT_ISSUER, new URL('/api/internal/notification-digest',
    config.ACCOUNT_INTROSPECT_URL).toString(), config.ACCOUNT_MAIN_CLIENT_SECRET);
const notificationRealtime = relayPool ? new NotificationRealtimeHub(pool) : undefined;
if (notificationRealtime) await notificationRealtime.start();
const notificationDeliveryWorker = notificationDispatcher
  ? new NotificationDeliveryWorker(notificationDispatcher, config.MAIN_NOTIFICATION_INTERVAL_MS)
  : undefined;
const connectedApps = new ConnectedAppStore(contentPool);
const sourceAdoptions = new SourceNativeWorkAdoptionStore(contentPool, sourceProposals,
  environment, account, access);
const sourceCorrespondences = new SourceChildCorrespondenceStore(contentPool, sourceConversions);
const sourceFieldWithdrawals = new SourceFieldWithdrawalStore(contentPool, environment);
const correctionWorker = new VerificationCorrectionWorker(new VerificationCorrectionPublisher(
  new VerificationStore(contentPool), new NotificationStore(pool)));
const actingContextDiscovery = new AccessActingContexts(pool, environment);
const openLibraryFetch = config.MAIN_OPEN_LIBRARY_FIXTURE_ROOT
  ? openLibraryFixtureFetch(config.MAIN_OPEN_LIBRARY_FIXTURE_ROOT) : fetch;
await configureNamePreferences(environment, pool);
configureLibraryShelves(contentPool, pool, fuseki);
configureFollowGraph(pool, fuseki);
configureLibraryFollows(contentPool, pool);
const libraryImport = new ReaderLibraryImportStore(contentPool, {
  sourceSearchesPerDay: config.MAIN_READER_IMPORT_SEARCHES_PER_DAY,
  acquisitionsPerDay: config.MAIN_READER_IMPORT_ACQUISITIONS_PER_DAY,
});
const app = createMainApp(fuseki, {
  mcp: { issuer: config.ACCOUNT_ISSUER, resource: config.ACCOUNT_MAIN_RESOURCE },
  wikiQuotations: new WikiQuotationStore(contentPool),
  wikiEvidence: new WikiEvidenceStore(contentPool),
  identityMerge: { accessPool: pool, contentPool },
  editorialReview: new EditorialReviewStore(pool),
  types,
  suitability: new SuitabilityStore(pool, access),
  projections: new ProjectionStore(pool),
  rateLimit: mainRateLimit(pool, config),
  follows: new FollowsStore(pool),
  feed: new FeedStore(pool),
  reviews: new ReaderReviews(pool),
  serialStats,
  zoneBrowse,
  readRankings,
  feedViewerState: new FeedViewerStateReader(),
  homePersonal: new HomePersonalStore(pool),
  personPreferences: new PersonPreferencesStore(pool),
  savedFilters: new SavedFilterStore(pool),
  homeTrending: new RankingHomeTrendingReader(readRankings),
  discovery: new DiscoveryProjection(pool),
  discoveryAudience: new DiscoveryAudienceStore(pool),
  alsoEnjoyed: new AlsoEnjoyedStore(pool, contentPool),
  profiles: new ProfilesAccess(pool),
  studioAccess: new StudioAccess(pool, fuseki),
  agentHandles: new AgentVanityHandles(pool),
  agentProfiles: new AgentPublicProfiles(pool, environment, media.store),
  libraryStatus: new ReaderLibraryStatusStore(contentPool),
  sessions: new ConsumptionSessionStore(contentPool, new ReaderLibraryStatusStore(contentPool)),
  editionPreferences: new EditionPreferenceStore(contentPool),
  seriesSessions: new SeriesSessionReader(contentPool),
  libraryImport,
  libraryFiles: new LibraryFileStore(contentPool),
  libraryBundle: new LibraryBundleExporter(contentPool, pool),
  libraryCopies: new LibraryCopyStore(contentPool),
  libraryLoans: new LibraryLoanStore(contentPool),
  authorReaders: new AuthorReaders(contentPool, pool),
  workStats: new WorkReaderStats(contentPool, pool),
  libraryRatings: new ReaderLibraryRatings(pool),
  agentProvisioning: new AgentProvisioning(pool, environment),
  onboardingPersons: new OnboardingPersons(pool),
  environment,
  structureObjects,
  structureStages: new StructureStageStore(contentPool, structureObjects),
  semanticStages: new SemanticStageStore(contentPool, semanticStageObjects),
  account,
  progress: new StructureProgressStore(contentPool),
  readingPositions: new ReadingPositionStore(contentPool),
  readingSettings: new ReadingSettingsStore(contentPool),
  access,
  contextSelections: rankingContextSelections,
  eventQueries,
  downloadLeases,
  protectionSigner: new ProtectionAdmissionSigner(pool, config.FUSEKI_TITLE_ADMISSION_KEY),
  erasures: erasureRelayPool ? new ErasureService(erasureRelayPool, contentPool, pool) : undefined,
  recommendations,
  governance: governanceServices(pool, contentPool, content, sourceIntake, access, environment),
  publicReports: new PublicReports(pool, publicReportOwners({ environment, account, access, media,
    contextSelections: rankingContextSelections, mediaAccess: new MediaAccessBatchReader(pool, fuseki),
    governance: governanceServices(pool, contentPool, content, sourceIntake, access, environment) } as MainWorkDependencies,
    contentPool, content)),
  managementReads: new ManagementReadStore(pool, environment),
  managementDecisionBasis: new ManagementDecisionBasis(pool, environment, ownerTargetHeads({ graph: environment, content: contentPool })),
  realmJoining: new AccessRealmJoining(pool, environment),
  realmRoster: new AccessRealmRoster(pool, environment),
  managedRealms: new AccessManagedRealms(pool, environment),
  realmAdmin: new AccessRealmManagement(pool),
  realmJoinRequests: new RealmJoinRequests(pool, environment),
  realmSubmissions: new RealmSubmissionStore(pool, access, environment),
  realmSubmissionReads: new RealmSubmissionReads(pool),
  ...(relayPool ? { notifications: { store: notificationStore, realtime: notificationRealtime,
    ...(notificationDispatcher ? { dispatcher: notificationDispatcher } : {}),
    ...(notificationProviderConfig.callbackSecret && notificationProvider
      ? { providerSecrets: { [notificationProvider.name]: notificationProviderConfig.callbackSecret } } : {}),
  } } : {}),
  rights: { store: new RightsStore(contentPool, pool) },
  themes: new ThemeStore(contentPool),
  privateSearch: { access, settlement: new PrivateSearchSettlement(pool) },
  media,
  mediaAccess: new MediaAccessBatchReader(pool, fuseki),
  releaseRatingInventory: new ReleaseRatingInventoryStore(pool),
  targetRatingInventory: new TargetRatingInventoryStore(pool),
  votes: new AccessVotes(pool),
  proposalExecutions: new AccessProposalExecutions(pool),
  judgments: new AccessJudgments(pool),
  exports: new ExportStore(contentPool),
  exportVerification: new VerificationStore(contentPool),
  exportVerificationPrivate: new VerificationStore(contentPool),
  exportRights: rightsStore.exportScope,
  actingContexts: new AccessActingContexts(pool),
  actingContextDiscovery,
  sessionAgents: new AccessSessionAgents(pool, actingContextDiscovery),
  groups: new AccessGroups(pool),
  grants: new AccessGrants(pool),
  platformAccess: new AccessExposure(pool),
  memberships: new AccessMemberships(pool),
  membershipConsents: new AccessMembershipConsents(pool),
  orgRealmParticipation: new AccessOrgRealmParticipation(pool),
  organizationModeration: new AccessOrganizationModeration(pool),
  managedOrganizations: new AccessManagedOrganizations(pool),
  privateMemberships: new AccessPrivateMemberships(pool),
  privateRecipients: new AccessPrivateRecipients(pool),
  representations: new AccessRepresentations(pool),
  representedMembershipAuthority: new AccessRepresentedMembershipAuthority(pool),
  eligibleOrgMemberSet: new AccessEligibleOrgMemberSet(pool),
  roles: new AccessRoles(pool),
  accessPolicy: new AccessPolicyOwner(pool),
  sourceIntake,
  sourceAuthorNames: new SourceAuthorNameStore(contentPool, sourceIntake, openLibraryFetch),
  openLibraryFetch,
  recipeSourceConversions: new RecipeSourceConversionStore(contentPool, sourceIntake),
  sourceAcquisitions: sourceAcquisitionServices(contentPool,
    { reserve: () => sourceIntake.reserveOpenLibrarySlot(),
      fetcher: openLibraryFetch,
      rawRetentionPermitted: (provider, namespace) => rightsStore.rawRetentionPermitted(provider, namespace) }),
  sourceConversions,
  sourceCorrespondences,
  sourceAuthorCredits: new SourceAuthorCreditStore(contentPool, sourceProposals, sourceConversions,
    sourceCorrespondences, environment, account, access),
  sourceFieldWithdrawals,
  sourceFieldApplications: new SourceFieldApplicationStore(contentPool, environment,
    account, access, sourceConversions, sourceAdoptions, sourceFieldWithdrawals, rightsStore),
  sourceNativeChildren: new SourceNativeChildStore(contentPool, sourceProposals, sourceConversions,
    sourceCorrespondences, environment, account, access),
  sourceFieldAttachments: new SourceFieldAttachmentStore(contentPool, environment, access),
  sourceProviderIdentity: new ProviderIdentityStore(contentPool),
  sourceScores: new SourceScoreStore(contentPool),
  packageResolutions: new GoMvsResolutionStore(contentPool, packageCaptures),
  packageCargoResolutions: new CargoResolutionStore(contentPool),
  packageNpmResolutions: new NpmResolutionStore(contentPool),
  packageNixResolutions: new NixResolutionStore(contentPool),
  packageModResolutions: new ModResolutionStore(contentPool, pool),
  webSnapshotRetention: (origin: string) => rightsStore.rawRetentionPermitted('web-location', origin),
  packageLocks,
  packageInstallations,
  hub,
  connectedApps,
  packageCaptures,
  packageVerifications: new GoSumdbTrustStore(contentPool, packageCaptures),
  sourceGraph,
  sourceProposals,
  sourceAdoptions,
  sourceAttachments: new SourceNativeWorkAttachmentStore(contentPool, sourceProposals,
    sourceAdoptions, environment, access),
  readerPreferences: new ReaderVariantPreferenceStore(pool),
  realmRecommendations: new RealmVariantRecommendationStore(pool),
  realmReplies: new RealmReplyStore(new RealmReplyContentStore(contentPool), content, access, environment),
  realmReplyThreads: new RealmReplyThreadStore(contentPool, pool),
  maintainers: new WorkMaintainers(pool, environment),
  verification: new VerificationStore(contentPool),
  catalogueIntake: new CatalogueIntakeStore(pool, environment),
  content,
  editorialProtection: new ContentProtectionStore(contentPool),
  contentAuthoring: content,
  comments,
  contentProjection: { content, cursor, consumer },
  contentPrivateSearch: { content, access: new ContentSearchReadAccess(pool),
    settlement: new PrivateSearchSettlement(pool) },
  ...(relayPool ? { relayPosition: new RelayHandoffPositions(relayPool, relayConsumer!) } : {}),
  ...(ownerRelayPool ? { ownerOperations: new OwnerOperations(ownerRelayPool, environment) } : {}),
});
libraryImport.setDispatch(request => app.handle(request));
const savedViewNotifications = new SavedViewNotifications(pool, { environment, account, access, media, content,
  judgments: new AccessJudgments(pool),
  realmReplies: new RealmReplyStore(new RealmReplyContentStore(contentPool), content, access, environment),
  governance: governanceServices(pool, contentPool, content, sourceIntake, access, environment) } as MainWorkDependencies,
notificationStore);
notificationProducerWorker.setSavedViews(savedViewNotifications);
for (const basis of SAVED_VIEW_BASES) notificationStore.registerReadSubjectReader(basis, savedViewNotifications);
for (const basis of SAVED_VIEW_BASES) notificationDispatcher?.registerSubjectReader(basis, savedViewNotifications);
const realmPolicyRecovery = new RealmPolicyRecoveryWorker(pool, environment);
const worker = new ContentProjectionWorker(
  () => relayContentProjectionOnce(environment, content, cursor, consumer),
  config.CONTENT_PROJECTION_INTERVAL_MS);
const discoveryWorker = relayPool ? new DiscoveryRefreshWorker({ environment, access, account, media,
  discoveryRefreshInputs: new DiscoveryRefreshInputs(relayPool, relayConsumer!),
  judgments: new AccessJudgments(pool),
  alsoEnjoyed: new AlsoEnjoyedStore(pool, contentPool),
  governance: governanceServices(pool, contentPool, content, sourceIntake, access, environment),
  relayPosition: new RelayHandoffPositions(relayPool, relayConsumer!) },
new DiscoveryRefreshStore(pool), new DiscoveryProjection(pool)) : undefined;
// A failed or partial conversion must not take Main down: unconverted chapters
// stay legacy until a restart resumes the migration.
await withWorkerTelemetry('main.post.backfill', () => prepareChapterPosts(environment, pool), undefined, 'startup')
  .catch(error => logWorkerFault('main.post.backfill', error));
app.listen({ hostname: process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', port });
telemetryLog('main_listening');
const libraryBackfillController = new AbortController();
const libraryBackfill = withWorkerTelemetry('main.library.backfill', () => prepareLibraryShelves(contentPool, pool, fuseki,
  { signal: libraryBackfillController.signal }), undefined, 'startup').catch(error => {
  if (!libraryBackfillController.signal.aborted) logWorkerFault('main.library.backfill', error);
});
const feedWorker = relayPool ? new FeedRefreshWorker({ environment, account, access, content,
  realmReplyThreads: new RealmReplyThreadStore(contentPool, pool),
  // Without the review owner the worker never ingests review events, and Home reports catching-up for good.
  reviews: new ReaderReviews(pool),
  relayPosition: new RelayHandoffPositions(relayPool, relayConsumer!) }, new FeedStore(pool), relayPool) : undefined;
feedWorker?.start();
const occurrenceLabelWorker = new OccurrenceLabelWorker(environment);
occurrenceLabelWorker.start();
realmPolicyRecovery.start();
worker.start();
const libraryImportRetentionWorker = new LibraryImportRetentionWorker(contentPool,pool);
libraryImportRetentionWorker.start();
const mediaScreenWorker = new MediaScreenWorker(new MediaScreenStore(contentPool), new LocalImageClassifier(),
  mediaObjects, governanceServices(pool, contentPool, content, sourceIntake, access, environment).store);
mediaScreenWorker.start();
const requiredMediaMatchWorker = requiredMatcher
  ? new RequiredMediaMatchWorker(media.store.matching, requiredMatcher, mediaObjects) : undefined;
requiredMediaMatchWorker?.start();
const mediaRenditionWorker = new MediaRenditionWorker(media.store.renditions, new LocalImageTransformer(), mediaObjects);
mediaRenditionWorker.start();
discoveryWorker?.start();
recommendationWorker?.enablePublicRefresh();
recommendationWorker?.start();
serialStats?.start();
zoneBrowse?.start();
readRankings.start();
correctionWorker.start();
notificationProducerWorker.start();
notificationDigestWorker.start();
notificationDeliveryWorker?.start();

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
  await occurrenceLabelWorker.stop();
  await realmPolicyRecovery.stop();
  await libraryImportRetentionWorker.stop();
  await mediaScreenWorker.stop();
  await requiredMediaMatchWorker?.stop();
  await mediaRenditionWorker.stop();
  await serialStats?.stop();
  await zoneBrowse?.stop();
  await readRankings.stop();
  libraryBackfillController.abort();
  await libraryBackfill;
  await app.stop();
  await feedWorker?.stop();
  await discoveryWorker?.stop();
  await correctionWorker.stop();
  await notificationProducerWorker.stop();
  await notificationDigestWorker.stop();
  await notificationDeliveryWorker?.stop();
  await notificationRealtime?.stop();
  await recommendationWorker?.stop();
  await worker.stop();
  } finally {
    try { await Promise.all([pool.end(), contentPool.end(), relayPool?.end(), erasureRelayPool?.end(), ownerRelayPool?.end(), recommendationRelayPool?.end()]); }
    finally { telemetryLog('main_stopped'); await shutdownTelemetry(); }
  }
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
