import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry }
  from '../../../packages/observability/src/runtime.ts';
import { TRENDING_WORK_COST } from '../../../services/main/src/modules/feed/cost-contract.ts';
import { runWorkProfileChild } from '../support/work-profile-child.ts';
import { assertWorkCostAtScales, profileRequest, startWorkProfileSink,
  type WorkCostField, type WorkProfile } from '../support/work-profile.ts';

interface Reading {
  hiddenWorks: number;
  sample: number;
  chunks: number;
  examined: number;
  candidateLimits: number[];
  responseBytes: number;
  profile: WorkProfile;
}

function maximumForChunks(chunks: number): Partial<Record<WorkCostField, number>> {
  return Object.fromEntries(Object.entries(TRENDING_WORK_COST.base).map(([field, base]) =>
    [field, base + TRENDING_WORK_COST.perRejectedChunk[field as keyof typeof TRENDING_WORK_COST.base] * chunks]));
}

// A separate process starts instrumentation before pg and HTTP clients load.
// Keeping its entry here gives this qualification one claimed test artifact.
if (process.env.REZICS_TRENDING_PROFILE_CHILD === '1') {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main' });
  const { startHomeStack } = await import('./feed-read-support.ts');
  const { grantFixtureAuthority } =
    await import('../../../services/main/src/modules/access/fixture-authority.ts');
  const { ReadRankingProjection, rankingBuckets } =
    await import('../../../services/main/src/modules/rankings/projection.ts');
  const { RankingHomeTrendingReader, TRENDING_COST } =
    await import('../../../services/main/src/modules/feed/trending.ts');
  const { createMainApp } = await import('../../../services/main/src/app.ts');
  const home = await startHomeStack('feed-trending-growth', { projectionStart: 'current' });
  const evidence: Reading[] = [];
  try {
    const prepared = performance.now();
    const author = await home.provision('Trending author', home.author.token);
    const reader = await home.provision('Trending reader', home.reader.token);
    const grant = async (scope: string, action: string) => grantFixtureAuthority(home.stack.accessPool, {
      scope, requireDispatch: true,
      representations: [{ principalId: home.author.principalId, actor: author,
        action, lifetime: '8 hours' }],
      grant: { actor: author, action, lifetime: '8 hours' },
    });
    const realms: string[] = [];
    // The per-Realm diversity bound is two, so five eligible Works need three
    // placements' Realms. Assign after sorting to keep every five diverse.
    for (let index = 0; index < 3; index++) {
      const realm = await home.json<{ realm: string }>(await home.call('POST', '/v1/spaces', {
        profile: 'space-realm-v1', name: `Trending community ${index}`,
        capabilities: ['realm'], actingSubject: author,
      }, home.author.token), 201);
      realms.push(realm.realm);
      await grant(`publication:adopt:${realm.realm}`, 'publication.adopt');
    }
    const works: Awaited<ReturnType<typeof home.stack.publicWork>>[] = [];
    for (let index = 0; index < 64 + TRENDING_WORK_COST.pageSize; index++) {
      works.push(await home.stack.publicWork(author, ['en'], `Trending Work ${index}`));
    }
    works.sort((a, b) => a.work.localeCompare(b.work));
    for (const [index, work] of works.entries()) {
      await home.json(await home.call('POST', '/v1/publication-selections', {
        profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: realms[index % 3] },
        work: work.work, mainVersion: work.mainVersion,
        contribution: work.variants[0]!.contribution,
        publicationDecision: work.variants[0]!.decision, expectedSelectionHead: null,
        selectionBasis: 'realm-manager-review', actingSubject: author,
      }, home.author.token), 201);
      await grant(`work:read:${work.work}`, 'work.read');
      // Whole-Work progress emits the ranking owner's real reads signal; no
      // fabricated score or admission row can stand in for the Works axis.
      await home.json(await home.call('PUT', `/v1/works/${work.work.slice(-36)}/progress`, {
        actingSubject: author, expectedVersion: 0, standing: 'started',
      }, home.author.token));
    }
    const projection = new ReadRankingProjection(home.stack.accessPool, home.stack.content,
      home.stack.contentPool, home.stack.env);
    let settled = false;
    for (let tick = 0; tick < 400; tick++) {
      if (await projection.tick() === 0) { settled = true; break; }
    }
    assert.equal(settled, true, 'Ranking fixture did not settle within its preparation budget');
    const checkpoint = await projection.current();
    const ranked = await projection.candidates(checkpoint.generation, 'reads', 'day',
      rankingBuckets(new Date(), 'day').current, 'growth', null, 100);
    assert.deepEqual(ranked.map(row => row.work), works.map(work => work.work));
    assert.ok(ranked.every(row => row.growth === '1' && row.score === '1'));
    assert.ok(performance.now() - prepared < 600_000, 'Fixture preparation exceeded ten minutes');

    let measured: { limits: number[]; examined: number } | undefined;
    const candidates = projection.candidates.bind(projection);
    projection.candidates = async (...args) => {
      const rows = await candidates(...args);
      if (measured) {
        measured.limits.push(args[6]);
        // The extra row is only the continuation witness, never examined.
        measured.examined += Math.min(rows.length, args[6] - 1);
      }
      return rows;
    };
    const app = createMainApp(home.stack.fuseki, { ...home.deps, readRankings: projection,
      homeTrending: new RankingHomeTrendingReader(projection) });
    let hidden = 0;
    for (const hiddenWorks of [4, 16, 64]) {
      for (; hidden < hiddenWorks; hidden++) {
        await home.json(await home.call('POST', '/v1/me/feed-feedback', {
          actingSubject: reader, kind: 'work', target: works[hidden]!.work, strength: 'hide',
        }, home.reader.token));
      }
      for (let sample = 0; sample < 3; sample++) {
        measured = { limits: [], examined: 0 };
        const read = measured;
        const { profile, result: responseBytes } = await profileRequest(sink, async headers => {
          headers.set('authorization', `Bearer ${home.reader.token}`);
          const response = await app.handle(new Request(`http://main.local/v1/trending?scope=global&window=day&actingSubject=${encodeURIComponent(reader)}`, { headers }));
          const text = await response.text();
          assert.equal(response.status, 200, text);
          const page = JSON.parse(text) as { items: { work: string; realm: string; rank: number }[];
            hasMore: boolean; cursor: string | null };
          assert.deepEqual(page.items.map(item => item.work),
            works.slice(hiddenWorks, hiddenWorks + TRENDING_WORK_COST.pageSize).map(work => work.work));
          assert.ok(page.items.every((item, index) => item.rank === index + 1));
          for (const realm of realms) assert.ok(page.items.filter(item => item.realm === realm).length <= TRENDING_COST.realmCap);
          assert.equal(typeof page.hasMore, 'boolean');
          assert.equal(page.hasMore, page.cursor !== null);
          assert.ok(Buffer.byteLength(text) <= TRENDING_COST.responseBytes);
          return Buffer.byteLength(text);
        }, { service: 'main', flush: flushTelemetryTraces });
        measured = undefined;
        assert.ok(read.limits.every(limit => limit > 1 && limit <= TRENDING_WORK_COST.chunkSize + 1));
        assert.equal(read.examined, hiddenWorks + TRENDING_WORK_COST.pageSize);
        assert.ok(read.examined <= TRENDING_WORK_COST.examinedLimit);
        assert.ok(read.limits.length <= Math.ceil(hiddenWorks / TRENDING_WORK_COST.chunkSize) + 2);
        evidence.push({ hiddenWorks, sample, chunks: read.limits.length,
          examined: read.examined, candidateLimits: read.limits, responseBytes, profile });
        sink.clear();
      }
      const readings = evidence.filter(reading => reading.hiddenWorks === hiddenWorks);
      assert.equal(new Set(readings.map(reading => reading.chunks)).size, 1);
      // WorkProfile has no Works/population dimension. Assert the existing
      // counters at every real scale without relabeling latency or a call count
      // as Works to manufacture a growth-class verdict.
      assertWorkCostAtScales(readings.map(reading => reading.profile), {
        ...maximumForChunks(readings[0]!.chunks), accountCalls: 0, otherFetches: 0, unclassifiedFetches: 0,
      }, `feed-trending-hidden-${hiddenWorks}`);
    }
    assertWorkCostAtScales(evidence.map(reading => reading.profile), {
      ...maximumForChunks(Math.max(...evidence.map(reading => reading.chunks))),
      accountCalls: 0, otherFetches: 0, unclassifiedFetches: 0,
    }, 'feed-trending-hidden-growth');
  } finally {
    const resultPath = process.env.REZICS_WORK_PROFILE_RESULT;
    if (!resultPath) throw new Error('Work profile result path is required');
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, `${JSON.stringify({ growthClass: TRENDING_WORK_COST.growthClass,
      qualificationGaps: ['Works/population scale dimension', 'incoming Main exchange and response/request wire bytes',
        'native Jena operators', 'SQL plan rows/buffers/WAL'], readings: evidence }, null, 2)}\n`);
    await home.stop();
    await shutdownTelemetry();
    await sink.stop();
  }
} else {
  const { test } = await import('bun:test');
  void test('G282: Trending refills five eligible Works at 4/16/64 feedback-hidden ranked Works within its declared work cost', async () => {
    if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
    const { resultPath } = await runWorkProfileChild('tests/qa/integration/feed-trending-growth.test.ts', {
      env: { REZICS_TRENDING_PROFILE_CHILD: '1' }, timeoutMs: 590_000,
    });
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { readings: Reading[] };
    assert.equal(result.readings.length, 9);
    assert.deepEqual([...new Set(result.readings.map(reading => reading.hiddenWorks))], [4, 16, 64]);
    console.log('Trending growth profile artifact', resultPath);
    console.log('Trending hidden-Work growth readings', JSON.stringify(result.readings.map(reading => ({
      hiddenWorks: reading.hiddenWorks, sample: reading.sample, chunks: reading.chunks,
      examined: reading.examined, mainCalls: reading.profile.mainCalls,
      fusekiRequests: reading.profile.fusekiRequests, postgresStatements: reading.profile.postgresStatements,
      fusekiSentBytes: reading.profile.fusekiSentBytes, fusekiReceivedBytes: reading.profile.fusekiReceivedBytes,
      responseBytes: reading.responseBytes,
    }))));
  }, 600_000);
}
