import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ContentComments, ContentCore, ContentProjectionCursor,
  migrateContent } from '../../content/src/index.ts';
import { createMainApp } from './app.ts';
import { ContentProjectionWorker } from './content-projection-worker.ts';
import { DiscoveryProjection } from './modules/discovery/store.ts';
import { FollowsStore } from './modules/follows/store.ts';
import { FeedStore } from './modules/feed/store.ts';
import { ReaderReviews } from './modules/review/store.ts';
import { FeedViewerStateReader } from './modules/feed/viewer-state.ts';
import { HomePersonalStore } from './modules/feed/personal.ts';
import { RankingHomeTrendingReader } from './modules/feed/trending.ts';
import { FeedRefreshWorker } from './modules/feed/refresh.ts';
import { DiscoveryRefreshWorker } from './modules/discovery/refresh.ts';
import { DiscoveryRefreshStore } from './modules/discovery/refresh-store.ts';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { S3ImmutableObjects } from './infrastructure/immutable-objects.ts';
import { StructureProgressStore } from './modules/progress/store.ts';
import { SerialStatisticsProjection } from './modules/work/serial-projection.ts';
import { ReadRankingProjection } from './modules/rankings/projection.ts';
import { ReadingSettingsStore } from './modules/reading-settings/store.ts';
import { StructureStageStore } from './modules/structure/stage.ts';
import { SemanticStageStore } from './modules/semantic/staging.ts';
import { AccessAdmissionRegistry } from './modules/access/admission.ts';
import { AccessDownloadLeases } from './modules/access/download-leases.ts';
import { AgentProvisioning } from './modules/agent/provision.ts';
import { AgentVanityHandles } from './modules/agent/vanity.ts';
import { AgentPublicProfiles } from './modules/agent/profile.ts';
import { ProfilesAccess } from './modules/profiles/access.ts';
import { StudioAccess } from './modules/studio/access.ts';
import { ReaderLibraryStatusStore } from './modules/library/status.ts';
import { ReaderLibraryRatings } from './modules/library/ratings.ts';
import { ProtectionAdmissionSigner } from './modules/access/protection-admission.ts';
import { ErasureService } from './modules/erasure/request.ts';
import { ContentProtectionStore } from './modules/protection/content-store.ts';
import { PrivateSearchSettlement } from './modules/contribution/private-search-settlement.ts';
import { ContentSearchReadAccess } from './modules/search-disclosure/content-read-lease.ts';
import { ReleaseRatingInventoryStore } from './modules/access/rating-aggregate-inventory.ts';
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
import { VerificationCorrectionPublisher, VerificationCorrectionWorker }
  from './modules/verification/correction-delivery.ts';
import { verificationCorrectionSubjectReader } from './modules/verification/correction-delivery.ts';
import { NotificationStore } from './modules/notification/store.ts';
import { SourceIntakeStore } from './modules/source/intake.ts';
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
import { AccessRealmManagement } from './modules/access/realm-management.ts';
import { ManagementReadStore } from './modules/management-reads/read-store.ts';
import { RealmSubmissionStore } from './modules/realm-submission/store.ts';
import { RealmSubmissionReads } from './modules/realm-submission/reads.ts';
import { AccessProposalExecutions } from './modules/proposal/access.ts';
import { currentContentSubjectReader, currentNotificationAgentReader } from './modules/notification/subjects.ts';
import { NotificationRealtimeHub } from './modules/notification/realtime.ts';
import { NotificationDispatcher } from './modules/notification/dispatcher.ts';
import { NotificationDeliveryWorker } from './modules/notification/delivery-worker.ts';
import { NotificationProducer, NotificationProducerWorker } from './modules/notification-producers/producer.ts';
import { notificationProducerSubjectReader } from './modules/notification-producers/subjects.ts';
import { HttpDeliveryProvider } from './modules/notification/http-provider.ts';
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
const pool = new Pool({ connectionString: config.ACCESS_DATABASE_URL });
// IAM35: every Main enforces the Access-active profile; this release requests its own.
const bounds = await activateOperationalBounds(pool, ACCESS_OPERATIONAL_BOUNDS_V1);
if (bounds.status === 'restricted') {
  console.warn('Access operational bounds are restricted; saved records exceed',
    JSON.stringify(bounds.violations));
}
// OPS06: the broker lane observes the relay checkpoint through a read-only session.
const relayUrl = config.MAIN_RELAY_DATABASE_URL;
const relayConsumer = config.MAIN_RELAY_CONSUMER;
const relayPool = relayUrl ? new Pool({ connectionString: relayUrl, max: 2,
  options: '-c default_transaction_read_only=on' }) : undefined;
const erasureRelayUrl = relayUrl ?? config.ACCOUNT_RELAY_DATABASE_URL;
const erasureRelayPool = erasureRelayUrl ? new Pool({ connectionString: erasureRelayUrl, max: 2 }) : undefined;
const ownerRelayUrl = config.OWNER_RELAY_DATABASE_URL ?? relayUrl;
const ownerRelayPool = ownerRelayUrl
  ? new Pool({ connectionString: ownerRelayUrl, max: 4 }) : undefined;
const recommendationRelayUrl = config.ACCOUNT_RELAY_DATABASE_URL ?? relayUrl;
const recommendationRelayPool = recommendationRelayUrl ? new Pool({ connectionString: recommendationRelayUrl,
  max: 2, options: '-c default_transaction_read_only=on' }) : undefined;
const contentPool = new Pool({ connectionString: config.CONTENT_DATABASE_URL });
await migrateContent(contentPool);
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
  fuseki,
  lineage: { dataEpoch: config.MAIN_DATA_EPOCH, routingEpoch: config.MAIN_ROUTING_EPOCH },
  objectDirectory: config.MAIN_OBJECT_DIRECTORY,
  ...(workObjects ? { workObjects } : {}),
};
const serialStats = recommendationRelayPool
  ? new SerialStatisticsProjection(pool, recommendationRelayPool, contentPool, environment) : undefined;
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
const media = { store: new MediaStore(contentPool, content), content, objects: mediaObjects };
const account = new AccountAssertionVerifier({
  issuer: config.ACCOUNT_ISSUER, audience: config.ACCOUNT_MAIN_RESOURCE,
  jwksUrl: config.ACCOUNT_JWKS_URL, introspectUrl: config.ACCOUNT_INTROSPECT_URL,
  clientId: config.ACCOUNT_MAIN_CLIENT_ID, clientSecret: config.ACCOUNT_MAIN_CLIENT_SECRET,
});
const access = new AccessAdmissionRegistry(pool, config.FUSEKI_TITLE_ADMISSION_KEY);
access.configureBaseline(fuseki);
const rankingContextSelections = new PrivateContextSelections(pool);
const recommendations = recommendationRelayPool ? new RankingGenerations({ access: pool,
  relay: recommendationRelayPool, dataEpoch: environment.lineage.dataEpoch,
  cursorKey: createHash('sha256').update('rezics-ranking-cursor-v1\0')
    .update(config.ACCOUNT_MAIN_CLIENT_SECRET).digest(),
  canReadWork: (principal, actingSubject, work) => access.canReadWork(principal, actingSubject, work),
  zeroSnapshot: () => graphZeroSnapshot(environment),
  zeroCandidates: graphZeroCandidates(environment),
  verifySemantic: (viewer, basis) => verifyRankingSemanticBasis(environment, pool, rankingContextSelections,
    viewer, basis) }) : undefined;
const recommendationWorker = recommendations ? new RankingBuildWorker(pool, recommendations) : undefined;
const eventQueries = new EventTemporalQueries(pool, environment, createHash('sha256')
  .update('rezics-event-cursor-v1\0').update(config.ACCOUNT_MAIN_CLIENT_SECRET).digest());
const hub = new HubStore(contentPool, content, access, environment, packageArtifacts);
const downloadLeases = new AccessDownloadLeases(pool);
const notificationStore = new NotificationStore(pool);
notificationStore.setDefaultReadSubjectReader(currentContentSubjectReader(content, notificationStore, access));
notificationStore.setReadAgentReader(currentNotificationAgentReader(fuseki, environment.lineage, media.store));
notificationStore.registerReadSubjectReader('verification-correction-subscription-v1',
  verificationCorrectionSubjectReader(new VerificationStore(contentPool)));
const notificationSourceReader = notificationProducerSubjectReader(pool, contentPool, environment);
for (const basis of ['realm-reply-v1', 'submission-decision-v1', 'moderation-outcome-v1',
  'realm-role-change-v1']) notificationStore.registerReadSubjectReader(basis, notificationSourceReader);
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
const notificationDispatcher = notificationProvider
  ? new NotificationDispatcher(pool, notificationProvider,
    currentContentSubjectReader(content, notificationStore, access)) : undefined;
notificationDispatcher?.registerSubjectReader('verification-correction-subscription-v1',
  verificationCorrectionSubjectReader(new VerificationStore(contentPool)));
for (const basis of ['realm-reply-v1', 'submission-decision-v1', 'moderation-outcome-v1',
  'realm-role-change-v1']) notificationDispatcher?.registerSubjectReader(basis, notificationSourceReader);
const notificationProducerWorker = new NotificationProducerWorker(new NotificationProducer(
  pool, relayPool ?? null, contentPool, fuseki, notificationStore, config.MAIN_RELAY_CONSUMER ?? null));
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
const app = createMainApp(fuseki, {
  follows: new FollowsStore(pool),
  feed: new FeedStore(pool),
  reviews: new ReaderReviews(pool),
  serialStats,
  readRankings,
  feedViewerState: new FeedViewerStateReader(),
  homePersonal: new HomePersonalStore(pool),
  homeTrending: new RankingHomeTrendingReader(readRankings),
  discovery: new DiscoveryProjection(pool),
  profiles: new ProfilesAccess(pool),
  studioAccess: new StudioAccess(pool),
  agentHandles: new AgentVanityHandles(pool),
  agentProfiles: new AgentPublicProfiles(pool, environment, media.store),
  libraryStatus: new ReaderLibraryStatusStore(contentPool),
  libraryRatings: new ReaderLibraryRatings(pool),
  agentProvisioning: new AgentProvisioning(pool, environment),
  environment,
  structureObjects,
  structureStages: new StructureStageStore(contentPool, structureObjects),
  semanticStages: new SemanticStageStore(contentPool, semanticStageObjects),
  account,
  progress: new StructureProgressStore(contentPool),
  readingSettings: new ReadingSettingsStore(contentPool),
  access,
  contextSelections: rankingContextSelections,
  eventQueries,
  downloadLeases,
  protectionSigner: new ProtectionAdmissionSigner(pool, config.FUSEKI_TITLE_ADMISSION_KEY),
  erasures: erasureRelayPool ? new ErasureService(erasureRelayPool, contentPool) : undefined,
  recommendations,
  governance: governanceServices(pool, contentPool, content, sourceIntake, access, environment),
  managementReads: new ManagementReadStore(pool, environment),
  realmAdmin: new AccessRealmManagement(pool),
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
  mediaAccess: new MediaAccessBatchReader(pool),
  releaseRatingInventory: new ReleaseRatingInventoryStore(pool),
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
  recipeSourceConversions: new RecipeSourceConversionStore(contentPool, sourceIntake),
  sourceAcquisitions: sourceAcquisitionServices(contentPool,
    { reserve: () => sourceIntake.reserveOpenLibrarySlot(),
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
  packageModResolutions: new ModResolutionStore(contentPool),
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
  maintainers: new WorkMaintainers(pool, environment),
  verification: new VerificationStore(contentPool),
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
const worker = new ContentProjectionWorker(
  () => relayContentProjectionOnce(environment, content, cursor, consumer),
  config.CONTENT_PROJECTION_INTERVAL_MS);
const discoveryWorker = relayPool ? new DiscoveryRefreshWorker({ environment, access, account, media,
  judgments: new AccessJudgments(pool),
  governance: governanceServices(pool, contentPool, content, sourceIntake, access, environment),
  relayPosition: new RelayHandoffPositions(relayPool, relayConsumer!) },
new DiscoveryRefreshStore(pool), new DiscoveryProjection(pool)) : undefined;
app.listen({ hostname: '127.0.0.1', port });
const feedWorker = relayPool ? new FeedRefreshWorker({ environment, account, access, content,
  relayPosition: new RelayHandoffPositions(relayPool, relayConsumer!) }, new FeedStore(pool), relayPool) : undefined;
feedWorker?.start();
worker.start();
discoveryWorker?.start();
recommendationWorker?.start();
serialStats?.start();
readRankings.start();
correctionWorker.start();
notificationProducerWorker.start();
notificationDeliveryWorker?.start();

let stopping = false;
async function stop(): Promise<void> {
  await serialStats?.stop();
  await readRankings.stop();
  if (stopping) return;
  stopping = true;
  await app.stop();
  await feedWorker?.stop();
  await discoveryWorker?.stop();
  await correctionWorker.stop();
  await notificationProducerWorker.stop();
  await notificationDeliveryWorker?.stop();
  await notificationRealtime?.stop();
  try {
  try { await worker.stop(); }
  finally { await Promise.all([pool.end(), contentPool.end(), relayPool?.end()]); }
  await erasureRelayPool?.end();
  } finally { await ownerRelayPool?.end(); }
  await recommendationWorker?.stop();
  try { await worker.stop(); }
  finally { await Promise.all([pool.end(), contentPool.end(), relayPool?.end()]); }
  await recommendationRelayPool?.end();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
