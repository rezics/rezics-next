import { RANKED_SEARCH_EXPECTED_COST, assertRankedSearchDeclaration } from '../../../scripts/load/ranked-search-contract.ts';
import { beforeAll, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertWorkCost, assertWorkCostAtScales, assertWorkMeterObserved, profileRequest, startWorkProfileSink,
  type WorkCostContract, type WorkCostField, type WorkProfile,
} from '../support/work-profile.ts';
import { runWorkProfileChild } from '../support/work-profile-child.ts';
import type { MediaStack } from './media-support.ts';
import type { RetainedSeedCut } from '../support/seed-checkpoints.ts';
import type { SearchContinuation } from '../../../services/main/src/modules/work/search-continuation.ts';

const phrase = 'Checkpoint selected text';
const pageSize = 2;
const meterContract = { minimumObserved: { postgresStatements: 1, fusekiRequests: 1 } } as const;
const requestCounters = [
  'mainCalls', 'fusekiRequests', 'fusekiSentBytes', 'fusekiReceivedBytes',
  'postgresStatements', 'accountCalls', 'otherFetches', 'unclassifiedFetches',
] as const satisfies readonly WorkCostField[];
type CandidateRead = { rows: number; candidates: number; sentBytes: number };
type CandidateProfile = WorkProfile & {
  candidateRows: number; candidateCount: number; candidateReceivedBytes: number; responseBytes: number;
};
type Page = { httpStatus: number; complete?: boolean; relationComplete?: boolean; population: number; total: number;
  results: { work: string; mainVersion: string; title?: unknown }[]; next: SearchContinuation | null;
  cardWindow?: { hydrated: number; limit: number; next: object | null } };
type Evidence = { matchingWorks: number; restoreMs: number;
  query: CandidateProfile; first: CandidateProfile; continuation: CandidateProfile;
  queryContinuation?: CandidateProfile };
type Refusal = { status: number; code?: string; responseStatus?: string | number; body: string };
type Attempt = { matchingWorks: number; page: string; profile: WorkProfile;
  hostLoad: string; refusal?: Refusal; candidateRead?: CandidateRead };

/** Attach candidate-query evidence; native work remains the shared owner's
 * nativeVisits/nativeVisitTotal, without aliases or a second aggregation. */
function withCandidateRead(profile: WorkProfile, read: CandidateRead, responseBytes: number): CandidateProfile {
  const calls = profile.fusekiCalls.filter(call => call.sentBytes === read.sentBytes);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.receivedBytes).toBeGreaterThan(0);
  return { ...profile, candidateRows: read.rows, candidateCount: read.candidates,
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
  const { restoreWorkProfileCorpus, CorpusCommandError } = await import('../../../scripts/load/work-profile-corpus.ts');
  const { root, stream, dockerEnvironment } = await import('../../../scripts/fixture/stack.ts');
  const { readRetainedSeed } = await import('../support/seed-checkpoints.ts');
  const { assertPublicContentSearchReady } = await import('../../../services/main/src/modules/content-publication/search.ts');
  const { SEARCH_CARD_WINDOW } = await import('../../../services/main/src/modules/search/card-window.ts');
  const retained = readRetainedSeed();
  expect(retained.cuts.map(cut => cut.works.length)).toEqual([4, 16, 64]);
  const hostLoadAtStart = readFileSync('/proc/loadavg', 'utf8').trim();
  console.log(JSON.stringify({ event: 'ranked-profile-start', hostLoadAtStart,
    cuts: retained.cuts.map(cut => cut.works.length) }));
  const qaRunId = process.env.REZICS_QA_RUN_ID;
  if (!qaRunId) throw new Error('Run through goalctl integration QA');
  // Release the unused harness stack before admitting the first restored copy.
  await stream('task', ['stack:down', '--', '--profile', 'qa', '--run-id', qaRunId, '--persistent'],
    dockerEnvironment());
  let verifying: RetainedSeedCut;
  let copy: MediaStack | undefined;
  const targets: string[] = [];
  const evidence: Evidence[] = [];
  const attempts: Attempt[] = [];
  let candidateReads: CandidateRead[] = [];
  const request = async (stack: MediaStack, path: string, body: object, headers = new Headers(), captureFailure = false) => {
    candidateReads = [];
    const hostLoad = readFileSync('/proc/loadavg', 'utf8').trim();
    headers.set('content-type', 'application/json');
    const response = await stack.main.handle(new Request(`http://main.local${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }));
    const text = await response.text();
    const value = JSON.parse(text) as Page;
    if (captureFailure) expect([200, 503]).toContain(response.status);
    else expect(response.status, JSON.stringify(value)).toBe(200);
    let refusal: Refusal | undefined;
    if (response.status === 503) {
      expect(value).toMatchObject({ status: 503, code: 'search_index_unavailable' });
      const error = new CorpusCommandError('ranked-page', `POST ${path}`, verifying.manifest.scale, response.status, text);
      refusal = { status: error.status, code: error.code, responseStatus: error.responseStatus, body: error.body };
    }
    if (response.status === 200) expect(candidateReads).toHaveLength(1);
    return { ...value, httpStatus: response.status, responseBytes: Buffer.byteLength(text),
      candidateRead: candidateReads[0], hostLoad, refusal };
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
        const measure = async (page: string, path: string, body: object) => {
          const measured = await profileRequest(sink, headers => request(copy!, path, body, headers, true),
            { flush: flushTelemetryTraces });
          attempts.push({ matchingWorks: count, page, profile: measured.profile,
            hostLoad: measured.result.hostLoad, refusal: measured.result.refusal,
            candidateRead: measured.result.candidateRead });
          assertWorkMeterObserved(measured.profile, meterContract);
          return measured;
        };
        const query = await measure('query', '/v1/queries', {
          profile: 'public-main-phrase-v1', phrase, language: 'en',
        });
        const body = { profile: 'public-main-phrase-page-v1', phrase, language: 'en', pageSize };
        const first = await measure('first', '/v1/queries/page', body);
        if (first.result.httpStatus !== 200) continue;
        expect(first.result.next).not.toBeNull();
        const continuation = await measure('continuation', '/v1/queries/page', {
          ...body, continuation: first.result.next,
        });
        if (continuation.result.httpStatus !== 200 || query.result.httpStatus !== 200) continue;
        expect(query.result.complete).toBe(true);
        expect(query.result.total).toBe(count);
        expect(query.result.results).toHaveLength(count);
        expect(new Set(query.result.results.map(row => row.work))).toEqual(new Set(cut.works.map(row => row.work)));
        expect(query.result.cardWindow).toMatchObject({ limit: SEARCH_CARD_WINDOW,
          hydrated: Math.min(count, SEARCH_CARD_WINDOW) });
        let queryContinuation: CandidateProfile | undefined;
        if (count > SEARCH_CARD_WINDOW) {
          expect(query.result.cardWindow!.next).not.toBeNull();
          const next = await measure('queryContinuation', '/v1/queries/page', query.result.cardWindow!.next!);
          if (next.result.httpStatus !== 200) continue;
          expect(next.result.results).toHaveLength(SEARCH_CARD_WINDOW);
          expect(next.result.total).toBe(count);
          expect(new Set([...query.result.results.slice(0, SEARCH_CARD_WINDOW), ...next.result.results]
            .map(row => row.work)).size).toBe(2 * SEARCH_CARD_WINDOW);
          queryContinuation = withCandidateRead(next.profile, next.result.candidateRead!, next.result.responseBytes);
        } else expect(query.result.cardWindow!.next).toBeNull();
        for (const result of [first.result, continuation.result]) {
          expect(result.relationComplete).toBe(true);
          expect(result.results).toHaveLength(pageSize);
          expect(result.total).toBe(count);
          expect(result.population).toBeGreaterThanOrEqual(count);
          expect(result.results.every(row => cut.works.some(work => work.work === row.work))).toBe(true);
        }
        expect(new Set([...first.result.results, ...continuation.result.results].map(row => row.work)).size).toBe(4);
        evidence.push({ matchingWorks: count, restoreMs,
          query: withCandidateRead(query.profile, query.result.candidateRead!, query.result.responseBytes),
          first: withCandidateRead(first.profile, first.result.candidateRead!, first.result.responseBytes),
          continuation: withCandidateRead(continuation.profile, continuation.result.candidateRead!, continuation.result.responseBytes),
          queryContinuation });
      } finally { await backups.stop(target); }
    }
  } finally {
    mkdirSync(dirname(process.env.REZICS_WORK_PROFILE_RESULT!), { recursive: true });
    writeFileSync(process.env.REZICS_WORK_PROFILE_RESULT!, JSON.stringify({ evidence, attempts, hostLoadAtStart }, null, 2));
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
  const { PUBLIC_SEARCH_PAGE_COST: declaration } = await import('../../../services/main/src/modules/work/search-continuation.ts');
  assertRankedSearchDeclaration(declaration);
  const PUBLIC_SEARCH_PAGE_COST = RANKED_SEARCH_EXPECTED_COST;
  let evidence: Evidence[];
  let attempts: Attempt[];
  beforeAll(async () => {
    const measured = await runWorkProfileChild('tests/qa/integration/search-ranked-growth.test.ts', {
      env: { REZICS_RANKED_SEARCH_PROFILE_CHILD: '1' }, timeoutMs: 450_000,
    });
    ({ evidence, attempts } = JSON.parse(readFileSync(measured.resultPath, 'utf8')) as {
      evidence: Evidence[]; attempts: Attempt[] });
    console.log(`Ranked search work profiles: ${measured.resultPath}`);
    console.log(JSON.stringify(attempts.map(row => ({ works: row.matchingWorks, page: row.page,
      route: row.profile.request.route, status: row.profile.request.status,
      fuseki: row.profile.fusekiRequests, sql: row.profile.postgresStatements,
      nativeVisits: row.profile.nativeVisits, nativeVisitTotal: row.profile.nativeVisitTotal,
      hostLoad: row.hostLoad, refusal: row.refusal, candidateRead: row.candidateRead })), null, 2));
    console.log(JSON.stringify(evidence.map(row => ({ works: row.matchingWorks, restoreMs: row.restoreMs,
      ...Object.fromEntries(['query', 'first', 'continuation', 'queryContinuation'].flatMap(operation => {
        const profile = row[operation as 'query' | 'first' | 'continuation' | 'queryContinuation'];
        return profile ? [[operation, { sentBytes: profile.fusekiSentBytes,
          receivedBytes: profile.fusekiReceivedBytes, candidateRows: profile.candidateRows,
          candidateReceivedBytes: profile.candidateReceivedBytes, responseBytes: profile.responseBytes }]] : [];
      })),
    })), null, 2));
  }, 460_000);

  test('SEARCH18/SEARCH16: both entry points and ranked continuations cover restored 4/16/64 matching Works', () => {
    for (const attempt of attempts) {
      assertWorkMeterObserved(attempt.profile, meterContract);
      expect(attempt.profile.request.status).toBe(200);
    }
    expect(evidence.map(row => row.matchingWorks)).toEqual([4, 16, 64]);
    expect(attempts.filter(row => row.page === 'query').map(row => row.matchingWorks)).toEqual([4, 16, 64]);
    expect(attempts.filter(row => row.page === 'first').map(row => row.matchingWorks)).toEqual([4, 16, 64]);
    expect(attempts.filter(row => row.page === 'continuation').map(row => row.matchingWorks)).toEqual([4, 16, 64]);
    for (const row of evidence) for (const operation of ['query', 'first', 'continuation'] as const) {
      const profile = row[operation];
      expect(profile.request.route).toBe(operation === 'query' ? '/v1/queries' : '/v1/queries/page');
      expect(profile.unclassifiedFetches).toBe(0);
      expect(profile.unobserved.filter(gap => gap.endsWith('SQL descendants'))).toEqual([]);
      for (const counter of requestCounters) expect(profile[counter]).not.toBeNull();
      expect(profile.nativeVisitTotal).toBeGreaterThanOrEqual(0);
      expect(profile.candidateRows).toBe(row.matchingWorks);
      expect(profile.candidateCount).toBe(row.matchingWorks);
      expect(profile.candidateRows).toBeLessThanOrEqual(PUBLIC_SEARCH_PAGE_COST.probeRows);
      expect(profile.candidateCount).toBeLessThanOrEqual(PUBLIC_SEARCH_PAGE_COST.candidates);
    }
    expect(evidence.filter(row => row.queryContinuation).map(row => row.matchingWorks)).toEqual([64]);
  });

  // The shared engine can read additional numeric profile evidence. Its current
  // type enumerates built-in fields; these keys retain the actual candidate
  // measurements rather than repurposing a request counter or normalizing it.
  const candidateDimension = 'candidateCount' as WorkCostField;
  const candidateRowsField = 'candidateRows' as WorkCostField;
  const candidateBytesField = 'candidateReceivedBytes' as WorkCostField;
  const responseBytesField = 'responseBytes' as WorkCostField;
  const growth = Object.fromEntries(Object.entries(PUBLIC_SEARCH_PAGE_COST.growth)
    .map(([counter, declaration]) => [counter, { ...declaration, dimension: candidateDimension }])) as NonNullable<WorkCostContract['growth']>;

  for (const operation of ['query', 'first', 'continuation'] as const) {
    test(`SEARCH18/SEARCH16: ranked ${operation} obeys declared candidate growth and pool formulas`, () => {
      const profiles = evidence.map(row => row[operation]);
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
      // The full pool, including the declared 25% row-byte slack, fits 1 MiB.
      expect(PUBLIC_SEARCH_PAGE_COST.candidates * measuredRowBytes).toBeLessThan(PUBLIC_SEARCH_PAGE_COST.responseBytes);
      expect(poolBytes).toBeLessThan(PUBLIC_SEARCH_PAGE_COST.responseBytes);
      console.log(JSON.stringify({ operation, measuredRowBytes, slack: PUBLIC_SEARCH_PAGE_COST.rowByteSlack,
        rowBytes, poolBytes, fixedFuseki, fixedSql, disclosureBatchSize: PUBLIC_SEARCH_PAGE_COST.disclosureBatchSize }));
      const perRowMaximum = (value: number) => Math.ceil(value / smallest.candidateRows
        * PUBLIC_SEARCH_PAGE_COST.candidates * PUBLIC_SEARCH_PAGE_COST.rowByteSlack);
      const contract: WorkCostContract = {
        ...meterContract, growth,
        mainCalls: smallest.mainCalls!, accountCalls: smallest.accountCalls!, otherFetches: smallest.otherFetches!,
        unclassifiedFetches: 0,
        fusekiRequests: fixedFuseki + batches(PUBLIC_SEARCH_PAGE_COST.candidates),
        postgresStatements: fixedSql + batches(PUBLIC_SEARCH_PAGE_COST.candidates),
        fusekiSentBytes: perRowMaximum(smallest.fusekiSentBytes!),
        fusekiReceivedBytes: PUBLIC_SEARCH_PAGE_COST.responseBytes,
        [candidateRowsField]: PUBLIC_SEARCH_PAGE_COST.probeRows,
        [candidateBytesField]: Math.min(poolBytes, PUBLIC_SEARCH_PAGE_COST.responseBytes),
        [responseBytesField]: PUBLIC_SEARCH_PAGE_COST.responseBytes,
      };
      // Per-cut formula ceilings and the cross-cut class both use the shared
      // verdict owner; raw SQL/Fuseki counters remain raw numeric evidence.
      for (const profile of profiles) assertWorkCost(profile, {
        fusekiRequests: fixedFuseki + batches(profile.candidateCount),
        postgresStatements: fixedSql + batches(profile.candidateCount),
        [candidateBytesField]: profile.candidateRows * rowBytes,
      });
      assertWorkCostAtScales(profiles, contract, `ranked-${operation}-candidate-pool`);
      if (operation === 'query') for (const row of evidence) {
        if (row.queryContinuation) assertWorkCost(row.queryContinuation, {
          fusekiRequests: fixedFuseki + batches(row.queryContinuation.candidateCount),
          postgresStatements: fixedSql + batches(row.queryContinuation.candidateCount),
          [candidateRowsField]: PUBLIC_SEARCH_PAGE_COST.probeRows,
          [candidateBytesField]: poolBytes,
          [responseBytesField]: PUBLIC_SEARCH_PAGE_COST.responseBytes,
          unclassifiedFetches: 0,
        });
      }
    });
  }
}
