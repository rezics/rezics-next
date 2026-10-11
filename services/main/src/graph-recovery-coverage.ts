import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { S3ImmutableObjects } from './infrastructure/immutable-objects.ts';
import { StructureGroupRootStore } from './modules/structure/group-root.ts';
import { StructureQualifierRootStore } from './modules/structure/qualifier-index.ts';
import { assertRecoveryCoverage, captureGraphRecoveryCoverage,
  type NativeAccessCustodyCapture, type RecoveryCoverage } from './modules/work/restore-lineage.ts';
import { openRecoveryPayload, sealRecoveryPayload } from '../../account/src/recovery-envelope.ts';
import { retainRecoveryCoverageHead } from './modules/outbox/recovery-coverage-head.ts';
import { encryptRecoveryAttachment } from '../../../scripts/ops/recovery-set.ts';

const fusekiUrl = Bun.env.FUSEKI_URL;
const accountUrl = Bun.env.ACCOUNT_RECOVERY_DATABASE_URL;
const accessUrl = Bun.env.ACCESS_RECOVERY_DATABASE_URL;
const relayUrl = Bun.env.RELAY_RECOVERY_DATABASE_URL;
const contentUrl = Bun.env.CONTENT_RECOVERY_DATABASE_URL;
const consumer = Bun.env.RELAY_CONSUMER;
const key = Bun.env.RECOVERY_MANIFEST_HMAC_KEY;
const objectDirectory = Bun.env.MAIN_OBJECT_DIRECTORY;
const erasureCaptureEnv = [Bun.env.ACCESS_ERASURE_BASE_COVERAGE_FILE, Bun.env.ACCESS_ERASURE_BASE_DATABASE_URL,
  Bun.env.RELAY_ERASURE_BASE_DATABASE_URL, Bun.env.ACCESS_ERASURE_ATTACHMENT_DIRECTORY,
  Bun.env.ACCESS_ERASURE_ATTACHMENT_RECIPIENT];
const configuredErasureCapture = erasureCaptureEnv.filter(value => value !== undefined && value !== '').length;
if (process.argv[2] !== 'capture' || !fusekiUrl || !accountUrl || !accessUrl || !relayUrl || !contentUrl
  || !consumer || !key || !objectDirectory || (configuredErasureCapture !== 0 && configuredErasureCapture !== 5)) {
  throw new Error('usage: FUSEKI_URL=... ACCOUNT_RECOVERY_DATABASE_URL=... ACCESS_RECOVERY_DATABASE_URL=... RELAY_RECOVERY_DATABASE_URL=... CONTENT_RECOVERY_DATABASE_URL=... MAIN_OBJECT_DIRECTORY=... RELAY_CONSUMER=... RECOVERY_MANIFEST_HMAC_KEY=<64 hex characters> bun graph-recovery-coverage.ts capture');
}
const workObjects = Bun.env.MAIN_S3_ENDPOINT ? new S3ImmutableObjects({
  endpoint: Bun.env.MAIN_S3_ENDPOINT, bucket: Bun.env.MAIN_S3_BUCKET!,
  region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
  secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/work/',
}) : undefined;

const structureObjects = Bun.env.MAIN_S3_ENDPOINT ? new S3ImmutableObjects({
  endpoint: Bun.env.MAIN_S3_ENDPOINT, bucket: Bun.env.MAIN_S3_BUCKET!,
  region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
  secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/structure/',
}) : undefined;

const account = new Pool({ connectionString: accountUrl });
const access = new Pool({ connectionString: accessUrl });
const relay = new Pool({ connectionString: relayUrl });
const content = new Pool({ connectionString: contentUrl });
let baseAccess: Pool | undefined;
let baseRelay: Pool | undefined;
let nativeAccessCustody: NativeAccessCustodyCapture | undefined;
if (configuredErasureCapture === 5) {
  const [baseCoveragePath, baseAccessUrl, baseRelayUrl, attachmentDirectory, recipient] = erasureCaptureEnv as string[];
  const baseCoverageEnvelope = readFileSync(baseCoveragePath!, 'utf8');
  const baseCoverage = openRecoveryPayload<RecoveryCoverage>(baseCoverageEnvelope, key!, 'graph-recovery-coverage');
  assertRecoveryCoverage(baseCoverage);
  baseAccess = new Pool({ connectionString: baseAccessUrl! });
  baseRelay = new Pool({ connectionString: baseRelayUrl! });
  nativeAccessCustody = {
    baseCoverage, baseCoverageEnvelope, baseCoverageHmacKey: key!,
    baseAccessPool: baseAccess, baseRelayPool: baseRelay,
    encryptAttachment: async produce => {
      const encrypted = await encryptRecoveryAttachment(recipient!, attachmentDirectory!, produce);
      return { value: encrypted.value, ciphertextDigest: encrypted.ciphertextDigest,
        ciphertextBytes: encrypted.ciphertextBytes, recipientFingerprint: encrypted.recipientFingerprint };
    },
  };
}
const fuseki = new FusekiClient(fusekiUrl);
const relayClient = await relay.connect();
try {
  await relayClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await relayClient.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
  const coverage = await captureGraphRecoveryCoverage(
    fuseki, account, access, relay, consumer, content,
    { directory: objectDirectory, ...(workObjects ? { workObjects } : {}),
      ...(structureObjects ? { structureObjects,
        structureGroupRoots: new StructureGroupRootStore(content, structureObjects),
        structureQualifierRoots: new StructureQualifierRootStore(content, structureObjects) } : {}) },
    { fuseki, relayClient }, nativeAccessCustody);
  const sealed = JSON.stringify(sealRecoveryPayload(
    coverage, key, 'graph-recovery-coverage'));
  await retainRecoveryCoverageHead(relayClient, sealed, key,
    nativeAccessCustody ? { attachmentDirectory: Bun.env.ACCESS_ERASURE_ATTACHMENT_DIRECTORY! } : undefined);
  await relayClient.query('COMMIT');
  console.log(sealed);
} catch (error) {
  await relayClient.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  relayClient.release();
  await Promise.all([account.end(), access.end(), relay.end(), content.end(),
    ...(baseAccess ? [baseAccess.end()] : []), ...(baseRelay ? [baseRelay.end()] : [])]);
}
