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

/** Raw SPARQL update refuses to remove this server-owned proof graph. */
export const WORK_SCOPE_REPAIR_GRAPH = 'urn:rezics:projection:public-name-repair';

const SPARQL_GRAPH_IRI = /^(?:urn:|https?:\/\/)[^\s<>"'{}|\\^`]+$/;

/** `CLEAR ALL` is a 400: the raw update servlet rejects it, `CLEAR NAMED`,
 * `DROP ALL` and `DROP NAMED` because each would remove the work-scope proof
 * graph. Named clears of every other graph are admitted and still reach
 * jena-text through removeGraph/deleteAny. The servlet then deletes the
 * proof graph's scope qualification itself. */
export function graphClearUpdate(graphs: readonly string[]): string {
  const statements: string[] = [];
  for (const graph of [...new Set(graphs)].sort()) {
    if (!SPARQL_GRAPH_IRI.test(graph)) throw new Error('integration reset refused an unsafe graph IRI');
    if (graph === WORK_SCOPE_REPAIR_GRAPH) continue;
    statements.push(`CLEAR GRAPH <${graph}>`);
  }
  statements.push('CLEAR DEFAULT');
  return statements.join('; ');
}

/** A reset that fails while the stack is broken is a harness failure. It does
 * not fail the file that already passed, or the files the reset never reached. */
export function integrationResetHarnessFailure(input: {
  stack: string;
  pendingFiles: readonly string[];
  timedOut?: boolean;
}): { message: string; failedFiles: readonly string[] } {
  const pending = input.pendingFiles.length ? ` before ${input.pendingFiles.join(', ')}` : '';
  return {
    message: `integration reset ${input.timedOut ? 'timed out' : 'failed'} on stack ${input.stack}${pending}`,
    failedFiles: [],
  };
}

export function filesKeptAfterResetFailure(
  files: readonly string[],
  pendingFiles: readonly string[],
): string[] {
  const pending = new Set(pendingFiles);
  return files.filter((file) => !pending.has(file));
}

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
  const listed = await fuseki.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
  const graphs = (listed.results?.bindings ?? []).flatMap((binding) =>
    binding.g?.type === 'uri' && binding.g.value ? [binding.g.value] : [],
  );
  await fuseki.update(graphClearUpdate(graphs));
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
