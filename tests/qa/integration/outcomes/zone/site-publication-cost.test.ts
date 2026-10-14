import { afterAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { context, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { fromPlainText } from '@rezics/document';
import type { QueryResult } from 'pg';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '../../../../../packages/observability/src/runtime.ts';
import { startWorkProfileSink, summarizeWorkProfile } from '../../../support/work-profile.ts';
import { runWorkProfileChild } from '../../../support/work-profile-child.ts';

// The helper executes this entry as a script. Replace that process with Bun's
// test context because persona support owns test hooks; no extra child or
// detached process survives the helper's deadline and reaping boundary.
if (process.env.REZICS_ZONE_COST_CHILD === 'entry') {
  if (!process.execve) throw new Error('Work profile entry requires process.execve');
  process.execve(process.execPath, [process.execPath, 'test', import.meta.path], {
    ...process.env, REZICS_ZONE_COST_CHILD: 'measure',
  });
}

if (process.env.REZICS_ZONE_COST_CHILD === 'measure') {
  if (!process.env.REZICS_QA_RUN_ID || !process.env.REZICS_WORK_PROFILE_RESULT)
    throw new Error('Run publication costs through the admitted profile child');
  const completedChecks: string[] = [];
  // Initialize the SDK before pg and Main load, so owner SQL joins the HTTP trace.
  const sink = startWorkProfileSink();
  startTelemetry('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main', OTEL_TRACES_SAMPLER_ARG: '1',
    MAIN_ORIGIN: `http://127.0.0.1:${process.env.MAIN_PORT}`,
    ACCOUNT_ORIGIN: `http://127.0.0.1:${process.env.ACCOUNT_PORT}` });
  const { Client } = await import('pg');
  const { FusekiClient, fusekiReadBudget } = await import('../../../../../services/main/src/infrastructure/fuseki.ts');
  type CommandEnvelope = Parameters<typeof FusekiClient.prototype.command>[0];
  type SparqlResult = Awaited<ReturnType<typeof FusekiClient.prototype.query>>;
  interface Statement {
    text: string; started: number; originSpanId: string; elapsedMs?: number;
    results?: Array<{ command: string; rowsReturned: number; rowsAffected: number | null }>;
    error?: string;
  }
  interface GraphStatement {
    method: 'query' | 'command'; input: string | CommandEnvelope; started: number;
    originSpanId: string;
    budget: { callsLeft: number; bytesLeft: number } | null;
    elapsedMs?: number; rowsReturned?: number; result?: unknown; error?: string;
  }
  let currentTrace = '', statements: Statement[] = [], graph: GraphStatement[] = [];
  const selected = () => currentTrace !== '' && trace.getSpan(context.active())?.spanContext().traceId === currentTrace;
  const originalQuery = Client.prototype.query;
  Client.prototype.query = function (this: InstanceType<typeof Client>, ...args: unknown[]) {
    if (!selected()) return Reflect.apply(originalQuery, this, args);
    const input = args[0] as string | { text: string };
    const record: Statement = { text: typeof input === 'string' ? input : input.text, started: performance.now(),
      originSpanId: trace.getSpan(context.active())!.spanContext().spanId };
    statements.push(record);
    const complete = (error: unknown, result?: QueryResult | QueryResult[]) => Object.assign(record, {
      elapsedMs: performance.now() - record.started,
      ...(result ? { results: (Array.isArray(result) ? result : [result]).map(part => ({
        command: part.command, rowsReturned: part.rows.length, rowsAffected: part.rowCount })) } : {}),
      ...(error ? { error: error instanceof Error ? error.stack : String(error) } : {}),
    });
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      args[args.length - 1] = (error: unknown, result: QueryResult | QueryResult[]) => {
        complete(error, result); return Reflect.apply(callback, undefined, [error, result]);
      };
      return Reflect.apply(originalQuery, this, args);
    }
    const pending = Reflect.apply(originalQuery, this, args) as Promise<QueryResult | QueryResult[]>;
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
        originSpanId: trace.getSpan(context.active())!.spanContext().spanId,
        budget: budget ? { callsLeft: budget.callsLeft, bytesLeft: budget.bytesLeft } : null, started: performance.now() };
      graph.push(record);
      try {
        const result: unknown = await Reflect.apply(original, this, args);
        const wire = result as SparqlResult;
        Object.assign(record, { elapsedMs: performance.now() - record.started, result,
          ...(wire.results?.bindings ? { rowsReturned: wire.results.bindings.length }
            : typeof wire.boolean === 'boolean' ? { rowsReturned: 0 } : {}) });
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
  let httpBoundaryQualified = false;
  afterAll(async () => {
    try { await sessions?.close(); }
    finally {
      Client.prototype.query = originalQuery;
      FusekiClient.prototype.query = originalGraphQuery;
      FusekiClient.prototype.command = originalCommand;
      try { await shutdownTelemetry(); } finally { await sink.stop(); }
      await Bun.write(process.env.REZICS_WORK_PROFILE_RESULT!, JSON.stringify({
        source, runId: process.env.REZICS_QA_RUN_ID, phase, pid: process.pid,
        completedChecks, httpBoundaryQualified,
      }, null, 2));
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
      expect(statements.map(statement => statement.results?.[0]?.rowsReturned)).toEqual([0, 2, 0]);
      expect(statements.map(statement => statement.results?.[0]?.rowsAffected)).toEqual([null, 2, null]);
      expect(graph).toHaveLength(1);
      expect(graph[0]?.rowsReturned).toBe(2);
      expect([...statements, ...graph].every(statement => statement.elapsedMs !== undefined && !statement.error)).toBe(true);
      await Bun.write(artifact('instrumentation'), JSON.stringify({ source, statements, graph }, null, 2));
      completedChecks.push('driver-calibration');
    } finally { await client.end(); }
  });

  type Page = { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string };
  // The HTTP fields asserted here belong to the public receipt, not its owner implementation.
  type Receipt = { revision: string; homeDocument: string; pages: Array<Omit<Page, 'contentEpoch'> & { language: string }> };
  type Draft = { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } };
  type Created = { zone: string; zoneRevision: string; navigationRevision: string };

  /** Follow the real HTTP client/server relationship, rather than assuming fetch
   * preserves a supplied header's parent while it starts its own client span. */
  async function measureHttp(name: string, request: { method: string; path: string; key?: string; body?: unknown },
    preparation: unknown, unrelated?: () => Promise<void>) {
    const traceId = randomBytes(16).toString('hex'), callerSpanId = randomBytes(8).toString('hex');
    const caller = trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId: callerSpanId,
      traceFlags: TraceFlags.SAMPLED, isRemote: true });
    statements = []; graph = []; currentTrace = traceId;
    const started = performance.now();
    const packet = { source, runId: process.env.REZICS_QA_RUN_ID, phase, traceId, callerSpanId, request, preparation };
    await Bun.write(artifact(`${name}-request`), JSON.stringify(packet, null, 2));
    let status: number, rawBody: string, elapsedMs: number;
    try {
      const response = await context.with(caller, async () => {
        const pending = sessions!.owner.main(request.method, request.path, request.body, request.key, { settle: false });
        await unrelated?.();
        return pending;
      });
      rawBody = await response.text(); status = response.status; elapsedMs = performance.now() - started;
      // This durable raw packet precedes JSON decoding and all collection work.
      await Bun.write(artifact(`${name}-response`), JSON.stringify({ ...packet, elapsedMs,
        response: { status, rawBody }, availableObservations: { statements, graph } }, null, 2));
    } catch (error) {
      await Bun.write(artifact(`${name}-request-error`), JSON.stringify({ ...packet,
        elapsedMs: performance.now() - started, error: error instanceof Error ? error.stack : String(error),
        availableObservations: { statements, graph } }, null, 2));
      throw error;
    } finally { currentTrace = ''; }
    try {
      await flushTelemetryTraces();
      const snapshot = sink.snapshot().filter(span => span.traceId === traceId);
      const clients = snapshot.filter(span => span.kind === 2 && span.parentSpanId === callerSpanId
        && span.attributes['rezics.peer.service'] === 'main'
        && span.attributes['http.request.method'] === request.method);
      expect(clients).toHaveLength(1);
      const parent = clients[0]!.spanId;
      const exported = await sink.collect(traceId, parent);
      const profile = summarizeWorkProfile(exported, traceId, parent, elapsedMs, { service: 'main' });
      const included = new Set(profile.spans.map(span => span.spanId));
      const ownedStatements = statements.filter(statement => included.has(statement.originSpanId));
      const ownedGraph = graph.filter(statement => included.has(statement.originSpanId));
      const excludedStatements = statements.filter(statement => !included.has(statement.originSpanId));
      await Bun.write(artifact(`${name}-profile`), JSON.stringify({ ...packet, elapsedMs, response: { status, rawBody },
        statements: ownedStatements, graph: ownedGraph, excludedStatements, profile, exported }, null, 2));
      expect(profile.request.status).toBe(status);
      expect(profile.postgresStatements).toBe(ownedStatements.length);
      expect(ownedStatements.length).toBeGreaterThan(0);
      expect(ownedGraph.length).toBeGreaterThan(0);
      expect(ownedStatements.every(statement => statement.elapsedMs !== undefined)).toBe(true);
      expect(profile.spans.every(span => span.traceId === traceId)).toBe(true);
      return { status, rawBody, elapsedMs, profile, statements: ownedStatements, graph: ownedGraph, excludedStatements };
    } catch (error) {
      await Bun.write(artifact(`${name}-collection-error`), JSON.stringify({ ...packet, elapsedMs,
        response: { status, rawBody }, error: error instanceof Error ? error.stack : String(error),
        availableObservations: { statements, graph }, exported: sink.snapshot() }, null, 2));
      throw error;
    } finally { sink.release(traceId); }
  }

  test('HTTP publication observation follows Main and excludes sibling and unrelated owner SQL', async () => {
    let setupRequest = 0;
    sessions = await personaSessions('public', { observeMain: async observed => {
      // Setup may fail before measureHttp exists. Retain the real caller packet
      // through the fixture's passive observer, without retrying its request.
      await Bun.write(artifact(`setup-${++setupRequest}`), JSON.stringify({ source,
        runId: process.env.REZICS_QA_RUN_ID, phase, request: observed.request,
        response: { status: observed.response.status, rawBody: observed.response.body },
        requestStartedAt: observed.requestStartedAt, answeredAt: observed.answeredAt,
        elapsedMs: observed.answeredAt - observed.requestStartedAt }, null, 2));
    } });
    const client = new Client({ connectionString: process.env.ACCESS_DATABASE_URL });
    await client.connect();
    try {
      const path = `/v1/zones/${sessions.zone.slice(-36)}/configuration?actingSubject=${encodeURIComponent(sessions.owner.actingSubject!)}`;
      const measured = await measureHttp('http-boundary', { method: 'GET', path }, { setupSeconds: sessions.elapsedSeconds }, async () => {
        expect((await client.query('SELECT 909 AS publication_cost_sibling')).rows).toEqual([{ publication_cost_sibling: 909 }]);
        await context.with(ROOT_CONTEXT, () => trace.getTracer('publication-cost').startActiveSpan('unrelated-owner', async span => {
          try { expect((await client.query('SELECT 808 AS publication_cost_unrelated')).rows).toEqual([{ publication_cost_unrelated: 808 }]); }
          finally { span.end(); }
        }));
      });
      expect(measured.status, measured.rawBody).toBe(200);
      expect(measured.profile.request.route).toContain('configuration');
      expect(measured.excludedStatements.map(statement => statement.text)).toEqual(['SELECT 909 AS publication_cost_sibling']);
      expect(measured.statements.some(statement => statement.text.includes('publication_cost_'))).toBe(false);
      expect(measured.profile.unclassifiedFetches).toBe(0);
      httpBoundaryQualified = true;
      completedChecks.push('http-ancestry-and-exclusions');
    } finally { await client.end(); }
  }, 180_000);

  test('equivalent admitted 8, 16 and 32 page publications complete with exact receipts and bounded costs', async () => {
    const started = performance.now();
    expect(sessions).toBeDefined();
    expect(httpBoundaryQualified).toBe(true);
    const owner = sessions!.owner, results: Array<{ count: number; status: number }> = [];
    const siteStarted = performance.now();
    // Persona setup uses two of the creator's three monthly Space admissions.
    // Publication scaling reuses one lawfully created Zone, not another quota.
    const created = await answer<Created>(owner.main('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Publication cost',
      language: 'en', visibility: 'public', capabilities: ['zone'], actingSubject: owner.actingSubject }), 201);
    const path = `/v1/zones/${created.zone.slice(-36)}`;
    const prepared = await answer<{ revision: string }>(owner.main('PUT', `${path}/configuration`, {
      expectedHead: created.zoneRevision, prepareHomeDocument: true, actingSubject: owner.actingSubject }));
    const configuration = await answer<{ configuration: { homeDocument: string } }>(owner.main('GET',
      `${path}/configuration?actingSubject=${encodeURIComponent(owner.actingSubject!)}`));
    const sitePreparationMs = performance.now() - siteStarted;
    let expectedHead = prepared.revision, priorPageCount = 0;
    for (const count of [8, 16, 32]) {
      const prepStarted = performance.now();
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
      const body = { expectedHead, actingSubject: owner.actingSubject,
        routesRevision: created.navigationRevision, navigationRevision: created.navigationRevision, pages };
      const key = randomUUID();
      const measured = await measureHttp(String(count), { method: 'POST', path: `${path}/site-publications`, key, body },
        { preparationMs, sitePreparationMs, setupMs: sessions!.elapsedSeconds * 1000, priorPageCount, drafts });
      const sql = measured.statements, graphReads = measured.graph.filter(statement => statement.method === 'query');
      const sqlResults = sql.flatMap(statement => statement.results ?? []);
      const writes = sqlResults.filter(result => ['INSERT', 'UPDATE', 'DELETE'].includes(result.command));
      const totals = { sqlDriverCalls: sql.length, sqlStatements: sql.every(statement => statement.results !== undefined) ? sqlResults.length : null,
        sqlRowsReturned: sql.every(statement => statement.results !== undefined) ? sqlResults.reduce((n, result) => n + result.rowsReturned, 0) : null,
        sqlRowsWritten: sql.every(statement => statement.results !== undefined) && writes.every(result => result.rowsAffected !== null)
          ? writes.reduce((n, result) => n + result.rowsAffected!, 0) : null,
        graphReads: graphReads.filter(statement => !statement.error).length, graphReadAttempts: graphReads.length,
        graphRowsReturned: graphReads.every(statement => statement.rowsReturned !== undefined)
          ? graphReads.reduce((n, statement) => n + statement.rowsReturned!, 0) : null,
        nativeWork: measured.profile.nativeVisits };
      const responseBody = JSON.parse(measured.rawBody) as Receipt;
      await Bun.write(artifact(String(count)), JSON.stringify({ phase, source, runId: process.env.REZICS_QA_RUN_ID,
        count, preparationMs, sitePreparationMs, priorPageCount,
        setupMs: sessions!.elapsedSeconds * 1000, elapsedMs: measured.elapsedMs,
        request: { method: 'POST', path: `${path}/site-publications`, key, body },
        response: { status: measured.status, rawBody: measured.rawBody, body: responseBody }, drafts, totals,
        perPage: Object.fromEntries(Object.entries(totals).filter(([, value]) => typeof value === 'number' || value === null)
          .map(([name, value]) => [name, typeof value === 'number' ? value / count : null])),
        statements: sql, graph: measured.graph, profile: measured.profile }, null, 2));
      console.info(JSON.stringify({ phase, count, preparationMs, elapsedMs: measured.elapsedMs, response: measured.status, totals }));
      // Retain a completed refusal at every scale before asserting the entire bound.
      expect([201, 422], measured.rawBody).toContain(measured.status);
      if (measured.status === 201) {
        // The measured 32-page command is linear. These operation-specific
        // ceilings catch repeated whole-receipt/owner reads without widening any
        // production budget. They include cold first-publication overhead.
        expect(totals.sqlDriverCalls).toBeLessThanOrEqual(150 + 76 * count);
        expect(totals.sqlStatements).not.toBeNull();
        expect(totals.sqlStatements!).toBeLessThanOrEqual(150 + 80 * count);
        expect(totals.sqlRowsReturned).not.toBeNull();
        expect(totals.sqlRowsReturned!).toBeLessThanOrEqual(85 + 46 * count);
        expect(totals.sqlRowsWritten).not.toBeNull();
        expect(totals.sqlRowsWritten!).toBeLessThanOrEqual(16 + 5 * count);
        expect(totals.graphReadAttempts).toBe(totals.graphReads);
        expect(totals.graphReads).toBeLessThanOrEqual(12 + 5 * count);
        expect(totals.graphRowsReturned).not.toBeNull();
        expect(totals.graphRowsReturned!).toBeLessThanOrEqual(6 + 5 * count);
        expect(measured.profile.nativeVisits.durable_commits).toBe(1);
        expect(measured.profile.nativeVisits.revisions_adds).toBeLessThanOrEqual(27 + 10 * count);
        const receipts = measured.graph.filter(statement => statement.method === 'query'
          && typeof statement.input === 'string' && statement.input.includes('SELECT ?zone ?revision'));
        const pins = receipts.filter(statement => typeof statement.input === 'string' && statement.input.includes('FILTER(?page ='));
        expect(pins).toHaveLength(count);
        expect(pins.every(statement => statement.rowsReturned === 1)).toBe(true);
        const bundles = receipts.filter(statement => !pins.includes(statement));
        expect(bundles).toHaveLength(1);
        expect(bundles[0]?.rowsReturned).toBe(count);
        expect(responseBody.pages).toHaveLength(count);
        expect(responseBody.pages).toEqual(expect.arrayContaining(pages.map(({ contentEpoch: _epoch, ...page }) => ({
          ...page, language: 'en' }))));
        expect(responseBody.homeDocument).toBe(configuration.configuration.homeDocument);
        expect(measured.graph.filter(statement => statement.method === 'command')).toHaveLength(1);
        expectedHead = responseBody.revision;
        priorPageCount = count;
      }
      results.push({ count, status: measured.status });
    }
    expect(performance.now() - started).toBeLessThan(600_000);
    expect(results).toEqual([8, 16, 32].map(count => ({ count, status: 201 })));
    completedChecks.push('exact-receipts-and-linear-8-16-32-costs');
  }, 600_000);

} else {
  test('publication profile owns its telemetry after another Main fixture lifecycle', async () => {
    const started = performance.now();
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const phase = process.env.ZONE_PUBLICATION_COST_PHASE ?? 'after';
    const prefix = `.temp/site-publication-cost/${process.env.REZICS_QA_RUN_ID}-${phase}-combined-lifetime`;
    const { personaSessions } = await import('../../../support/personas.ts');
    let setupRequest = 0;
    // Reproduce the combined-use premise: Main and its drivers were loaded and
    // a real fixture was closed before the cost SDK starts. The SDK belongs to
    // the isolated process, so prior files cannot determine its lifetime.
    const prior = await personaSessions('public', { observeMain: async observed => {
      await Bun.write(`${prefix}-setup-${++setupRequest}.json`, JSON.stringify({ source,
        runId: process.env.REZICS_QA_RUN_ID, phase, request: observed.request,
        response: { status: observed.response.status, rawBody: observed.response.body },
        requestStartedAt: observed.requestStartedAt, answeredAt: observed.answeredAt,
        elapsedMs: observed.answeredAt - observed.requestStartedAt }, null, 2));
    } });
    try {
      const path = `/v1/zones/${prior.zone.slice(-36)}/configuration?actingSubject=${encodeURIComponent(prior.owner.actingSubject!)}`;
      const response = await prior.owner.main('GET', path);
      const rawBody = await response.text();
      await Bun.write(`${prefix}-response.json`, JSON.stringify({ source,
        runId: process.env.REZICS_QA_RUN_ID, phase, pid: process.pid,
        request: { method: 'GET', path }, response: { status: response.status, rawBody },
        elapsedMs: performance.now() - started }, null, 2));
      expect(response.status, rawBody).toBe(200);
    } finally { await prior.close(); }
    const { resultPath, stdout } = await runWorkProfileChild(import.meta.path, {
      env: { REZICS_ZONE_COST_CHILD: 'entry' },
      timeoutMs: 600_000 - (performance.now() - started) - 5_000,
    });
    console.info('Publication cost isolated process', resultPath, stdout);
    const result = await Bun.file(resultPath).json() as {
      source: string; pid: number; completedChecks: string[]; httpBoundaryQualified: boolean;
    };
    expect(result.source).toBe(source);
    expect(result.pid).not.toBe(process.pid);
    expect(result.httpBoundaryQualified).toBe(true);
    expect(result.completedChecks).toEqual(['driver-calibration', 'http-ancestry-and-exclusions',
      'exact-receipts-and-linear-8-16-32-costs']);
    expect(performance.now() - started).toBeLessThan(600_000);
  }, 600_000);
}
