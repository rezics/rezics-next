import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { contentPublicationDigest, publishPinnedContent, type PublishPinnedContentInput }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { activateMetadataWork, GRAPHS, metadataWorkRequestDigest, RV }
  from '../../../services/main/src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('WORK10: partial native graph commit settles an exact Content pin and replays its receipt', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run this test through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `content-native-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 8 });
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const lineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH };
    const env = { fuseki, lineage, objectDirectory: join(state, 'objects') };
    const title = `Content publication ${randomUUID()}`;
    const workAdmissionId = randomUUID();
    const created = await activateMetadataWork(env, { title, admission: {
      id: workAdmissionId, scope: 'work:create:root', action: 'work.create',
      idempotencyKey: `content-work-${workAdmissionId}`,
      requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } });
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const saved = await content.saveDraft({ operationId: `save-${randomUUID()}`,
      variant: { id: variantId, resourceId: created.work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      sourceRevision: created.workRevision, provenance: { author: 'native-integration' },
      expectedHead: null, model: 'content-shape-v1',
      serializedJson: '{"body":"Exact native Content publication"}' });
    expect(saved.outcome).toBe('succeeded');
    if (!saved.revisionId) throw new Error('Content save has no revision');
    const exact = (await content.readExactBatch([saved.revisionId],
      async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('Content revision is unavailable');
    const input: PublishPinnedContentInput = { preparationId: `publish-${randomUUID()}`,
      revisionId: saved.revisionId, expectedDigest: exact.reference.byteDigest,
      expectedContentEpoch: saved.position.dataEpoch, resourceId: created.work,
      variantId, expectedPublicationHead: null };
    const admissionId = randomUUID();
    const admission: RegisteredAdmission = { id: admissionId, principalId: randomUUID(),
      actingSubject: `https://rezics.com/id/${randomUUID()}`,
      scope: `content:publish:${variantId}`, action: 'content.publish',
      idempotencyKey: `publish-${admissionId}`, requestDigest: contentPublicationDigest(input),
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'registered', dispatchEligible: true, replayed: false };
    const first = await publishPinnedContent(env, content, admission, input);
    expect(first.status).toBe('active');
    expect(first.replayed).toBe(false);
    expect(first.decision).toBeTruthy();
    expect(first.graphDataEpoch).toBe(lineage.dataEpoch);
    const preparation = await content.readPublicationPreparation(input.preparationId);
    expect(preparation?.status).toBe('active');
    expect(preparation?.pinActive).toBe(true);
    expect(preparation?.reference.revisionId).toBe(saved.revisionId);
    const graph = await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH <${GRAPHS.current}> {
        <${variantId}> rv:contentPublicationHead <${first.decision}> . }
      GRAPH <${GRAPHS.revisions}> {
        <${first.decision}> rv:contentRevision <urn:rezics:content:revision:${saved.revisionId}> ;
          rv:byteDigest ${JSON.stringify(input.expectedDigest)} ;
          rv:ownerDataEpoch ${JSON.stringify(input.expectedContentEpoch)} . }
    }`);
    expect(graph.boolean).toBe(true);
    const replay = await publishPinnedContent(env, content, admission, input);
    expect(replay.status).toBe('active');
    expect(replay.replayed).toBe(true);
    expect(replay.graphSequence).toBe(first.graphSequence);
  } finally {
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 45_000);
