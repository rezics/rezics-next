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
import { ID, initializeFreshGraph, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork }
  from '../../../services/main/src/modules/work/create-admitted.ts';
import { createAdmittedTextContribution }
  from '../../../services/main/src/modules/contribution/create-admitted.ts';
import { publishAdmittedTextContribution }
  from '../../../services/main/src/modules/contribution/publish-admitted.ts';
import { selectAdmittedMainDefault }
  from '../../../services/main/src/modules/work/select-main-admitted.ts';
import { createAdmittedFixedRelease, readFixedRelease }
  from '../../../services/main/src/modules/work/fixed-release.ts';
import { reconcileRetainedFixedRelease }
  from '../../../services/main/src/modules/work/reconcile-fixed-release.ts';
import { reconcileRetainedContributionDraftCreate, reconcileRetainedContributionPublication,
  reconcileRetainedMainSelection, reconcileRetainedWorkCreate, RetainedEffectConflict }
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

test('WORK05/OPS03: graph loss restores only the admitted fixed release and exact bytes', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery tier');
  const prefix = randomUUID().slice(0, 12);
  const liveId = `fixed-release-${prefix}-l`;
  const restoredId = `fixed-release-${prefix}-r`;
  const directory = join(root, '.temp', `fixed-release-restore-${randomUUID()}`);
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
    const restoredApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: restoredId }), 'apps.env'));
    const liveFuseki = new FusekiClient(liveApps.FUSEKI_URL!,
      liveApps.FUSEKI_MAINTENANCE_TOKEN!, liveApps.FUSEKI_COMMAND_TOKEN!);
    const restoredFuseki = new FusekiClient(restoredApps.FUSEKI_URL!,
      restoredApps.FUSEKI_MAINTENANCE_TOKEN!, restoredApps.FUSEKI_COMMAND_TOKEN!);
    accessPool = new Pool({ connectionString: liveApps.ACCESS_DATABASE_URL, max: 4 });
    relayPool = new Pool({ connectionString: liveApps.ACCOUNT_RELAY_DATABASE_URL, max: 4 });
    await migrate(accessPool, 'access');
    await migrate(relayPool, 'relay');
    const lineage = { dataEpoch: liveApps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    const live: WorkActivationEnvironment = { fuseki: liveFuseki, lineage,
      objectDirectory: join(directory, 'objects') };
    await initializeFreshGraph(liveFuseki, lineage);
    const consumer = `work05-restore:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, lineage.dataEpoch);
    const principal = { issuer: 'https://qa-work05-recovery.test', subject: randomUUID() };
    const principalId = randomUUID();
    const actor = ID + randomUUID();
    const account = { verify: async () => principal };
    const request = new Request('https://main.rezics.test/v1/fixed-releases', {
      headers: { authorization: 'Bearer recovery' } });
    const access = new AccessAdmissionRegistry(accessPool);
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)',
      [actor, 'agent']);
    const grant = async (scope: string, action: string) => {
      await accessPool!.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
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
    const work = await createAdmittedMetadataWork(live, account, access, request,
      { title: 'Retained fixed release', actingSubject: actor,
        idempotencyKey: `work-${randomUUID()}` });
    await grant(`contribution:create:${work.work}`, 'contribution.create');
    const body = `Exact retained release ${randomUUID()}`;
    const draft = await createAdmittedTextContribution(live, account, access, request,
      { work: work.work, language: 'en', body, actingSubject: actor,
        idempotencyKey: `draft-${randomUUID()}` });
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('retained draft creation is unavailable');
    }
    await grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    const publication = await publishAdmittedTextContribution(live, account, access, request,
      { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution',
        disclosure: 'public', actingSubject: actor,
        idempotencyKey: `publication-${randomUUID()}` });
    if (publication.outcome !== 'succeeded' || !publication.publicationDecision) {
      throw new Error('retained publication is unavailable');
    }
    await grant(`publication:select:${work.mainVersion}`, 'publication.select');
    const selection = await selectAdmittedMainDefault(live, account, access, request,
      { context: { kind: 'main-version-default', id: work.mainVersion },
        work: work.work, contribution: draft.contribution,
        publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer',
        actingSubject: actor, idempotencyKey: `selection-${randomUUID()}` });
    if (selection.outcome !== 'succeeded' || !selection.selection || !selection.mainRevision) {
      throw new Error('retained selection is unavailable');
    }
    await grant(`release:seal:${work.mainVersion}`, 'release.seal');
    const sealed = await createAdmittedFixedRelease(live, account, access, request,
      { work: work.work, mainVersion: work.mainVersion,
        expectedMainRevision: selection.mainRevision, expectedSelection: selection.selection,
        actingSubject: actor, idempotencyKey: `release-${randomUUID()}` });
    expect([work.sequence, draft.sequence, publication.sequence, selection.sequence])
      .toEqual(['1', '2', '3', '4']);
    const original = await readFixedRelease(live, sealed.release, async () => true);
    expect(original.body).toBe(body);
    for (let n = 1; n <= 5; n++) {
      expect((await relayMainOutboxOnce(liveFuseki, relayPool, consumer))?.sequence)
        .toBe(String(n));
    }
    const coverage = await relayCoverage(relayPool, consumer);
    expect(coverage).toMatchObject({ dataEpoch: lineage.dataEpoch, sequence: '5',
      batchCount: '5', eventCount: '5' });
    await engageAccessRecoveryFence(accessPool);

    await initializeFreshGraph(restoredFuseki, lineage);
    const nextLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(restoredFuseki, {
      prior: { ...lineage, sequence: '0' }, next: nextLineage });
    const restored: WorkActivationEnvironment = { ...live, fuseki: restoredFuseki,
      lineage: nextLineage };
    expect((await reconcileRetainedWorkCreate(restored, accessPool, relayPool,
      coverage, '1')).work).toBe(work.work);
    await reconcileRetainedContributionDraftCreate(restored, accessPool, relayPool, coverage, '2');
    await reconcileRetainedContributionPublication(restored, accessPool, relayPool, coverage, '3');
    await reconcileRetainedMainSelection(restored, accessPool, relayPool, coverage, '4');

    const admitted = (await accessPool.query<{ id: string; idempotency_key: string }>(
      'SELECT id, idempotency_key FROM access.admission WHERE graph_receipt = $1',
      [sealed.receipt])).rows[0];
    if (!admitted) throw new Error('retained fixed release admission is absent');
    await accessPool.query('UPDATE access.admission SET idempotency_key = $1 WHERE id = $2',
      [`altered-${randomUUID()}`, admitted.id]);
    await expect(reconcileRetainedFixedRelease(restored, accessPool, relayPool,
      coverage, '5')).rejects.toBeInstanceOf(RetainedEffectConflict);
    await accessPool.query('UPDATE access.admission SET idempotency_key = $1 WHERE id = $2',
      [admitted.idempotency_key, admitted.id]);
    const retained = (await relayPool.query<{ source: string; event_id: string;
      data_epoch: string; sequence: string; envelope: unknown }>(
      'SELECT source, event_id, data_epoch, sequence::text, envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = 5',
      [lineage.dataEpoch])).rows[0];
    if (!retained) throw new Error('retained fixed release event is absent');
    await relayPool.query('DELETE FROM relay.delivered_event WHERE event_id = $1',
      [retained.event_id]);
    await expect(reconcileRetainedFixedRelease(restored, accessPool, relayPool,
      coverage, '5')).rejects.toThrow();
    await relayPool.query(`INSERT INTO relay.delivered_event
      (source, event_id, data_epoch, sequence, envelope) VALUES ($1, $2, $3, $4, $5)`,
    [retained.source, retained.event_id, retained.data_epoch, retained.sequence, retained.envelope]);
    await relayPool.query(`UPDATE relay.delivered_event SET envelope = jsonb_set(
      envelope, '{data,receipt,bodyDigest}', to_jsonb($1::text)) WHERE event_id = $2`,
    [randomUUID().replaceAll('-', '').repeat(2), retained.event_id]);
    await expect(reconcileRetainedFixedRelease(restored, accessPool, relayPool,
      coverage, '5')).rejects.toThrow();
    await relayPool.query('UPDATE relay.delivered_event SET envelope = $1 WHERE event_id = $2',
      [retained.envelope, retained.event_id]);
    expect(await relayCoverage(relayPool, consumer)).toEqual(coverage);
    expect(await reconcileRetainedFixedRelease(restored, accessPool, relayPool,
      coverage, '5')).toEqual({ receipt: sealed.receipt, release: sealed.release,
      replayed: false });
    expect((await reconcileRetainedFixedRelease(restored, accessPool, relayPool,
      coverage, '5')).replayed).toBe(true);
    expect(await readFixedRelease(restored, sealed.release, async () => true)).toEqual(original);
  } finally {
    await Promise.all([accessPool?.end(), relayPool?.end()]);
    for (const runId of started.reverse()) stack('stack:reset', runId);
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
