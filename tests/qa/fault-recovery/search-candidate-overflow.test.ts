import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { initializeFreshGraph, iri, lit, RV } from '../../../services/main/src/modules/work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';

const root = resolve(import.meta.dir, '../../..');

function rootCommand(args: string[], timeout: number): void {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout
      || result.error?.message || '').slice(-2000)}`);
  }
}

test('SEARCH02/SEARCH10: 513 real text hits with no eligible relation return a budget outcome', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const runId = `candidate-overflow-${randomUUID().slice(0, 12)}`;
  const options = { profile: 'qa' as const, runId, rawUpdate: true };
  const stackArgs = ['--profile', 'qa', '--run-id', runId, '--raw-update'];
  let started = false;
  try {
    started = true;
    rootCommand(['stack:up', ...stackArgs], 180_000);
    const apps = readEnv(resolve(stackDirectory(root, options), 'apps.env'));
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const env = { fuseki,
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
      objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
    await initializeFreshGraph(fuseki, env.lineage);
    const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    const app = createMainApp(fuseki, { environment: env,
      account: { verify: async () => { throw new Error('public query needs no Account assertion'); } },
      access: new AccessAdmissionRegistry(accessPool) });
    const phrase = `overflow${randomUUID().replaceAll('-', '')}`;
    const query = () => app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-phrase-v1', phrase, language: null }),
    }));
    try {
      const units = Array.from({ length: 513 }, (_, index) =>
        iri(`urn:rezics:qa:overflow:${runId}:${index}`));
      const triples = units.map(unit => `${unit} a <${RV}MatchUnit> ;
        <${RV}searchBody> ${lit(`${phrase} hidden candidate`)}@en .`);
      const firstBatch = triples.slice(0, 512).join('\n');
      await fuseki.update(`INSERT DATA { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${firstBatch} } }`);
      try {
        const withinBudget = await query();
        expect(withinBudget.status).toBe(200);
        expect(await withinBudget.json()).toMatchObject({ complete: true, total: 0 });
        await fuseki.update(`INSERT DATA { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${triples[512]} } }`);
        const indexed = await fuseki.query(`PREFIX rv: <${RV}>
        PREFIX text: <http://jena.apache.org/text#>
        SELECT (COUNT(?unit) AS ?count) WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody ${lit(phrase)} 514) .
        } }`);
        expect(indexed.results?.bindings[0]?.count?.value).toBe('513');
        const overflow = await query();
        expect(overflow.status).toBe(422);
        expect(await overflow.json()).toMatchObject({ code: 'query_budget_exceeded' });
      } finally {
        await fuseki.update(`DELETE DATA { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ${triples.join('\n')} } }`);
      }
    } finally {
      await accessPool.end();
    }
  } finally {
    if (started) rootCommand(['stack:reset', ...stackArgs], 120_000);
  }
}, 240_000);
