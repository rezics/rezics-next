import { qaStartupTestTimeout, runQaAdmissionChildAsync, runQaStartupChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { authorCreditFixture, author, shortId } from '../fixtures/author-credit.ts';
import { FusekiClient, fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { cutoverRestoredGraphLineage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce, relayCoverage, relayRetainedEventAt,
  readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { reconcileRetainedSourceProjection } from '../../../services/main/src/modules/source/reconcile-restored.ts';
import { reconcileRetainedWorkCreate, RetainedEffectConflict } from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { reconcileRetainedNativeChild } from '../../../services/main/src/modules/source/child-recovery.ts';
import { SourceNativeChildStore } from '../../../services/main/src/modules/source/child-native-support.ts';
import { SourceNativeWorkProposalStore } from '../../../services/main/src/modules/source/native-work-proposal.ts';
import { OpenLibrarySourceGraph } from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceChildCorrespondenceStore } from '../../../services/main/src/modules/source/record-child-correspondence.ts';
import { sourceChildOccurrence } from '../../../services/main/src/modules/source/child-correspondence.ts';
import { readNativeChildRetirement } from '../../../services/main/src/modules/source/child-retirement.ts';

const root = resolve(import.meta.dir, '../../..');
async function stack(action: 'stack:up' | 'stack:reset', runId: string) {
  const args = [action, '--profile', 'qa', '--run-id', runId];
  const result = action === 'stack:up'
    ? await runQaStartupChildAsync(root, args, 180_000)
    : await runQaAdmissionChildAsync(root, 'bun', ['scripts/dev/cli.ts', ...args], 180_000);
  if (result.status !== 0 || result.error) throw new Error(`${action}: ${(result.stderr || result.stdout).slice(-2000)}`);
  return result.admissionWaitMs;
}

test('LIVE04: native subject child and human retirement survive held graph recovery', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the fault/recovery tier');
  const nonce = randomUUID().slice(0, 12), liveId = `child-${nonce}-l`, restoredId = `child-${nonce}-r`;
  const directory = join(root, '.temp', `child-restore-${nonce}`), started: string[] = [];
  let h: Awaited<ReturnType<typeof authorCreditFixture>> | undefined, relay: Pool | undefined;
  try {
    const start = Date.now();
    let admissionWaitMs = 0;
    for (const run of [liveId, restoredId]) { started.push(run); admissionWaitMs += await stack('stack:up', run); }
    const apps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: liveId }), 'apps.env'));
    const restoredApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: restoredId }), 'apps.env'));
    const access = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    relay = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    for (const [owner, pool] of [['access', access], ['relay', relay]] as const) {
      const path = join(root, `services/main/migrations/${owner}`);
      for (const file of schemaFiles(root, owner)) {
        await pool.query(readFileSync(join(path, file), 'utf8'));
      }
    }
    await access.end();
    h = await authorCreditFixture({ ...apps, MAIN_ROUTING_EPOCH: '1' }, directory);
    await initializeFreshGraph(h.env.fuseki, h.env.lineage);
    expect(Date.now() - start - admissionWaitMs).toBeLessThan(600_000);
    const consumer = `child:${nonce}`;
    await initializeRelayCheckpoint(relay, consumer, h.env.lineage.dataEpoch);
    const proposal = await h.propose('OL991899W', [author('/authors/OL1A')],
      'Recover child', undefined, ['river', 'river']);
    const work = await h.adoptWork(proposal);
    await h.grant(`work:edit:${work.work}`, 'work.edit');
    await h.grant(`work:read:${work.work}`, 'work.read');
    const input = { profile: 'source-native-child-adoption-v1' as const,
      field: 'subjects' as const, proposal: proposal.proposal,
      conversion: proposal.conversion,
      occurrence: sourceChildOccurrence(proposal.observation, 'subjects', 1), sourceOrdinal: 1,
      confirmedSourceKey: 'river', nativeOrdinal: 1, expectedHead: work.workRevision,
      actingSubject: h.actor, baseSupport: null, correspondence: null,
      confirmedUse: 'factual-reference-only' as const };
    const saved = await h.json<{ support: { support: string; child: { child: string;
      revision: string }; nativeReceipt: string } }>(await h.call('POST',
        `/v1/works/${shortId(work.work)}/source-children`, input), 201);
    const retirement = await h.json<{ retirement: { retirement: string; child: string;
      revision: string; admissionId: string } }>(await h.call('POST',
        `/v1/works/${shortId(work.work)}/native-children/${shortId(saved.support.child.child)}/retirements`,
        { profile: 'work-native-child-retirement-v1',
          revision: saved.support.child.revision, expectedHead: work.workRevision,
          actingSubject: h.actor, reason: 'Human retirement after adoption' }), 201);
    for (let position = 1; position <= 4; position++) {
      expect((await relayMainOutboxOnce(h.env.fuseki, relay, consumer))?.sequence).toBe(String(position));
    }
    const coverage = await relayCoverage(relay, consumer);
    const restoredFuseki = new FusekiClient(restoredApps.FUSEKI_URL!, restoredApps.FUSEKI_MAINTENANCE_TOKEN!,
      restoredApps.FUSEKI_COMMAND_TOKEN!);
    await initializeFreshGraph(restoredFuseki, h.env.lineage);
    const next = { dataEpoch: randomUUID(), routingEpoch: String(BigInt(h.env.lineage.routingEpoch) + 1n) };
    await cutoverRestoredGraphLineage(restoredFuseki, { prior: { ...h.env.lineage, sequence: '0' }, next });
    const restored = { ...h.env, fuseki: restoredFuseki, lineage: next };
    const replay = (sequence: string, retirement = false, contentPool = h!.pool) =>
      reconcileRetainedNativeChild(restored, h!.accessPool, relay!, contentPool,
        coverage, sequence, retirement);
    await expect(replay('3')).rejects.toBeInstanceOf(RetainedEffectConflict);
    await engageAccessRecoveryFence(h.accessPool);
    await expect(replay('3')).rejects.toBeInstanceOf(RetainedEffectConflict);
    await reconcileRetainedSourceProjection(restored, h.accessPool, relay, h.pool, coverage, '1');
    await reconcileRetainedWorkCreate(restored, h.accessPool, relay, coverage, '2');
    const missing = new Proxy(h.pool, { get(target, property) {
      if (property === 'query') return (query: string, params?: unknown[]) =>
        query.includes('FROM source.native_child_intent')
          ? Promise.resolve({ rows: [], rowCount: 0 }) : target.query(query, params);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Pool;
    await expect(replay('3', false, missing)).rejects.toBeInstanceOf(RetainedEffectConflict);
    await expect(replay('4', true)).rejects.toBeInstanceOf(RetainedEffectConflict);
    const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 80, bytesLeft: 262_144 };
    expect(await fusekiReadBudget.run(budget, () => replay('3'))).toEqual({
      receipt: saved.support.nativeReceipt, child: saved.support.child.child,
      revision: saved.support.child.revision, replayed: false });
    expect(80 - budget.callsLeft).toBeLessThanOrEqual(48);
    expect(262_144 - budget.bytesLeft).toBeLessThan(192_000);
    expect(await replay('3')).toMatchObject({ replayed: true });
    expect(await replay('4', true)).toEqual({ receipt: retirement.retirement.retirement,
      child: saved.support.child.child, revision: saved.support.child.revision, replayed: false });
    expect(await replay('4', true)).toMatchObject({ replayed: true });
    expect((await readNativeChildRetirement(restored, saved.support.child.child))?.retirement)
      .toBe(retirement.retirement.retirement);
    const accessPlan = (await h.accessPool.query<{ 'QUERY PLAN': Array<{ Plan: {
      'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
      'Temp Read Blocks': number } }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
      SELECT * FROM access.admission WHERE id = $1`,
    [retirement.retirement.admissionId])).rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(accessPlan['Actual Rows']).toBe(1);
    expect(accessPlan['Shared Hit Blocks'] + accessPlan['Shared Read Blocks']).toBeLessThan(48);
    expect(accessPlan['Temp Read Blocks']).toBe(0);
    const graph = new OpenLibrarySourceGraph(restoredFuseki, next, h.conversions);
    const proposals = new SourceNativeWorkProposalStore(h.pool, graph, h.conversions);
    const store = new SourceNativeChildStore(h.pool, proposals, h.conversions,
      new SourceChildCorrespondenceStore(h.pool, h.conversions), restored,
      h.account.verifier, h.access);
    expect((await store.read(h.principalId, shortId(saved.support.support)))?.child.state).toBe('retired');
    for (const sequence of ['3', '4']) {
      const retained = await relayRetainedEventAt(relay, coverage, sequence);
      expect(await readMainOutboxEnvelope(restoredFuseki, { batchId: retained.batch.batchId,
        dataEpoch: coverage.dataEpoch, sequence, routingEpoch: retained.batch.routingEpoch,
        eventIds: [retained.eventId] }, retained.eventId)).toEqual(retained.envelope);
    }
  } finally {
    await h?.close(); await relay?.end();
    for (const run of started.reverse()) await stack('stack:reset', run);
    rmSync(directory, { recursive: true, force: true });
  }
}, qaStartupTestTimeout(300_000));
