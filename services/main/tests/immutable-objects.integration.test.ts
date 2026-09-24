import { expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { S3ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { activateMetadataWork, initializeFreshGraph, metadataWorkRequestDigest, GRAPHS } from '../src/modules/work/activate.ts';
import { editMetadataWork, metadataWorkEditDigest } from '../src/modules/work/edit.ts';
import { readExactWorkRevision } from '../src/modules/work/history.ts';

const runId = Bun.env.REZICS_S3_GATE_PROJECT;
const rustfsGate = runId ? test : test.skip;

rustfsGate('P0.5 RustFS signed conditional create, checksum and concurrent writers', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const env = readEnv(`${stackDirectory(root, { profile: 'qa', runId: runId! })}/compose.env`);
  const endpoint = `http://127.0.0.1:${env.RUSTFS_PORT}`;
  const bucket = `rezics-p05-${randomBytes(8).toString('hex')}`;
  const options = { endpoint, bucket, accessKeyId: env.RUSTFS_ACCESS_KEY!,
    secretAccessKey: env.RUSTFS_SECRET_KEY!, prefix: 'semantic/work/' };
  const store = new S3ImmutableObjects(options);
  await store.initialize();
  const bytes = Buffer.from('RustFS immutable revision gate\0' + randomBytes(16).toString('hex'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const results = await Promise.all(Array.from({ length: 8 }, () => store.put(bytes)));
  expect(results).toEqual(Array(8).fill(digest));
  expect(Buffer.from(await store.get(digest))).toEqual(bytes);

  const signer = new AwsClient({ accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey, service: 's3', region: 'us-east-1', retries: 0 });
  const overwrite = await signer.fetch(`${endpoint}/${bucket}/semantic/work/sha256/${digest}`, {
    method: 'PUT', headers: { 'if-none-match': '*', 'content-type': 'application/octet-stream' },
    body: Buffer.from('different bytes'), aws: { allHeaders: true },
  });
  expect(overwrite.status).toBe(412);
  expect(Buffer.from(await store.get(digest))).toEqual(bytes);
  await new S3ImmutableObjects(options).initialize();
});

rustfsGate('P0.5 Main Work create, edit and exact read use RustFS manifests', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const stack = stackDirectory(root, { profile: 'qa', runId: runId! });
  const env = readEnv(`${stack}/compose.env`);
  const lineage = { dataEpoch: env.MAIN_DATA_EPOCH!, routingEpoch: env.MAIN_ROUTING_EPOCH! };
  const fuseki = new FusekiClient(`http://127.0.0.1:${env.FUSEKI_PORT}/rezics/`);
  const control = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    ASK { GRAPH <${GRAPHS.control}> { <urn:rezics:dataset:product> rv:dataEpoch ?epoch } }`);
  if (control.boolean !== true) {
    try { await initializeFreshGraph(fuseki, lineage); }
    catch {
      // Another integration test may have won the fresh-dataset bootstrap.
      const current = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
        ASK { GRAPH <${GRAPHS.control}> { <urn:rezics:dataset:product>
          rv:dataEpoch ${JSON.stringify(lineage.dataEpoch)} ;
          rv:routingEpoch ${JSON.stringify(lineage.routingEpoch)} . } }`);
      if (current.boolean !== true) throw new Error('QA dataset bootstrap has a different lineage');
    }
  }
  const objects = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${env.RUSTFS_PORT}`,
    bucket: 'rezics-semantic', accessKeyId: env.RUSTFS_ACCESS_KEY!,
    secretAccessKey: env.RUSTFS_SECRET_KEY!, prefix: 'semantic/work/' });
  await objects.initialize();
  const objectDirectory = join(stack, 'legacy-work-objects');
  const work = { fuseki, lineage, objectDirectory, workObjects: objects };
  const title = `RustFS Work ${randomBytes(6).toString('hex')}`;
  const created = await activateMetadataWork(work, { title, admission: {
    id: Bun.randomUUIDv7(), scope: 'work:create:root', action: 'work.create',
    idempotencyKey: `s3-${randomBytes(8).toString('hex')}`,
    requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } });
  const first = await readExactWorkRevision(work, created.workRevision, async () => true);
  expect(first.title).toBe(title);
  expect(first.mainVersion).toBe(created.mainVersion);
  const nextTitle = `${title} edited`;
  const edited = await editMetadataWork(work, { work: created.work,
    expectedHead: created.workRevision, title: nextTitle, admission: {
      id: Bun.randomUUIDv7(), scope: `work:edit:${created.work}`, action: 'work.edit',
      requestDigest: metadataWorkEditDigest(created.work, created.workRevision, nextTitle),
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } });
  const second = await readExactWorkRevision(work, edited.revision, async () => true);
  expect(second.title).toBe(nextTitle);
  expect(second.predecessor).toBe(created.workRevision);
  const reopenedObjects = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${env.RUSTFS_PORT}`,
    bucket: 'rezics-semantic', accessKeyId: env.RUSTFS_ACCESS_KEY!,
    secretAccessKey: env.RUSTFS_SECRET_KEY!, prefix: 'semantic/work/' });
  await reopenedObjects.initialize();
  const reopened = await readExactWorkRevision({ ...work, workObjects: reopenedObjects },
    edited.revision, async () => true);
  expect(reopened).toEqual(second);
  expect(existsSync(objectDirectory)).toBe(false);
});
