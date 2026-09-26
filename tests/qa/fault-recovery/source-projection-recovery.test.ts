import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce,
  readMainOutboxEnvelope, relayRetainedEventAt }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { OpenLibraryConversionStore }
  from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { OpenLibrarySourceGraph }
  from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { SourceNativeWorkProposalStore }
  from '../../../services/main/src/modules/source/native-work-proposal.ts';
import { SourceNativeWorkAdoptionStore, SourceAdoptionUnavailable }
  from '../../../services/main/src/modules/source/native-work-adoption.ts';
import { SourceNativeWorkAttachmentStore } from '../../../services/main/src/modules/source/native-work-attachment.ts';
import { reconcileRetainedSourceProjection }
  from '../../../services/main/src/modules/source/reconcile-restored.ts';
import { ID, initializeFreshGraph, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { cutoverRestoredGraphLineage }
  from '../../../services/main/src/modules/work/restore-lineage.ts';
import { reconcileRetainedWorkCreate, RetainedEffectConflict }
  from '../../../services/main/src/modules/work/reconcile-restored.ts';

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

test('OPS03/LIVE01/LIVE02/LIVE03/LIVE05/LIVE13: source and withdrawn title support survive held graph restore', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const prefix = randomUUID().slice(0, 12);
  const liveId = `source-replay-${prefix}-l`;
  const restoredId = `source-replay-${prefix}-r`;
  const directory = join(root, '.temp', `source-restore-${prefix}`);
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
    const live: WorkActivationEnvironment = { fuseki: liveFuseki, lineage,
      objectDirectory: directory };
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
    const proposals = new SourceNativeWorkProposalStore(contentPool, source, conversions);
    const proposed = await proposals.propose(principalId, conversionId);
    const proposalId = proposed!.proposal.proposal.split('/').at(-1)!;
    const principal = { issuer: 'https://qa-source-restore.test', subject: randomUUID() };
    const actor = ID + randomUUID();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3)`, [principalId, principal.issuer, principal.subject]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')",
      [actor]);
    await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ('work:create:root')
      ON CONFLICT DO NOTHING`);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','work.create',now() + interval '1 hour')`,
    [randomUUID(), actor]);
    const account = { verify: async () => principal };
    const access = new AccessAdmissionRegistry(accessPool);
    const adoptionStore = new SourceNativeWorkAdoptionStore(contentPool, proposals,
      live, account, access);
    const adoption = await adoptionStore.adopt(principalId,
      new Request('https://main.rezics.test/v1/sources/proposals/adoption', {
        headers: { authorization: 'Bearer recovery' } }), proposalId,
      { actingSubject: actor, authorityPath: 'represented-agent',
        confirmedTitle: 'Retained source title', titleLanguage: 'en' });
    expect(adoption?.adoption.sourcePosition.sequence).toBe('2');
    const secondWorkId = 'OL991499W';
    const secondObserved = await intake.submit(principalId, `source-second-${randomUUID()}`, {
      provider: 'open-library', namespace: 'work', externalId: secondWorkId,
      sourceRevision: '1', mediaType: 'application/json', retention: 'retained',
      rawBytesBase64: Buffer.from(JSON.stringify({ key: `/works/${secondWorkId}`,
        type: { key: '/type/work' }, title: 'Retained source title' })).toString('base64'),
      coverage: { scope: 'open-library-work-response-v1', complete: true, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: 'Second source' },
    }, { profile: 'open-library-work-acquisition-v1', url: `https://openlibrary.org/works/${secondWorkId}.json`,
      status: 200, etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
    const secondConversion = await conversions.convert(principalId, secondObserved.observation.observation.split('/').at(-1)!);
    const secondConversionId = secondConversion!.conversion.conversion.split('/').at(-1)!;
    await source.project(principalId, secondConversionId);
    const secondProposal = (await proposals.propose(principalId, secondConversionId))!.proposal;
    const editScope = `work:edit:${adoption!.adoption.work}`;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [editScope]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.edit',now() + interval '1 hour')`, [randomUUID(), principalId, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'work.edit',now() + interval '1 hour')`, [randomUUID(), actor, editScope]);
    const attachments = new SourceNativeWorkAttachmentStore(contentPool, proposals, adoptionStore, live, access);
    const attachKey = `source-attach-${randomUUID()}`;
    const attachIntent = { proposal: secondProposal.proposal, expectedHead: adoption!.adoption.workRevision,
      confirmedTitle: 'Retained source title', titleLanguage: 'en' as const, actingSubject: actor };
    const attached = await attachments.attach(principal, principalId, adoption!.adoption.work, attachKey, attachIntent);
    expect(attached?.replayed).toBe(false);
    const withdrawIntent = { binding: adoption!.adoption.binding,
      expectedSupport: adoption!.adoption.binding, reason: 'Explicitly withdrawn before restore' };
    const withdrawKey = `source-withdraw-${randomUUID()}`;
    const withdrawn = await adoptionStore.withdrawSupport(principalId, adoption!.adoption.work,
      withdrawKey, withdrawIntent);
    expect(withdrawn?.replayed).toBe(false);
    const retainedSupport = await adoptionStore.readSupport(principalId, adoption!.adoption.work);
    expect(retainedSupport).toMatchObject({ state: 'withdrawn',
      withdrawal: withdrawn!.withdrawal, latestApplication: null });
    const retainedCollection = await attachments.read(principalId, adoption!.adoption.work);
    expect(retainedCollection?.supports.map(item => item.support.state)).toEqual(['withdrawn', 'recorded']);
    for (let position = 1; position <= 3; position++) {
      expect((await relayMainOutboxOnce(liveFuseki, relayPool, consumer))?.sequence)
        .toBe(String(position));
    }
    const coverage = await relayCoverage(relayPool, consumer);
    expect(coverage).toMatchObject({ dataEpoch: lineage.dataEpoch, sequence: '3',
      batchCount: '3', eventCount: '3' });

    await initializeFreshGraph(restoredFuseki, lineage);
    const nextLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(restoredFuseki, {
      prior: { ...lineage, sequence: '0' }, next: nextLineage });
    const restored: WorkActivationEnvironment = { fuseki: restoredFuseki,
      lineage: nextLineage, objectDirectory: directory };
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
    const restoredProposals = new SourceNativeWorkProposalStore(contentPool,
      restoredSource, conversions);
    const restoredAdoption = new SourceNativeWorkAdoptionStore(contentPool,
      restoredProposals, restored, account, access);
    const restoredAttachments = new SourceNativeWorkAttachmentStore(contentPool, restoredProposals,
      restoredAdoption, restored, access);
    await expect(restoredAttachments.read(principalId, adoption!.adoption.work)).rejects.toThrow();
    await expect(restoredAdoption.read(principalId, proposalId))
      .rejects.toBeInstanceOf(SourceAdoptionUnavailable);
    await expect(restoredAdoption.readSupport(principalId, adoption!.adoption.work))
      .rejects.toBeInstanceOf(SourceAdoptionUnavailable);
    const workReplay = await reconcileRetainedWorkCreate(restored, accessPool, relayPool,
      coverage, '2');
    expect(workReplay).toMatchObject({ work: adoption!.adoption.work,
      receipt: adoption!.adoption.receipt, replayed: false });
    expect((await reconcileRetainedWorkCreate(restored, accessPool, relayPool,
      coverage, '2')).replayed).toBe(true);
    expect(await restoredAdoption.read(principalId, proposalId)).toEqual(adoption!.adoption);
    expect(await restoredAdoption.readSupport(principalId, adoption!.adoption.work))
      .toEqual(retainedSupport);
    expect(await restoredAdoption.withdrawSupport(principalId, adoption!.adoption.work,
      withdrawKey, withdrawIntent)).toEqual({ ...withdrawn, replayed: true });
    // The second projection is an independent required dependency: no partial 200.
    await expect(restoredAttachments.read(principalId, adoption!.adoption.work)).rejects.toThrow();
    const secondReplay = await reconcileRetainedSourceProjection(restored, accessPool, relayPool, contentPool, coverage, '3');
    expect(secondReplay.replayed).toBe(false);
    expect((await reconcileRetainedSourceProjection(restored, accessPool, relayPool, contentPool, coverage, '3')).replayed).toBe(true);
    expect(await restoredAttachments.read(principalId, adoption!.adoption.work)).toEqual(retainedCollection);
    expect(await restoredAttachments.attach(principal, principalId, adoption!.adoption.work,
      attachKey, attachIntent)).toEqual({ ...attached, replayed: true });
    const secondWithdraw = await restoredAttachments.withdraw(principalId, adoption!.adoption.work,
      attached!.attachment.binding, 'restored-second-withdrawal', {
        expectedSupport: attached!.attachment.binding, reason: 'Independent restored withdrawal' });
    expect(secondWithdraw?.kind).toBe('attachment');
    expect((await restoredAttachments.read(principalId, adoption!.adoption.work))?.supports[0])
      .toEqual(retainedCollection?.supports[0]);
    const alteredBinding = new Proxy(contentPool, { get(target, property) {
      if (property === 'query') return async (query: string, values: unknown[]) => {
        const result = await target.query(query, values);
        if (query.includes('FROM source.native_work_binding b') && result.rows[0]) {
          return { ...result, rows: [{ ...result.rows[0], graph_receipt:
            `urn:rezics:receipt:${'0'.repeat(64)}` }] };
        }
        return result;
      };
      return Reflect.get(target, property, target);
    } }) as Pool;
    const invalidBinding = new SourceNativeWorkAdoptionStore(alteredBinding,
      restoredProposals, restored, account, access);
    await expect(invalidBinding.read(principalId, proposalId))
      .rejects.toBeInstanceOf(SourceAdoptionUnavailable);
  } finally {
    await Promise.all([accessPool?.end(), relayPool?.end(), contentPool?.end()]);
    for (const runId of started.reverse()) stack('stack:reset', runId);
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
