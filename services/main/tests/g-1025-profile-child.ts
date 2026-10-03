import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { profileRequest, startWorkProfileSink, assertWorkCostAtScales,
  type WorkProfile } from '../../../tests/qa/support/work-profile.ts';
import { flushTelemetryTraces, shutdownTelemetry, startTelemetry } from '../../../packages/observability/src/runtime.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { workProfileCorpusApi, workProfileDimensions, WORK_PROFILE_SCALES,
  type CorpusApi, type CorpusDimensions } from '../../../scripts/load/work-profile-corpus.ts';
import { HOME_REQUEST_COST } from '../../../services/main/src/modules/feed/cost-contract.ts';
import { captureFusekiQueryPlan } from '../../../scripts/load/fuseki-plan.ts';
import type { CapturedFusekiQuery } from '../../../scripts/load/fuseki-candidates.ts';
import type { HomeStack } from '../../../tests/qa/integration/feed-read-support.ts';

/** Independent public-command base with exact selected-text read-back. */
async function seedProfileHome(home: HomeStack, api: CorpusApi, readerApi: CorpusApi) {
  const author = await home.provision('Home cost author', home.author.token);
  const unrelatedAuthor = await home.provision('Unfollowed corpus author', home.author.token);
  const reader = await home.provision('Home cost reader', home.reader.token);
  const work = await seedPublicProfileWork(api, 'g1025:fixed-work', { actingSubject: author,
    title: 'Home cost fixed Work', body: 'Home cost fixed selected text' });
  await readerApi.command('g1025:follow-author', { method: 'POST', path: '/v1/follows', body: {
    profile: 'follow-command-v1', actingSubject: reader, target: author, kind: 'agent',
    following: true, expectedRevision: null } });
  await home.project();
  const signed = (path: string) => `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(reader)}`;
  assert.notEqual(unrelatedAuthor, author);
  return { author, unrelatedAuthor, reader, work, signed };
}

async function profileHome() {
  const sink = startWorkProfileSink({ settleMs: 25 });
  // No pg/application imports precede telemetry: zero SQL spans cannot pass.
  startTelemetry('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main' });
  const { startHomeStack } = await import('../../../tests/qa/integration/feed-read-support.ts');
  const home = await startHomeStack('g-1025-profile', { projectionStart: 'current' });
  const sourceQueries: CapturedFusekiQuery[] = [];
  const plans: ReturnType<typeof captureFusekiQueryPlan>[] = [];
  let captureSources = false;
  const originalQuery = home.stack.fuseki.query.bind(home.stack.fuseki);
  home.stack.fuseki.query = async (sparql, maxBytes) => {
    const result = await originalQuery(sparql, maxBytes);
    if (captureSources && sparql.includes('SELECT DISTINCT ?id ?sequence ?kind ?target ?work'))
      sourceQueries.push({ sparql, result });
    return result;
  };
  const evidence: { dimension: string; dimensions: CorpusDimensions; scale: string;
    temperature: string; operation: string; items: number; profile: WorkProfile }[] = [];
  const continuations: { scale: string; unrelatedWorks: number; pages: number }[] = [];
  const comparison: { operation: string; items: number; before: WorkProfile; after: WorkProfile }[] = [];
  try {
    const api = workProfileCorpusApi('http://main.local', home.author.token, {
      fetch: ((input, init) => home.app.handle(new Request(input, init))) as typeof fetch,
    });
    const readerApi = workProfileCorpusApi('http://main.local', home.reader.token, {
      fetch: ((input, init) => home.app.handle(new Request(input, init))) as typeof fetch,
    });
    const seeded = await seedProfileHome(home, api, readerApi);
    const dimensions: CorpusDimensions = { unrelatedWorks: 0, unrelatedPosts: 0,
      follows: 0, memberships: 0, historyDepth: 0, realmSize: 0, conceptVocabulary: 0 };
    const works: Awaited<ReturnType<typeof seedPublicProfileWork>>[] = [];
    const recipes = ['unrelatedWorks', 'follows', 'historyDepth'] as const;
    const operations = [
      { name: 'anonymous Best', path: '/v1/feed?scope=all&sort=best', cost: HOME_REQUEST_COST.anonymousFeed },
      { name: 'anonymous New', path: '/v1/feed?scope=all&sort=new', cost: HOME_REQUEST_COST.anonymousFeed },
      { name: 'signed Best', path: seeded.signed('/v1/feed?scope=following&sort=best'),
        cost: HOME_REQUEST_COST.signedFeed, token: home.reader.token },
      { name: 'signed New', path: seeded.signed('/v1/feed?scope=following&sort=new'),
        cost: HOME_REQUEST_COST.signedFeed, token: home.reader.token },
      { name: 'anonymous suggestions', path: '/v1/onboarding/suggested-follows', cost: HOME_REQUEST_COST.suggestions },
      { name: 'signed suggestions', path: seeded.signed('/v1/onboarding/suggested-follows'),
        cost: HOME_REQUEST_COST.suggestions, token: home.reader.token },
    ];
    // Grow exactly one axis at a time, holding every already-built axis fixed.
    // Every growth command is public and its resulting identity/head is read
    // back before measurement. Continue's populated Book and the other rail
    // owners require a separate qualification; an empty preview cannot pass.
    let historyHead: string | undefined;
    for (const dimension of recipes) {
      const preparationStarted = performance.now();
      for (const scale of WORK_PROFILE_SCALES) {
        const target = workProfileDimensions(dimension, scale, dimensions)[dimension];
        for (let index = dimensions[dimension]; index < target; index++) {
          const key = `g1025:${dimension}:${index}`;
          if (dimension === 'unrelatedWorks') {
            const work = await seedPublicProfileWork(api, key, { actingSubject: seeded.unrelatedAuthor,
              title: `Unrelated Home cost Work ${index}`, body: `Home cost corpus selected body ${index}` });
            works.push(work);
            const selected = await api.read<{ selectedDraft: string; body: string }>(
              `/v1/main-versions/${work.mainVersion.slice(-36)}/selection?language=en`);
            assert.equal(selected.selectedDraft, work.draftRevision);
            assert.equal(selected.body, `Home cost corpus selected body ${index}`);
          } else if (dimension === 'follows') {
            const work = works[index]!;
            await readerApi.command(key, { method: 'POST', path: '/v1/follows', body: {
              profile: 'follow-command-v1', actingSubject: seeded.reader, target: work.work,
              kind: 'work', following: true, expectedRevision: null } });
            const state = await readerApi.read<{ following: boolean }>(
              `/v1/me/follow-state?actingSubject=${encodeURIComponent(seeded.reader)}&target=${encodeURIComponent(work.work)}&kind=work`);
            assert.equal(state.following, true);
          } else {
            const work = works[0]!;
            const edit = await api.command<{ draftRevision: string }>(key, { method: 'POST',
              path: '/v1/contribution-edits', body: { profile: 'text-contribution-v1',
                contribution: work.contribution, expectedHead: historyHead ?? work.draftRevision,
                actingSubject: seeded.unrelatedAuthor, body: `Historical Home draft ${index}` } });
            historyHead = edit.draftRevision;
            const head = await api.read<{ draftHead: string }>(`/v1/contributions/${work.contribution.slice(-36)}?actingSubject=${encodeURIComponent(seeded.unrelatedAuthor)}`);
            assert.equal(head.draftHead, historyHead);
          }
          dimensions[dimension]++;
          assert(performance.now() - preparationStarted < 600_000, 'Corpus preparation exceeded 600 seconds');
        }
        await home.project();
        if (dimension === 'unrelatedWorks') {
          // An empty bounded candidate page is useful only if continuation
          // eventually reaches the older followed Work. Exercise that oracle
          // outside each individual request's trace and latency measurement.
          let cursor: string | null = null, found = false, pages = 0;
          const cursors = new Set<string>();
          const maximumPages = Math.ceil((target + 1) / 8) + 1;
          for (; pages < maximumPages && !found; pages++) {
            const path = seeded.signed('/v1/feed?scope=following&sort=new')
              + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
            const response = await home.app.handle(new Request(`http://main.local${path}`, {
              headers: { authorization: `Bearer ${home.reader.token}` } }));
            const page = await response.json() as { items: { target: { work: string } }[]; nextCursor: string | null };
            assert.equal(response.status, 200);
            found = page.items.some(item => item.target.work === seeded.work.work);
            cursor = page.nextCursor;
            if (cursor) {
              assert(!cursors.has(cursor), 'A continuation must advance, never replay a completed prefix');
              cursors.add(cursor);
            }
            if (!cursor && !found) break;
          }
          assert(found, 'Following New lost the older followed Work behind unrelated candidates');
          continuations.push({ scale, unrelatedWorks: target, pages });
        }
        for (const temperature of ['cold', 'warm']) {
          for (const operation of operations) {
            captureSources = scale === 'large' && temperature === 'warm' && operation.name === 'anonymous Best';
            const firstQuery = sourceQueries.length;
            const measured = await profileRequest(sink, async headers => {
              if (operation.token) headers.set('authorization', `Bearer ${operation.token}`);
              const response = await home.app.handle(new Request(`http://main.local${operation.path}`, { headers }));
              const body = await response.text();
              if (response.status !== 200) throw new Error(`${operation.name}: ${response.status} ${body}`);
              const page = JSON.parse(body) as { items: { viewerState?: { status: string };
                time: string; reason: { kind: string }; target: { work: string }; post: { excerpt: string | null } }[];
                nextCursor: string | null };
              if (operation.name.includes('Best') || operation.name.includes('New')) {
                // Following's bounded candidate page may be sparse, but it
                // must retain a continuation until its relation is exhausted.
                assert(page.items.length > 0 || operation.token && page.nextCursor,
                  'A populated Feed must return items or its remaining candidate cursor');
                const knownWorks = new Set([seeded.work.work, ...works.map(work => work.work)]);
                assert(page.items.every(item => knownWorks.has(item.target.work)), 'Feed returned an unrelated target');
                assert(page.items.every(item => item.post.excerpt?.startsWith('Home cost ')), 'Feed lost selected text');
                assert(page.items.every(item => item.viewerState?.status ===
                  (operation.token ? 'available' : 'anonymous')), 'Feed reader state differs');
                if (operation.name.includes('New')) assert.deepEqual(page.items.map(item => item.time),
                  page.items.map(item => item.time).sort().reverse());
                if (operation.name === 'signed New') assert(page.items.every(item => item.reason.kind === 'followed'),
                  'Following New must never fill with unrelated recommendations');
              }
              return page.items.length;
            }, { service: 'main', flush: flushTelemetryTraces });
            assert(measured.profile.postgresStatements !== null && measured.profile.postgresStatements > 0, 'SQL spans must be observed');
            assert(measured.profile.fusekiRequests !== null && measured.profile.fusekiRequests > 0, 'Fuseki spans must be observed');
            evidence.push({ dimension, dimensions: { ...dimensions }, scale, temperature,
              operation: operation.name, items: measured.result, profile: measured.profile });
            if (dimension === 'follows' && scale === 'large' && temperature === 'warm'
              && ['signed Best', 'signed New'].includes(operation.name)) {
              // Replay the former closing full read on the exact same corpus.
              // This isolates the algorithm change from fixture/host variation.
              const owner = home.deps.homePersonal, fence = owner.fence.bind(owner);
              owner.fence = async (...args) => ({ revision: (await owner.read(...args)).revision });
              try {
                const baseline = await profileRequest(sink, async headers => {
                  headers.set('authorization', `Bearer ${operation.token}`);
                  const response = await home.app.handle(new Request(`http://main.local${operation.path}`, { headers }));
                  const page = await response.json() as { items: unknown[] };
                  assert.equal(response.status, 200);
                  assert.equal(page.items.length, measured.result);
                }, { service: 'main', flush: flushTelemetryTraces });
                assert.equal(baseline.profile.fusekiRequests, measured.profile.fusekiRequests);
                assert.equal(baseline.profile.postgresStatements, measured.profile.postgresStatements! + 1);
                comparison.push({ operation: operation.name, items: measured.result,
                  before: baseline.profile, after: measured.profile });
              } finally { owner.fence = fence; }
            }
            if (captureSources) {
              const captured = sourceQueries[firstQuery];
              assert(captured, 'Feed source query must be captured');
              const plan = captureFusekiQueryPlan(captured!, { label: `g-1025-${dimension.toLowerCase()}` });
              assert(plan.bytes > 0, 'ARQ plan must contain algebra');
              assert(plan.candidates.returnedBindings !== null && plan.candidates.returnedBindings > 0);
              // This owner query reports returned references, not native candidates.
              assert.equal(plan.candidates.counts, null);
              plans.push(plan);
            }
            captureSources = false;
            sink.clear();
          }
        }
      }
      for (const operation of operations) for (const temperature of ['cold', 'warm']) {
        assertWorkCostAtScales(evidence.filter(row => row.dimension === dimension &&
          row.operation === operation.name && row.temperature === temperature).map(row => row.profile),
        operation.cost);
      }
    }
  } finally {
    mkdirSync('.temp/work-profiles', { recursive: true });
    writeFileSync('.temp/work-profiles/g-1025-home.json', JSON.stringify({
      basis: 'isolated real Main/Fuseki/PostgreSQL; fixture Account assertion; first/repeated reads, not engine cache eviction; no stopped backup/restore qualification',
      plans, continuations, comparison, evidence }, null, 2) + '\n');
    await home.stop();
    await shutdownTelemetry();
    await sink.stop();
  }
}
await profileHome();
