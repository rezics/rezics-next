import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { RankingBuildWorker } from '../../../services/main/src/modules/recommendation/build-worker.ts';
import { RankingGenerations } from '../../../services/main/src/modules/recommendation/ranking.ts';
import { PUBLIC_DISCOVERY_RANKING, DISCOVERY_RANKING_HEALTH_COST }
  from '../../../services/main/src/modules/discovery/public-ranking.ts';
import { graphZeroCandidates, graphZeroSnapshot, WORK_CANDIDATE_MEMBERSHIP_COST }
  from '../../../services/main/src/modules/recommendation/zero-candidates.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { meteredPool, requireQa } from './recommendation-support.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

interface Health {
  status: string; generation: string | null; sequenceLag: string | null; stale: boolean;
  buildFailure: { generation: string; reason: string } | null;
}

test('public ranking counts target-form Work receipts, skips non-Works and reports strict failures until recovery', async () => {
  const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'privileged');
  let stack: MediaStack | undefined;
  const relay = new Pool({ connectionString: owners.urls.relay });
  try {
    stack = await startMediaStack('public-ranking-target-receipts', { ownerUrls: owners.urls, profileCredits: true });
    const writer = await stack.member('ranking receipt writer');
    const work = await stack.publicWork(writer.actor);
    const accessMeter = meteredPool(stack.accessPool);
    const rankings = new RankingGenerations({ access: accessMeter.pool, relay,
      dataEpoch: stack.env.lineage.dataEpoch, cursorKey: new Uint8Array(32),
      zeroSnapshot: () => graphZeroSnapshot(stack!.env), zeroCandidates: graphZeroCandidates(stack.env),
      canReadWork: (principal, actor, candidate) => stack!.access.canReadWork(principal, actor, candidate),
    });
    const principal = { ...writer.principal, emailVerified: true as const };
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, recommendations: rankings,
      account: { verify: async () => ({ ...principal, currentAssertion: async () => principal }) } });
    const call = (method: string, path: string, body?: object) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${writer.token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const json = async <T>(response: Response, status = 201): Promise<T> => {
      expect(response.status, await response.clone().text()).toBe(status);
      return await response.json() as T;
    };
    const health = async () => json<Health>(await call('GET', '/health/discovery-ready'), 200);
    await writer.grant('space:create:root', 'space.create');
    const { realm } = await json<{ realm: string }>(await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Ranking receipt population', language: 'en', capabilities: ['realm'],
      actingSubject: writer.actor,
    }));
    await writer.grant('semantic:create:root', 'semantic.change');
    const { component: character } = await json<{ component: string }>(await call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: writer.actor,
      state: { component: 'resource', types: ['https://rezics.com/vocab/Character'], properties: [{
        predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: 'Ranking character', language: 'en', direction: 'ltr' },
      }] },
    }));
    await writer.grant(`semantic:read:${character}`, 'semantic.read');
    await writer.grant(`rating:context:${realm}`, 'rating.context.create');
    let characterRating: { context: string; observationRevision: string } | undefined;
    for (const [target, targetGrain, value] of [[work.work, 'work', 7], [character, 'resource', 10]] as const) {
      const { context } = await json<{ context: string }>(await call('POST', '/v1/rating-contexts', {
        profile: targetGrain === 'work' ? 'realm-standing-rating-context-v1' : 'realm-target-rating-context-v3',
        realm, question: 'How good is this target?', actingSubject: writer.actor,
        ...(targetGrain === 'work' ? {} : { language: 'en', targetGrain }),
      }));
      await writer.grant(`rating:observe:${context}`, 'rating.observation.set');
      const opinion = await json<{ observationRevision: string }>(await call('POST', '/v1/rating-observations', { profile: targetGrain === 'work' ? 'realm-standing-rating-observation-v1' : 'realm-target-rating-observation-v1',
        context, value, expectedRevisionHead: null, actingSubject: writer.actor,
        ...(targetGrain === 'work' ? { work: target, mainVersion: work.mainVersion } : { target }) }));
      if (target === character) characterRating = { context, observationRevision: opinion.observationRevision };
    }
    const consumer = `ranking-target-receipts-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, stack.env.lineage.dataEpoch);
    const drain = async () => {
      for (let i = 0; i < 100; i++) {
        if (!await relayMainOutboxOnce(stack!.fuseki, relay, consumer)) return;
      }
      throw new Error('Relay fixture exceeded its batch bound');
    };
    await drain();
    // Work's command currently emits the legacy form. Replay its real sealed
    // admission in the relay's admitted target form to exercise that consumer
    // contract without adding a new rating command to this regression fix.
    await relay.query(`UPDATE relay.delivered_event SET envelope=jsonb_set(envelope,'{data,receipt}',
      ((envelope->'data'->'receipt') - 'work' - 'main') || jsonb_build_object('target',$2::text))
      WHERE data_epoch=$1 AND envelope->>'type'='com.rezics.rating.observation-changed.v1'
        AND envelope->'data'->'receipt'->>'work'=$2`, [stack.env.lineage.dataEpoch, work.work]);
    const receipts = (await relay.query<{ sequence: string; event_id: string; envelope: {
      data: { receipt: { target: string; work?: string; main?: string } } } }>(`
      SELECT sequence::text,event_id,envelope FROM relay.delivered_event WHERE data_epoch=$1
        AND envelope->>'type'='com.rezics.rating.observation-changed.v1' ORDER BY sequence`,
    [stack.env.lineage.dataEpoch])).rows;
    expect(receipts.map(row => row.envelope.data.receipt.target).sort()).toEqual([work.work, character].sort());
    for (const row of receipts) {
      expect(row.envelope.data.receipt.work).toBeUndefined();
      expect(row.envelope.data.receipt.main).toBeUndefined();
    }
    const snapshot = await graphZeroSnapshot(stack.env), graphQueries = stack.fuseki.queries;
    expect(await graphZeroCandidates(stack.env)(null, snapshot, 2, [work.work, character])).toEqual([work.work]);
    expect(stack.fuseki.queries - graphQueries).toBeLessThanOrEqual(WORK_CANDIDATE_MEMBERSHIP_COST.graphCalls);
    expect(await graphZeroCandidates(stack.env)(null, '0', 2, [work.work, character])).toEqual([]);
    const worker = new RankingBuildWorker(stack.accessPool, rankings);
    worker.enablePublicRefresh();
    const activate = async (previous: string | null = null) => {
      for (let i = 0; i < 100; i++) {
        await worker.tick();
        const state = await rankings.publicRankingStatus();
        if (state && state.generation !== previous) return state;
      }
      throw new Error('Public ranking did not activate within its tick bound');
    };
    const active = await activate();
    expect(await health()).toMatchObject({ status: 'ready', sequenceLag: '0', stale: false, buildFailure: null });
    expect((await stack.accessPool.query('SELECT candidate,score::text FROM access.ranking_score WHERE generation_id=$1',
      [active.generation])).rows).toEqual([{ candidate: work.work, score: '7' }]);
    expect((await rankings.page({ public: true, principal: null, actingSubject: null }, PUBLIC_DISCOVERY_RANKING, 20)).items)
      .toContainEqual({ candidate: work.work });

    // A later real observation makes the serving head stale. Corrupt its
    // retained non-Work receipt: kind exclusion cannot conceal malformed input.
    await json(await call('POST', '/v1/rating-observations', { profile: 'realm-target-rating-observation-v1',
      context: characterRating!.context, target: character, value: 8,
      expectedRevisionHead: characterRating!.observationRevision, actingSubject: writer.actor }));
    await drain();
    const invalid = (await relay.query<{ sequence: string; event_id: string; envelope: object }>(`
      SELECT sequence::text,event_id,envelope FROM relay.delivered_event WHERE data_epoch=$1
        AND envelope->'data'->'receipt'->>'target'=$2 ORDER BY sequence DESC LIMIT 1`,
    [stack.env.lineage.dataEpoch, character])).rows[0]!;
    await relay.query(`UPDATE relay.delivered_event SET envelope=jsonb_set(envelope,'{data,receipt,ratingValue}','11')
      WHERE event_id=$1`, [invalid.event_id]);
    await worker.tick();
    const failure = await rankings.publicRankingBuildFailure();
    expect(failure).toMatchObject({ reason: `source-invalid at ${invalid.sequence}` });
    expect((await stack.accessPool.query('SELECT state,failure_reason FROM access.derived_generation WHERE id=$1',
      [failure!.generation])).rows[0]).toEqual({ state: 'failed', failure_reason: `source-invalid at ${invalid.sequence}` });
    expect(await health()).toMatchObject({ generation: active.generation, stale: true, buildFailure: failure });
    await worker.tick(); // Repeated failure stays visible with its offending sequence.
    expect(await health()).toMatchObject({ buildFailure: { reason: `source-invalid at ${invalid.sequence}` } });
    accessMeter.reset();
    await health();
    expect(accessMeter.count()).toBeLessThanOrEqual(DISCOVERY_RANKING_HEALTH_COST.accessStatements);

    await relay.query('UPDATE relay.delivered_event SET envelope=$2 WHERE event_id=$1', [invalid.event_id, invalid.envelope]);
    const recovered = await activate(active.generation);
    expect(recovered.generation).not.toBe(active.generation);
    expect(await health()).toMatchObject({ status: 'ready', sequenceLag: '0', stale: false, buildFailure: null });
  } finally {
    await relay.end(); await stack?.stop(); await owners.close();
  }
}, 180_000);
