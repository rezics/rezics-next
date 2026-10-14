import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { context, trace } from '@opentelemetry/api';
import { fromPlainText } from '@rezics/document';
import type { QueryResult } from 'pg';
import type { CommandEnvelope, SparqlResult } from '../../../../../services/main/src/infrastructure/fuseki.ts';
import type { ZoneSitePublicationReceipt } from '../../../../../services/main/src/modules/zone/configuration.ts';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '../../../../../packages/observability/src/runtime.ts';
import { startWorkProfileSink, profileRequest } from '../../../support/work-profile.ts';

// Initialize the SDK before pg and Main load, so owner SQL joins the HTTP trace.
const sink = startWorkProfileSink();
startTelemetry('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main', OTEL_TRACES_SAMPLER_ARG: '1' });
const { Client } = await import('pg');
const { FusekiClient, fusekiReadBudget } = await import('../../../../../services/main/src/infrastructure/fuseki.ts');
interface Statement {
  text: string; started: number; elapsedMs?: number; command?: string;
  rowsReturned?: number; rowsAffected?: number; error?: string;
}
interface GraphStatement {
  method: 'query' | 'command'; input: string | CommandEnvelope; started: number;
  budget: { callsLeft: number; bytesLeft: number } | null;
  elapsedMs?: number; rowsReturned?: number; result?: unknown; error?: string;
}
let currentTrace = '', statements: Statement[] = [], graph: GraphStatement[] = [];
const selected = () => currentTrace !== '' && trace.getSpan(context.active())?.spanContext().traceId === currentTrace;
const originalQuery = Client.prototype.query;
Client.prototype.query = function (this: InstanceType<typeof Client>, ...args: unknown[]) {
  if (!selected()) return Reflect.apply(originalQuery, this, args);
  const input = args[0] as string | { text: string };
  const record: Statement = { text: typeof input === 'string' ? input : input.text, started: performance.now() };
  statements.push(record);
  const complete = (error: unknown, result?: QueryResult) => Object.assign(record, {
    elapsedMs: performance.now() - record.started, command: result?.command,
    rowsReturned: result?.rows.length ?? 0, rowsAffected: result?.rowCount ?? 0,
    ...(error ? { error: error instanceof Error ? error.stack : String(error) } : {}),
  });
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    args[args.length - 1] = (error: unknown, result: QueryResult) => {
      complete(error, result); return Reflect.apply(callback, undefined, [error, result]);
    };
    return Reflect.apply(originalQuery, this, args);
  }
  const pending = Reflect.apply(originalQuery, this, args) as Promise<QueryResult>;
  return pending.then(result => { complete(null, result); return result; },
    (error: unknown) => { complete(error); throw error; });
} as typeof originalQuery;
const originalGraphQuery = FusekiClient.prototype.query;
const originalCommand = FusekiClient.prototype.command;
for (const method of ['query', 'command'] as const) {
  const original = FusekiClient.prototype[method];
  const observed = async function (this: InstanceType<typeof FusekiClient>, ...args: unknown[]) {
    if (!selected()) return Reflect.apply(original, this, args);
    const budget = fusekiReadBudget.getStore();
    const record: GraphStatement = { method, input: args[0] as string | CommandEnvelope,
      budget: budget ? { callsLeft: budget.callsLeft, bytesLeft: budget.bytesLeft } : null, started: performance.now() };
    graph.push(record);
    try {
      const result: unknown = await Reflect.apply(original, this, args);
      Object.assign(record, { elapsedMs: performance.now() - record.started,
        rowsReturned: (result as SparqlResult)?.results?.bindings?.length ?? 0, result });
      return result;
    } catch (error) {
      Object.assign(record, { elapsedMs: performance.now() - record.started,
        error: error instanceof Error ? error.stack : String(error) });
      throw error;
    }
  };
  if (method === 'query') FusekiClient.prototype.query = observed as typeof originalGraphQuery;
  else FusekiClient.prototype.command = observed as typeof originalCommand;
}
const { personaSessions } = await import('../../../support/personas.ts');
let sessions: Awaited<ReturnType<typeof personaSessions>> | undefined;
afterAll(async () => {
  try { await sessions?.close(); }
  finally {
    Client.prototype.query = originalQuery;
    FusekiClient.prototype.query = originalGraphQuery;
    FusekiClient.prototype.command = originalCommand;
    try { await shutdownTelemetry(); } finally { await sink.stop(); }
  }
});
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const phase = process.env.ZONE_PUBLICATION_COST_PHASE ?? 'after';
const artifact = (name: string) => `.temp/site-publication-cost/${process.env.REZICS_QA_RUN_ID}-${phase}-${name}.json`;
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, body = await response.text();
  expect(response.status, body).toBe(status); return JSON.parse(body) as T;
}

test('publication instrumentation counts actual driver rows and excludes other traces', async () => {
  const client = new Client({ connectionString: process.env.ACCESS_DATABASE_URL });
  await client.connect();
  statements = []; graph = [];
  try {
    await trace.getTracer('publication-cost').startActiveSpan('calibration', async span => {
      currentTrace = span.spanContext().traceId;
      try {
        await client.query('BEGIN');
        const result = await client.query('SELECT * FROM (VALUES (1), (2)) AS calibration(value)');
        expect(result.rows).toHaveLength(2);
        await client.query('ROLLBACK');
        const rows = await new FusekiClient(process.env.FUSEKI_URL!).query('SELECT ?value WHERE { VALUES ?value { 1 2 } }');
        expect(rows.results?.bindings).toHaveLength(2);
      } finally { currentTrace = ''; span.end(); }
    });
    await client.query('SELECT 3');
    expect(statements).toHaveLength(3);
    expect(statements.map(statement => statement.rowsReturned)).toEqual([0, 2, 0]);
    expect(statements.map(statement => statement.rowsAffected)).toEqual([0, 2, 0]);
    expect(graph).toHaveLength(1);
    expect(graph[0]?.rowsReturned).toBe(2);
    expect([...statements, ...graph].every(statement => statement.elapsedMs !== undefined && !statement.error)).toBe(true);
    await Bun.write(artifact('instrumentation'), JSON.stringify({ source, statements, graph }, null, 2));
  } finally { await client.end(); }
});

type Page = { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string };
type Draft = { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } };
type Created = { zone: string; zoneRevision: string; navigationRevision: string };

test('equivalent admitted 8, 16 and 32 page publications complete with exact receipts and bounded costs', async () => {
  const started = performance.now();
  sessions = await personaSessions('public');
  const owner = sessions.owner, results: Array<{ count: number; status: number }> = [];
  for (const count of [8, 16, 32]) {
    const prepStarted = performance.now();
    const created = await answer<Created>(owner.main('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Publication cost',
      language: 'en', visibility: 'public', capabilities: ['zone'], actingSubject: owner.actingSubject }), 201);
    const path = `/v1/zones/${created.zone.slice(-36)}`;
    const prepared = await answer<{ revision: string }>(owner.main('PUT', `${path}/configuration`, {
      expectedHead: created.zoneRevision, prepareHomeDocument: true, actingSubject: owner.actingSubject }));
    const configuration = await answer<{ configuration: { homeDocument: string } }>(owner.main('GET',
      `${path}/configuration?actingSubject=${encodeURIComponent(owner.actingSubject!)}`));
    const pages: Page[] = [], drafts = [];
    for (let index = 0; index < count; index += 4) {
      const saved = await Promise.all(Array.from({ length: 4 }, async (_, offset) => {
        const body = { profile: 'content-text-v1', resourceId: configuration.configuration.homeDocument,
          variantId: `urn:rezics:variant:${randomUUID()}`, expectedHead: null,
          document: fromPlainText(`Publication cost page ${index + offset}`, 'blocks'),
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: owner.actingSubject };
        const response = await answer<Draft>(owner.main('POST', '/v1/content-drafts', body), 201);
        return { body, response };
      }));
      drafts.push(...saved);
      pages.push(...saved.map(({ body, response }) => ({ page: body.resourceId, variantId: body.variantId,
        revisionId: response.revisionId, byteDigest: response.byteDigest, contentEpoch: response.sourcePosition.dataEpoch })));
    }
    const preparationMs = performance.now() - prepStarted;
    const body = { expectedHead: prepared.revision, actingSubject: owner.actingSubject,
      routesRevision: created.navigationRevision, navigationRevision: created.navigationRevision, pages };
    const key = randomUUID(); statements = []; graph = [];
    const measured = await profileRequest(sink, async headers => {
      currentTrace = headers.get('traceparent')!.split('-')[1]!;
      try {
        const response = await owner.main('POST', `${path}/site-publications`, body, key,
          { headers: { traceparent: headers.get('traceparent')! }, settle: false });
        return { status: response.status, body: await response.json() as ZoneSitePublicationReceipt };
      } finally { currentTrace = ''; }
    }, { service: 'main', flush: flushTelemetryTraces });
    const totals = { sqlStatements: statements.length,
      sqlRowsReturned: statements.reduce((n, statement) => n + (statement.rowsReturned ?? 0), 0),
      sqlRowsWritten: statements.filter(statement => ['INSERT', 'UPDATE', 'DELETE'].includes(statement.command ?? ''))
        .reduce((n, statement) => n + (statement.rowsAffected ?? 0), 0),
      graphReads: graph.filter(statement => statement.method === 'query' && !statement.error).length,
      graphRowsReturned: graph.reduce((n, statement) => n + (statement.rowsReturned ?? 0), 0),
      nativeWork: measured.profile.nativeVisits };
    await Bun.write(artifact(String(count)), JSON.stringify({ phase, source, runId: process.env.REZICS_QA_RUN_ID,
      count, preparationMs, setupMs: sessions.elapsedSeconds * 1000, elapsedMs: measured.profile.totalLatencyMs,
      request: { method: 'POST', path: `${path}/site-publications`, key, body }, response: measured.result, drafts, totals,
      perPage: { sqlStatements: totals.sqlStatements / count, sqlRowsReturned: totals.sqlRowsReturned / count,
        sqlRowsWritten: totals.sqlRowsWritten / count, graphReads: totals.graphReads / count,
        graphRowsReturned: totals.graphRowsReturned / count }, statements, graph, profile: measured.profile }, null, 2));
    console.info(JSON.stringify({ phase, count, preparationMs, elapsedMs: measured.profile.totalLatencyMs,
      response: measured.result.status, totals }));
    // Retain a completed refusal at every scale before asserting the entire bound.
    expect(statements.length).toBeGreaterThan(0); expect(graph.length).toBeGreaterThan(0);
    expect(statements.every(statement => statement.elapsedMs !== undefined)).toBe(true);
    expect(measured.profile.postgresStatements).toBe(statements.length);
    expect([201, 422]).toContain(measured.result.status);
    if (measured.result.status === 201) {
      expect(measured.result.body.pages).toHaveLength(count);
      expect(measured.result.body.pages).toEqual(expect.arrayContaining(pages.map(({ contentEpoch: _epoch, ...page }) => ({
        ...page, language: 'en' }))));
      expect(measured.result.body.homeDocument).toBe(configuration.configuration.homeDocument);
      expect(graph.filter(statement => statement.method === 'command')).toHaveLength(1);
    }
    results.push({ count, status: measured.result.status });
  }
  expect(performance.now() - started).toBeLessThan(600_000);
  expect(results).toEqual([8, 16, 32].map(count => ({ count, status: 201 })));
}, 600_000);
