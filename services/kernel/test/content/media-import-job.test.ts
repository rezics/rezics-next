import { afterAll, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { createAccess } from '../../src/access/index.ts';
import { createCollectionJob } from '../../src/content/collection-job.ts';
import { createErasureJob } from '../../src/content/erasure-job.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import { processImportedMedia } from '../../src/content/media-import-job.ts';
import { R2Storage } from '../../src/content/r2-storage.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const storage = new R2Storage({
  endpoint: 'https://media-import-test.r2.cloudflarestorage.com',
  bucket: 'media-import-test',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  fetch: (request) => fetch(request),
  maxObjectBytes: 20 * 1024 * 1024,
});

// Import completion must use these production dependencies. Keep their missing
// integration visible rather than substituting a processor, state machine or worker.
test('trusted media import has a content module in the single native worker', () => {
  expect(KERNEL_WORK_MODULES.filter((module) => module.name === 'content')).toHaveLength(1);
});

test('trusted media import can use the shared native image publication pipeline', () => {
  expect(typeof createImageJob(pool, storage).process).toBe('function');
});

test('trusted media import can coordinate with the native collection fence', () => {
  expect(typeof createCollectionJob(pool, storage).collectPartition).toBe('function');
});

test('trusted media import can use durable native governance prefix purge', () => {
  expect(typeof createErasureJob(pool, storage).purgeObject).toBe('function');
});

test('native cover import uploads measured original bytes and preserves reservation uploader in its event', async () => {
  const route = 42000;
  const mediaId = newId(route);
  const containerId = newId(route);
  const uploaderId = newId(route + 16);
  const sourceUrl = 'https://images.example.test/cover.png';
  const bytes = await sharp({ create: { width: 37, height: 19, channels: 3, background: '#a02476' } })
    .png()
    .toBuffer();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const credit = {
    rightsHolder: 'Cover artist',
    via: { name: 'Catalogue', url: 'https://catalogue.example.test/record' },
    license: 'LicenseRef-unknown',
    obligations: [],
  };
  const provenance = {
    source: 'example',
    external_id: 'cover-record',
    record_revision: '1',
    digest: 'a'.repeat(64),
    converter_revision: '1',
    field_group: 'cover',
    references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: sourceUrl } }] }],
  };
  await pool.query(
    `INSERT INTO content.media
       (route,media_id,container_id,uploader_id,reservation_request_id,purpose,state,key,
        transaction_id,source_url,credit,provenance)
     VALUES ($1,$2::uuid,$3,$4,$2::text,'cover','reserved',$5,$2::uuid,$6,$7,$8)`,
    [route, mediaId, containerId, uploaderId, `m/${mediaId}/original`, sourceUrl, credit, provenance],
  );

  const requests: Request[] = [];
  const puts: { path: string; bytes: Uint8Array; mediaType: string | null }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method === 'PUT') {
        puts.push({
          path: new URL(request.url).pathname,
          bytes: new Uint8Array(await request.arrayBuffer()),
          mediaType: request.headers.get('content-type'),
        });
        return new Response(null, { status: 200 });
      }
      // Deliberately disagree with the actual PNG: remote metadata is not evidence.
      return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
    },
  });
  const transport = globalThis.fetch;
  const sourceFetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    expect(request.url).toBe(sourceUrl);
    expect(request.redirect).toBe('manual');
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('cookie')).toBe(false);
    return transport(new URL('/cover.png', server.url), { signal: request.signal, redirect: 'manual' });
  });
  const originalStorage = new R2Storage({
    endpoint: 'https://media-import-test.r2.cloudflarestorage.com',
    bucket: 'media-import-test',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    maxObjectBytes: 20 * 1024 * 1024,
    fetch: (request) =>
      transport(new URL(new URL(request.url).pathname, server.url), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        redirect: 'manual',
      }),
  });
  try {
    await processImportedMedia(
      {
        pool,
        access: createAccess({ actions: new Map() }),
        routeKey: new Uint8Array(32).fill(7),
        clock: () => new Date(),
        fetchConfig: { allowedHosts: ['images.example.test'] },
        storage: originalStorage,
      },
      mediaId,
    );
    expect(requests).toHaveLength(1);
    expect(puts).toEqual([
      { path: `/media-import-test/m/${mediaId}/original`, bytes: new Uint8Array(bytes), mediaType: 'image/png' },
    ]);
    expect(
      (
        await pool.query(
          `SELECT state,uploader_id,byte_count,actual_byte_count,media_type,sha256,credit,provenance
           FROM content.media WHERE route=$1 AND media_id=$2`,
          [route, mediaId],
        )
      ).rows,
    ).toEqual([
      {
        state: 'uploaded',
        uploader_id: uploaderId,
        byte_count: String(bytes.byteLength),
        actual_byte_count: String(bytes.byteLength),
        media_type: 'image/png',
        sha256,
        credit,
        provenance,
      },
    ]);
    expect(
      (
        await pool.query('SELECT type,data FROM core.outbox WHERE partition_no=$1 AND subject=$2', [
          partitionOf(route),
          mediaId,
        ])
      ).rows,
    ).toEqual([{ type: 'com.rezics.content.media.uploaded.v1', data: { mediaId, containerId, actorId: uploaderId } }]);
    // Restart delivery cannot refetch, overwrite storage or emit a second event.
    await processImportedMedia(
      {
        pool,
        access: createAccess({ actions: new Map() }),
        routeKey: new Uint8Array(32).fill(7),
        clock: () => new Date(),
        fetchConfig: { allowedHosts: ['images.example.test'] },
        storage: originalStorage,
      },
      mediaId,
    );
    expect(requests).toHaveLength(1);
    expect(puts).toHaveLength(1);
    expect(
      (
        await pool.query('SELECT count(*) FROM core.outbox WHERE partition_no=$1 AND subject=$2', [
          partitionOf(route),
          mediaId,
        ])
      ).rows,
    ).toEqual([{ count: '1' }]);
  } finally {
    sourceFetch.mockRestore();
    await server.stop(true);
  }
});
