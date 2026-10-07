import { Pool } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../services/main/src/infrastructure/immutable-objects.ts';
import { convertPopulatedStatements } from '../../services/main/src/modules/statement/populated-conversion.ts';

if (!process.argv.includes('--fenced')) throw new Error('Run only on an explicitly fenced populated stack with --fenced');
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const pool = new Pool({connectionString: required('ACCESS_DATABASE_URL')});
try {
  const workObjects = process.env.MAIN_S3_ENDPOINT ? new S3ImmutableObjects({
    endpoint: required('MAIN_S3_ENDPOINT'),bucket: required('MAIN_S3_BUCKET'),region: required('MAIN_S3_REGION'),
    accessKeyId: required('MAIN_S3_ACCESS_KEY'),secretAccessKey: required('MAIN_S3_SECRET_KEY'),prefix: 'semantic/work/',
  }) : undefined;
  const result = await convertPopulatedStatements({
    fuseki: new FusekiClient(required('FUSEKI_URL'),required('FUSEKI_MAINTENANCE_TOKEN'),required('FUSEKI_COMMAND_TOKEN')),
    lineage: {dataEpoch: required('MAIN_DATA_EPOCH'),routingEpoch: required('MAIN_ROUTING_EPOCH')},
    objectDirectory: required('MAIN_OBJECT_DIRECTORY'),
    ...(workObjects ? {workObjects} : {}),
  },pool);
  console.log(JSON.stringify(result));
} finally {await pool.end();}
