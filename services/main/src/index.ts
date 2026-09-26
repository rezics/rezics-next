import { Pool } from 'pg';
import { ContentComments, ContentCore, ContentProjectionCursor,
  migrateContent } from '../../content/src/index.ts';
import { createMainApp } from './app.ts';
import { ContentProjectionWorker } from './content-projection-worker.ts';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { S3ImmutableObjects } from './infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from './modules/access/admission.ts';
import { AccessActingContexts } from './modules/access/contexts.ts';
import { AccessGroups } from './modules/access/groups.ts';
import { AccessGrants } from './modules/access/grants.ts';
import { AccessMemberships } from './modules/access/memberships.ts';
import { AccessMembershipConsents } from './modules/access/membership-consents.ts';
import { AccessRepresentations } from './modules/access/representations.ts';
import { AccessRoles } from './modules/access/roles.ts';
import { ReaderVariantPreferenceStore } from './modules/work/native-variants.ts';
import { RealmVariantRecommendationStore } from './modules/work/realm-variant-recommendation.ts';
import { SourceIntakeStore } from './modules/source/intake.ts';
import { OpenLibraryConversionStore } from './modules/source/open-library-conversion.ts';
import { SourceChildCorrespondenceStore }
  from './modules/source/record-child-correspondence.ts';
import { GoMvsResolutionStore } from './modules/package/go-mvs.ts';
import { GoProxyCaptureStore } from './modules/package/go-proxy-capture.ts';
import { GoSumdbTrustStore } from './modules/package/go-sumdb-trust.ts';
import { OpenLibrarySourceGraph } from './modules/source/graph-projection.ts';
import { SourceNativeWorkProposalStore } from './modules/source/native-work-proposal.ts';
import { SourceNativeWorkAdoptionStore } from './modules/source/native-work-adoption.ts';
import { AccountAssertionVerifier } from './modules/account/verify-assertion.ts';
import { relayContentProjectionOnce } from './modules/content-publication/relay.ts';

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
const account = new AccountAssertionVerifier({
  issuer: required('ACCOUNT_ISSUER'), audience: required('ACCOUNT_MAIN_RESOURCE'),
  jwksUrl: required('ACCOUNT_JWKS_URL'), introspectUrl: required('ACCOUNT_INTROSPECT_URL'),
  clientId: required('ACCOUNT_MAIN_CLIENT_ID'), clientSecret: required('ACCOUNT_MAIN_CLIENT_SECRET'),
});
const access = new AccessAdmissionRegistry(pool);
const app = createMainApp(fuseki, {
  environment: {
    ...environment,
    ...(workObjects ? { workObjects } : {}),
  },
  account,
  access,
  actingContexts: new AccessActingContexts(pool),
  groups: new AccessGroups(pool),
  grants: new AccessGrants(pool),
  memberships: new AccessMemberships(pool),
  membershipConsents: new AccessMembershipConsents(pool),
  representations: new AccessRepresentations(pool),
  roles: new AccessRoles(pool),
  sourceIntake,
  sourceConversions,
  sourceCorrespondences: new SourceChildCorrespondenceStore(contentPool, sourceConversions),
  packageResolutions: new GoMvsResolutionStore(contentPool, packageCaptures),
  packageCaptures,
  packageVerifications: new GoSumdbTrustStore(contentPool, packageCaptures),
  sourceGraph,
  sourceProposals,
  sourceAdoptions: new SourceNativeWorkAdoptionStore(contentPool, sourceProposals,
    environment, account, access),
  readerPreferences: new ReaderVariantPreferenceStore(pool),
  realmRecommendations: new RealmVariantRecommendationStore(pool),
  content,
  contentAuthoring: content,
  comments,
  contentProjection: { content, cursor, consumer },
});
const worker = new ContentProjectionWorker(
  () => relayContentProjectionOnce(environment, content, cursor, consumer),
  Number(Bun.env.CONTENT_PROJECTION_INTERVAL_MS ?? '1000'));
app.listen({ hostname: '127.0.0.1', port });
worker.start();

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.stop();
  try { await worker.stop(); }
  finally { await Promise.all([pool.end(), contentPool.end()]); }
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
