import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { markErasureBlocked, journalErasure } from '../../../services/main/src/modules/erasure/journal.ts';
import { ErasureRestoreHold, reconcileRestoredErasures, releaseErasureRestoreHold,
  retainErasureCoverage } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { initializeFreshGraph, type GraphLineage } from '../../../services/main/src/modules/work/activate.ts';
import { captureGraphRecoveryCoverage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = 'd7'.repeat(32);

test('SYS07: unsupported graph and object erasures keep an older owner restore held', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  const dataEpoch = Bun.env.MAIN_DATA_EPOCH;
  const routingEpoch = Bun.env.MAIN_ROUTING_EPOCH;
  if (!runId || !dataEpoch || !routingEpoch || !Bun.env.FUSEKI_URL
    || !Bun.env.FUSEKI_MAINTENANCE_TOKEN || !Bun.env.FUSEKI_COMMAND_TOKEN) {
    throw new Error('Run through the isolated fault/recovery QA tier');
  }

  const databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content', 'relay']);
  const stack = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
  const apps = readEnv(join(stack, 'apps.env'));
  const account = await ratingAccount({ ...apps, ACCOUNT_DATABASE_URL: databases.urls.account },
    'openid access:manage');
  let accountClosed = false;
  const closeAccount = async () => {
    if (!accountClosed) {
      accountClosed = true;
      await account.close();
    }
  };
  const accountPool = new Pool({ connectionString: databases.urls.account, max: 2 });
  let access = new Pool({ connectionString: databases.urls.access, max: 2 });
  let contentPool = new Pool({ connectionString: databases.urls.content, max: 2 });
  const relay = new Pool({ connectionString: databases.urls.relay, max: 2 });
  const pools = new Set<Pool>([accountPool, access, contentPool, relay]);
  const temporary = join(root, '.temp', `sys-erasure-replay-${randomUUID()}`);
  const objects = join(temporary, 'objects');
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL, Bun.env.FUSEKI_MAINTENANCE_TOKEN,
    Bun.env.FUSEKI_COMMAND_TOKEN);
  const lineage: GraphLineage = { dataEpoch, routingEpoch };
  const consumer = `sys07-${randomUUID()}`;
  let sealedCoverage: string | undefined;
  let restored: { account: Pool; access: Pool; content: Pool } | undefined;
  try {
    await migrateContent(contentPool);
    const saved = await new ContentCore(contentPool).saveDraft({
      operationId: `sys07-before-erasure-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`,
        resourceId: `https://rezics.com/id/${randomUUID()}`,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'sys07-erasure-replay' },
      serializedJson: JSON.stringify({ body: 'older Content copy' }),
    });
    if (saved.outcome !== 'succeeded' || !saved.revisionId) {
      throw new Error('Content owner did not save the pre-erasure revision');
    }

    // Record a real cross-owner recovery cut while Access is closed. The retained
    // graph/object evidence is empty, so later graph/object target support cannot
    // be inferred from an unrelated Content revision.
    await initializeFreshGraph(fuseki, lineage);
    await initializeRelayCheckpoint(relay, consumer, dataEpoch);
    const fence = await engageAccessRecoveryFence(access);
    const coverage = await captureGraphRecoveryCoverage(fuseki, accountPool, access, relay,
      consumer, contentPool, { directory: objects });
    sealedCoverage = JSON.stringify(sealRecoveryPayload(coverage,
      recoveryKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relay, sealedCoverage, recoveryKey);
    await retainErasureCoverage(relay, consumer);

    const accountBackup = await databases.snapshot('account', async () => {
      await closeAccount();
      await accountPool.end();
      pools.delete(accountPool);
    });
    const accessBackup = await databases.snapshot('access', async () => {
      await access.end();
      pools.delete(access);
    });
    const contentBackup = await databases.snapshot('content', async () => {
      await contentPool.end();
      pools.delete(contentPool);
    });

    // The retained relay learns of graph and object targets after the owner cut.
    // G-059's current reconciler must keep this restored cut offline because those
    // target families do not yet have replay executors.
    const intent = await journalErasure(relay, {
      operationId: `sys07-unsupported-owner-${randomUUID()}`,
      requestDigest: 'a'.repeat(64), kind: 'resource',
      principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: fence,
      targets: [
        { kind: 'resource', ref: `https://rezics.com/id/${randomUUID()}` },
        { kind: 'object', ref: `sha256:${'b'.repeat(64)}` },
      ],
    });
    await markErasureBlocked(relay, intent.erasureId,
      'graph and object erasure replay is not implemented');

    restored = {
      account: new Pool({ connectionString: accountBackup, max: 2 }),
      access: new Pool({ connectionString: accessBackup, max: 2 }),
      content: new Pool({ connectionString: contentBackup, max: 2 }),
    };
    pools.add(restored.account);
    pools.add(restored.access);
    pools.add(restored.content);
    const restoredFence = await engageAccessRecoveryFence(restored.access);
    const pass = await reconcileRestoredErasures(relay, restored, {
      operationId: `sys07-restore-${randomUUID()}`, consumer, replay: true,
      authority: { sealedCoverage, hmacKey: recoveryKey },
    });
    expect(pass).toMatchObject({ state: 'held', counts: { conflict: 1 } });
    expect((await restored.content.query<{ availability: string }>(
      'SELECT availability FROM content.revision WHERE id = $1', [saved.revisionId])).rows[0])
      .toEqual({ availability: 'available' });
    expect((await relay.query<{ owner: string; target_kind: string }>(
      'SELECT owner, target_kind FROM relay.erasure_target WHERE erasure_id = $1 ORDER BY ordinal',
      [intent.erasureId])).rows).toEqual([
      { owner: 'graph', target_kind: 'resource' },
      { owner: 'object', target_kind: 'object' },
    ]);
    await expect(releaseErasureRestoreHold(relay, restored, pass.reconciliationId,
      restoredFence, { sealedCoverage, hmacKey: recoveryKey }))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
  } finally {
    await closeAccount().catch(() => undefined);
    await Promise.allSettled([...pools].map(pool => pool.end()));
    await databases.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}, 180_000);
