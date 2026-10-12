import { beforeAll, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commandCounters } from '../../../packages/observability/src/http-measurement.ts';
import {
  assertWorkCostAtScales, profileRequest, startWorkProfileSink,
  type WorkCostContract, type WorkCostField, type WorkProfile,
} from '../support/work-profile.ts';
import { runWorkProfileChild } from '../support/work-profile-child.ts';
import type { MediaStack } from './media-support.ts';
import type { RetainedSeedCut } from '../support/seed-checkpoints.ts';
import type { SearchContinuation } from '../../../services/main/src/modules/work/search-continuation.ts';

const phrase = 'Checkpoint selected text';
const pageSize = 2;
const requestCounters = [
  'mainCalls', 'fusekiRequests', 'fusekiSentBytes', 'fusekiReceivedBytes',
  'postgresStatements', 'accountCalls', 'otherFetches', 'unclassifiedFetches',
] as const satisfies readonly WorkCostField[];
const counters = [...requestCounters, ...commandCounters];
type CandidateRead = { rows: number; candidates: number; sentBytes: number };
type MeasuredProfile = WorkProfile & Record<(typeof commandCounters)[number], number> & {
  candidateRows: number; candidateCount: number; candidateReceivedBytes: number; responseBytes: number;
};
type Page = { httpStatus: number; complete?: boolean; relationComplete?: boolean; population: number; total: number;
  results: { work: string; mainVersion: string }[]; next: SearchContinuation | null };
type Evidence = { matchingWorks: number; restoreMs: number;
  first: MeasuredProfile; continuation: MeasuredProfile };

/** Project the request's existing native span counters into numeric verdict fields.
 * CommandWork initializes mutation counters, but emits visit keys sparsely.
 * A covered dictionary's absent visit key means zero; an absent dictionary fails.
 * Health GETs do not execute native commands or queries. */
function measuredProfile(profile: WorkProfile, read: CandidateRead, responseBytes: number): MeasuredProfile {
  const spans = profile.fusekiCalls.map(call => profile.spans.find(span => span.spanId === call.spanId)!);
  const native = spans.filter(span => span.attributes['http.request.method'] === 'POST');
  expect(native.length).toBeGreaterThan(0);
  for (const span of native) for (const sentinel of ['current_adds', 'durable_commits'])
    expect(Number.isSafeInteger(span.attributes[`rezics.fuseki.${sentinel}`])).toBe(true);
  const totals = Object.fromEntries(commandCounters.map(counter => [counter,
    native.reduce((sum, span) => {
      const value = span.attributes[`rezics.fuseki.${counter}`] ?? 0;
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value as number).toBeGreaterThanOrEqual(0);
      return sum + (value as number);
    }, 0),
  ])) as Record<(typeof commandCounters)[number], number>;
  // Match the observed query to its HTTP span by its exact SPARQL body size.
  // This excludes fixed health responses and the later hydration/facet reads.
  const calls = profile.fusekiCalls.filter(call => call.sentBytes === read.sentBytes);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.receivedBytes).toBeGreaterThan(0);
  return { ...profile, ...totals, candidateRows: read.rows, candidateCount: read.candidates,
    candidateReceivedBytes: calls[0]!.receivedBytes!, responseBytes };
}

async function profileRankedSearch() {
  const sink = startWorkProfileSink({ settleMs: 25 });
  const { startTelemetry, flushTelemetryTraces, shutdownTelemetry } =
    await import('../../../packages/observability/src/runtime.ts');
  // Instrument pg before loading either the application or restore driver.
  startTelemetry('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main' });
  const { startMediaStack } = await import('./media-support.ts');
  const { createCorpusBackupDriver } = await import('../../../scripts/load/corpus-backup-driver.ts');
  const { restoreWorkProfileCorpus } = await import('../../../scripts/load/work-profile-corpus.ts');
  const { root, stream, dockerEnvironment } = await import('../../../scripts/fixture/stack.ts');
  const { readRetainedSeed } = await import('../support/seed-checkpoints.ts');
  const { assertPublicContentSearchReady } = await import('../../../services/main/src/modules/content-publication/search.ts');
  const retained = readRetainedSeed();
  expect(retained.cuts.map(cut => cut.works.length)).toEqual([4, 16, 64]);
  const qaRunId = process.env.REZICS_QA_RUN_ID;
  if (!qaRunId) throw new Error('Run through goalctl integration QA');
  // Release the unused harness stack before admitting the first restored copy.
  await stream('task', ['stack:down', '--', '--profile', 'qa', '--run-id', qaRunId, '--persistent'],
    dockerEnvironment());
  let verifying: RetainedSeedCut;
  let copy: MediaStack | undefined;
  const targets: string[] = [];
  const evidence: Evidence[] = [];
  const attempts: { matchingWorks: number; page: string; profile: WorkProfile }[] = [];
  let blind: { matchingWorks: number; page: string; profile: WorkProfile } | undefined;
  let candidateReads: CandidateRead[] = [];
  const assertMeter = (matchingWorks: number, page: string, profile: WorkProfile) => {
    if (profile.postgresStatements === null || profile.postgresStatements <= 0
      || profile.fusekiRequests === null || profile.fusekiRequests <= 0) {
      blind = { matchingWorks, page, profile };
      throw new Error(`meter blind at ${matchingWorks} matching Works (${page})`);
    }
  };
  const request = async (stack: MediaStack, path: string, body: object, headers = new Headers(), captureFailure = false) => {
    candidateReads = [];
    headers.set('content-type', 'application/json');
    const response = await stack.main.handle(new Request(`http://main.local${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }));
    const text = await response.text();
    const value = JSON.parse(text) as Page;
    if (captureFailure) expect([200, 503]).toContain(response.status);
    else expect(response.status, JSON.stringify(value)).toBe(200);
    if (response.status === 503) expect(value).toMatchObject({ status: 503, code: 'search_index_unavailable' });
    if (response.status === 200) expect(candidateReads).toHaveLength(1);
    return { ...value, httpStatus: response.status, responseBytes: Buffer.byteLength(text),
      candidateRead: candidateReads[0] };
  };
  const backups = createCorpusBackupDriver({
    sourceRunId: retained.sourceRunId,
    directory: join(root, '.temp/work-profiles/search-ranked-growth'),
    resumeSource: false, restoreResourceClass: 'ordinary',
    quiesce: async () => { throw new Error('Ranked growth only restores retained checkpoints'); },
    async smokeRead(input) {
      const env = { ...input.apps, REZICS_QA_RUN_ID: input.runId,
        REZICS_QA_STACK_MODE: 'scale', REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
      const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
      Object.assign(process.env, env);
      let stack: MediaStack;
      try {
        stack = await startMediaStack('ranked-growth-copy', {
          ownerUrls: { access: input.apps.ACCESS_DATABASE_URL!, content: input.apps.CONTENT_DATABASE_URL!,
            relay: input.apps.ACCOUNT_RELAY_DATABASE_URL! },
        });
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
      try {
        // A restored project has a new Content consumer. Advance it through the
        // retained outbox using its owner worker before admitting search reads.
        const projection = stack.composition.dependencies.contentProjection!;
        const source = await projection.content.ownerPosition();
        const deadline = performance.now() + 60_000;
        while ((await projection.cursor.read(projection.consumer)).sequence !== source.sequence) {
          if (performance.now() >= deadline)
            throw new Error('Restored Content projection readiness exceeded 60 seconds');
          if (!await stack.composition.contentProjectionWorker.pollOnce())
            throw new Error('Restored Content projection cannot cover its retained source');
        }
        await assertPublicContentSearchReady(stack.env, projection.content, projection.cursor, projection.consumer);
        // Verify the matching source bodies without executing the complete
        // search outside its profile (which could itself exhaust the deadline).
        for (const [index, work] of verifying.works.entries()) {
          const response = await stack.main.handle(new Request(
            `http://main.local/v1/main-versions/${work.mainVersion.slice(-36)}/selection?language=en`));
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ work: work.work,
            selectedDraft: work.draftRevision, body: `${phrase} ${index}` });
        }
        const query = stack.env.fuseki.query.bind(stack.env.fuseki);
        stack.env.fuseki.query = async (...args) => {
          const result = await query(...args);
          if (args[0].includes('SELECT ?candidateCount ?epoch ?sequence ?indexGeneration ?unit ?score ?work ?main ?contribution')) {
            const rows = result.results?.bindings ?? [];
            candidateReads.push({ rows: rows.length, candidates: Number(rows[0]?.candidateCount?.value),
              sentBytes: Buffer.byteLength(args[0]) });
          }
          return result;
        };
        copy = stack;
        return async () => { copy = undefined; await stack.stop(); };
      } catch (error) { await stack.stop(); throw error; }
    },
  });
  try {
    for (const cut of retained.cuts) {
      verifying = cut;
      const target = `ranked-growth-${qaRunId.replaceAll('-', '').slice(0, 24)}-${cut.manifest.scale}`;
      targets.push(target);
      // Restore accepts checkout-local backup artifacts. Copy the published
      // read-only files, retaining the same stopped volumes and compatibility.
      const local = join(root, '.temp/work-profiles/search-ranked-growth/retained', qaRunId, cut.manifest.id);
      mkdirSync(dirname(local), { recursive: true, mode: 0o700 });
      cpSync(dirname(cut.manifest.backup), local, { recursive: true, force: false, errorOnExist: true });
      const restoreMs = await restoreWorkProfileCorpus({ ...cut.manifest, backup: join(local, 'backup.json') },
        target, backups);
      try {
        const count = cut.works.length;
        const body = { profile: 'public-main-phrase-page-v1', phrase, language: 'en', pageSize };
        const first = await profileRequest(sink, headers => request(copy!, '/v1/queries/page', body, headers, true),
          { flush: flushTelemetryTraces });
        attempts.push({ matchingWorks: count, page: 'first', profile: first.profile });
        assertMeter(count, 'first', first.profile);
        if (first.result.httpStatus !== 200) continue;
        expect(first.result.next).not.toBeNull();
        const continuation = await profileRequest(sink, headers => request(copy!, '/v1/queries/page', {
          ...body, continuation: first.result.next,
        }, headers, true), { flush: flushTelemetryTraces });
        attempts.push({ matchingWorks: count, page: 'continuation', profile: continuation.profile });
        assertMeter(count, 'continuation', continuation.profile);
        if (continuation.result.httpStatus !== 200) continue;
        for (const result of [first.result, continuation.result]) {
          expect(result.relationComplete).toBe(true);
          expect(result.results).toHaveLength(pageSize);
          expect(result.total).toBe(count);
          expect(result.population).toBeGreaterThanOrEqual(count);
          expect(result.results.every(row => cut.works.some(work => work.work === row.work))).toBe(true);
        }
        expect(new Set([...first.result.results, ...continuation.result.results].map(row => row.work)).size).toBe(4);
        evidence.push({ matchingWorks: count, restoreMs,
          first: measuredProfile(first.profile, first.result.candidateRead!, first.result.responseBytes),
          continuation: measuredProfile(continuation.profile, continuation.result.candidateRead!, continuation.result.responseBytes) });
      } finally { await backups.stop(target); }
    }
  } finally {
    mkdirSync(dirname(process.env.REZICS_WORK_PROFILE_RESULT!), { recursive: true });
    writeFileSync(process.env.REZICS_WORK_PROFILE_RESULT!, JSON.stringify({ evidence, attempts, blind }, null, 2));
    const errors: unknown[] = [];
    for (const target of targets) {
      try { await backups.stop(target); } catch (error) { errors.push(error); }
    }
    await shutdownTelemetry();
    await sink.stop();
    if (errors.length) throw new AggregateError(errors, 'Ranked checkpoint cleanup failed');
  }
}

if (process.env.REZICS_RANKED_SEARCH_PROFILE_CHILD === '1') {
  await profileRankedSearch();
} else {
  const { PUBLIC_SEARCH_PAGE_COST } = await import('../../../services/main/src/modules/work/search-continuation.ts');
  let evidence: Evidence[];
  let attempts: { matchingWorks: number; page: string; profile: WorkProfile }[];
  beforeAll(async () => {
    const measured = await runWorkProfileChild('tests/qa/integration/search-ranked-growth.test.ts', {
      env: { REZICS_RANKED_SEARCH_PROFILE_CHILD: '1' }, timeoutMs: 450_000,
    });
    ({ evidence, attempts } = JSON.parse(readFileSync(measured.resultPath, 'utf8')) as {
      evidence: Evidence[]; attempts: typeof attempts });
    console.log(`Ranked search work profiles: ${measured.resultPath}`);
    console.log(JSON.stringify(attempts.map(row => ({ works: row.matchingWorks, page: row.page,
      status: row.profile.request.status, fuseki: row.profile.fusekiRequests, sql: row.profile.postgresStatements })), null, 2));
    console.log(JSON.stringify(evidence.map(row => ({ matchingWorks: row.matchingWorks, restoreMs: row.restoreMs,
      ...Object.fromEntries(['first', 'continuation'].map(page => [page,
        Object.fromEntries([...counters, 'candidateRows', 'candidateCount', 'candidateReceivedBytes', 'responseBytes']
          .map(counter => [counter, row[page as 'first' | 'continuation'][counter as keyof MeasuredProfile]]))])),
    })), null, 2));
  }, 460_000);

  test('SEARCH18/SEARCH16: ranked first and continuation pages cover restored 4/16/64 matching Works', () => {
    for (const attempt of attempts) expect(attempt.profile.request.status).toBe(200);
    expect(evidence.map(row => row.matchingWorks)).toEqual([4, 16, 64]);
    for (const row of evidence) for (const profile of [row.first, row.continuation]) {
      expect(profile.request.route).toBe('/v1/queries/page');
      expect(profile.request.status).toBe(200);
      expect(profile.unclassifiedFetches).toBe(0);
      expect(profile.unobserved.filter(gap => gap.endsWith('SQL descendants'))).toEqual([]);
      for (const counter of counters) expect(profile[counter]).not.toBeNull();
      expect(profile.postgresStatements).toBeGreaterThan(0);
      expect(profile.fusekiRequests).toBeGreaterThan(0);
      expect(profile.candidateRows).toBe(row.matchingWorks);
      expect(profile.candidateCount).toBe(row.matchingWorks);
      expect(profile.candidateRows).toBeLessThanOrEqual(PUBLIC_SEARCH_PAGE_COST.probeRows);
      expect(profile.candidateCount).toBeLessThanOrEqual(PUBLIC_SEARCH_PAGE_COST.candidates);
    }
  });
  for (const page of ['first', 'continuation'] as const) {
    test(`SEARCH18/SEARCH16: ranked ${page} page obeys the bounded candidate-pool formulas`, () => {
      const profiles = evidence.map(row => row[page]);
      const smallest = profiles[0]!;
      const batches = (candidates: number) => Math.ceil(candidates / PUBLIC_SEARCH_PAGE_COST.hydrationBatchSize);
      const fixedFuseki = smallest.fusekiRequests! - batches(smallest.candidateCount);
      const fixedSql = smallest.postgresStatements! - batches(smallest.candidateCount);
      const measuredRowBytes = smallest.candidateReceivedBytes / smallest.candidateRows;
      const rowBytes = Math.ceil(measuredRowBytes * PUBLIC_SEARCH_PAGE_COST.rowByteSlack);
      const poolBytes = PUBLIC_SEARCH_PAGE_COST.candidates * rowBytes;
      expect(fixedFuseki).toBeGreaterThanOrEqual(0);
      expect(fixedSql).toBeGreaterThanOrEqual(0);
      expect(measuredRowBytes).toBeGreaterThan(0);

      // Computed overflow check, not a new seed: filling all 512 admitted slots
      // must still fit the candidate query's 1 MiB response cap, including slack.
      expect(PUBLIC_SEARCH_PAGE_COST.candidates * measuredRowBytes).toBeLessThan(PUBLIC_SEARCH_PAGE_COST.responseBytes);
      expect(poolBytes).toBeLessThan(PUBLIC_SEARCH_PAGE_COST.responseBytes);
      console.log(JSON.stringify({ page, measuredRowBytes, slack: PUBLIC_SEARCH_PAGE_COST.rowByteSlack,
        rowBytes, poolBytes, fixedFuseki, fixedSql, disclosureBatchSize: PUBLIC_SEARCH_PAGE_COST.disclosureBatchSize,
        candidatesPerBatch: PUBLIC_SEARCH_PAGE_COST.hydrationBatchSize }));

      // Numeric utilization fields let the existing verdict enforce per-cut
      // formula maxima without replacing the raw request counters or its engine.
      const bounded = profiles.map(profile => ({ ...profile,
        candidateRowBudgetUse: profile.candidateRows / PUBLIC_SEARCH_PAGE_COST.probeRows,
        candidateByteBudgetUse: profile.candidateReceivedBytes / poolBytes,
        candidateFillByteBudgetUse: profile.candidateReceivedBytes / (profile.candidateRows * rowBytes),
        fusekiCallBudgetUse: profile.fusekiRequests! / (fixedFuseki + batches(profile.candidateCount)),
        sqlCallBudgetUse: profile.postgresStatements! / (fixedSql + batches(profile.candidateCount)),
      }));
      const perRowMaximum = (value: number) => Math.ceil(value / smallest.candidateRows
        * PUBLIC_SEARCH_PAGE_COST.candidates * PUBLIC_SEARCH_PAGE_COST.rowByteSlack);
      const contract = {
        candidateRowBudgetUse: 1, candidateByteBudgetUse: 1, candidateFillByteBudgetUse: 1,
        fusekiCallBudgetUse: 1, sqlCallBudgetUse: 1,
        mainCalls: smallest.mainCalls!, accountCalls: smallest.accountCalls!, otherFetches: smallest.otherFetches!,
        unclassifiedFetches: 0,
        fusekiSentBytes: perRowMaximum(smallest.fusekiSentBytes!),
        // Total traffic also includes health and hydration. The per-row formula
        // above applies specifically to the candidate-query response.
        fusekiReceivedBytes: PUBLIC_SEARCH_PAGE_COST.responseBytes,
        candidateReceivedBytes: Math.min(poolBytes, PUBLIC_SEARCH_PAGE_COST.responseBytes),
        responseBytes: PUBLIC_SEARCH_PAGE_COST.responseBytes,
        ...Object.fromEntries(commandCounters.map(counter => [counter, perRowMaximum(smallest[counter])])),
      } as unknown as WorkCostContract;
      assertWorkCostAtScales(bounded, contract, `ranked-${page}-candidate-pool`);
    });
  }
}
