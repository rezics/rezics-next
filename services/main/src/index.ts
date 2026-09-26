import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ContentComments, ContentCore, ContentProjectionCursor,
  migrateContent } from '../../content/src/index.ts';
import { createMainApp } from './app.ts';
import { ContentProjectionWorker } from './content-projection-worker.ts';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { S3ImmutableObjects } from './infrastructure/immutable-objects.ts';
import { StructureProgressStore } from './modules/progress/store.ts';
import { AccessAdmissionRegistry } from './modules/access/admission.ts';
import { AccessDownloadLeases } from './modules/access/download-leases.ts';
import { AgentProvisioning } from './modules/agent/provision.ts';
import { ErasureService } from './modules/erasure/request.ts';
import { ContentProtectionStore } from './modules/protection/content-store.ts';
import { PrivateSearchSettlement } from './modules/contribution/private-search-settlement.ts';
import { ReleaseRatingInventoryStore } from './modules/access/rating-aggregate-inventory.ts';
import { AccessActingContexts } from './modules/access/contexts.ts';
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
import { ReaderVariantPreferenceStore } from './modules/work/native-variants.ts';
import { RealmVariantRecommendationStore } from './modules/work/realm-variant-recommendation.ts';
import { RealmReplyContentStore } from './modules/realm-reply/content-store.ts';
import { RealmReplyStore } from './modules/realm-reply/store.ts';
import { SourceIntakeStore } from './modules/source/intake.ts';
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
import { HubStore } from './modules/hub/store.ts';
import { GoProxyCaptureStore } from './modules/package/go-proxy-capture.ts';
import { GoSumdbTrustStore } from './modules/package/go-sumdb-trust.ts';
import { OpenLibrarySourceGraph } from './modules/source/graph-projection.ts';
import { SourceNativeWorkProposalStore } from './modules/source/native-work-proposal.ts';
import { SourceNativeWorkAdoptionStore } from './modules/source/native-work-adoption.ts';
import { SourceNativeWorkAttachmentStore } from './modules/source/native-work-attachment.ts';
import { SourceAuthorCreditStore } from './modules/source/author-credit.ts';
import { SourceFieldWithdrawalStore } from './modules/source/withdrawal.ts';
import { ProviderIdentityStore } from './modules/source/provider-identity.ts';
import { SourceScoreStore } from './modules/source/score.ts';
import { AccountAssertionVerifier } from './modules/account/verify-assertion.ts';
import { relayContentProjectionOnce } from './modules/content-publication/relay.ts';
import { RelayHandoffPositions } from './modules/outbox/relay-position.ts';
import { OwnerOperations } from './modules/owner/operations.ts';
import { governanceServices } from './modules/governance/composition.ts';
import { NotificationStore } from './modules/notification/store.ts';
import { RightsStore } from './modules/rights/store.ts';
import { ACCESS_OPERATIONAL_BOUNDS_V1, activateOperationalBounds } from './operations/bounds.ts';
import { RankingGenerations } from './modules/recommendation/ranking.ts';
import { RankingBuildWorker } from './modules/recommendation/build-worker.ts';
import { verifyRankingSemanticBasis } from './modules/recommendation/semantic-basis.ts';
import { PrivateContextSelections } from './modules/context/private-selection.ts';

function required(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const fusekiUrl = required('FUSEKI_URL');
const port = Number(Bun.env.MAIN_PORT ?? '3001');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MAIN_PORT must be an integer TCP port');
}

const fuseki = new FusekiClient(fusekiUrl);
const pool = new Pool({ connectionString: required('ACCESS_DATABASE_URL') });
// IAM35: every Main enforces the Access-active profile; this release requests its own.
const bounds = await activateOperationalBounds(pool, ACCESS_OPERATIONAL_BOUNDS_V1);
if (bounds.status === 'restricted') {
  console.warn('Access operational bounds are restricted; saved records exceed',
    JSON.stringify(bounds.violations));
}
// OPS06: the broker lane observes the relay checkpoint through a read-only session.
const relayUrl = Bun.env.MAIN_RELAY_DATABASE_URL;
const relayConsumer = Bun.env.MAIN_RELAY_CONSUMER;
if (Boolean(relayUrl) !== Boolean(relayConsumer)) {
  throw new Error('MAIN_RELAY_DATABASE_URL and MAIN_RELAY_CONSUMER are configured together');
}
const relayPool = relayUrl ? new Pool({ connectionString: relayUrl, max: 2,
  options: '-c default_transaction_read_only=on' }) : undefined;
const erasureRelayUrl = relayUrl ?? Bun.env.ACCOUNT_RELAY_DATABASE_URL;
const erasureRelayPool = erasureRelayUrl ? new Pool({ connectionString: erasureRelayUrl, max: 2 }) : undefined;
const ownerRelayUrl = Bun.env.OWNER_RELAY_DATABASE_URL ?? relayUrl;
const ownerRelayPool = ownerRelayUrl
  ? new Pool({ connectionString: ownerRelayUrl, max: 4 }) : undefined;
const recommendationRelayUrl = Bun.env.ACCOUNT_RELAY_DATABASE_URL ?? relayUrl;
const recommendationRelayPool = recommendationRelayUrl ? new Pool({ connectionString: recommendationRelayUrl,
  max: 2, options: '-c default_transaction_read_only=on' }) : undefined;
const contentPool = new Pool({ connectionString: required('CONTENT_DATABASE_URL') });
await migrateContent(contentPool);
const content = new ContentCore(contentPool);
const sourceIntake = new SourceIntakeStore(contentPool);
const sourceConversions = new OpenLibraryConversionStore(contentPool, sourceIntake);
const packageCaptures = new GoProxyCaptureStore(contentPool);
const comments = new ContentComments(contentPool);
const cursor = new ContentProjectionCursor(contentPool);
const consumer = Bun.env.CONTENT_PROJECTION_CONSUMER ?? 'main-content-public-search-v1';
await cursor.initialize(consumer);
const environment = {
  fuseki,
  lineage: { dataEpoch: required('MAIN_DATA_EPOCH'), routingEpoch: required('MAIN_ROUTING_EPOCH') },
  objectDirectory: required('MAIN_OBJECT_DIRECTORY'),
};
const sourceGraph = new OpenLibrarySourceGraph(fuseki, environment.lineage, sourceConversions);
const sourceProposals = new SourceNativeWorkProposalStore(contentPool, sourceGraph, sourceConversions);
const workObjects = Bun.env.MAIN_S3_ENDPOINT ? new S3ImmutableObjects({
  endpoint: required('MAIN_S3_ENDPOINT'), bucket: required('MAIN_S3_BUCKET'),
  region: required('MAIN_S3_REGION'), accessKeyId: required('MAIN_S3_ACCESS_KEY'),
  secretAccessKey: required('MAIN_S3_SECRET_KEY'), prefix: 'semantic/work/',
}) : undefined;
if (workObjects) await workObjects.initialize();
const structureObjects = new S3ImmutableObjects({
  endpoint: required('MAIN_S3_ENDPOINT'), bucket: required('MAIN_S3_BUCKET'),
  region: required('MAIN_S3_REGION'), accessKeyId: required('MAIN_S3_ACCESS_KEY'),
  secretAccessKey: required('MAIN_S3_SECRET_KEY'), prefix: 'semantic/structure/',
});
await structureObjects.initialize();
const mediaObjects = (prefix: string) => new S3ImmutableObjects({
  endpoint: required('MAIN_S3_ENDPOINT'), bucket: required('MAIN_S3_BUCKET'),
  region: required('MAIN_S3_REGION'), accessKeyId: required('MAIN_S3_ACCESS_KEY'),
  secretAccessKey: required('MAIN_S3_SECRET_KEY'), prefix,
});
await mediaObjects('media/').initialize();
await mediaObjects('package/artifact/public/').initialize();
const packageArtifacts = new PackageArtifactStore(contentPool, mediaObjects);
const packageLocks = new PackageLockStore(contentPool, new NpmResolutionStore(contentPool), packageArtifacts);
const packageInstallations = new PackageInstallationStore(contentPool, packageLocks,
  { rootDirectory: join(environment.objectDirectory, 'package-installations') });
const media = { store: new MediaStore(contentPool, content), content, objects: mediaObjects };
const account = new AccountAssertionVerifier({
  issuer: required('ACCOUNT_ISSUER'), audience: required('ACCOUNT_MAIN_RESOURCE'),
  jwksUrl: required('ACCOUNT_JWKS_URL'), introspectUrl: required('ACCOUNT_INTROSPECT_URL'),
  clientId: required('ACCOUNT_MAIN_CLIENT_ID'), clientSecret: required('ACCOUNT_MAIN_CLIENT_SECRET'),
});
const access = new AccessAdmissionRegistry(pool);
const rankingContextSelections = new PrivateContextSelections(pool);
const recommendations = recommendationRelayPool ? new RankingGenerations({ access: pool,
  relay: recommendationRelayPool, dataEpoch: environment.lineage.dataEpoch,
  cursorKey: createHash('sha256').update('rezics-ranking-cursor-v1\0')
    .update(required('ACCOUNT_MAIN_CLIENT_SECRET')).digest(),
  canReadWork: (principal, actingSubject, work) => access.canReadWork(principal, actingSubject, work),
  verifySemantic: (viewer, basis) => verifyRankingSemanticBasis(environment, pool, rankingContextSelections,
    viewer, basis) }) : undefined;
const recommendationWorker = recommendations ? new RankingBuildWorker(pool, recommendations) : undefined;
const hub = new HubStore(contentPool, content, access, environment, packageArtifacts);
const downloadLeases = new AccessDownloadLeases(pool);
const notificationStore = new NotificationStore(pool);
if (relayPool) await notificationStore.reconcileRetainedErasures(relayPool);
const sourceAdoptions = new SourceNativeWorkAdoptionStore(contentPool, sourceProposals,
  environment, account, access);
const sourceCorrespondences = new SourceChildCorrespondenceStore(contentPool, sourceConversions);
const app = createMainApp(fuseki, {
  agentProvisioning: new AgentProvisioning(pool,
    { ...environment, ...(workObjects ? { workObjects } : {}) }),
  environment: {
    ...environment,
    ...(workObjects ? { workObjects } : {}),
  },
  structureObjects,
  account,
  progress: new StructureProgressStore(contentPool),
  access,
  downloadLeases,
  erasures: erasureRelayPool ? new ErasureService(erasureRelayPool, contentPool) : undefined,
  recommendations,
  governance: governanceServices(pool, contentPool, content, sourceIntake, access, environment),
  ...(relayPool ? { notifications: { store: notificationStore } } : {}),
  rights: { store: new RightsStore(contentPool, pool) },
  privateSearch: { access, settlement: new PrivateSearchSettlement(pool) },
  media,
  mediaAccess: new MediaAccessBatchReader(pool),
  releaseRatingInventory: new ReleaseRatingInventoryStore(pool),
  votes: new AccessVotes(pool),
  exports: new ExportStore(contentPool),
  exportVerification: new VerificationStore(contentPool),
  actingContexts: new AccessActingContexts(pool),
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
  sourceAcquisitions: sourceAcquisitionServices(contentPool,
    { reserve: () => sourceIntake.reserveOpenLibrarySlot() }),
  sourceConversions,
  sourceCorrespondences,
  sourceAuthorCredits: new SourceAuthorCreditStore(contentPool, sourceProposals, sourceConversions,
    sourceCorrespondences, environment, account, access),
  sourceFieldWithdrawals: new SourceFieldWithdrawalStore(contentPool),
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
  packageCaptures,
  packageVerifications: new GoSumdbTrustStore(contentPool, packageCaptures),
  sourceGraph,
  sourceProposals,
  sourceAdoptions,
  sourceAttachments: new SourceNativeWorkAttachmentStore(contentPool, sourceProposals,
    sourceAdoptions, { ...environment, ...(workObjects ? { workObjects } : {}) }, access),
  readerPreferences: new ReaderVariantPreferenceStore(pool),
  realmRecommendations: new RealmVariantRecommendationStore(pool),
  realmReplies: new RealmReplyStore(new RealmReplyContentStore(contentPool), content, access, environment),
  verification: new VerificationStore(contentPool),
  content,
  editorialProtection: new ContentProtectionStore(contentPool),
  contentAuthoring: content,
  comments,
  contentProjection: { content, cursor, consumer },
  ...(relayPool ? { relayPosition: new RelayHandoffPositions(relayPool, relayConsumer!) } : {}),
  ...(ownerRelayPool ? { ownerOperations: new OwnerOperations(ownerRelayPool, environment) } : {}),
});
const worker = new ContentProjectionWorker(
  () => relayContentProjectionOnce(environment, content, cursor, consumer),
  Number(Bun.env.CONTENT_PROJECTION_INTERVAL_MS ?? '1000'));
app.listen({ hostname: '127.0.0.1', port });
worker.start();
recommendationWorker?.start();

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.stop();
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
