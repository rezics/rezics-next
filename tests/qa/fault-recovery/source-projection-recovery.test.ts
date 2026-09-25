import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce,
  readMainOutboxEnvelope, relayRetainedEventAt }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { OpenLibraryConversionStore }
  from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { OpenLibrarySourceGraph }
  from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { reconcileRetainedSourceProjection }
  from '../../../services/main/src/modules/source/reconcile-restored.ts';
import { initializeFreshGraph, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { cutoverRestoredGraphLineage }
  from '../../../services/main/src/modules/work/restore-lineage.ts';
import { RetainedEffectConflict } from '../../../services/main/src/modules/work/reconcile-restored.ts';

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

test('OPS03/LIVE01/LIVE02: retained source event replays only verified private evidence at graph restore', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const prefix = randomUUID().slice(0, 12);
  const liveId = `source-replay-${prefix}-l`;
  const restoredId = `source-replay-${prefix}-r`;
  const started: string[] = [];
  let accessPool: Pool | undefined;
  let relayPool: Pool | undefined;
  let contentPool: Pool | undefined;
  try {
    for (const runId of [liveId, restoredId]) {
      started.push(runId);
      stack('stack:up', runId);
    }
    const liveApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: liveId }), 'apps.env'));
    const restoredApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: restoredId }), 'apps.env'));
    const liveFuseki = new FusekiClient(liveApps.FUSEKI_URL!,
      liveApps.FUSEKI_MAINTENANCE_TOKEN!, liveApps.FUSEKI_COMMAND_TOKEN!);
    const restoredFuseki = new FusekiClient(restoredApps.FUSEKI_URL!,
      restoredApps.FUSEKI_MAINTENANCE_TOKEN!, restoredApps.FUSEKI_COMMAND_TOKEN!);
    accessPool = new Pool({ connectionString: liveApps.ACCESS_DATABASE_URL });
    relayPool = new Pool({ connectionString: liveApps.ACCOUNT_RELAY_DATABASE_URL });
    contentPool = new Pool({ connectionString: liveApps.CONTENT_DATABASE_URL });
    await migrate(accessPool, 'access');
    await migrate(relayPool, 'relay');
    await migrateContent(contentPool);
    const lineage = { dataEpoch: liveApps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    await initializeFreshGraph(liveFuseki, lineage);
    const consumer = `source-restore:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, lineage.dataEpoch);
    const principalId = randomUUID();
    const workId = 'OL45804W';
    const bytes = Buffer.from(JSON.stringify({ key: `/works/${workId}`,
      type: { key: '/type/work' }, title: 'Retained source title',
      description: { value: 'Source-only text' }, subjects: ['Recovery'] }));
    const intake = new SourceIntakeStore(contentPool);
    const conversions = new OpenLibraryConversionStore(contentPool, intake);
    const observed = await intake.submit(principalId, `source-recovery-${randomUUID()}`, {
      provider: 'open-library', namespace: 'work', externalId: workId,
      sourceRevision: 'open-library-revision:1', mediaType: 'application/json',
      retention: 'retained', rawBytesBase64: bytes.toString('base64'),
      coverage: { scope: 'open-library-work-response-v1', complete: true,
        omittedFields: [] }, rightsEvidence: { basis: 'unknown', note: 'Not cleared' },
    }, { profile: 'open-library-work-acquisition-v1',
      url: `https://openlibrary.org/works/${workId}.json`, status: 200,
      etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
    const converted = await conversions.convert(principalId,
      observed.observation.observation.split('/').at(-1)!);
    const conversionId = converted!.conversion.conversion.split('/').at(-1)!;
    const source = new OpenLibrarySourceGraph(liveFuseki, lineage, conversions);
    const original = await source.project(principalId, conversionId);
    expect(original?.sourcePosition.sequence).toBe('1');
    expect((await relayMainOutboxOnce(liveFuseki, relayPool, consumer))?.sequence).toBe('1');
    const coverage = await relayCoverage(relayPool, consumer);
    expect(coverage).toMatchObject({ dataEpoch: lineage.dataEpoch, sequence: '1',
      batchCount: '1', eventCount: '1' });

    await initializeFreshGraph(restoredFuseki, lineage);
    const nextLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(restoredFuseki, {
      prior: { ...lineage, sequence: '0' }, next: nextLineage });
    const restored: WorkActivationEnvironment = { fuseki: restoredFuseki,
      lineage: nextLineage, objectDirectory: join(root, '.temp', `source-restore-${prefix}`) };
    const replay = () => reconcileRetainedSourceProjection(restored, accessPool!, relayPool!,
      contentPool!, coverage, '1');
    await expect(replay()).rejects.toBeInstanceOf(RetainedEffectConflict);
    await engageAccessRecoveryFence(accessPool);
    const originalEvent = (await relayPool.query<{ event_id: string; envelope: unknown }>(
      'SELECT event_id, envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = 1',
      [lineage.dataEpoch])).rows[0];
    if (!originalEvent) throw new Error('retained source event is missing');
    await relayPool.query(`UPDATE relay.delivered_event SET envelope =
      jsonb_set(envelope, '{data,receipt,byteDigest}', to_jsonb($1::text))
      WHERE event_id = $2`, ['0'.repeat(64), originalEvent.event_id]);
    await expect(replay()).rejects.toBeInstanceOf(RetainedEffectConflict);
    await relayPool.query('UPDATE relay.delivered_event SET envelope = $1 WHERE event_id = $2',
      [originalEvent.envelope, originalEvent.event_id]);
    const missingContent = new Proxy(contentPool, { get(target, property) {
      if (property === 'query') return (query: string, values: unknown[]) => {
        if (query.startsWith('SELECT principal_id FROM source.conversion')) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return target.query(query, values);
      };
      return Reflect.get(target, property, target);
    } }) as Pool;
    await expect(reconcileRetainedSourceProjection(restored, accessPool, relayPool,
      missingContent, coverage, '1')).rejects.toBeInstanceOf(RetainedEffectConflict);
    expect((await restoredFuseki.query(`ASK { GRAPH <urn:rezics:graph:source> {
      <${converted!.conversion.conversion}> ?p ?o . } }`)).boolean).toBe(false);

    const first = await replay();
    expect(first).toEqual({ receipt: original!.receipt,
      conversion: converted!.conversion.conversion, replayed: false });
    expect(await replay()).toEqual({ ...first, replayed: true });
    const restoredSource = new OpenLibrarySourceGraph(restoredFuseki, nextLineage, conversions);
    expect(await restoredSource.read(principalId, conversionId)).toEqual(original);
    const retained = await relayRetainedEventAt(relayPool, coverage, '1');
    const envelope = await readMainOutboxEnvelope(restoredFuseki, {
      batchId: retained.batch.batchId, dataEpoch: coverage.dataEpoch, sequence: '1',
      routingEpoch: retained.batch.routingEpoch, eventIds: [retained.eventId],
    }, retained.eventId);
    expect(envelope).toMatchObject({ type: 'com.rezics.source.projected.v1',
      data: { receipt: { id: original!.receipt, conversion: original!.conversion } } });
  } finally {
    await Promise.all([accessPool?.end(), relayPool?.end(), contentPool?.end()]);
    for (const runId of started.reverse()) stack('stack:reset', runId);
  }
}, 300_000);
