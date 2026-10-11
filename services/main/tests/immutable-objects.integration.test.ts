import { expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { ObjectIntegrityError, ObjectListingUnavailable, ObjectReadBudgetExceeded,
  ObjectVersioningUnsupported, S3ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { activateMetadataWork, initializeFreshGraph, metadataWorkRequestDigest, GRAPHS } from '../src/modules/work/activate.ts';
import { editMetadataWork, metadataWorkEditDigest } from '../src/modules/work/edit.ts';
import { readExactWorkRevision } from '../src/modules/work/history.ts';

const runId = Bun.env.REZICS_S3_GATE_PROJECT;
const rustfsGate = runId ? test : test.skip;

function listingXml(options: { bucket?: string; prefix: string; maxKeys: string; keys?: string[];
  truncated?: string; reportedPrefix?: string; keyCount?: string | null }) {
  const keys = options.keys ?? [];
  const contents = keys.map(key => `<Contents><Key>${key.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}`
    + `</Key><Size>1</Size></Contents>`).join('');
  const keyCount = options.keyCount === null ? '' : `<KeyCount>${options.keyCount ?? String(keys.length)}</KeyCount>`;
  return `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`
    + `<Name>${options.bucket ?? 'rezics-semantic'}</Name>`
    + `<Prefix>${options.reportedPrefix ?? options.prefix}</Prefix><MaxKeys>${options.maxKeys}</MaxKeys>`
    + `${keyCount}<IsTruncated>${options.truncated ?? 'false'}</IsTruncated>${contents}</ListBucketResult>`;
}

function namespaceFixture(options: { versioning?: string; listing?: (url: URL) => string;
  deleteMarker?: boolean }) {
  const counts = { versioning: 0, listing: 0, deletes: 0, probes: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.searchParams.has('versioning')) {
      counts.versioning++;
      const status = options.versioning ? `<Status>${options.versioning}</Status>` : '';
      return new Response(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${status}</VersioningConfiguration>`);
    }
    if (url.searchParams.get('list-type') === '2') {
      counts.listing++;
      return new Response(options.listing?.(url) ?? listingXml({
        prefix: url.searchParams.get('prefix') ?? '', maxKeys: url.searchParams.get('max-keys') ?? '',
      }));
    }
    if (request.method === 'DELETE') {
      counts.deletes++;
      return new Response(null, { status: 204 });
    }
    if (request.method === 'HEAD') {
      counts.probes++;
      return options.deleteMarker
        ? new Response(null, { status: 404, headers: { 'x-amz-delete-marker': 'true' } })
        : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  } });
  const store = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
    bucket: 'rezics-semantic', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
    prefix: 'semantic/work/' });
  return { store, server, counts };
}

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
  expect(await store.listPrefix('semantic/work/', { maxEntries: 8 }))
    .toContain(`semantic/work/sha256/${digest}`);

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

test('S3 namespace listing returns only a complete in-prefix inventory', async () => {
  const prefix = 'semantic/work/';
  const key = `${prefix}sha256/${'a'.repeat(64)}`;
  const fixture = namespaceFixture({ listing: url => listingXml({ prefix,
    maxKeys: url.searchParams.get('max-keys') ?? '', keys: [key] }) });
  try {
    expect(await fixture.store.listPrefix(prefix, { maxEntries: 2 })).toEqual([key]);
    expect(fixture.counts).toEqual({ versioning: 1, listing: 1, deletes: 0, probes: 0 });
    await expect(fixture.store.listPrefix('semantic/other/', { maxEntries: 2 }))
      .rejects.toBeInstanceOf(ObjectIntegrityError);
    expect(fixture.counts.listing).toBe(1);
  } finally {
    await fixture.server.stop(true);
  }
});

test('S3 namespace listing refuses truncation, false metadata and lookahead overflow', async () => {
  const prefix = 'semantic/work/';
  const keys = [0, 1, 2].map(index => `${prefix}orphan/${index}`);
  const cases = [
    { name: 'truncated page', expected: ObjectListingUnavailable,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, keys: keys.slice(0, 2), truncated: 'true' }) },
    { name: 'wrong reported prefix', expected: ObjectListingUnavailable,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, reportedPrefix: 'semantic/work-other/', keys: [] }) },
    { name: 'blank key count', expected: ObjectListingUnavailable,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, keys: [], keyCount: '' }) },
    { name: 'whitespace key count', expected: ObjectListingUnavailable,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, keys: [], keyCount: ' \t ' }) },
    { name: 'missing key count', expected: ObjectListingUnavailable,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, keys: [], keyCount: null }) },
    { name: 'non-numeric key count', expected: ObjectListingUnavailable,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, keys: [], keyCount: 'abc' }) },
    { name: 'negative key count', expected: ObjectListingUnavailable,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, keys: [], keyCount: '-1' }) },
    { name: 'fractional key count', expected: ObjectListingUnavailable,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, keys: [], keyCount: '1.5' }) },
    { name: 'key count beyond requested maximum', expected: ObjectListingUnavailable,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, keys: [], keyCount: '999' }) },
    { name: 'key count disagrees with contents', expected: ObjectListingUnavailable,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, keys: [keys[0]!], keyCount: '2' }) },
    { name: 'lookahead entry', expected: ObjectReadBudgetExceeded,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, keys }) },
    { name: 'key outside requested prefix', expected: ObjectListingUnavailable,
      build: (maxKeys: string) => listingXml({ prefix, maxKeys, keys: ['semantic/work-other/object'] }) },
  ];
  for (const item of cases) {
    const fixture = namespaceFixture({ listing: url => item.build(url.searchParams.get('max-keys') ?? '') });
    try {
      await expect(fixture.store.listPrefix(prefix, { maxEntries: 2 }))
        .rejects.toBeInstanceOf(item.expected);
      expect(fixture.counts.listing).toBe(1);
    } finally {
      await fixture.server.stop(true);
    }
  }
});

test('S3 namespace listing enforces its combined response byte budget', async () => {
  const prefix = 'semantic/work/';
  const fixture = namespaceFixture({ listing: url => listingXml({ prefix,
    maxKeys: url.searchParams.get('max-keys') ?? '', keys: [`${prefix}${'a'.repeat(400)}`] }) });
  try {
    await expect(fixture.store.listPrefix(prefix, { maxEntries: 2, maxResponseBytes: 256 }))
      .rejects.toBeInstanceOf(ObjectReadBudgetExceeded);
  } finally {
    await fixture.server.stop(true);
  }
});

test('S3 namespace listing refuses versioned buckets even when current-key listing is empty', async () => {
  for (const versioning of ['Enabled', 'Suspended']) {
    const fixture = namespaceFixture({ versioning });
    try {
      await expect(fixture.store.listPrefix('semantic/work/', { maxEntries: 2 }))
        .rejects.toBeInstanceOf(ObjectVersioningUnsupported);
      expect(fixture.counts.listing).toBe(0);
    } finally {
      await fixture.server.stop(true);
    }
  }
});

test('S3 delete marker response cannot prove an immutable object is absent', async () => {
  const fixture = namespaceFixture({ deleteMarker: true });
  try {
    await expect(fixture.store.deleteAndVerifyAbsent('b'.repeat(64)))
      .rejects.toBeInstanceOf(ObjectVersioningUnsupported);
    expect(fixture.counts).toEqual({ versioning: 0, listing: 0, deletes: 1, probes: 1 });
  } finally {
    await fixture.server.stop(true);
  }
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
