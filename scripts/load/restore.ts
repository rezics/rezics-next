import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { readEnv } from '../dev/config.ts';
import { runQaStartupChildAsync } from '../qa/stack-startup.ts';

const root = resolve(import.meta.dir, '../..');
const deadlineMs = 600_000;

export async function ownerReady(url: string, database: string): Promise<void> {
  const client = new Client({ connectionString: url,
    connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
  try {
    await client.connect();
    const result = await client.query<{ database: string }>('SELECT current_database() AS database');
    if (result.rows[0]?.database !== database) throw new Error(`${database} owner database differs`);
  } finally { await client.end().catch(() => undefined); }
}

/** Legacy path: clone a stopped command-seeded `load:prepare` baseline through stack:clone. */
export async function restoreLoadBaseline(source: string, target: string): Promise<void> {
  const started = Date.now();
  const artifacts = join(root, '.artifacts', 'fixture-restore', target);
  if (existsSync(artifacts)) throw new Error(`Fixture restore evidence already exists: ${target}`);
  mkdirSync(artifacts, { recursive: true });
  const evidence: Record<string, unknown> = { source, target, startedAt: new Date(started).toISOString(),
    deadlineMs };
  let failure: string | undefined;
  let admissionWaitMs = 0;
  try {
    const sourceRun = JSON.parse(readFileSync(join(root, '.artifacts', 'load', source, 'run.json'), 'utf8')) as {
      mode?: string; baselineDigest?: string; sourceStable?: boolean; failure?: string;
    };
    if (sourceRun.mode !== 'prepare' || sourceRun.failure || sourceRun.sourceStable !== true
      || !/^[0-9a-f]{64}$/.test(sourceRun.baselineDigest ?? '')) {
      throw new Error('Source is not a retained successful prepared fixture');
    }
    evidence.baselineDigest = sourceRun.baselineDigest;
    const cloned = await runQaStartupChildAsync(root, ['stack:clone', '--profile', 'qa', '--run-id', source,
      '--persistent', '--to-run-id', target], 560_000);
    admissionWaitMs = cloned.admissionWaitMs;
    writeFileSync(join(artifacts, 'clone.log'),
      [cloned.stdout, cloned.stderr, cloned.error?.message].filter(Boolean).join('\n'));
    if (cloned.error || cloned.status !== 0) throw new Error('Physical fixture clone failed; see clone.log');
    evidence.cloneMs = Date.now() - started - admissionWaitMs;
    const apps = readEnv(join(root, '.temp', 'stack', `rezics-qa-${target}`, 'apps.env'));
    for (const [key, database] of [
      ['ACCOUNT_DATABASE_URL', 'account'], ['ACCESS_DATABASE_URL', 'access'],
      ['CONTENT_DATABASE_URL', 'content'], ['ACCOUNT_RELAY_DATABASE_URL', 'relay'],
    ] as const) await ownerReady(apps[key]!, database);
    const graph = await fetch(new URL('query', apps.FUSEKI_URL), {
      method: 'POST', headers: { 'content-type': 'application/sparql-query',
        accept: 'application/sparql-results+json' },
      body: 'SELECT (1 AS ?ready) WHERE {}', signal: AbortSignal.timeout(5_000),
    });
    if (!graph.ok) throw new Error(`Fixture graph readiness returned ${graph.status}`);
    const result = await graph.json() as { results?: { bindings?: Array<{ ready?: { value?: string } }> } };
    if (result.results?.bindings?.[0]?.ready?.value !== '1') {
      throw new Error('Fixture graph readiness query differs');
    }
    evidence.ready = ['account', 'access', 'content', 'relay', 'fuseki'];
    if (Date.now() - started - admissionWaitMs > deadlineMs) throw new Error('Fixture preparation exceeded 600 seconds');
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  evidence.elapsedMs = Date.now() - started - admissionWaitMs;
  evidence.admissionWaitMs = admissionWaitMs;
  evidence.completedAt = new Date().toISOString();
  if (failure) evidence.failure = failure;
  writeFileSync(join(artifacts, 'run.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Fixture restore artifacts: ${artifacts}`);
  if (failure) throw new Error(failure);
}
