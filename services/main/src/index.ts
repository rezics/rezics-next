import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from './app.ts';
import { FusekiClient } from './infrastructure/fuseki.ts';
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
const repositoryRoot = resolve(import.meta.dir, '../../..');
const app = createMainApp(fuseki, {
  environment: {
    fuseki,
    lineage: { dataEpoch: required('MAIN_DATA_EPOCH'), routingEpoch: required('MAIN_ROUTING_EPOCH') },
    objectDirectory: required('MAIN_OBJECT_DIRECTORY'),
    candidateDirectory: required('MAIN_CANDIDATE_DIRECTORY'),
    repositoryRoot,
    jenaHome: required('REZICS_JENA_HOME'),
    javaHome: required('REZICS_JAVA_HOME'),
    python: Bun.env.REZICS_PYTHON ?? 'python3',
  },
  account: new AccountAssertionVerifier({
    issuer: required('ACCOUNT_ISSUER'), audience: required('ACCOUNT_MAIN_RESOURCE'),
    jwksUrl: required('ACCOUNT_JWKS_URL'), introspectUrl: required('ACCOUNT_INTROSPECT_URL'),
    clientId: required('ACCOUNT_MAIN_CLIENT_ID'), clientSecret: required('ACCOUNT_MAIN_CLIENT_SECRET'),
  }),
  access: new AccessAdmissionRegistry(pool),
});
app.listen({ hostname: '127.0.0.1', port });
