import { beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertWorkCostAtScales,
  profileRequest,
  startWorkProfileSink,
  type WorkCostContract,
  type WorkCostField,
  type WorkProfile,
} from '../support/work-profile.ts';
import { runWorkProfileChild } from '../support/work-profile-child.ts';
import type { MediaStack } from './media-support.ts';
import type { CorpusDimensions } from '../../../scripts/load/work-profile-corpus.ts';
import type { SearchContinuation } from '../../../services/main/src/modules/work/search-continuation.ts';

const phrase = 'rankedgrowthcorpus';
const pageSize = 2;
const counters = [
  'mainCalls', 'fusekiRequests', 'fusekiSentBytes', 'fusekiReceivedBytes',
  'postgresStatements', 'accountCalls', 'otherFetches', 'unclassifiedFetches',
] as const satisfies readonly WorkCostField[];
type Page = { complete: boolean; population: number; total: number;
  results: { work: string; mainVersion: string }[]; next: SearchContinuation | null };
type Evidence = { matchingWorks: number; first: WorkProfile; continuation: WorkProfile };

async function profileRankedSearch() {
  const sink = startWorkProfileSink({ settleMs: 25 });
  const { startTelemetry, flushTelemetryTraces, shutdownTelemetry } =
    await import('../../../packages/observability/src/runtime.ts');
  // Instrument pg before loading the application or the backup driver.
  startTelemetry('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main' });
  const { startMediaStack } = await import('./media-support.ts');
  const { createCorpusBackupDriver } = await import('../../../scripts/load/corpus-backup-driver.ts');
  const { prepareWorkProfileCorpus, restoreWorkProfileCorpus, workProfileCorpusApi,
    WORK_PROFILE_SCALES } = await import('../../../scripts/load/work-profile-corpus.ts');
  const { seedPublicProfileWork } = await import('../../../scripts/load/work-profile-work.ts');
  const { initializeRelayCheckpoint } = await import('../../../services/main/src/modules/outbox/relay.ts');
  const sourceRunId = process.env.REZICS_QA_RUN_ID;
  if (!sourceRunId) throw new Error('Run through goalctl integration QA');
  const directory = join(process.cwd(), '.temp/work-profiles/search-ranked-growth', sourceRunId);
  mkdirSync(directory, { recursive: true });
  const fixed: CorpusDimensions = { unrelatedWorks: 0, unrelatedPosts: 0, follows: 0,
    memberships: 0, historyDepth: 0, realmSize: 0, conceptVocabulary: 0 };
  let source: MediaStack | undefined;
  let actor = '';
  const works: Awaited<ReturnType<typeof seedPublicProfileWork>>[] = [];
  const copies = new Map<string, MediaStack>();
  const evidence: Evidence[] = [];
  const manifests: Awaited<ReturnType<typeof prepareWorkProfileCorpus>>[] = [];
  const label = 'ranked-growth-source';
  const memberName = 'ranked-growth-author';
  const apiFor = async (stack: MediaStack) => {
    const member = await stack.member(memberName, { stable: true, verified: true });
    return workProfileCorpusApi('http://main.local', member.token, {
      fetch: ((input, init) => stack.main.handle(new Request(input, init))) as typeof fetch,
    });
  };
  const request = async (stack: MediaStack, path: string, body: object, headers = new Headers()) => {
    headers.set('content-type', 'application/json');
    const response = await stack.main.handle(new Request(`http://main.local${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }));
    const value = await response.json() as Page;
    expect(response.status, JSON.stringify(value)).toBe(200);
    return value;
  };
  const verifyPopulation = async (stack: MediaStack, count: number) => {
    const result = await request(stack, '/v1/queries', {
      profile: 'public-main-phrase-v1', phrase, language: 'en',
    });
    expect(result.complete).toBe(true);
    expect(result.population).toBe(count);
    expect(result.total).toBe(count);
    expect(new Set(result.results.map(row => row.work))).toEqual(
      new Set(works.slice(0, count).map(row => row.work)),
    );
  };
  const backups = createCorpusBackupDriver({
    sourceRunId,
    directory: join(directory, 'backups'),
    async quiesce(signal) {
      signal.throwIfAborted();
      await source!.stop();
      source = undefined;
      return async () => { source = await startMediaStack(label, { library: true }); };
    },
    async smokeRead(input) {
      const env = { ...input.apps, REZICS_QA_RUN_ID: input.runId,
        REZICS_QA_STACK_MODE: 'scale', REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
      const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
      Object.assign(process.env, env);
      let copy: MediaStack;
      try {
        copy = await startMediaStack('ranked-growth-copy', { library: true,
          ownerUrls: { access: input.apps.ACCESS_DATABASE_URL!, content: input.apps.CONTENT_DATABASE_URL!,
            relay: input.apps.ACCOUNT_RELAY_DATABASE_URL! } });
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      try {
        await verifyPopulation(copy, manifests.find(row => input.target.endsWith(row.scale))!.dimensions.unrelatedWorks);
        copies.set(input.target, copy);
        return async () => { copies.delete(input.target); await copy.stop(); };
      } catch (error) {
        await copy.stop();
        throw error;
      }
    },
  });
  try {
    source = await startMediaStack(label, { library: true });
    await initializeRelayCheckpoint(source.composition.relayPool!, process.env.MAIN_RELAY_CONSUMER!,
      source.env.lineage.dataEpoch);
    const recipe = {
      version: 'public-ranked-search-growth-v1', fixed,
      async initialize(client: Awaited<ReturnType<typeof apiFor>>, key: string) {
        if (actor) return;
        const created = await client.command<{ agent: string }>(`${key}:author`, { method: 'POST',
          path: '/v1/agents', body: { profile: 'agent-provision-v1', kind: 'person',
            displayName: 'Ranked search corpus author' } });
        actor = created.agent;
      },
      async grow(client: Awaited<ReturnType<typeof apiFor>>, dimension: string, index: number, key: string) {
        expect(dimension).toBe('unrelatedWorks');
        if (works[index]) return;
        works[index] = await seedPublicProfileWork(client, key, { actingSubject: actor,
          title: `Ranked search corpus Work ${index}`, body: `${phrase} selected text ${index}` });
      },
      async verify(client: Awaited<ReturnType<typeof apiFor>>) {
        for (const [index, work] of works.entries()) {
          const selected = await client.read<{ body: string; selectedDraft: string }>(
            `/v1/main-versions/${work.mainVersion.slice(-36)}/selection?language=en`);
          expect(selected).toMatchObject({ body: `${phrase} selected text ${index}`,
            selectedDraft: work.draftRevision });
        }
        await verifyPopulation(source!, works.length);
        return { ...fixed, unrelatedWorks: works.length };
      },
    };
    for (const scale of WORK_PROFILE_SCALES) {
      manifests.push(await prepareWorkProfileCorpus({ recipe, api: await apiFor(source!), backups,
        dimension: 'unrelatedWorks', scale, directory: join(directory, 'manifests') }));
    }
    await source!.stop();
    source = undefined;
    for (const manifest of manifests) {
      const target = `ranked-growth-${sourceRunId.replaceAll('-', '').slice(0, 24)}-${manifest.scale}`;
      await restoreWorkProfileCorpus(manifest, target, backups);
      try {
        const copy = copies.get(target)!;
        const count = manifest.dimensions.unrelatedWorks;
        const body = { profile: 'public-main-phrase-page-v1', phrase, language: 'en', pageSize };
        const first = await profileRequest(sink, headers => request(copy, '/v1/queries/page', body, headers),
          { flush: flushTelemetryTraces });
        expect(first.result.results).toHaveLength(pageSize);
        expect(first.result.next).not.toBeNull();
        const continuation = await profileRequest(sink, headers => request(copy, '/v1/queries/page', {
          ...body, continuation: first.result.next,
        }, headers), { flush: flushTelemetryTraces });
        expect(continuation.result.results).toHaveLength(pageSize);
        for (const result of [first.result, continuation.result]) {
          expect(result.complete).toBe(true);
          expect(result.population).toBe(count);
          expect(result.total).toBe(count);
          expect(result.results.every(row => works.slice(0, count).some(work => work.work === row.work))).toBe(true);
        }
        expect(new Set([...first.result.results, ...continuation.result.results].map(row => row.work)).size).toBe(4);
        evidence.push({ matchingWorks: count, first: first.profile, continuation: continuation.profile });
      } finally { await backups.stop(target); }
    }
    writeFileSync(process.env.REZICS_WORK_PROFILE_RESULT!, JSON.stringify({ evidence, manifests }, null, 2));
  } finally {
    for (const target of copies.keys()) await backups.stop(target);
    await source?.stop();
    await shutdownTelemetry();
    await sink.stop();
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
    console.log(JSON.stringify(evidence.map(row => ({ matchingWorks: row.matchingWorks,
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
  for (const page of ['first', 'continuation'] as const) for (const counter of counters) {
    test(`SEARCH18: ranked ${page} page ${counter} stays constant by matching Works`, () => {
      // The verdict already reads numeric dimensions at runtime. Its current
      // type lists only counters; extend the evidence without replacing a real
      // counter (notably mainCalls) with the seeded population.
      const profiles = evidence.map(row => ({ ...row[page], matchingWorks: row.matchingWorks }));
      const contract = { growth: { [counter]: PUBLIC_SEARCH_PAGE_COST } } as unknown as WorkCostContract;
      assertWorkCostAtScales(profiles, contract, `ranked-${page}-${counter}`);
    });
  }
}
