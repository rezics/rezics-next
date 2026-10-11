import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StatementSeek } from '../src/modules/statement/seek.ts';
import { acceptedStatementPattern } from '../src/modules/statement/subject-read.ts';
import { reconcileRetainedEmptyBatch } from '../src/modules/work/reconcile-restored.ts';
import { relayCoverage } from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';

const root = resolve(import.meta.dir, '../../..');

async function projectionQueries(through: number) {
  const queries: string[] = [];
  const client = { query: async (sql: string) => ({ rows: sql.includes('FROM access.statement_seek_coverage')
    ? [{ complete: true, through_sequence: String(through) }] : [] }), release() {} };
  const pool = { query: client.query, connect: async () => client } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'epoch' }, fuseki: { query: async (query: string) => {
    queries.push(query);
    if (query.includes('OutboxBatch')) {
      const sequences = query.match(/VALUES \?sequence \{\s*([^}]+)\}/)![1]!.trim().split(/\s+/);
      return { results: { bindings: sequences.map(value => ({ sequence: { value },
        batch: { value: `urn:rezics:test:batch:${value}` } })) } };
    }
    if (query.includes('SELECT ?sequence WHERE'))
      return { results: { bindings: [{ sequence: { value: '64' } }] } };
    return { results: { bindings: [] } };
  } } } as unknown as WorkActivationEnvironment;
  expect(await new StatementSeek(pool, env).projectOnce()).toBe(true);
  return queries.filter(query => query.includes('VALUES ?sequence'));
}

async function restoredBatchQuery() {
  const queries: string[] = [];
  const batches = Array.from({ length: 64 }, (_, i) => ({ sequence: String(i + 1),
    batch_id: `urn:rezics:test:batch:${i + 1}`, routing_epoch: 'routing', event_count: 0, actual_count: '0' }));
  const relayClient = { query: async (sql: string) => {
    if (sql.includes('FROM relay.checkpoint')) return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE,
      data_epoch: 'epoch', sequence: '64' }], rowCount: 1 };
    if (sql.includes('FROM relay.delivered_batch AS batch')) return { rows: batches, rowCount: 64 };
    if (sql.includes('SELECT batch_id, routing_epoch, event_count')) return { rows: [batches[63]], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }, release() {} };
  const relayPool = { query: relayClient.query, connect: async () => relayClient } as unknown as Pool;
  const coverage = await relayCoverage(relayPool, 'test');
  expect(coverage.eventDigest).toBe(createHash('sha256').digest('hex'));
  const accessClient = { query: async (sql: string) => ({ rows: sql.includes('SELECT open')
    ? [{ open: false }] : [] }), release() {} };
  const env = { lineage: { dataEpoch: 'restored', routingEpoch: 'routing' }, fuseki: {
    query: async (query: string) => {
      queries.push(query);
      if (query.includes('SELECT ?saved')) return { results: { bindings: [{ saved: { value: '64' } }] } };
      if (query.includes('SELECT ?cursor')) return { results: { bindings: [{ cursor: { value: '64' } }] } };
      if (query.includes('OutboxBatch')) return { results: { bindings: [{
        batch: { value: batches[63]!.batch_id }, count: { value: '0' },
      }] } };
      throw new Error('Unexpected restore query');
    },
  } } as unknown as WorkActivationEnvironment;
  expect(await reconcileRetainedEmptyBatch(env, { connect: async () => accessClient } as unknown as Pool,
    relayPool, coverage, '64')).toEqual({ batchId: batches[63]!.batch_id, replayed: true });
  return queries.find(query => query.includes('OutboxBatch'))!;
}

function sequenceFirst(query: string, subject: string, type: string, sequence: string) {
  const lookup = query.indexOf(`${subject} rv:sequence ${sequence}`);
  const constraint = query.indexOf(`${subject} a rv:${type}`);
  expect(lookup).toBeGreaterThanOrEqual(0);
  expect(constraint).toBeGreaterThan(lookup);
}

test('audited bounded lookups bind sequence or identity before checking type', async () => {
  for (const through of [63, 62]) {
    const queries = await projectionQueries(through);
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query).toContain(`VALUES ?sequence { ${through === 63 ? '64' : '63 64'} }`);
      expect(query).toContain('rv:dataEpoch "epoch"');
    }
    sequenceFirst(queries[0]!, '?batch', 'OutboxBatch', '?sequence');
    sequenceFirst(queries[1]!, '?revision', 'StatementRevision', '?sequence');
    sequenceFirst(queries[2]!, '?revision', 'SemanticRevision', '?sequence');
  }
  sequenceFirst(await restoredBatchQuery(), '?batch', 'OutboxBatch', '64');
  const acceptance = acceptedStatementPattern('https://rezics.com/id/00000000-0000-4000-8000-000000000001', true);
  expect(acceptance).toMatch(/\?blockingSlot rv:decisionTarget \?decisionTarget\s*;[\s\S]*?a rv:DecisionSlot/);
  // These private query templates are also guarded at their authored identity
  // joins; the projection queries above are captured from real owner calls.
  const subject = readFileSync(join(root, 'services/main/src/modules/statement/subject-read.ts'), 'utf8');
  expect(subject).toMatch(/\?statement rdf:subject \$\{iri\(resource\)\}[^}]*?a rdf:Statement/);
  const conversion = readFileSync(join(root, 'services/main/src/modules/statement/populated-conversion.ts'), 'utf8');
  expect(conversion).toContain('?revision rv:component ?statement ; a rv:StatementRevision');
  expect(conversion).toMatch(/\?decision rv:convertedFrom \$\{iri\(head\)\}\s*;[^\n]*?a rv:StatementDecision/);
});

test('native Jena sequence lookups visit the same batches at N and 16N', async () => {
  const artifacts = join(root, '.temp', `statement-outbox-lookup-${randomUUID()}`);
  const build = join(artifacts, 'build');
  const tests = 'src/test/java/com/rezics/jena';
  mkdirSync(join(build, tests), { recursive: true });
  mkdirSync(join(build, 'tmp'));
  mkdirSync(join(build, 'queries'));
  const module = join(root, 'infra/jena/command-module');
  cpSync(join(module, 'pom.xml'), join(build, 'pom.xml'));
  cpSync(join(module, tests, 'StatementOutboxLookupTest.java'), join(build, tests, 'StatementOutboxLookupTest.java'));
  for (const through of [63, 62]) {
    const queries = await projectionQueries(through);
    for (const [index, query] of queries.entries())
      writeFileSync(join(build, 'queries', `projection-${through}-${index}.rq`), query);
  }
  writeFileSync(join(build, 'queries', 'restored.rq'), await restoredBatchQuery());
  const image = /^FROM (\S+) AS module$/m.exec(readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'))?.[1];
  if (!image) throw new Error('Missing pinned native builder');
  const cache = join(root, '.temp/statement-outbox-lookup-maven-cache');
  mkdirSync(cache, { recursive: true });
  const child = Bun.spawn(['docker', 'run', '--rm', '--name', `statement-outbox-lookup-${randomUUID()}`,
    '--user', `${process.getuid!()}:${process.getgid!()}`, '--memory', '1g', '--cpus', '2',
    '--volume', `${build}:/build`, '--volume', `${cache}:/maven-cache`, '--env', 'MAVEN_CONFIG=/maven-cache',
    '--env', 'MAVEN_OPTS=-Xmx128m', '--env', 'JAVA_TOOL_OPTIONS=-XX:+UseSerialGC -XX:ActiveProcessorCount=2 -Djava.io.tmpdir=/build/tmp',
    '--workdir', '/build', image, 'mvn', '-B', '-ntp', '-Dmaven.repo.local=/maven-cache',
    '-DargLine=-Xmx384m -Drezics.statement.seek.queries=/build/queries', '-Dtest=StatementOutboxLookupTest', 'test'],
  { cwd: root, env: loadDockerEnvironment(), stdout: 'pipe', stderr: 'pipe', timeout: 240_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(),
    new Response(child.stderr).text(), child.exited]);
  writeFileSync(join(artifacts, 'native.log'), `${stdout}\n${stderr}`);
  expect(code, `Native evidence: ${join(artifacts, 'native.log')}`).toBe(0);
  expect(stdout).toMatch(/Tests run: \d+, Failures: 0, Errors: 0, Skipped: 0/);
  console.info(stdout.split('\n').filter(line => line.startsWith('Statement lookup ')).join('\n'));
}, 250_000);
