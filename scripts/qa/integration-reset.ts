import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { Client } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph } from '../../services/main/src/modules/work/activate.ts';
import { readEnv, replacePrivate } from '../dev/config.ts';

export const integrationOwnerResetStatements = ['account', 'access', 'content', 'relay'].flatMap(
  (owner) => [
    `DROP DATABASE ${owner} WITH (FORCE)`,
    `CREATE DATABASE ${owner} WITH TEMPLATE ${owner}_tpl OWNER ${owner}`,
  ],
);

/** Called only between exited Bun commands, never alongside a test writer.
 * Migrated templates remain untouched. A fresh lineage and object directory
 * keep graph receipts, SQL authority and immutable bytes from crossing files. */
async function resetOwners(compose: Record<string, string>) {
  const db = new Client({
    connectionString: `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres`,
  });
  await db.connect();
  try {
    for (const sql of integrationOwnerResetStatements) await db.query(sql);
  } finally {
    await db.end();
  }
}

async function resetGraph(
  apps: Record<string, string>,
  lineage: { dataEpoch: string; routingEpoch: string },
) {
  const fuseki = new FusekiClient(
    apps.FUSEKI_URL!,
    apps.FUSEKI_MAINTENANCE_TOKEN,
    apps.FUSEKI_COMMAND_TOKEN,
  );
  // CLEAR ALL + fresh bootstrap is also the classification bootstrap test's
  // reset path; it clears receipts/control and updates the jena-text wrapper.
  // Jena 6.2.0 monitors removeGraph/deleteAny through TextQuadAction.DELETE:
  // https://github.com/apache/jena/blob/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/changes/DatasetGraphTextMonitor.java
  await fuseki.update('CLEAR ALL');
  await initializeFreshGraph(fuseki, lineage);
}

export async function resetIntegrationState(
  apps: Record<string, string>,
  compose: Record<string, string>,
  dependencies = { owners: resetOwners, graph: resetGraph },
): Promise<Record<string, string>> {
  const lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };
  await dependencies.owners(compose);
  await dependencies.graph(apps, lineage);
  const objects = apps.MAIN_OBJECT_DIRECTORY!;
  for (const directory of [objects, apps.MAIN_CANDIDATE_DIRECTORY].filter((path): path is string =>
    Boolean(path),
  )) {
    rmSync(directory, { recursive: true, force: true });
  }
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  return {
    ...apps,
    MAIN_DATA_EPOCH: lineage.dataEpoch,
    MAIN_ROUTING_EPOCH: lineage.routingEpoch,
    MAIN_OBJECT_DIRECTORY: objects,
  };
}

if (import.meta.main) {
  const appsPath = process.argv[2]!;
  const composePath = process.argv[3]!;
  const next = await resetIntegrationState(readEnv(appsPath), readEnv(composePath));
  replacePrivate(appsPath, next);
  replacePrivate(composePath, {
    ...readEnv(composePath),
    MAIN_DATA_EPOCH: next.MAIN_DATA_EPOCH!,
    MAIN_ROUTING_EPOCH: next.MAIN_ROUTING_EPOCH!,
  });
}
