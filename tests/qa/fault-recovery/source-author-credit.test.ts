import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
import { reconcileRetainedAuthorCredit } from '../../../services/main/src/modules/source/reconcile-author-credit.ts';
import { reconcileRetainedAuthorCreditRetirement } from '../../../services/main/src/modules/source/reconcile-author-credit-retirement.ts';
import { SourceAuthorCreditStore, type SourceAuthorCreditSupport } from '../../../services/main/src/modules/source/author-credit.ts';
import { SourceNativeWorkProposalStore } from '../../../services/main/src/modules/source/native-work-proposal.ts';
import { OpenLibrarySourceGraph } from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceChildCorrespondenceStore } from '../../../services/main/src/modules/source/record-child-correspondence.ts';
import { SourceFieldWithdrawalStore } from '../../../services/main/src/modules/source/withdrawal.ts';
import { readAuthorCreditRetirement } from '../../../services/main/src/modules/work/author-credit-retirement.ts';

const root = resolve(import.meta.dir, '../../..');
function stack(action: 'stack:up' | 'stack:reset', runId: string) {
  const result = spawnSync('bun', ['scripts/dev/cli.ts', action, '--profile', 'qa', '--run-id', runId],
    { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) throw new Error(`${action}: ${(result.stderr || result.stdout).slice(-2000)}`);
}

test('LIVE04/LIVE05/MODEL06/OPS03: native credit, field proof and withdrawals survive held graph recovery', async () => {
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
    const mapping = `fixture-${randomUUID().replaceAll('-', '')}-v1`;
    const sourceRecord = randomUUID(), observation = randomUUID(), conversion = randomUUID();
    const raw = Buffer.from(JSON.stringify({ semanticTypes: work.semanticTypes }));
    const digest = createHash('sha256').update(raw).digest('hex');
    const mappingClient = await pool.connect();
    try {
      await mappingClient.query('BEGIN');
      await mappingClient.query(`INSERT INTO source.field_mapping
        (mapping_revision, provider, namespace, root_grain, field_count)
        VALUES ($1,'fixture','work','work',1)`, [mapping]);
      await mappingClient.query(`INSERT INTO source.field_disposition
        (mapping_revision, grain, field_key, disposition, value_kind, reason, native_target)
        VALUES ($1,'work','semanticTypes','native','structure','exact native value',
          'work-metadata-v1#semantic-types')`, [mapping]);
      await mappingClient.query('COMMIT');
    } catch (error) { await mappingClient.query('ROLLBACK'); throw error; }
    finally { mappingClient.release(); }
    await pool.query("INSERT INTO source.record (id,provider,namespace,external_id) VALUES ($1,'fixture','work',$2)",
      [sourceRecord, `recovery-${nonce}`]);
    await pool.query(`INSERT INTO source.observation
      (id,record_id,principal_id,media_type,retention,raw_bytes,byte_digest,coverage,rights_evidence)
      VALUES ($1,$2,$3,'application/json','retained',$4,$5,'{"complete":true}','{}')`,
    [observation, sourceRecord, fixture.principalId, raw, digest]);
    await pool.query(`INSERT INTO source.conversion
      (id,observation_id,principal_id,mapping_revision,source_digest,projection,field_inventory)
      VALUES ($1,$2,$3,$4,$5,'{}','[{"grain":"work","field":"semanticTypes","disposition":"native"}]')`,
    [conversion, observation, fixture.principalId, mapping, digest]);
    const field = await json<{ support: { support: string; supportIdentity: string; nativeRevision: string } }>(
      await call('POST', '/v1/sources/field-supports', {
        profile: 'source-field-support-attachment-v1', target: work.work,
        slot: 'work-metadata-v1#semantic-types', occurrence: null, context: 'global',
        sourceRecord: `https://rezics.com/id/${sourceRecord}`,
        conversion: `https://rezics.com/id/${conversion}`, grain: 'work', sourceField: 'semanticTypes',
        sourceOccurrence: null, sourcePointer: '/semanticTypes', expectedHead: work.workRevision,
        actingSubject: fixture.actor,
      }), 201);
    const fieldWithdrawn = await json<{ support: { support: string; state: string } }>(
      await call('POST', '/v1/sources/withdrawals', {
        profile: 'source-support-withdrawal-v1', support: field.support.support,
        expectedSupport: field.support.supportIdentity,
        reason: 'Retain native Work after source support withdrawal',
      }), 201);
    expect(fieldWithdrawn.support.state).toBe('withdrawn');
    const saved = await json<{ support: SourceAuthorCreditSupport }>(await call('POST',
      `/v1/works/${shortId(work.work)}/source-author-credits`, input(proposal, work, 1)), 201);
    const supportPath = `/v1/sources/author-credit-supports/${shortId(saved.support.support)}`;
    const withdrawn = await json<{ support: SourceAuthorCreditSupport }>(await call('POST', `${supportPath}/withdrawals`,
      { reason: 'Retain the native occurrence after source withdrawal' }), 201);
    const retirement = await json<{ retirement: { retirement: string; credit: string;
      revision: string; admissionId: string } }>(
      await call('POST', `/v1/works/${shortId(work.work)}/author-credits/${shortId(saved.support.credit.credit)}/retirements`, {
        profile: 'work-author-credit-retirement-v1', revision: saved.support.credit.revision,
        expectedHead: work.workRevision, actingSubject: fixture.actor,
        reason: 'Human retirement survives graph restoration',
      }), 201);
    for (let position = 1; position <= 4; position++) expect((await relayMainOutboxOnce(env.fuseki, relay, consumer))?.sequence).toBe(String(position));
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
    await expect(reconcileRetainedAuthorCreditRetirement(restored,
      accessPool, relay!, coverage, '4')).rejects.toBeInstanceOf(RetainedEffectConflict);
    const first = await replay();
    expect(first).toEqual({ receipt: saved.support.nativeReceipt, credit: saved.support.credit.credit,
      revision: saved.support.credit.revision, replayed: false });
    expect(await replay()).toEqual({ ...first, replayed: true });
    const recoverRetirement = () => reconcileRetainedAuthorCreditRetirement(restored,
      accessPool, relay!, coverage, '4');
    await expect(reconcileRetainedAuthorCreditRetirement(restored,
      accessPool, relay!, coverage, '3')).rejects.toBeInstanceOf(RetainedEffectConflict);
    const retirementBudget = { signal: AbortSignal.timeout(10_000), callsLeft: 64, bytesLeft: 262_144 };
    expect(await fusekiReadBudget.run(retirementBudget, recoverRetirement)).toEqual({ receipt: retirement.retirement.retirement,
      credit: retirement.retirement.credit, revision: retirement.retirement.revision, replayed: false });
    expect(64 - retirementBudget.callsLeft).toBeLessThanOrEqual(24);
    expect(262_144 - retirementBudget.bytesLeft).toBeLessThan(128_000);
    expect(await recoverRetirement()).toEqual({ receipt: retirement.retirement.retirement,
      credit: retirement.retirement.credit, revision: retirement.retirement.revision, replayed: true });
    expect((await readAuthorCreditRetirement(restored, saved.support.credit.credit))?.retirement)
      .toBe(retirement.retirement.retirement);
    const retirementEvent = await relayRetainedEventAt(relay, coverage, '4');
    expect(await readMainOutboxEnvelope(restoredFuseki, { batchId: retirementEvent.batch.batchId,
      dataEpoch: coverage.dataEpoch, sequence: '4', routingEpoch: retirementEvent.batch.routingEpoch,
      eventIds: [retirementEvent.eventId] }, retirementEvent.eventId)).toEqual(retirementEvent.envelope);
    const accessPlan = (await accessPool.query<{ 'QUERY PLAN': Array<{ Plan: {
      'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
      'Temp Read Blocks': number } }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
      SELECT * FROM access.admission WHERE id = $1`, [retirement.retirement.admissionId]))
      .rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(accessPlan['Actual Rows']).toBe(1);
    expect(accessPlan['Shared Hit Blocks'] + accessPlan['Shared Read Blocks']).toBeLessThan(48);
    expect(accessPlan['Temp Read Blocks']).toBe(0);
    const restoredGraph = new OpenLibrarySourceGraph(restoredFuseki, next, fixture.conversions);
    const restoredProposals = new SourceNativeWorkProposalStore(pool, restoredGraph, fixture.conversions);
    const restoredCredits = new SourceAuthorCreditStore(pool, restoredProposals, fixture.conversions,
      new SourceChildCorrespondenceStore(pool, fixture.conversions), restored, fixture.account.verifier, fixture.access);
    expect(await restoredCredits.read(fixture.principalId, shortId(saved.support.support))).toEqual(withdrawn.support);
    const restoredField = await new SourceFieldWithdrawalStore(pool, restored).read(
      fixture.principalId, shortId(field.support.support));
    expect(restoredField).toMatchObject({ state: 'withdrawn', support: field.support.support,
      nativeRevision: field.support.nativeRevision, withdrawal: { nativeEffect: 'none' } });
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
