import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { titleControlFixture } from '../fixtures/title-control.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { cutoverRestoredGraphLineage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce, relayCoverage } from '../../../services/main/src/modules/outbox/relay.ts';
import { reconcileRetainedSourceProjection } from '../../../services/main/src/modules/source/reconcile-restored.ts';
import { reconcileRetainedWorkCreate, RetainedEffectConflict } from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { reconcileRetainedTitleControl } from '../../../services/main/src/modules/work/reconcile-title-control.ts';
import { readTitleControl } from '../../../services/main/src/modules/work/title-control.ts';

const root = resolve(import.meta.dir, '../../..');
function stack(action: 'stack:up' | 'stack:reset', runId: string) {
  const result = spawnSync('corepack', ['yarn', action, '--profile', 'qa', '--run-id', runId],
    { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) throw new Error(`${action}: ${(result.stderr || result.stdout).slice(-2000)}`);
}

test('LIVE03/OPS03: retained Source title restores exact epoch and receipt under graph-loss fence', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the fault/recovery tier');
  const nonce = randomUUID().slice(0, 12), liveId = `title-${nonce}-l`, restoredId = `title-${nonce}-r`;
  const directory = join(root, '.temp', `title-restore-${nonce}`), started: string[] = [];
  let fixture: Awaited<ReturnType<typeof titleControlFixture>> | undefined, relay: Pool | undefined;
  try {
    const start = Date.now();
    for (const run of [liveId, restoredId]) { started.push(run); stack('stack:up', run); }
    const apps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: liveId }), 'apps.env'));
    const restoredApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: restoredId }), 'apps.env'));
    const access = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    relay = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    for (const [owner, pool] of [['access', access], ['relay', relay]] as const) {
      const path = join(root, `services/main/migrations/${owner}`);
      for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: path })].sort()) await pool.query(readFileSync(join(path, file), 'utf8'));
    }
    await access.end();
    fixture = await titleControlFixture({ ...apps, MAIN_ROUTING_EPOCH: '1' }, directory);
    const { env, propose, adoptWork, grantWork, apply, result, state, edit, returnControl,
      grant, json, accessPool, pool } = fixture;
    await initializeFreshGraph(env.fuseki, env.lineage);
    expect(Date.now() - start).toBeLessThan(600_000);
    const consumer = `title:${nonce}`;
    await initializeRelayCheckpoint(relay, consumer, env.lineage.dataEpoch);
    const original = await propose('OL991929W', undefined, 'Original title');
    const work = await adoptWork(original);
    await grantWork(work.work);
    const candidate = await propose('OL991929W', undefined, 'Retained refresh');
    const applied = await result(await apply(work, candidate, await state(work.work)));
    const originalControl = (await state(work.work)).basis.head;
    const human = await json<{ revision: string }>(await edit(await state(work.work), 'Retained refresh'), 200);
    await grant(`work:title:return:${work.work}`, 'work.title.return');
    const returned = await json<{ control: string }>(await returnControl(await state(work.work), candidate), 200);
    for (let position = 1; position <= 6; position++)
      expect((await relayMainOutboxOnce(env.fuseki, relay, consumer))?.sequence).toBe(String(position));
    const coverage = await relayCoverage(relay, consumer);
    const restoredFuseki = new FusekiClient(restoredApps.FUSEKI_URL!, restoredApps.FUSEKI_MAINTENANCE_TOKEN!, restoredApps.FUSEKI_COMMAND_TOKEN!);
    await initializeFreshGraph(restoredFuseki, env.lineage);
    const next = { dataEpoch: randomUUID(), routingEpoch: String(BigInt(env.lineage.routingEpoch) + 1n) };
    await cutoverRestoredGraphLineage(restoredFuseki, { prior: { ...env.lineage, sequence: '0' }, next });
    const restored = { ...env, fuseki: restoredFuseki, lineage: next,
      titleAdmissionKey: restoredApps.FUSEKI_TITLE_ADMISSION_KEY! };
    const replay = () => reconcileRetainedTitleControl(restored, accessPool, relay!, coverage, '4');
    await expect(replay()).rejects.toBeInstanceOf(RetainedEffectConflict);
    await engageAccessRecoveryFence(accessPool);
    await expect(replay()).rejects.toBeInstanceOf(RetainedEffectConflict);
    await reconcileRetainedSourceProjection(restored, accessPool, relay, pool, coverage, '1');
    await reconcileRetainedWorkCreate(restored, accessPool, relay, coverage, '2');
    await reconcileRetainedSourceProjection(restored, accessPool, relay, pool, coverage, '3');
    const first = await replay();
    expect(first).toEqual({ receipt: applied.application.receipt,
      revision: applied.application.workRevision, control: originalControl, replayed: false });
    expect(await replay()).toEqual({ ...first, replayed: true });
    const humanEffect = await reconcileRetainedTitleControl(restored, accessPool, relay, coverage, '5');
    expect(humanEffect.revision).toBe(human.revision);
    const returnEffect = await reconcileRetainedTitleControl(restored, accessPool, relay, coverage, '6');
    expect(returnEffect).toMatchObject({ revision: human.revision, control: returned.control, replayed: false });
    expect(await reconcileRetainedTitleControl(restored, accessPool, relay, coverage, '6'))
      .toEqual({ ...returnEffect, replayed: true });
    const recovered = await readTitleControl(restored, work.work);
    expect(recovered).toMatchObject({ mode: 'source-managed', contentHead: human.revision,
      basis: { epoch: '3', head: returned.control },
      source: { observation: candidate.observation, conversion: candidate.conversion } });
  } finally {
    await fixture?.close(); await relay?.end();
    for (const run of started.reverse()) stack('stack:reset', run);
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
