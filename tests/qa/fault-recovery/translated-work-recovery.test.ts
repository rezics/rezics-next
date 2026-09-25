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
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { GRAPHS, ID, RV, initializeFreshGraph, iri, lit,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { createAdmittedTextContribution } from '../../../services/main/src/modules/contribution/create-admitted.ts';
import { publishAdmittedTextContribution } from '../../../services/main/src/modules/contribution/publish-admitted.ts';
import { selectAdmittedMainDefault } from '../../../services/main/src/modules/work/select-main-admitted.ts';
import { reconcileRetainedContributionDraftCreate, reconcileRetainedContributionPublication,
  reconcileRetainedMainSelection, reconcileRetainedTranslationLink, reconcileRetainedWorkCreate,
  RetainedEffectConflict } from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { cutoverRestoredGraphLineage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { createAdmittedTranslationLink, readTranslationLinks,
  type TranslationLinkInput } from '../../../services/main/src/modules/work/translation-links.ts';

const root = resolve(import.meta.dir, '../../..');

function rootCommand(args: string[], timeout: number): void {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout
      || result.error?.message || '').slice(-2000)}`);
  }
}

async function migrate(pool: Pool, owner: 'access' | 'relay'): Promise<void> {
  const directory = join(root, `services/main/migrations/${owner}`);
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
    await pool.query(readFileSync(join(directory, file), 'utf8'));
  }
}

test('WORK02/OPS03: isolated graph loss restores exact translated Work links from retained events', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const childRunId = randomUUID().slice(0, 12);
  const liveRunId = `translation-${childRunId}-l`;
  const restoreRunId = `translation-${childRunId}-r`;
  const directory = join(root, '.temp', `translation-restore-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started: string[] = [];
  let accessPool: Pool | undefined;
  let relayPool: Pool | undefined;
  try {
    for (const runId of [liveRunId, restoreRunId]) {
      started.push(runId);
      rootCommand(['stack:up', '--profile', 'qa', '--run-id', runId], 180_000);
    }
    const liveApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: liveRunId }), 'apps.env'));
    const restoreApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: restoreRunId }), 'apps.env'));
    const liveFuseki = new FusekiClient(liveApps.FUSEKI_URL!,
      liveApps.FUSEKI_MAINTENANCE_TOKEN!, liveApps.FUSEKI_COMMAND_TOKEN!);
    const restoreFuseki = new FusekiClient(restoreApps.FUSEKI_URL!,
      restoreApps.FUSEKI_MAINTENANCE_TOKEN!, restoreApps.FUSEKI_COMMAND_TOKEN!);
    accessPool = new Pool({ connectionString: liveApps.ACCESS_DATABASE_URL, max: 4 });
    relayPool = new Pool({ connectionString: liveApps.ACCOUNT_RELAY_DATABASE_URL, max: 4 });
    await migrate(accessPool, 'access');
    await migrate(relayPool, 'relay');
    // Restore cutover epochs are monotonic numbers; QA stack routing tokens are UUIDs.
    const lineage = { dataEpoch: liveApps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    const liveEnv: WorkActivationEnvironment = { fuseki: liveFuseki, lineage,
      objectDirectory: join(directory, 'objects') };
    await initializeFreshGraph(liveFuseki, lineage);
    const consumer = `work02-restore:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, lineage.dataEpoch);

    const principal = { issuer: 'https://qa-translation-recovery.test', subject: randomUUID() };
    const principalId = randomUUID();
    const actor = ID + randomUUID();
    const translatorOfficial = ID + randomUUID();
    const translatorThirdParty = ID + randomUUID();
    const account = { verify: async () => principal };
    const request = new Request('https://main.rezics.test/v1/works', {
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
    const source = await createAdmittedMetadataWork(liveEnv, account, access, request,
      { title: 'Retained source A', actingSubject: actor, idempotencyKey: `source-${randomUUID()}` });
    const officialTarget = await createAdmittedMetadataWork(liveEnv, account, access, request,
      { title: 'Retained official B', actingSubject: actor, idempotencyKey: `official-${randomUUID()}` });
    const thirdPartyTarget = await createAdmittedMetadataWork(liveEnv, account, access, request,
      { title: 'Retained third-party C', actingSubject: actor, idempotencyKey: `third-${randomUUID()}` });
    expect([source.sequence, officialTarget.sequence, thirdPartyTarget.sequence]).toEqual(['1', '2', '3']);
    expect(new Set([source.work, officialTarget.work, thirdPartyTarget.work]).size).toBe(3);
    expect(new Set([source.mainVersion, officialTarget.mainVersion, thirdPartyTarget.mainVersion]).size).toBe(3);

    await grant(`translation:link:${officialTarget.work}`, 'translation.link');
    await grant(`translation:link:${thirdPartyTarget.work}`, 'translation.link');
    const authorization = `translation:authorize:${source.work}:${source.mainRevision}`;
    await grant(authorization, 'translation.authorize');
    const officialInput: TranslationLinkInput = {
      targetWork: officialTarget.work, targetMainVersion: officialTarget.mainVersion,
      targetMainRevision: officialTarget.mainRevision, sourceWork: source.work,
      sourceMainVersion: source.mainVersion, sourceMainRevision: source.mainRevision,
      status: 'official', contentLanguage: 'zh', translator: translatorOfficial,
      publisher: actor, evidence: 'https://publisher.example/retained-official', actingSubject: actor,
    };
    const thirdPartyInput: TranslationLinkInput = {
      ...officialInput, targetWork: thirdPartyTarget.work,
      targetMainVersion: thirdPartyTarget.mainVersion,
      targetMainRevision: thirdPartyTarget.mainRevision, sourceMainRevision: null,
      status: 'third-party', translator: translatorThirdParty,
      evidence: 'https://publisher.example/retained-third-party',
    };
    const official = await createAdmittedTranslationLink(liveEnv, account, access, request,
      { ...officialInput, idempotencyKey: `link-official-${randomUUID()}` });
    const thirdParty = await createAdmittedTranslationLink(liveEnv, account, access, request,
      { ...thirdPartyInput, idempotencyKey: `link-third-${randomUUID()}` });
    expect([official.sequence, thirdParty.sequence]).toEqual(['4', '5']);
    const originalOfficial = await readTranslationLinks(liveEnv,
      officialTarget.mainVersion, officialTarget.mainRevision);
    const originalThirdParty = await readTranslationLinks(liveEnv,
      thirdPartyTarget.mainVersion, thirdPartyTarget.mainRevision);
    expect(originalOfficial).toHaveLength(1);
    expect(originalThirdParty).toHaveLength(1);
    await grant(`contribution:create:${officialTarget.work}`, 'contribution.create');
    const draft = await createAdmittedTextContribution(liveEnv, account, access, request,
      { work: officialTarget.work, language: 'zh', body: '重建后的译本正文',
        actingSubject: actor, idempotencyKey: `draft-${randomUUID()}` });
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('retained translation draft is unavailable');
    }
    await grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    const publication = await publishAdmittedTextContribution(liveEnv, account, access, request,
      { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution',
        disclosure: 'public', actingSubject: actor,
        idempotencyKey: `publication-${randomUUID()}` });
    if (publication.outcome !== 'succeeded' || !publication.publicationDecision) {
      throw new Error('retained translation publication is unavailable');
    }
    await grant(`publication:select:${officialTarget.mainVersion}`, 'publication.select');
    const selection = await selectAdmittedMainDefault(liveEnv, account, access, request,
      { context: { kind: 'main-version-default', id: officialTarget.mainVersion },
        work: officialTarget.work, contribution: draft.contribution,
        publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer',
        actingSubject: actor, idempotencyKey: `selection-${randomUUID()}` });
    if (selection.outcome !== 'succeeded' || !selection.mainRevision) {
      throw new Error('retained Main Version revision is unavailable');
    }
    expect([draft.sequence, publication.sequence, selection.sequence]).toEqual(['6', '7', '8']);
    expect(await readTranslationLinks(liveEnv, officialTarget.mainVersion,
      selection.mainRevision)).toEqual([]);
    for (let n = 1; n <= 8; n++) {
      expect((await relayMainOutboxOnce(liveFuseki, relayPool, consumer))?.sequence).toBe(String(n));
    }
    const coverage = await relayCoverage(relayPool, consumer);
    expect(coverage).toMatchObject({ dataEpoch: lineage.dataEpoch, sequence: '8',
      batchCount: '8', eventCount: '8' });
    await engageAccessRecoveryFence(accessPool);

    // A fresh empty graph is the isolated loss boundary; the retained relay and
    // Access owners survive, so all five source positions must be rebuilt.
    await initializeFreshGraph(restoreFuseki, lineage);
    const restoredLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(restoreFuseki, {
      prior: { ...lineage, sequence: '0' }, next: restoredLineage,
    });
    const restoredEnv: WorkActivationEnvironment = { ...liveEnv,
      fuseki: restoreFuseki, lineage: restoredLineage };
    for (const [n, work] of [source, officialTarget, thirdPartyTarget].entries()) {
      const replay = await reconcileRetainedWorkCreate(restoredEnv, accessPool,
        relayPool, coverage, String(n + 1));
      expect(replay).toMatchObject({ work: work.work, workRevision: work.workRevision,
        replayed: false });
    }

    const officialAdmission = (await accessPool.query<{ id: string; idempotency_key: string }>(
      'SELECT id, idempotency_key FROM access.admission WHERE graph_receipt = $1',
      [official.receipt])).rows[0];
    if (!officialAdmission) throw new Error('retained official Access admission is absent');
    await accessPool.query('UPDATE access.admission SET idempotency_key = $1 WHERE id = $2',
      [`altered-${randomUUID()}`, officialAdmission.id]);
    await expect(reconcileRetainedTranslationLink(restoredEnv, accessPool, relayPool,
      coverage, '4')).rejects.toBeInstanceOf(RetainedEffectConflict);
    expect(await readTranslationLinks(restoredEnv,
      officialTarget.mainVersion, officialTarget.mainRevision)).toEqual([]);
    await accessPool.query('UPDATE access.admission SET idempotency_key = $1 WHERE id = $2',
      [officialAdmission.idempotency_key, officialAdmission.id]);
    expect(await reconcileRetainedTranslationLink(restoredEnv, accessPool,
      relayPool, coverage, '4')).toEqual({ receipt: official.receipt, link: official.link,
      replayed: false });
    expect((await reconcileRetainedTranslationLink(restoredEnv, accessPool,
      relayPool, coverage, '4')).replayed).toBe(true);
    expect(await readTranslationLinks(restoredEnv,
      officialTarget.mainVersion, officialTarget.mainRevision)).toEqual(originalOfficial);

    const retained = (await relayPool.query<{ source: string; event_id: string;
      data_epoch: string; sequence: string; envelope: unknown }>(
      'SELECT source, event_id, data_epoch, sequence::text, envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = 5',
      [lineage.dataEpoch])).rows[0];
    if (!retained) throw new Error('retained third-party event is absent');
    await relayPool.query('DELETE FROM relay.delivered_event WHERE event_id = $1', [retained.event_id]);
    await expect(reconcileRetainedTranslationLink(restoredEnv, accessPool, relayPool,
      coverage, '5')).rejects.toThrow();
    expect(await readTranslationLinks(restoredEnv,
      thirdPartyTarget.mainVersion, thirdPartyTarget.mainRevision)).toEqual([]);
    await relayPool.query(`INSERT INTO relay.delivered_event
      (source, event_id, data_epoch, sequence, envelope) VALUES ($1, $2, $3, $4, $5)`,
    [retained.source, retained.event_id, retained.data_epoch, retained.sequence, retained.envelope]);
    await relayPool.query(`UPDATE relay.delivered_event
      SET envelope = jsonb_set(envelope, '{data,receipt,sourceVersionStatus}', $1::jsonb)
      WHERE event_id = $2`, [JSON.stringify('exact'), retained.event_id]);
    await expect(reconcileRetainedTranslationLink(restoredEnv, accessPool, relayPool,
      coverage, '5')).rejects.toThrow();
    expect(await readTranslationLinks(restoredEnv,
      thirdPartyTarget.mainVersion, thirdPartyTarget.mainRevision)).toEqual([]);
    await relayPool.query('UPDATE relay.delivered_event SET envelope = $1 WHERE event_id = $2',
      [retained.envelope, retained.event_id]);
    expect(await relayCoverage(relayPool, consumer)).toEqual(coverage);
    expect(await reconcileRetainedTranslationLink(restoredEnv, accessPool,
      relayPool, coverage, '5')).toEqual({ receipt: thirdParty.receipt,
      link: thirdParty.link, replayed: false });
    expect((await reconcileRetainedTranslationLink(restoredEnv, accessPool,
      relayPool, coverage, '5')).replayed).toBe(true);
    expect(await readTranslationLinks(restoredEnv,
      thirdPartyTarget.mainVersion, thirdPartyTarget.mainRevision)).toEqual(originalThirdParty);
    for (const [link, sequence] of [[official.link, '4'], [thirdParty.link, '5']] as const) {
      expect((await restoreFuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(link)} a rv:TranslationLink ;
          rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence ${sequence} ;
          rv:linkedBy ${iri(actor)} . }
      }`)).boolean).toBe(true);
    }
    expect((await restoreFuseki.query(`PREFIX rv: <${RV}> SELECT (COUNT(?link) AS ?count) WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ?link a rv:TranslationLink }
    }`)).results?.bindings[0]?.count?.value).toBe('2');
    expect((await reconcileRetainedContributionDraftCreate(restoredEnv, accessPool,
      relayPool, coverage, '6')).replayed).toBe(false);
    expect((await reconcileRetainedContributionPublication(restoredEnv, accessPool,
      relayPool, coverage, '7')).replayed).toBe(false);
    const retainedSelection = (await relayPool.query<{ event_id: string; envelope: unknown }>(
      'SELECT event_id, envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = 8',
      [lineage.dataEpoch])).rows[0];
    if (!retainedSelection) throw new Error('retained selection event is absent');
    await relayPool.query(`UPDATE relay.delivered_event SET envelope =
      jsonb_set(envelope, '{data,receipt,mainManifest}', $1::jsonb) WHERE event_id = $2`,
    [JSON.stringify(`urn:rezics:sha256:${'0'.repeat(64)}`), retainedSelection.event_id]);
    await expect(reconcileRetainedMainSelection(restoredEnv, accessPool, relayPool,
      coverage, '8')).rejects.toThrow();
    await relayPool.query('UPDATE relay.delivered_event SET envelope = $1 WHERE event_id = $2',
      [retainedSelection.envelope, retainedSelection.event_id]);
    expect((await reconcileRetainedMainSelection(restoredEnv, accessPool, relayPool,
      coverage, '8')).replayed).toBe(false);
    expect((await reconcileRetainedMainSelection(restoredEnv, accessPool, relayPool,
      coverage, '8')).replayed).toBe(true);
    expect((await restoreFuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(officialTarget.mainVersion)} rv:head ${iri(selection.mainRevision)} ;
          rv:selectionHead ${iri(selection.selection!)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(selection.mainRevision)} rv:predecessor ${iri(officialTarget.mainRevision)} . }
    }`)).boolean).toBe(true);
    expect(await readTranslationLinks(restoredEnv, officialTarget.mainVersion,
      selection.mainRevision)).toEqual([]);
    expect(await readTranslationLinks(restoredEnv, officialTarget.mainVersion,
      officialTarget.mainRevision)).toEqual(originalOfficial);
  } finally {
    await Promise.all([accessPool?.end(), relayPool?.end()]);
    for (const runId of started.reverse()) {
      rootCommand(['stack:reset', '--profile', 'qa', '--run-id', runId], 120_000);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 350_000);
