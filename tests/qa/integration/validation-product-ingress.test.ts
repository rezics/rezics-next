import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { composeProcessEnvironment, projectName, readEnv, stackDirectory }
  from '../../../scripts/dev/config.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';

const root = resolve(import.meta.dir, '../../..');

function stack(action: 'stack:up' | 'stack:reset', runId: string) {
  const result = spawnSync('corepack', ['yarn', action, '--profile', 'qa', '--run-id', runId, '--persistent'], {
    cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 1_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`${action} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-3000)}`);
  }
}

function installReportEndpoint(runId: string) {
  const options = { profile: 'qa' as const, runId, persistent: true };
  const directory = stackDirectory(root, options);
  const source = readFileSync(join(root, 'infra/jena/fuseki-text.ttl'), 'utf8');
  const command = 'fuseki:endpoint [ fuseki:operation <https://rezics.com/fuseki/command> ; fuseki:name "command" ] ;';
  if (!source.includes(command)) throw new Error('product command endpoint moved');
  const configPath = join(directory, 'validation-shacl.ttl');
  const overridePath = join(directory, 'validation-shacl-compose.yaml');
  writeFileSync(configPath, source.replace(command,
    `${command}\n    fuseki:endpoint [ fuseki:operation fuseki:shacl ; fuseki:name "shacl" ] ;`));
  writeFileSync(overridePath, `services:\n  fuseki:\n    command: ["/opt/apache-jena-fuseki-6.2.0/fuseki-server", "--port=3030", "--no-cors", "--timeout=10000", "--config=/fuseki/validation-shacl.ttl"]\n    volumes:\n      - ${JSON.stringify(`${configPath}:/fuseki/validation-shacl.ttl:ro,Z`)}\n`);
  const saved = readEnv(join(directory, 'compose.env'));
  const result = spawnSync('docker', ['compose', '--env-file', join(directory, 'compose.env'),
    '-f', join(root, 'infra/dev/compose.yaml'), '-f', overridePath, '--project-name', projectName(options),
    'up', '-d', '--no-deps', '--force-recreate', 'fuseki'], {
    cwd: root, env: composeProcessEnvironment(loadDockerEnvironment(), saved),
    encoding: 'utf8', timeout: 120_000, maxBuffer: 1_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`SHACL report service failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-3000)}`);
  }
  return { configPath, overridePath };
}

test('MODEL24: product Fuseki ingress rejects raw Update and Graph Store writes', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const runId = `validation-${randomUUID().slice(0, 12)}`;
  let generated: { configPath: string; overridePath: string } | undefined;
  try {
    // Persistent QA uses the product assembler; add only the documented report endpoint in this disposable project.
    stack('stack:up', runId);
    generated = installReportEndpoint(runId);
    const apps = readEnv(resolve(stackDirectory(root, { profile: 'qa', runId, persistent: true }), 'apps.env'));
    const base = new URL(apps.FUSEKI_URL!);
    const client = new FusekiClient(base.href, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { healthy = /^[0-9a-f]{64}$/.test((await client.commandHealth()).profiles['work-metadata-v1'] ?? ''); }
      catch { /* Fuseki is restarting with the temporary assembler. */ }
      if (healthy) break;
      await Bun.sleep(500);
    }
    expect(healthy).toBe(true);
    const shapes = `@prefix sh: <http://www.w3.org/ns/shacl#> .
      <urn:rezics:validation:shape> a sh:NodeShape ; sh:targetNode <urn:rezics:validation:focus> ;
        sh:property [ sh:path <https://rezics.com/vocab/required> ; sh:minCount 1 ] .`;
    const report = await fetch(new URL('shacl?graph=default', base), {
      method: 'POST', headers: { 'content-type': 'text/turtle', accept: 'text/turtle' }, body: shapes,
      signal: AbortSignal.timeout(10_000) });
    const reportBody = await report.text();
    if (report.status !== 200) console.error('SHACL report response', report.status, reportBody.slice(0, 1000));
    expect(report.status).toBe(200);
    expect(reportBody).toContain('false');
    const graph = `urn:rezics:validation-product:${randomUUID()}`;
    const triple = `<${graph}> <https://rezics.com/vocab/unsafe> "raw" .`;
    const update = await fetch(new URL('update', base), { method: 'POST',
      headers: { 'content-type': 'application/sparql-update' },
      body: `INSERT DATA { GRAPH <${graph}> { ${triple} } }`, signal: AbortSignal.timeout(10_000) });
    expect(update.status).toBe(404);
    const graphStore = await fetch(new URL(`data?graph=${encodeURIComponent(graph)}`, base), { method: 'PUT',
      headers: { 'content-type': 'text/turtle' }, body: triple, signal: AbortSignal.timeout(10_000) });
    expect([400, 404, 405]).toContain(graphStore.status);
    expect((await client.query(`ASK { GRAPH <${graph}> { ${triple} } }`)).boolean).toBe(false);
  } finally {
    stack('stack:reset', runId);
    if (generated) {
      rmSync(generated.configPath, { force: true });
      rmSync(generated.overridePath, { force: true });
    }
  }
}, 240_000);
