import { Pool } from 'pg';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { S3ImmutableObjects } from './infrastructure/immutable-objects.ts';
import { StructureGroupRootStore } from './modules/structure/group-root.ts';
import { StructureQualifierRootStore } from './modules/structure/qualifier-index.ts';
import { captureGraphRecoveryCoverage } from './modules/work/restore-lineage.ts';
import { sealRecoveryPayload } from '../../account/src/recovery-envelope.ts';
import { retainRecoveryCoverageHead } from './modules/outbox/recovery-coverage-head.ts';

const fusekiUrl = Bun.env.FUSEKI_URL;
const accountUrl = Bun.env.ACCOUNT_RECOVERY_DATABASE_URL;
const accessUrl = Bun.env.ACCESS_RECOVERY_DATABASE_URL;
const relayUrl = Bun.env.RELAY_RECOVERY_DATABASE_URL;
const contentUrl = Bun.env.CONTENT_RECOVERY_DATABASE_URL;
const consumer = Bun.env.RELAY_CONSUMER;
const key = Bun.env.RECOVERY_MANIFEST_HMAC_KEY;
const objectDirectory = Bun.env.MAIN_OBJECT_DIRECTORY;
if (process.argv[2] !== 'capture' || !fusekiUrl || !accountUrl || !accessUrl || !relayUrl || !contentUrl
  || !consumer || !key || !objectDirectory) {
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
try {
  const coverage = await captureGraphRecoveryCoverage(
    new FusekiClient(fusekiUrl), account, access, relay, consumer, content,
    { directory: objectDirectory, ...(workObjects ? { workObjects } : {}),
      ...(structureObjects ? { structureObjects,
        structureGroupRoots: new StructureGroupRootStore(content, structureObjects),
        structureQualifierRoots: new StructureQualifierRootStore(content, structureObjects) } : {}) });
  const sealed = JSON.stringify(sealRecoveryPayload(
    coverage, key, 'graph-recovery-coverage'));
  await retainRecoveryCoverageHead(relay, sealed, key);
  console.log(sealed);
} finally {
  await Promise.all([account.end(), access.end(), relay.end(), content.end()]);
}
