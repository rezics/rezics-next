import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { contentPublicationDigest, contentPublicationReceiptIri,
  publishPinnedContent, reconcilePinnedContentPublication,
  type PublishPinnedContentInput } from '../../../services/main/src/modules/content-publication/publish.ts';
import { GRAPHS, RV, activateMetadataWork, initializeFreshGraph,
  metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';

const root = resolve(import.meta.dir, '../../..');

function rootCommand(args: string[], timeout: number): void {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-2000)}`);
  }
}

/** The graph still receives the real validated command; only cross-owner
 * settlement is interrupted, as if Main stopped after the graph commit. */
function interruptSettlement(content: ContentCore): { content: ContentCore; calls: () => number } {
  let calls = 0;
  const interrupted = new Proxy(content, { get(target, property) {
    if (property === 'settlePublication') return () => {
      calls++;
      throw new Error('simulated outcome-delivery interruption');
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { content: interrupted, calls: () => calls };
}

async function migrateAccess(url: string): Promise<void> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const directory = join(root, 'services/main/migrations/access');
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
      await db.query(readFileSync(join(directory, file), 'utf8'));
    }
  } finally { await db.end(); }
}

test('WORK10: ambiguous, active and rejected Content publication pins reconcile from exact graph receipts', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const runId = `${Bun.env.REZICS_QA_RUN_ID}-w10`;
  const options = { profile: 'qa' as const, runId };
  const stackArgs = ['--profile', 'qa', '--run-id', runId];
  let started = false;
  try {
    started = true;
    rootCommand(['stack:up', ...stackArgs], 180_000);
    const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    await initializeFreshGraph(fuseki, lineage);
    await migrateAccess(apps.ACCESS_DATABASE_URL!);
    const pool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 4 });
    const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 4 });
    try {
      await migrateContent(pool);
      const content = new ContentCore(pool);
      const access = new AccessAdmissionRegistry(accessPool);
      const env = { fuseki, lineage, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
      const title = `WORK10 recovery ${randomUUID()}`;
      const work = await activateMetadataWork(env, { title, admission: {
        id: randomUUID(), scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `work10-work-${randomUUID()}`,
        requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      } });
      const variantId = `urn:rezics:variant:${randomUUID()}`;
      const actor = `https://rezics.com/id/${randomUUID()}`;
      const principal = { issuer: 'https://qa-work10-local.test', subject: randomUUID() };
      const principalId = randomUUID();
      const publishScope = `content:publish:${variantId}`;
      await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
        [principalId, principal.issuer, principal.subject]);
      await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [actor, 'agent']);
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [publishScope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, 'content.publish', now() + interval '1 hour')`,
      [randomUUID(), principalId, actor]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, 'content.publish', now() + interval '1 hour')`,
      [randomUUID(), actor, publishScope]);
      const admission = async (input: PublishPinnedContentInput) => {
        const digest = contentPublicationDigest(input);
        const registered = await access.register({ principal, actingSubject: actor,
          scope: publishScope, action: 'content.publish',
          idempotencyKey: `work10-${randomUUID()}`, requestDigest: digest });
        return access.claim(registered.id, digest);
      };
      const variant = { id: variantId, resourceId: work.work,
        language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' },
        direction: 'ltr' as const };
      const save = async (body: string, expectedHead: string | null) => {
        const saved = await content.saveDraft({ operationId: `work10-draft-${randomUUID()}`,
          variant, expectedHead, model: 'content-shape-v1', sourceRevision: null,
          provenance: { fixture: 'work10-reconciliation' },
          serializedJson: JSON.stringify({ body }) });
        expect(saved.outcome).toBe('succeeded');
        if (!saved.revisionId) throw new Error('saved Content revision is absent');
        const exact = (await content.readExactBatch([saved.revisionId],
          async ids => new Set(ids)))[0];
        if (exact?.status !== 'available') throw new Error('saved Content bytes are unavailable');
        return { saved, exact };
      };
      const makeInput = (revisionId: string, byteDigest: string, contentEpoch: string,
        expectedPublicationHead: string | null): PublishPinnedContentInput => ({
        preparationId: `work10-prepare-${randomUUID()}`, revisionId,
        expectedDigest: byteDigest, expectedContentEpoch: contentEpoch,
        resourceId: work.work, variantId, expectedPublicationHead,
      });
      const graphReceipt = async (id: string, outcome: 'Succeeded' | 'Cancelled') =>
        (await fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH <${GRAPHS.receipts}> { <${contentPublicationReceiptIri(id)}>
            a rv:OperationReceipt ; rv:outcome rv:${outcome} . } }`)).boolean;

      const first = await save('retained accepted Content', null);
      const activeInput = makeInput(first.saved.revisionId!, first.exact.reference.byteDigest,
        first.saved.position.dataEpoch, null);
      const activeAdmission = await admission(activeInput);
      const activePin = await content.preparePublication(activeInput.preparationId,
        activeInput.revisionId, activeInput.expectedDigest, true, activeInput.expectedContentEpoch);
      expect(activePin.status).toBe('pending');
      expect(activePin.pinActive).toBe(true);
      expect(await graphReceipt(activeAdmission.id, 'Succeeded')).toBe(false);
      expect((await reconcilePinnedContentPublication(env, content, activeAdmission, activeInput)).status).toBe('pending');
      expect((await content.readPublicationPreparation(activeInput.preparationId))?.pinActive).toBe(true);
      expect((await content.readExactBatch([first.saved.revisionId!],
        async ids => new Set(ids)))[0]?.status).toBe('available');
      const interruptedActive = interruptSettlement(content);
      await expect(publishPinnedContent(env, interruptedActive.content, activeAdmission, activeInput))
        .rejects.toThrow('simulated outcome-delivery interruption');
      expect(interruptedActive.calls()).toBe(1);
      expect(await graphReceipt(activeAdmission.id, 'Succeeded')).toBe(true);
      expect((await content.readPublicationPreparation(activeInput.preparationId))?.status).toBe('pending');
      expect((await content.readPublicationPreparation(activeInput.preparationId))?.pinActive).toBe(true);
      expect((await content.readExactBatch([first.saved.revisionId!],
        async ids => new Set(ids)))[0]?.status).toBe('available');
      const active = await reconcilePinnedContentPublication(env, content, activeAdmission, activeInput);
      expect(active.status).toBe('active');
      expect(active.decision).toBeTruthy();
      expect((await content.readPublicationPreparation(activeInput.preparationId))?.pinActive).toBe(true);
      expect((await reconcilePinnedContentPublication(env, content, activeAdmission, activeInput)).replayed).toBe(true);
      expect((await publishPinnedContent(env, content, activeAdmission, activeInput)).status).toBe('active');

      const second = await save('retained rejected Content', first.saved.revisionId!);
      // The graph has an active publication head. This stale expectation must
      // produce a terminal rejection receipt before its pin can be released.
      const rejectedInput = makeInput(second.saved.revisionId!, second.exact.reference.byteDigest,
        second.saved.position.dataEpoch, null);
      const rejectedAdmission = await admission(rejectedInput);
      await content.preparePublication(rejectedInput.preparationId,
        rejectedInput.revisionId, rejectedInput.expectedDigest, true, rejectedInput.expectedContentEpoch);
      expect((await reconcilePinnedContentPublication(env, content, rejectedAdmission, rejectedInput)).status).toBe('pending');
      expect((await content.readPublicationPreparation(rejectedInput.preparationId))?.pinActive).toBe(true);
      const interruptedRejected = interruptSettlement(content);
      await expect(publishPinnedContent(env, interruptedRejected.content,
        rejectedAdmission, rejectedInput)).rejects.toThrow('simulated outcome-delivery interruption');
      expect(interruptedRejected.calls()).toBe(1);
      expect(await graphReceipt(rejectedAdmission.id, 'Cancelled')).toBe(true);
      expect((await content.readPublicationPreparation(rejectedInput.preparationId))?.pinActive).toBe(true);
      const rejected = await reconcilePinnedContentPublication(env, content, rejectedAdmission, rejectedInput);
      expect(rejected.status).toBe('rejected');
      expect(rejected.decision).toBeNull();
      expect((await content.readPublicationPreparation(rejectedInput.preparationId))?.pinActive).toBe(false);
      expect((await reconcilePinnedContentPublication(env, content, rejectedAdmission, rejectedInput)).replayed).toBe(true);
      expect((await publishPinnedContent(env, content, rejectedAdmission, rejectedInput)).status).toBe('rejected');
      const retained = (await content.readExactBatch([second.saved.revisionId!],
        async ids => new Set(ids)))[0];
      expect(retained?.status).toBe('available');
      if (retained?.status !== 'available') throw new Error('rejected Content bytes were lost');
      expect(retained.body.body).toBe('retained rejected Content');
      const current = await fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH <${GRAPHS.current}> { <${variantId}>
          rv:contentPublicationHead <${active.decision}> . } }`);
      expect(current.boolean).toBe(true);
      const events = await content.readOutbox(first.saved.position.dataEpoch, '0', 16);
      expect(events.filter(event => event.eventType === 'content.publication.active')).toHaveLength(1);
      expect(events.filter(event => event.eventType === 'content.publication.rejected')).toHaveLength(1);
    } finally { await Promise.all([pool.end(), accessPool.end()]); }
  } finally {
    if (started) rootCommand(['stack:reset', ...stackArgs], 120_000);
  }
}, 240_000);
