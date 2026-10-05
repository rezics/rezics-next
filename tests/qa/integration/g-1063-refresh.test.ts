import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startMediaStack } from './media-support.ts';
import {
  DiscoveryProjection,
  discoveryScopeKey,
} from '../../../services/main/src/modules/discovery/store.ts';
import {
  DiscoveryRefreshStore,
  DISCOVERY_REFRESH_COST,
} from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { DiscoveryRefreshInputs } from '../../../services/main/src/modules/discovery/source.ts';
import {
  initializeRelayCheckpoint,
  relayMainOutboxOnce,
} from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { FollowsStore } from '../../../services/main/src/modules/follows/store.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { RecommendationStale } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { RankingGenerations } from '../../../services/main/src/modules/recommendation/ranking.ts';
import { RankingBuildWorker } from '../../../services/main/src/modules/recommendation/build-worker.ts';
import {
  graphZeroSnapshot,
  graphZeroCandidates,
} from '../../../services/main/src/modules/recommendation/zero-candidates.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('G1063: rating/follow readiness, retained cursors, concurrent edits during a build, rollback and terminal retention', async () => {
  const f = await startMediaStack('g-1063-refresh', { agents: true, library: true });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const a = await f.member('writer');
    const controlled = await json<{ agent: string }>(
      await a.send('POST', '/v1/agents', {
        profile: 'agent-provision-v1',
        kind: 'person',
        displayName: 'G1063 reader',
      }),
      201,
    );
    const originals = [];
    for (let i = 0; i < 3; i++)
      originals.push(await f.publicWork(a.actor, ['en'], `G1063 original ${i}`));
    await a.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const { context } = await json<{ context: string }>(
      await a.send('POST', '/v1/global-rating-contexts', {
        profile: 'global-rating-standing-context-v1',
        question: 'Quality?',
        actingSubject: a.actor,
      }),
      201,
    );
    await a.grant(`rating:observe:${context}`, 'rating.observation.set');
    const consumer = `g1063-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, f.env.lineage.dataEpoch);
    const drain = async () => {
      for (let i = 0; i < 100; i++)
        if (!(await relayMainOutboxOnce(f.fuseki, relay, consumer))) return;
      throw new Error('Relay budget');
    };
    await drain();
    const projection = new DiscoveryProjection(f.accessPool),
      store = new DiscoveryRefreshStore(f.accessPool);
    const rankings = new RankingGenerations({
      access: f.accessPool,
      relay,
      dataEpoch: f.env.lineage.dataEpoch,
      cursorKey: new Uint8Array(32),
      leaseMs: 1000,
      signalBatches: 1,
      zeroSnapshot: () => graphZeroSnapshot(f.env),
      zeroCandidates: graphZeroCandidates(f.env),
      canReadWork: (principal, actor, work) => f.access.canReadWork(principal, actor, work),
    });
    const rankingWorker = new RankingBuildWorker(f.accessPool, rankings);
    rankingWorker.enablePublicRefresh();
    const base = { scope: 'global' as const, realm: null, context: null, owner: null };
    const rated = { ...base, context };
    const deps = {
      environment: f.env,
      access: f.access,
      media: f.media,
      discovery: projection,
      account: { verify: async () => ({ ...a.principal, emailVerified: true }) },
      discoveryRefreshInputs: new DiscoveryRefreshInputs(relay, consumer),
      relayPosition: new RelayHandoffPositions(relay, consumer),
      follows: new FollowsStore(f.accessPool),
      recommendations: rankings,
    };
    const worker = new DiscoveryRefreshWorker(deps, store, projection);
    const app = createMainApp(f.fuseki, deps);
    const read = (path: string) => app.handle(new Request(`http://main.local${path}`));
    await store.enroll([base, rated]);
    await f.accessPool.query(
      "UPDATE access.discovery_refresh_catalog SET due_at=clock_timestamp()+interval '1 hour'",
    );
    const due = () =>
      f.accessPool.query(
        "UPDATE access.discovery_refresh SET due_at=clock_timestamp()-interval '1 second' WHERE priority=0",
      );
    const tick = async () => {
      await due();
      return worker.tick();
    };
    const healthy = async () => (await read('/health/rating-ready')).status === 200;
    for (let i = 0; i < 8 && !(await healthy()); i++) expect(await tick()).not.toBe('retry');
    expect(await healthy()).toBe(true);
    for (let i = 0; i < 16 && (await read('/health/discovery-ready')).status !== 200; i++)
      await rankingWorker.tick();
    expect((await read('/health/discovery-ready')).status).toBe(200);
    const prior = await projection.active(rated, (await deps.relayPosition.read())!);
    const page = await json<{ nextCursor: string | null; items: unknown[] }>(
      await read(`/v1/works?context=${context}&limit=1`),
    );
    expect(page.nextCursor).not.toBeNull();
    const writeStarted = performance.now();
    await json(
      await a.send('POST', '/v1/global-rating-observations', {
        profile: 'global-rating-standing-observation-v1',
        context,
        work: originals[0]!.work,
        mainVersion: originals[0]!.mainVersion,
        value: 4,
        expectedRevisionHead: null,
        actingSubject: a.actor,
      }),
      201,
    );
    await drain();
    expect(await healthy()).toBe(false);
    for (let i = 0; i < 8 && !(await healthy()); i++) expect(await tick()).not.toBe('retry');
    expect(await healthy()).toBe(true);
    expect((await read('/health/discovery-ready')).status).toBe(200);
    expect(performance.now() - writeStarted).toBeLessThan(DISCOVERY_REFRESH_COST.recoveryMs);
    const position = (await deps.relayPosition.read())!;
    const current = await projection.active(rated, position);
    expect(current.changed_works).toEqual([originals[0]!.work]);
    expect(current.storage_generation).toBe(prior.generation_id);
    expect(
      (await projection.page(current, 'top-rated', '', '', 20)).map((row) => [
        row.work,
        row.payload.rating?.mean,
      ]),
    ).toEqual([[originals[0]!.work, 4]]);
    expect(await projection.page(prior, 'top-rated', '', '', 20)).toEqual([]);
    expect(
      (
        await read(
          `/v1/works?context=${context}&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
        )
      ).status,
    ).toBe(200);

    const generations = (
      await f.accessPool.query('SELECT count(*)::int AS n FROM access.discovery_generation')
    ).rows[0].n;
    const followStarted = performance.now();
    await json(
      await app.handle(
        new Request('http://main.local/v1/follows', {
          method: 'POST',
          headers: {
            authorization: 'Bearer writer',
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify({
            profile: 'follow-command-v1',
            actingSubject: controlled.agent,
            target: originals[0]!.work,
            kind: 'work',
            following: true,
            expectedRevision: null,
          }),
        }),
      ),
    );
    await drain();
    for (let i = 0; i < 3; i++) expect(await tick()).not.toBe('retry');
    expect(await healthy()).toBe(true);
    expect((await read('/health/discovery-ready')).status).toBe(200);
    expect(performance.now() - followStarted).toBeLessThan(DISCOVERY_REFRESH_COST.recoveryMs);
    expect(
      (await f.accessPool.query('SELECT count(*)::int AS n FROM access.discovery_generation'))
        .rows[0].n,
    ).toBe(generations);

    // Finish the population and pin its catch-up pass, then edit an existing
    // Work and append another. Restarted workers activate at the catch-up cut;
    // later writes remain stale until the following refresh covers them.
    const pending = await projection.register(automaticDiscovery(null), base, position, {
      idempotencyKey: randomUUID(),
      requestDigest: 'b'.repeat(64),
    });
    const beforeScan = await f.publicWork(a.actor, ['en'], 'Append before resumed scan');
    await drain();
    const catchupPosition = (await deps.relayPosition.read())!;
    const commit = projection.commitBatch.bind(projection);
    projection.commitBatch = (operator, id, lease, checkpoint, result, pin) => {
      const first = result.items[0];
      return commit(
        operator,
        id,
        lease,
        checkpoint,
        !result.nextPass && result.items.length > 1
          ? { after: first!.work, complete: false, items: [first!] }
          : result,
        pin,
      );
    };
    await f.accessPool.query(
      "UPDATE access.discovery_refresh SET due_at=clock_timestamp()+interval '1 hour' WHERE scope_key<>$1",
      [discoveryScopeKey(base)],
    );
    const baseTick = async () => {
      await f.accessPool.query(
        "UPDATE access.discovery_refresh SET due_at=clock_timestamp()-interval '1 second' WHERE scope_key=$1",
        [discoveryScopeKey(base)],
      );
      return new DiscoveryRefreshWorker(deps, store, projection).tick();
    };
    expect(await baseTick()).toBe('advanced');
    await a.grant(`work:edit:${originals[0]!.work}`, 'work.edit');
    const header = await json<{ revision: string }>(
      await read(`/v1/works/${originals[0]!.work.slice(-36)}`),
    );
    await json(
      await a.send(
        'PUT',
        `/v1/works/${originals[0]!.work.slice(-36)}/type`,
        {
          profile: 'work-type-v3',
          expectedHead: header.revision,
          types: ['https://schema.org/Book'],
          actingSubject: a.actor,
        },
        randomUUID(),
      ),
    );
    const appended = await f.publicWork(a.actor, ['en'], 'Appended during pinned build');
    await drain();
    const latestPosition = (await deps.relayPosition.read())!;
    projection.commitBatch = commit;
    expect(await baseTick()).toBe('activated');
    expect(
      (
        await f.accessPool.query('SELECT state FROM access.derived_generation WHERE id=$1', [
          pending.generation_id,
        ])
      ).rows[0].state,
    ).toBe('ready');
    const cut = await projection.active(base, latestPosition);
    expect(cut.generation_id).toBe(pending.generation_id);
    expect(cut.stale).toBe(true);
    expect(cut.source_sequence).toBe(catchupPosition.sequence);
    expect(cut.covered_sequence).toBe(catchupPosition.sequence);
    expect(BigInt(cut.covered_sequence!)).toBeLessThan(BigInt(latestPosition.sequence));
    expect(cut.work_count).toBe('4');
    const cutWorks = (await projection.page(cut, 'recent', '', '', 20)).map((row) => row.work);
    expect(cutWorks).toContain(beforeScan.work);
    expect(cutWorks).not.toContain(appended.work);
    expect(
      (
        await f.accessPool.query<{ checkpoint: string }>(
          `SELECT checkpoint_sequence::text AS checkpoint FROM access.derived_generation_input
          WHERE generation_id=$1 AND source='main-graph'`,
          [cut.generation_id],
        )
      ).rows[0]!.checkpoint,
    ).toBe(catchupPosition.sequence);

    expect(await baseTick()).toBe('activated');
    const built = await projection.active(base, latestPosition);
    expect(built.generation_id).not.toBe(cut.generation_id);
    expect(built.storage_generation).toBe(cut.generation_id);
    expect(built.stale).toBe(false);
    expect(built.covered_sequence).toBe(latestPosition.sequence);
    expect(built.changed_works).toEqual([originals[0]!.work, appended.work].sort());
    expect(built.work_count).toBe('5');
    expect((await projection.page(built, 'recent', '', '', 20)).map((row) => row.work)).toContain(
      appended.work,
    );
    expect((await projection.page(cut, 'recent', '', '', 20)).map((row) => row.work)).not.toContain(
      appended.work,
    );
    expect(
      (
        await f.accessPool.query(
          "SELECT count(*)::int AS n FROM access.derived_generation WHERE family='discovery' AND state='cancelled'",
        )
      ).rows[0].n,
    ).toBe(0);

    // A staged version rolls back on cancellation, including term intervals.
    const staged = await projection.register(
      automaticDiscovery(null),
      base,
      (await deps.relayPosition.read())!,
      { idempotencyKey: randomUUID(), requestDigest: 'c'.repeat(64) },
      { generation: built.generation_id, works: [originals[0]!.work] },
    );
    const step = await projection.beginStep(automaticDiscovery(null), staged.generation_id, '');
    await projection.commitBatch(
      automaticDiscovery(null),
      staged.generation_id,
      step.lease,
      '',
      { after: originals[0]!.work, complete: false, items: [] },
      { dataEpoch: staged.source_epoch, sequence: staged.source_sequence },
    );
    await projection.cancel(automaticDiscovery(null), staged.generation_id);
    expect(await projection.page(built, 'recent', '', '', 20)).toHaveLength(5);
    await f.accessPool.query(
      "UPDATE access.derived_generation SET finished_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
      [staged.generation_id],
    );
    await f.accessPool.query(
      "UPDATE access.discovery_retirement SET due_at=clock_timestamp()-interval '1 hour' WHERE generation_id=$1",
      [staged.generation_id],
    );
    for (let i = 0; i < 10; i++) await store.purge();
    expect(
      (
        await f.accessPool.query(
          'SELECT generation_id FROM access.discovery_generation WHERE generation_id=$1',
          [staged.generation_id],
        )
      ).rows,
    ).toHaveLength(0);
    expect(await projection.page(built, 'recent', '', '', 20)).toHaveLength(5);

    // Exact source/lease fences still reject a delayed writer.
    await due();
    const old = await store.claim();
    await due();
    await store.claim();
    await expect(store.finish(old!, null, 'current', 0, 0)).rejects.toBeInstanceOf(
      RecommendationStale,
    );
    expect((await projection.page(built, 'recent', '', '', 20)).map((row) => row.work)).toContain(
      beforeScan.work,
    );
  } finally {
    await relay.end();
    await f.stop();
  }
}, 180_000);
