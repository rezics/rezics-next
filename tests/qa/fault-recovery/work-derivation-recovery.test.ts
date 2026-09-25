import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { initializeRelayCheckpoint, relayCoverage, RelayCheckpointConflict, relayMainOutboxOnce,
  relayRetainedEventAt }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { GRAPHS, ID, RV, initializeFreshGraph, iri, lit,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { createAdmittedWorkDerivation, readWorkDerivations }
  from '../../../services/main/src/modules/work/derivations.ts';
import { reconcileRetainedWorkDerivation }
  from '../../../services/main/src/modules/work/reconcile-derivation.ts';
import { reconcileRetainedWorkCreate, RetainedEffectConflict }
  from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { cutoverRestoredGraphLineage }
  from '../../../services/main/src/modules/work/restore-lineage.ts';

const root = resolve(import.meta.dir, '../../..');

function stack(action: 'stack:up' | 'stack:reset', runId: string): void {
  const command = spawnSync('corepack', ['yarn', action, '--profile', 'qa', '--run-id', runId],
    { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000 });
  if (command.status !== 0 || command.error) throw new Error(`${action} failed: ${(
    command.stderr || command.stdout || command.error?.message || '').slice(-2000)}`);
}

async function migrate(pool: Pool, owner: 'access' | 'relay'): Promise<void> {
  const directory = join(root, `services/main/migrations/${owner}`);
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
    await pool.query(readFileSync(join(directory, file), 'utf8'));
  }
}

test('WORK04/OPS03: graph loss replays only the original admitted Work derivation', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const prefix = randomUUID().slice(0, 12);
  const liveId = `derivation-${prefix}-l`;
  const restoredId = `derivation-${prefix}-r`;
  const directory = join(root, '.temp', `derivation-restore-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started: string[] = [];
  let accessPool: Pool | undefined;
  let relayPool: Pool | undefined;
  try {
    for (const runId of [liveId, restoredId]) {
      started.push(runId);
      stack('stack:up', runId);
    }
    const liveApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: liveId }), 'apps.env'));
    const restoreApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: restoredId }), 'apps.env'));
    const liveFuseki = new FusekiClient(liveApps.FUSEKI_URL!,
      liveApps.FUSEKI_MAINTENANCE_TOKEN!, liveApps.FUSEKI_COMMAND_TOKEN!);
    const restoredFuseki = new FusekiClient(restoreApps.FUSEKI_URL!,
      restoreApps.FUSEKI_MAINTENANCE_TOKEN!, restoreApps.FUSEKI_COMMAND_TOKEN!);
    accessPool = new Pool({ connectionString: liveApps.ACCESS_DATABASE_URL, max: 4 });
    relayPool = new Pool({ connectionString: liveApps.ACCOUNT_RELAY_DATABASE_URL, max: 4 });
    await migrate(accessPool, 'access');
    await migrate(relayPool, 'relay');
    const lineage = { dataEpoch: liveApps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    const live: WorkActivationEnvironment = { fuseki: liveFuseki, lineage,
      objectDirectory: join(directory, 'objects') };
    await initializeFreshGraph(liveFuseki, lineage);
    const consumer = `work04-restore:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, lineage.dataEpoch);
    const principal = { issuer: 'https://qa-work04-recovery.test', subject: randomUUID() };
    const principalId = randomUUID();
    const actor = ID + randomUUID();
    const account = { verify: async () => principal };
    const request = new Request('https://main.rezics.test/v1/work-derivations', {
      headers: { authorization: 'Bearer recovery' },
    });
    const access = new AccessAdmissionRegistry(accessPool);
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [actor, 'agent']);
    const grant = async (scope: string, action: string) => {
      await accessPool!.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [scope]);
      await accessPool!.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), principalId, actor, action]);
      await accessPool!.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), actor, scope, action]);
    };
    await grant('work:create:root', 'work.create');
    const source = await createAdmittedMetadataWork(live, account, access, request,
      { title: 'Retained derivation source', actingSubject: actor,
        idempotencyKey: `source-${randomUUID()}` });
    const target = await createAdmittedMetadataWork(live, account, access, request,
      { title: 'Retained derivation target', actingSubject: actor,
        idempotencyKey: `target-${randomUUID()}` });
    expect([source.sequence, target.sequence]).toEqual(['1', '2']);
    await grant(`derivation:link:${target.work}`, 'work.derive');
    const linked = await createAdmittedWorkDerivation(live, account, access, request, {
      targetWork: target.work, targetMainVersion: target.mainVersion,
      expectedTargetHead: target.mainRevision, sourceWork: source.work,
      sourceMainVersion: source.mainVersion, sourceMainRevision: source.mainRevision,
      kind: 'software-fork', evidence: 'https://creator.example/restored-source',
      actingSubject: actor, idempotencyKey: `derive-${randomUUID()}` });
    expect(linked.sequence).toBe('3');
    const original = await readWorkDerivations(live, target.mainVersion, target.mainRevision);
    expect(original).toHaveLength(1);
    for (let position = 1; position <= 3; position++) {
      expect((await relayMainOutboxOnce(liveFuseki, relayPool, consumer))?.sequence)
        .toBe(String(position));
    }
    const coverage = await relayCoverage(relayPool, consumer);
    expect(coverage).toMatchObject({ dataEpoch: lineage.dataEpoch, sequence: '3',
      batchCount: '3', eventCount: '3' });
    const originalEvent = (await relayPool.query<{ event_id: string; envelope: unknown }>(
      'SELECT event_id, envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = 3',
      [lineage.dataEpoch])).rows[0];
    const originalBatch = (await relayPool.query<{ batch_id: string; routing_epoch: string;
      event_count: number }>(
      'SELECT batch_id, routing_epoch, event_count FROM relay.delivered_batch WHERE data_epoch = $1 AND sequence = 3',
      [lineage.dataEpoch])).rows[0];
    if (!originalEvent || !originalBatch) throw new Error('retained derivation evidence is absent');
    let changedDuringScan = false;
    const snapshotPool = { connect: async () => {
      const client = await relayPool!.connect();
      return {
        query: async (sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params);
          if (!changedDuringScan && sql.startsWith('SELECT data_epoch, sequence FROM relay.checkpoint')) {
            changedDuringScan = true;
            await relayPool!.query('UPDATE relay.delivered_batch SET batch_id = $1 WHERE data_epoch = $2 AND sequence = 3',
              [`changed-${randomUUID()}`, lineage.dataEpoch]);
            await relayPool!.query(`UPDATE relay.delivered_event SET envelope =
              jsonb_set(envelope, '{data,receipt,workDerivation}', to_jsonb($1::text))
              WHERE event_id = $2`, [`changed-${randomUUID()}`, originalEvent.event_id]);
          }
          return result;
        },
        release: () => client.release(),
      };
    } } as unknown as Pool;
    try {
      const snapshotEvent = await relayRetainedEventAt(snapshotPool, coverage, '3');
      expect(changedDuringScan).toBe(true);
      expect(snapshotEvent).toEqual({ eventId: originalEvent.event_id,
        envelope: originalEvent.envelope, batch: { batchId: originalBatch.batch_id,
          routingEpoch: originalBatch.routing_epoch, eventCount: originalBatch.event_count } });
      await expect(relayRetainedEventAt(relayPool, coverage, '3'))
        .rejects.toBeInstanceOf(RelayCheckpointConflict);
    } finally {
      await relayPool.query('UPDATE relay.delivered_batch SET batch_id = $1 WHERE data_epoch = $2 AND sequence = 3',
        [originalBatch.batch_id, lineage.dataEpoch]);
      await relayPool.query('UPDATE relay.delivered_event SET envelope = $1 WHERE event_id = $2',
        [originalEvent.envelope, originalEvent.event_id]);
    }
    expect(await relayCoverage(relayPool, consumer)).toEqual(coverage);
    await engageAccessRecoveryFence(accessPool);

    await initializeFreshGraph(restoredFuseki, lineage);
    const nextLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(restoredFuseki, {
      prior: { ...lineage, sequence: '0' }, next: nextLineage });
    const restored: WorkActivationEnvironment = { ...live, fuseki: restoredFuseki,
      lineage: nextLineage };
    expect((await reconcileRetainedWorkCreate(restored, accessPool, relayPool,
      coverage, '1')).work).toBe(source.work);
    expect((await reconcileRetainedWorkCreate(restored, accessPool, relayPool,
      coverage, '2')).work).toBe(target.work);

    const admitted = (await accessPool.query<{ id: string; idempotency_key: string }>(
      'SELECT id, idempotency_key FROM access.admission WHERE graph_receipt = $1',
      [linked.receipt])).rows[0];
    if (!admitted) throw new Error('retained derivation admission is absent');
    await accessPool.query('UPDATE access.admission SET idempotency_key = $1 WHERE id = $2',
      [`altered-${randomUUID()}`, admitted.id]);
    await expect(reconcileRetainedWorkDerivation(restored, accessPool, relayPool,
      coverage, '3')).rejects.toBeInstanceOf(RetainedEffectConflict);
    expect(await readWorkDerivations(restored, target.mainVersion, target.mainRevision)).toEqual([]);
    await accessPool.query('UPDATE access.admission SET idempotency_key = $1 WHERE id = $2',
      [admitted.idempotency_key, admitted.id]);

    const retained = (await relayPool.query<{ source: string; event_id: string;
      data_epoch: string; sequence: string; envelope: unknown }>(
      'SELECT source, event_id, data_epoch, sequence::text, envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = 3',
      [lineage.dataEpoch])).rows[0];
    if (!retained) throw new Error('retained Work derivation event is absent');
    await relayPool.query('DELETE FROM relay.delivered_event WHERE event_id = $1', [retained.event_id]);
    await expect(reconcileRetainedWorkDerivation(restored, accessPool, relayPool,
      coverage, '3')).rejects.toThrow();
    expect(await readWorkDerivations(restored, target.mainVersion, target.mainRevision)).toEqual([]);
    await relayPool.query(`INSERT INTO relay.delivered_event
      (source, event_id, data_epoch, sequence, envelope) VALUES ($1, $2, $3, $4, $5)`,
    [retained.source, retained.event_id, retained.data_epoch, retained.sequence, retained.envelope]);
    await relayPool.query(`UPDATE relay.delivered_event SET envelope =
      jsonb_set(envelope, '{data,receipt,derivationKind}', $1::jsonb) WHERE event_id = $2`,
    [JSON.stringify('adaptation'), retained.event_id]);
    await expect(reconcileRetainedWorkDerivation(restored, accessPool, relayPool,
      coverage, '3')).rejects.toThrow(RetainedEffectConflict);
    await relayPool.query('UPDATE relay.delivered_event SET envelope = $1 WHERE event_id = $2',
      [retained.envelope, retained.event_id]);
    expect(await relayCoverage(relayPool, consumer)).toEqual(coverage);
    expect(await reconcileRetainedWorkDerivation(restored, accessPool, relayPool,
      coverage, '3')).toEqual({ receipt: linked.receipt,
      derivation: linked.derivation, replayed: false });
    expect((await reconcileRetainedWorkDerivation(restored, accessPool, relayPool,
      coverage, '3')).replayed).toBe(true);
    expect(await readWorkDerivations(restored, target.mainVersion, target.mainRevision))
      .toEqual(original);
    expect((await restoredFuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(linked.derivation)} a rv:WorkDerivation ;
        rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence 3 ;
        rv:linkedBy ${iri(actor)} . }
    }`)).boolean).toBe(true);
  } finally {
    await Promise.all([accessPool?.end(), relayPool?.end()]);
    for (const runId of started.reverse()) stack('stack:reset', runId);
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
