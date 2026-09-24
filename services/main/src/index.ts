import { Pool } from 'pg';
import { createMainApp } from './app.ts';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { S3ImmutableObjects } from './infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from './modules/access/admission.ts';
import { AccountAssertionVerifier } from './modules/account/verify-assertion.ts';

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
const workObjects = Bun.env.MAIN_S3_ENDPOINT ? new S3ImmutableObjects({
  endpoint: required('MAIN_S3_ENDPOINT'), bucket: required('MAIN_S3_BUCKET'),
  region: required('MAIN_S3_REGION'), accessKeyId: required('MAIN_S3_ACCESS_KEY'),
  secretAccessKey: required('MAIN_S3_SECRET_KEY'), prefix: 'semantic/work/',
}) : undefined;
if (workObjects) await workObjects.initialize();
const app = createMainApp(fuseki, {
  environment: {
    fuseki,
    lineage: { dataEpoch: required('MAIN_DATA_EPOCH'), routingEpoch: required('MAIN_ROUTING_EPOCH') },
    objectDirectory: required('MAIN_OBJECT_DIRECTORY'),
    ...(workObjects ? { workObjects } : {}),
  },
  account: new AccountAssertionVerifier({
    issuer: required('ACCOUNT_ISSUER'), audience: required('ACCOUNT_MAIN_RESOURCE'),
    jwksUrl: required('ACCOUNT_JWKS_URL'), introspectUrl: required('ACCOUNT_INTROSPECT_URL'),
    clientId: required('ACCOUNT_MAIN_CLIENT_ID'), clientSecret: required('ACCOUNT_MAIN_CLIENT_SECRET'),
  }),
  access: new AccessAdmissionRegistry(pool),
});
app.listen({ hostname: '127.0.0.1', port });
