import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { authorCreditFixture, author, shortId } from '../fixtures/author-credit.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { cutoverRestoredGraphLineage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce, relayCoverage, relayRetainedEventAt,
  readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { reconcileRetainedSourceProjection } from '../../../services/main/src/modules/source/reconcile-restored.ts';
import { reconcileRetainedWorkCreate, RetainedEffectConflict } from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { reconcileRetainedAuthorCredit } from '../../../services/main/src/modules/source/reconcile-author-credit.ts';
import { SourceAuthorCreditStore, type SourceAuthorCreditSupport } from '../../../services/main/src/modules/source/author-credit.ts';
import { SourceNativeWorkProposalStore } from '../../../services/main/src/modules/source/native-work-proposal.ts';
import { OpenLibrarySourceGraph } from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceChildCorrespondenceStore } from '../../../services/main/src/modules/source/record-child-correspondence.ts';

const root = resolve(import.meta.dir, '../../..');
function stack(action: 'stack:up' | 'stack:reset', runId: string) {
  const result = spawnSync('corepack', ['yarn', action, '--profile', 'qa', '--run-id', runId],
    { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) throw new Error(`${action}: ${(result.stderr || result.stdout).slice(-2000)}`);
}

test('LIVE04/MODEL06/OPS03: native credit, source proof and withdrawal survive isolated held graph recovery', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the fault/recovery tier');
  const nonce = randomUUID().slice(0, 12), liveId = `credit-${nonce}-l`, restoredId = `credit-${nonce}-r`;
  const directory = join(root, '.temp', `credit-restore-${nonce}`), started: string[] = [];
  let fixture: Awaited<ReturnType<typeof authorCreditFixture>> | undefined, relay: Pool | undefined;
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
    // The restore protocol uses monotonic decimal epochs; stack config defaults
    // to opaque UUID epochs, so this isolated lineage starts at the protocol's 1.
    fixture = await authorCreditFixture({ ...apps, MAIN_ROUTING_EPOCH: '1' }, directory);
    const { env, call, json, propose, adoptWork, input, grant, pool, accessPool } = fixture;
    await initializeFreshGraph(env.fuseki, env.lineage);
    expect(Date.now() - start).toBeLessThan(600_000);
    const consumer = `credit:${nonce}`;
    await initializeRelayCheckpoint(relay, consumer, env.lineage.dataEpoch);
    const proposal = await propose('OL991899W', [author('/authors/OL1A'), author('/authors/OL1A')]);
    const work = await adoptWork(proposal);
    await grant(`work:edit:${work.work}`, 'work.edit');
    const saved = await json<{ support: SourceAuthorCreditSupport }>(await call('POST',
      `/v1/works/${shortId(work.work)}/source-author-credits`, input(proposal, work, 1)), 201);
    const supportPath = `/v1/sources/author-credit-supports/${shortId(saved.support.support)}`;
    const withdrawn = await json<{ support: SourceAuthorCreditSupport }>(await call('POST', `${supportPath}/withdrawals`,
      { reason: 'Retain the native occurrence after source withdrawal' }), 201);
    for (let position = 1; position <= 3; position++) expect((await relayMainOutboxOnce(env.fuseki, relay, consumer))?.sequence).toBe(String(position));
    const coverage = await relayCoverage(relay, consumer);
    const restoredFuseki = new FusekiClient(restoredApps.FUSEKI_URL!, restoredApps.FUSEKI_MAINTENANCE_TOKEN!, restoredApps.FUSEKI_COMMAND_TOKEN!);
    await initializeFreshGraph(restoredFuseki, env.lineage);
    const next = { dataEpoch: randomUUID(), routingEpoch: String(BigInt(env.lineage.routingEpoch) + 1n) };
    await cutoverRestoredGraphLineage(restoredFuseki, { prior: { ...env.lineage, sequence: '0' }, next });
    const restored = { ...env, fuseki: restoredFuseki, lineage: next };
    const replay = (sourcePool = pool) => reconcileRetainedAuthorCredit(restored, accessPool, relay!, sourcePool, coverage, '3');
    await expect(replay()).rejects.toBeInstanceOf(RetainedEffectConflict);
    await engageAccessRecoveryFence(accessPool);
    await expect(replay()).rejects.toBeInstanceOf(RetainedEffectConflict);
    await reconcileRetainedSourceProjection(restored, accessPool, relay, pool, coverage, '1');
    await reconcileRetainedWorkCreate(restored, accessPool, relay, coverage, '2');
    const missing = new Proxy(pool, { get(target, property) {
      if (property === 'query') return (query: string, params?: unknown[]) => query.includes('FROM source.author_credit_intent')
        ? Promise.resolve({ rows: [], rowCount: 0 }) : target.query(query, params);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Pool;
    await expect(replay(missing)).rejects.toBeInstanceOf(RetainedEffectConflict);
    const wrong = new Proxy(pool, { get(target, property) {
      if (property === 'query') return async (query: string, params?: unknown[]) => {
        const result = await target.query(query, params);
        if (query.includes('FROM source.author_credit_intent') && result.rows[0]) {
          return { ...result, rows: [{ ...result.rows[0], source_ordinal: 0 }] };
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Pool;
    await expect(replay(wrong)).rejects.toBeInstanceOf(RetainedEffectConflict);
    const first = await replay();
    expect(first).toEqual({ receipt: saved.support.nativeReceipt, credit: saved.support.credit.credit,
      revision: saved.support.credit.revision, replayed: false });
    expect(await replay()).toEqual({ ...first, replayed: true });
    const restoredGraph = new OpenLibrarySourceGraph(restoredFuseki, next, fixture.conversions);
    const restoredProposals = new SourceNativeWorkProposalStore(pool, restoredGraph, fixture.conversions);
    const restoredCredits = new SourceAuthorCreditStore(pool, restoredProposals, fixture.conversions,
      new SourceChildCorrespondenceStore(pool, fixture.conversions), restored, fixture.account.verifier, fixture.access);
    expect(await restoredCredits.read(fixture.principalId, shortId(saved.support.support))).toEqual(withdrawn.support);
    const retained = await relayRetainedEventAt(relay, coverage, '3');
    expect(await readMainOutboxEnvelope(restoredFuseki, { batchId: retained.batch.batchId,
      dataEpoch: coverage.dataEpoch, sequence: '3', routingEpoch: retained.batch.routingEpoch,
      eventIds: [retained.eventId] }, retained.eventId)).toEqual(retained.envelope);
    // A second replay neither creates an occurrence nor advances the recovered source cut.
    expect((await restoredFuseki.query(`SELECT (COUNT(?credit) AS ?n) WHERE {
      GRAPH <urn:rezics:graph:current> { ?credit a <https://rezics.com/vocab/AuthorCredit> } }`)).results?.bindings[0]?.n?.value).toBe('1');
  } finally {
    await fixture?.close(); await relay?.end();
    for (const run of started.reverse()) stack('stack:reset', run);
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
