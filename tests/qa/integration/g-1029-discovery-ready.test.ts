import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { migrateTracked, migrationDirectories, migrationRecords } from '../../../scripts/ops/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { RankingBuildWorker } from '../../../services/main/src/modules/recommendation/build-worker.ts';
import { RankingGenerations } from '../../../services/main/src/modules/recommendation/ranking.ts';
import { automaticPublicRanking, DISCOVERY_RANKING_HEALTH_COST, DISCOVERY_RANKING_REFRESH_COST,
  PUBLIC_DISCOVERY_RANKING } from '../../../services/main/src/modules/discovery/public-ranking.ts';
import { RecommendationDenied, RecommendationUnavailable } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { graphZeroCandidates, graphZeroSnapshot } from '../../../services/main/src/modules/recommendation/zero-candidates.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { backfillPublicNames } from '../../../services/main/src/modules/search/names.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { meteredPool, requireQa } from './recommendation-support.ts';
import { waitForRealmDirectory } from './support/realm-directory.ts';
import { measureGraphReads } from './support/graph-reads.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const root = resolve(import.meta.dir, '../../..');
async function until<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== null) return result;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

interface Health { status: string; generation: string | null; sequenceLag: string | null; stale: boolean }
interface Sections { items: { id: string; page: { items: { id: string }[] } }[] }

test('G1029: restored migrated owners bootstrap and resume the public ranking, then replace it without an availability gap', async () => {
  const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'privileged');
  const compose = readEnv(resolve(root, '.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`, 'compose.env'));
  const admin = new Client({ connectionString: `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres` });
  const restored: string[] = [];
  let stack: MediaStack | undefined, relay: Pool | undefined, worker: RankingBuildWorker | undefined;
  let unblockFinish: (() => void) | undefined;
  try {
    // Build once, close every owner connection, and restore exact isolated copies
    // of that consistent PostgreSQL cut. Jena/objects are the QA stack's durable
    // source; restarting Main must not need a build or activation API command.
    stack = await startMediaStack('g-1029-source', { ownerUrls: owners.urls });
    relay = new Pool({ connectionString: owners.urls.relay });
    // QA templates have already applied all owner SQL without the dev/release
    // journal. Give the backup the corresponding real restore migration history.
    for (const [owner, pool] of [['access', stack.accessPool], ['relay', relay]] as const) {
      await pool.query(`CREATE TABLE IF NOT EXISTS public.rezics_local_migration (
        name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      await pool.query(`INSERT INTO public.rezics_local_migration(name)
        SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`, [migrationRecords(root, owner).map(file => file.name)]);
    }
    const writer = await stack.member('G1029 writer');
    const works: { work: string }[] = [];
    for (let i = 0; i < 6; i++) works.push(await stack.publicWork(writer.actor, ['en'], `G1029 original ${i}`));
    const consumer = `g1029-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, stack.env.lineage.dataEpoch);
    const drain = async () => {
      for (let i = 0; i < 100; i++) if (!await relayMainOutboxOnce(stack!.fuseki, relay!, consumer)) return;
      throw new Error('G1029 relay exceeded the fixture batch bound');
    };
    await drain();
    expect((await stack.accessPool.query(`SELECT count(*)::text AS count FROM access.derived_generation WHERE family='ranking'`)).rows[0].count).toBe('0');
    await relay.end(); relay = undefined;
    await stack.stop(); stack = undefined;
    await admin.connect();
    const restoredUrls = { access: '', content: '', relay: '' };
    for (const owner of ['access', 'content', 'relay'] as const) {
      const source = new URL(owners.urls[owner]), target = `g1029_${randomBytes(5).toString('hex')}_${owner}`;
      const sourceName = source.pathname.slice(1);
      if (!/^[a-z0-9_]+$/.test(sourceName)) throw new Error('Unexpected fixture database name');
      await admin.query(`CREATE DATABASE ${target} WITH TEMPLATE ${sourceName}`);
      restored.push(target);
      source.pathname = `/${target}`;
      restoredUrls[owner] = source.toString();
    }
    // Re-run the actual restore/startup SQL migration path, including no-op
    // migration replay, before reconstructing the production stores and worker.
    await migrateTracked(restoredUrls.access, root, migrationDirectories.access);
    await migrateTracked(restoredUrls.relay, root, migrationDirectories.relay);
    stack = await startMediaStack('g-1029-restored', { ownerUrls: restoredUrls });
    relay = new Pool({ connectionString: restoredUrls.relay });
    await backfillPublicNames(stack.env); await drain();
    const accessMeter = meteredPool(stack.accessPool), relayMeter = meteredPool(relay);
    let snapshotUnavailable = false;
    const makeRankings = (dataEpoch = stack!.env.lineage.dataEpoch) => new RankingGenerations({
      access: accessMeter.pool, relay: relayMeter.pool, dataEpoch, cursorKey: new Uint8Array(32), leaseMs: 1000, signalBatches: 1,
      zeroSnapshot: async () => {
        if (snapshotUnavailable) throw new Error('Candidate snapshot temporarily unavailable');
        return graphZeroSnapshot(stack!.env);
      }, zeroCandidates: graphZeroCandidates(stack!.env),
      canReadWork: (principal, actor, work) => stack!.access.canReadWork(principal, actor, work),
    });
    const rankings = makeRankings();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, recommendations: rankings,
      account: { verify: async () => writer.principal } });
    const read = (path: string) => app.handle(new Request(`http://main.local${path}`));
    const health = async () => {
      const response = await read('/health/discovery-ready');
      return { status: response.status, body: await response.json() as Health };
    };
    expect(await health()).toMatchObject({ status: 503, body: { status: 'unavailable', generation: null } });
    const missing = await read('/v1/discovery/sections');
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ code: 'discovery_ranking_unavailable' });

    // This expired pre-restore epoch comes first in the queue. It must neither
    // starve the current epoch nor be activated by the restarted process.
    const obsolete = await makeRankings(randomUUID()).registerBuild(automaticPublicRanking, PUBLIC_DISCOVERY_RANKING, 1,
      { idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
    const start = () => {
      const running = new RankingBuildWorker(stack!.accessPool, rankings, 10);
      running.enablePublicRefresh(); running.start(); return running;
    };
    worker = start();
    const partial = await until(async () => (await stack!.accessPool.query(`SELECT g.id::text,i.checkpoint_sequence::text AS checkpoint
      FROM access.derived_generation g JOIN access.derived_generation_input i ON i.generation_id=g.id
      WHERE g.family='ranking' AND g.state='building' AND i.data_epoch=$1 AND i.checkpoint_sequence>0`,
    [stack!.env.lineage.dataEpoch])).rows[0] ?? null, 'durable partial public build');
    await worker.stop(); worker = undefined;
    expect((await stack.accessPool.query('SELECT state FROM access.derived_generation WHERE id=$1', [partial.id])).rows[0].state).toBe('building');
    await Bun.sleep(1050); // A stopped process releases its persisted lease by expiry.

    // Stop after finish commits, before the next automatic activation tick. A
    // restart must discover this ready generation without an in-memory job ID.
    let finished: string | null = null;
    const release = new Promise<void>(resolveRelease => { unblockFinish = resolveRelease; });
    const finish = rankings.finish.bind(rankings);
    rankings.finish = async (generation, epoch) => {
      const result = await finish(generation, epoch);
      finished = generation; await release; return result;
    };
    worker = start();
    const ready = await until(async () => finished, 'public ranking finish');
    const stopping = worker.stop(); unblockFinish!(); await stopping; worker = undefined;
    rankings.finish = finish;
    expect(ready).toBe(partial.id);
    expect((await stack.accessPool.query('SELECT state FROM access.derived_generation WHERE id=$1', [ready])).rows[0].state).toBe('ready');
    worker = start();
    const available = await until(async () => {
      const result = await health(); return result.status === 200 ? result.body : null;
    }, 'automatic public activation after restart');
    await worker.stop(); worker = undefined;
    expect(available).toMatchObject({ status: 'ready', generation: ready, sequenceLag: '0', stale: false });
    expect((await stack.accessPool.query('SELECT state FROM access.derived_generation WHERE id=$1', [obsolete.generation])).rows[0].state).toBe('building');
    await waitForRealmDirectory(stack.env, () => read('/v1/realms'));
    const sections = await read('/v1/discovery/sections');
    expect(sections.status, await sections.clone().text()).toBe(200);
    expect(((await sections.json()) as Sections).items.find(item => item.id === 'popular')!.page.items.map(item => item.id).sort())
      .toEqual(works.map(work => work.work).sort());

    // Automation has only one fixed public population. Ordinary management
    // still requires a human's grant and a JSON-shaped fake is never authority.
    await expect(rankings.registerBuild(automaticPublicRanking,
      { ...PUBLIC_DISCOVERY_RANKING, population: { kind: 'personal' } }, 1,
      { idempotencyKey: randomUUID(), requestDigest: 'b'.repeat(64) })).rejects.toBeInstanceOf(RecommendationDenied);
    await expect(rankings.registerBuild({ principal: writer.principal, actingSubject: writer.actor }, PUBLIC_DISCOVERY_RANKING, 1,
      { idempotencyKey: randomUUID(), requestDigest: 'c'.repeat(64) })).rejects.toBeInstanceOf(RecommendationDenied);

    const newcomer = await stack.member('G1029 later writer');
    const appended = await stack.publicWork(newcomer.actor, ['en'], 'G1029 later Work');
    await backfillPublicNames(stack.env); await drain();
    expect(await health()).toMatchObject({ status: 200, body: { generation: ready, stale: true } });
    // Two simultaneous Main processes share bootstrap/activation's scope lock.
    await Promise.all([rankings.refreshPublicRanking(), rankings.refreshPublicRanking()]);
    expect((await stack.accessPool.query(`SELECT count(*)::text AS count FROM access.derived_generation g
      JOIN access.derived_generation_input i ON i.generation_id=g.id WHERE g.family='ranking'
        AND g.state='building' AND i.data_epoch=$1`, [stack.env.lineage.dataEpoch])).rows[0].count).toBe('1');
    const failedBuild = (await stack.accessPool.query(`SELECT g.id FROM access.derived_generation g
      JOIN access.derived_generation_input i ON i.generation_id=g.id WHERE g.family='ranking'
        AND g.state='building' AND i.data_epoch=$1`, [stack.env.lineage.dataEpoch])).rows[0].id;
    const failedLease = await rankings.claim(failedBuild);
    await rankings.fail(failedBuild, failedLease, 'g1029-transient-build-failure');
    let servingProbes = 0;
    worker = start();
    const replacement = await until(async () => {
      const status = await health();
      expect(status.status).toBe(200);
      const page = await read('/v1/discovery/sections?section=popular&limit=20');
      expect(page.status, await page.clone().text()).toBe(200);
      const ids = ((await page.json()) as Sections).items[0]!.page.items.map(item => item.id);
      expect(works.every(work => ids.includes(work.work))).toBe(true);
      servingProbes++;
      return status.body.generation !== ready && ids.includes(appended.work) ? status.body : null;
    }, 'replacement while every probe remains available');
    await worker.stop(); worker = undefined;
    expect(replacement).toMatchObject({ status: 'ready', sequenceLag: '0', stale: false });
    expect(servingProbes).toBeGreaterThan(1);
    expect((await stack.accessPool.query('SELECT state FROM access.derived_generation WHERE id=$1', [ready])).rows[0].state).toBe('superseded');
    accessMeter.reset(); relayMeter.reset();
    expect(await rankings.refreshPublicRanking()).toBe('current');
    expect(accessMeter.count()).toBeLessThanOrEqual(DISCOVERY_RANKING_REFRESH_COST.accessStatements);
    expect(relayMeter.count()).toBeLessThanOrEqual(DISCOVERY_RANKING_REFRESH_COST.relayQueries);
    accessMeter.reset(); relayMeter.reset();
    const measuredHealth = await measureGraphReads(() => rankings.publicRankingStatus());
    expect(measuredHealth.value).toMatchObject({ generation: replacement.generation });
    expect(accessMeter.count()).toBeLessThanOrEqual(DISCOVERY_RANKING_HEALTH_COST.accessStatements);
    expect(relayMeter.count()).toBe(1);
    expect(measuredHealth.calls).toBe(0);
    snapshotUnavailable = true;
    await expect(rankings.refreshPublicRanking()).rejects.toBeInstanceOf(RecommendationUnavailable);
    expect((await health()).status).toBe(200);
    snapshotUnavailable = false;
    await stack.accessPool.query('UPDATE access.recovery_fence SET open=false WHERE id');
    expect((await health()).status).toBe(503);
    await stack.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id');
    expect((await health()).status).toBe(200);
  } finally {
    unblockFinish?.();
    await worker?.stop();
    await relay?.end(); await stack?.stop();
    for (const name of restored) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end(); await owners.close();
  }
}, 240_000);
