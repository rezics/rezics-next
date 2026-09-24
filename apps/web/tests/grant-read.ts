import { grantQaWorkRead } from '../../../scripts/dev/qa-work-read.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the isolated QA Work read`);
  return value;
}

await grantQaWorkRead({
  runId: required('REZICS_QA_RUN_ID'),
  privateConfigPath: required('REZICS_WEB_AUTH_PRIVATE_PATH'),
  accessDatabaseUrl: required('ACCESS_DATABASE_URL'),
  fusekiUrl: required('FUSEKI_URL'),
  work: required('REZICS_QA_WORK'),
});
