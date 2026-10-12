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
type MeasuredProfile = WorkProfile & Record<(typeof commandCounters)[number], number>;
type Page = { complete?: boolean; relationComplete?: boolean; population: number; total: number;
  results: { work: string; mainVersion: string }[]; next: SearchContinuation | null };
type Evidence = { matchingWorks: number; restoreMs: number;
  first: MeasuredProfile; continuation: MeasuredProfile };

/** Project the request's existing native span counters into numeric verdict fields.
 * CommandWork initializes mutation counters, but emits visit keys sparsely.
 * A covered dictionary's absent visit key means zero; an absent dictionary fails.
 * Health GETs do not execute native commands or queries. */
function nativeCounters(profile: WorkProfile): MeasuredProfile {
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
  return { ...profile, ...totals };
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
  let blind: { matchingWorks: number; first: WorkProfile; continuation: WorkProfile } | undefined;
  const request = async (stack: MediaStack, path: string, body: object, headers = new Headers()) => {
    headers.set('content-type', 'application/json');
    const response = await stack.main.handle(new Request(`http://main.local${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }));
    const value = await response.json() as Page;
    expect(response.status, JSON.stringify(value)).toBe(200);
    return value;
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
        const result = await request(stack, '/v1/queries', {
          profile: 'public-main-phrase-v1', phrase, language: 'en',
        });
        expect(result.complete).toBe(true);
        expect(result.total).toBe(verifying.works.length);
        expect(new Set(result.results.map(row => row.work))).toEqual(
          new Set(verifying.works.map(row => row.work)),
        );
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
        const first = await profileRequest(sink, headers => request(copy!, '/v1/queries/page', body, headers),
          { flush: flushTelemetryTraces });
        expect(first.result.next).not.toBeNull();
        const continuation = await profileRequest(sink, headers => request(copy!, '/v1/queries/page', {
          ...body, continuation: first.result.next,
        }, headers), { flush: flushTelemetryTraces });
        if ([first.profile, continuation.profile].some(profile => profile.postgresStatements === 0
          || profile.fusekiRequests === 0)) {
          blind = { matchingWorks: count, first: first.profile, continuation: continuation.profile };
          throw new Error(`meter blind at ${count} matching Works`);
        }
        for (const result of [first.result, continuation.result]) {
          expect(result.relationComplete).toBe(true);
          expect(result.results).toHaveLength(pageSize);
          expect(result.total).toBe(count);
          expect(result.population).toBeGreaterThanOrEqual(count);
          expect(result.results.every(row => cut.works.some(work => work.work === row.work))).toBe(true);
        }
        expect(new Set([...first.result.results, ...continuation.result.results].map(row => row.work)).size).toBe(4);
        evidence.push({ matchingWorks: count, restoreMs,
          first: nativeCounters(first.profile), continuation: nativeCounters(continuation.profile) });
      } finally { await backups.stop(target); }
    }
  } finally {
    mkdirSync(dirname(process.env.REZICS_WORK_PROFILE_RESULT!), { recursive: true });
    writeFileSync(process.env.REZICS_WORK_PROFILE_RESULT!, JSON.stringify({ evidence, blind }, null, 2));
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
  beforeAll(async () => {
    const measured = await runWorkProfileChild('tests/qa/integration/search-ranked-growth.test.ts', {
      env: { REZICS_RANKED_SEARCH_PROFILE_CHILD: '1' }, timeoutMs: 450_000,
    });
    evidence = (JSON.parse(readFileSync(measured.resultPath, 'utf8')) as { evidence: Evidence[] }).evidence;
    console.log(`Ranked search work profiles: ${measured.resultPath}`);
    console.log(JSON.stringify(evidence.map(row => ({ matchingWorks: row.matchingWorks, restoreMs: row.restoreMs,
      ...Object.fromEntries(['first', 'continuation'].map(page => [page,
        Object.fromEntries(counters.map(counter => [counter, row[page as 'first' | 'continuation'][counter]]))])),
    })), null, 2));
  }, 460_000);

  test('SEARCH18/SEARCH16: ranked first and continuation pages cover restored 4/16/64 matching Works', () => {
    expect(evidence.map(row => row.matchingWorks)).toEqual([4, 16, 64]);
    for (const row of evidence) for (const profile of [row.first, row.continuation]) {
      expect(profile.request.route).toBe('/v1/queries/page');
      expect(profile.request.status).toBe(200);
      expect(profile.unclassifiedFetches).toBe(0);
      expect(profile.unobserved.filter(gap => gap.endsWith('SQL descendants'))).toEqual([]);
      for (const counter of counters) expect(profile[counter]).not.toBeNull();
      expect(profile.postgresStatements).toBeGreaterThan(0);
      expect(profile.fusekiRequests).toBeGreaterThan(0);
    }
  });
  for (const page of ['first', 'continuation'] as const) {
    const profiles = () => evidence.map(row => ({ ...row[page], matchingWorks: row.matchingWorks }));
    const contractFor = (counter: string) =>
      // The verdict accepts numeric evidence at runtime; preserve real counters
      // while extending its current counter-only type with the seeded dimension.
      ({ growth: { [counter]: PUBLIC_SEARCH_PAGE_COST } }) as unknown as WorkCostContract;
    for (const counter of counters)
      test(`SEARCH18: ranked ${page} page ${counter} stays constant by matching Works`, () => {
        assertWorkCostAtScales(profiles(), contractFor(counter), `ranked-${page}-${counter}`);
      });
  }
}
