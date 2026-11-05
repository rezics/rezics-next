import { afterAll, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { createAccess } from '../../src/access/index.ts';
import { processImportedMedia } from '../../src/content/media-import-job.ts';
import { R2Storage } from '../../src/content/r2-storage.ts';
import { assertGrowthPointPlans } from './support/media-fixtures.ts';
import { newId, partitionOf } from '../../src/route/route.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
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
    idleTimeout: 0,
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
  const sourceFetch = spyOn(
    globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
    'fetch',
  ).mockImplementation(async (input, init) => {
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

// Only HTTP transport is substituted. PostgreSQL, signed R2 storage and Sharp are real.
const routeKey = new Uint8Array(32).fill(7);
const credit = {
  rightsHolder: 'Artist',
  via: { name: 'Catalogue', url: 'https://catalogue.example.test/' },
  license: 'LicenseRef-unknown',
  obligations: [],
};
async function reserve(db = pool, overrides: Record<string, unknown> = {}) {
  const route = 42112;
  const mediaId = newId(route);
  const provenance = {
    source: 'catalogue',
    external_id: mediaId,
    record_revision: '1',
    digest: 'a'.repeat(64),
    converter_revision: '1',
    field_group: 'cover',
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://images.example.test/image' } },
        ],
      },
    ],
    ...overrides,
  };
  await db.query(
    `INSERT INTO content.media
    (route,media_id,container_id,uploader_id,reservation_request_id,purpose,state,key,transaction_id,source_url,credit,provenance)
    VALUES ($1,$2::uuid,$3,$4,$2::text,'cover','reserved',$5,$2::uuid,'https://images.example.test/image',$6,$7)`,
    [route, mediaId, newId(route), newId(12), `m/${mediaId}/original`, credit, provenance],
  );
  return { route, mediaId, provenance };
}
async function fixture(source: (request: Request) => Response | Promise<Response>) {
  const transport = globalThis.fetch;
  const requests: Request[] = [];
  const objects = new Map<string, Uint8Array>();
  let failPut = false;
  let failPurge = false;
  let puts = 0;
  const server = Bun.serve({
    idleTimeout: 0,
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/bucket' && !url.pathname.startsWith('/bucket/')) return source(request);
      const key = decodeURIComponent(url.pathname.slice('/bucket/'.length));
      if (request.method === 'PUT') {
        puts++;
        objects.set(key, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: failPut ? 503 : 200 });
      }
      if (request.method === 'DELETE') {
        if (failPurge) return new Response(null, { status: 503 });
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const prefix = url.searchParams.get('prefix')!;
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return new Response(
        `<ListBucketResult><EncodingType>url</EncodingType><Prefix>${encodeURIComponent(prefix)}</Prefix><IsTruncated>false</IsTruncated><KeyCount>${keys.length}</KeyCount>${keys.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join('')}</ListBucketResult>`,
      );
    },
  });
  const sourceFetch = spyOn(
    globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
    'fetch',
  ).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    expect(request.redirect).toBe('manual');
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('cookie')).toBe(false);
    return transport(new URL(new URL(request.url).pathname, server.url), {
      signal: request.signal,
      redirect: 'manual',
    });
  });
  const storage = new R2Storage({
    endpoint: 'https://fixture.r2.cloudflarestorage.com',
    bucket: 'bucket',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    maxObjectBytes: 20 * 1024 * 1024,
    fetch: (request) =>
      transport(new URL(new URL(request.url).pathname + new URL(request.url).search, server.url), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        redirect: 'manual',
      }),
  });
  return {
    requests,
    objects,
    storage,
    get puts() {
      return puts;
    },
    set failPut(value: boolean) {
      failPut = value;
    },
    set failPurge(value: boolean) {
      failPurge = value;
    },
    async close() {
      sourceFetch.mockRestore();
      await server.stop(true);
    },
  };
}
function deps(storage: R2Storage, db = pool) {
  return {
    pool: db,
    access: createAccess({ actions: new Map() }),
    routeKey,
    clock: () => new Date(),
    fetchConfig: { allowedHosts: ['images.example.test', 'other.example.test'] },
    storage,
  };
}
async function fetched(url = 'https://images.example.test/image') {
  return (await import('../../src/content/fetch-source-image.ts')).fetchSourceImage(url, {
    allowedHosts: ['images.example.test', 'other.example.test'],
  });
}
const png = () =>
  sharp({ create: { width: 23, height: 17, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();

test('registration configuration fails closed and validates exact host names', async () => {
  const { readMediaImportFetchConfig } = await import('../../src/content/fetch-source-image.ts');
  for (const value of [
    undefined,
    '',
    '*',
    '.example.test',
    'https://images.example.test',
    '127.0.0.1',
    '[::1]',
    'host:443',
  ]) {
    expect(() => readMediaImportFetchConfig({ KERNEL_MEDIA_IMPORT_ALLOWED_HOSTS: value })).toThrow(
      'KERNEL_MEDIA_IMPORT_ALLOWED_HOSTS',
    );
  }
  expect(
    readMediaImportFetchConfig({ KERNEL_MEDIA_IMPORT_ALLOWED_HOSTS: 'images.example.test,other.example.test' }),
  ).toEqual({ allowedHosts: ['images.example.test', 'other.example.test'] });
});

test('every redirect is validated before sending, with a four request ceiling', async () => {
  const bytes = await png();
  let location = 'https://other.example.test/final';
  const http = await fixture((request) =>
    new URL(request.url).pathname === '/final'
      ? new Response(bytes)
      : new Response(null, { status: 302, headers: { location } }),
  );
  try {
    expect((await fetched()).bytes).toEqual(new Uint8Array(bytes));
    expect(http.requests.map((request) => new URL(request.url).hostname)).toEqual([
      'images.example.test',
      'other.example.test',
    ]);
    for (const invalid of [
      'https://images.example.test.evil.test/',
      'https://sub.images.example.test/',
      'http://images.example.test/',
      'https://user:secret@images.example.test/',
      'https://images.example.test:444/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://2130706433/',
      'https://169.254.169.254/',
    ]) {
      location = invalid;
      const before = http.requests.length;
      await expect(fetched()).rejects.toMatchObject({ code: 'source-url' });
      expect(http.requests.length - before).toBe(1);
      await expect(fetched(invalid)).rejects.toMatchObject({ code: 'source-url' });
      expect(http.requests.length - before).toBe(1);
    }
    location = '/loop';
    const before = http.requests.length;
    await expect(fetched()).rejects.toMatchObject({ code: 'source-redirect' });
    expect(http.requests.length - before).toBe(4);
  } finally {
    await http.close();
  }
});

test('stream bytes are bounded despite missing or falsely small length and headers are bounded', async () => {
  for (const length of [undefined, '1']) {
    let cancelled = false;
    const mock = spyOn(
      globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
      'fetch',
    ).mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: length ? { 'content-length': length } : {} },
        ),
    );
    try {
      await expect(fetched()).rejects.toMatchObject({ code: 'source-bytes' });
      expect(cancelled).toBe(true);
    } finally {
      mock.mockRestore();
    }
  }
  const http = await fixture(() => new Response('x', { headers: { 'x-padding': 'x'.repeat(20_000) } }));
  try {
    await expect(fetched()).rejects.toMatchObject({ code: 'source-headers' });
  } finally {
    await http.close();
  }
});

test('whole fetch deadline cancels the active HTTP body', async () => {
  const http = await fixture(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
      ),
  );
  try {
    await expect(fetched()).rejects.toMatchObject({ code: 'source-timeout' });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.signal.aborted).toBe(true);
  } finally {
    await http.close();
  }
}, 20_000);

test('permanent decode and pixel failures commit rejection and durable purge, never upload', async () => {
  const oversized = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: '#000000' } })
    .png()
    .toBuffer();
  for (const bytes of [Buffer.from('invalid image'), oversized, Buffer.from('<svg width="1" height="1"></svg>')]) {
    const row = await reserve();
    const http = await fixture(() => new Response(bytes));
    try {
      expect(await processImportedMedia(deps(http.storage), row.mediaId)).toMatchObject({ state: 'rejected' });
      const state = (
        await pool.query(
          'SELECT state,decision,collection_pending,actual_byte_count FROM content.media WHERE route=$1 AND media_id=$2',
          [row.route, row.mediaId],
        )
      ).rows[0];
      expect(state).toMatchObject({ state: 'rejected', collection_pending: true, actual_byte_count: null });
      expect(state.decision.length).toBeLessThan(100);
      expect(http.puts).toBe(0);
      expect(
        (
          await pool.query('SELECT type,data FROM core.outbox WHERE partition_no=$1 AND subject=$2', [
            partitionOf(row.route),
            row.mediaId,
          ])
        ).rows,
      ).toEqual([
        {
          type: 'com.rezics.content.media.rejected.v1',
          data: { mediaId: row.mediaId, containerId: expect.any(String), decisionId: expect.any(String) },
        },
      ]);
      await processImportedMedia(deps(http.storage), row.mediaId);
      expect(http.requests).toHaveLength(1);
    } finally {
      await http.close();
    }
  }
});

test('transient R2 writes retry deterministic bytes, and rejected cleanup survives restart', async () => {
  const bytes = await png();
  const row = await reserve();
  const http = await fixture(() => new Response(bytes));
  try {
    http.failPut = true;
    await expect(processImportedMedia(deps(http.storage), row.mediaId)).rejects.toThrow();
    expect(
      (await pool.query('SELECT state FROM content.media WHERE route=$1 AND media_id=$2', [row.route, row.mediaId]))
        .rows,
    ).toEqual([{ state: 'reserved' }]);
    http.failPut = false;
    await processImportedMedia(deps(http.storage), row.mediaId);
    expect(http.puts).toBe(2);
    expect(http.objects.size).toBe(1);
    const rejected = await reserve();
    await pool.query('UPDATE content.media SET source_url=$3 WHERE route=$1 AND media_id=$2', [
      rejected.route,
      rejected.mediaId,
      'https://denied.example.test/',
    ]);
    http.objects.set(`m/${rejected.mediaId}/original`, bytes);
    http.failPurge = true;
    await expect(processImportedMedia(deps(http.storage), rejected.mediaId)).rejects.toThrow();
    expect(
      (
        await pool.query('SELECT state,collection_pending FROM content.media WHERE route=$1 AND media_id=$2', [
          rejected.route,
          rejected.mediaId,
        ])
      ).rows,
    ).toEqual([{ state: 'rejected', collection_pending: true }]);
    http.failPurge = false;
    await processImportedMedia(deps(http.storage), rejected.mediaId);
    expect(http.objects.has(`m/${rejected.mediaId}/original`)).toBe(false);
  } finally {
    await http.close();
  }
});

test('erased, collecting, taken down and non-cover rows never fetch or publish', async () => {
  const http = await fixture(() => new Response('unexpected'));
  try {
    for (const patch of [
      'erased=true,security_revision=security_revision+1',
      'collection_pending=true',
      'taken_down=true,security_revision=1',
    ]) {
      const row = await reserve();
      await pool.query(`UPDATE content.media SET ${patch} WHERE route=$1 AND media_id=$2`, [row.route, row.mediaId]);
      expect(await processImportedMedia(deps(http.storage), row.mediaId)).toMatchObject({ state: 'already_terminal' });
    }
    expect(await processImportedMedia(deps(http.storage), newId(42112))).toMatchObject({ state: 'already_terminal' });
    expect(http.requests).toHaveLength(0);
    expect(http.puts).toBe(0);
  } finally {
    await http.close();
  }
});

test('different-partition source preparation releases both anchors before locked media work; later fence remains', async () => {
  const { tupleRoute } = await import('../../src/content/imported-contract.ts');
  const { readFences } = await import('../../src/content/source-fences.ts');
  const { readPartition } = await import('../../src/partition/partition.ts');
  const row = await reserve(pool, { external_id: 'separate-source' });
  const sourceRoute = tupleRoute(routeKey, row.provenance.source, row.provenance.external_id);
  expect(partitionOf(sourceRoute)).not.toBe(partitionOf(row.route));
  const traced = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const connect = traced.connect.bind(traced);
  const instrumented = new WeakSet<pg.PoolClient>();
  const anchors: number[] = [];
  const releases: number[] = [];
  let active = 0;
  const observe = spyOn(traced, 'connect').mockImplementation((async () => {
    expect(active).toBe(0);
    const client = await connect();
    active++;
    if (!instrumented.has(client)) {
      instrumented.add(client);
      const query = client.query.bind(client);
      spyOn(client, 'query').mockImplementation(((sql: string | pg.QueryConfig, values?: unknown[]) => {
        const text = typeof sql === 'string' ? sql : sql.text;
        const parameters = typeof sql === 'string' ? values : sql.values;
        if (text.includes('FROM core.partition')) anchors.push(Number(parameters![0]));
        return query(sql, values);
      }) as typeof client.query);
    }
    const release = client.release.bind(client);
    client.release = () => {
      releases.push(anchors.length);
      active--;
      release();
    };
    return client;
  }) as typeof traced.connect);
  const bytes = await png();
  const http = await fixture(async () => {
    expect(anchors).toEqual([partitionOf(row.route), partitionOf(sourceRoute), partitionOf(row.route)]);
    expect(releases).toEqual([1, 2]);
    await pool.query(
      `INSERT INTO content.source_fences (route,source,external_id,field_group,taken_down,security_revision)
      VALUES ($1,$2,$3,'cover',true,1)`,
      [sourceRoute, row.provenance.source, row.provenance.external_id],
    );
    return new Response(bytes);
  });
  try {
    expect(await processImportedMedia(deps(http.storage, traced), row.mediaId)).toMatchObject({ state: 'uploaded' });
    expect(active).toBe(0);
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await readPartition(client, partitionOf(sourceRoute));
      expect(
        await readFences(client, [
          {
            route: sourceRoute,
            source: row.provenance.source,
            external_id: row.provenance.external_id,
            field_group: 'cover',
          },
        ]),
      ).toMatchObject([{ takenDown: true, securityRevision: '1' }]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const before = http.requests.length;
    const blocked = await reserve(pool, { external_id: row.provenance.external_id });
    expect(await processImportedMedia(deps(http.storage), blocked.mediaId)).toMatchObject({ state: 'rejected' });
    expect(http.requests.length).toBe(before);
  } finally {
    observe.mockRestore();
    await traced.end();
    await http.close();
  }
});

test('media lock spans network and original write so collection cannot commit ahead of late bytes', async () => {
  const row = await reserve();
  const bytes = await png();
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const http = await fixture(async () => {
    started.resolve();
    await resume.promise;
    return new Response(bytes);
  });
  const collector = await pool.connect();
  try {
    const importing = processImportedMedia(deps(http.storage), row.mediaId);
    await started.promise;
    await collector.query('BEGIN');
    const pid = (await collector.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const collecting = collector.query(
      'UPDATE content.media SET collection_pending=true WHERE route=$1 AND media_id=$2',
      [row.route, row.mediaId],
    );
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked;
      if (blocked) break;
      await Bun.sleep(5);
    }
    expect(blocked).toBe(true);
    resume.resolve();
    await importing;
    await collecting;
    await collector.query('COMMIT');
    await http.storage.deletePrefix(`m/${row.mediaId}/`);
    const requests = http.requests.length;
    await processImportedMedia(deps(http.storage), row.mediaId);
    expect(http.requests.length).toBe(requests);
    expect(http.objects.size).toBe(0);
  } finally {
    resume.resolve();
    await collector.query('ROLLBACK');
    collector.release();
    await http.close();
  }
});

test('actual Sharp pipeline strips metadata after imported original, with measured digest', async () => {
  const { transformImage } = await import('../../src/content/image-transform.ts');
  const bytes = await sharp(await png())
    .withMetadata({ exif: { IFD0: { Artist: 'Private source' } } })
    .jpeg()
    .toBuffer();
  const row = await reserve();
  const http = await fixture(() => new Response(bytes, { headers: { 'content-type': 'image/png' } }));
  try {
    await processImportedMedia(deps(http.storage), row.mediaId);
    const original = http.objects.get(`m/${row.mediaId}/original`)!;
    expect(original).toEqual(new Uint8Array(bytes));
    const transformed = await transformImage(original);
    expect(transformed.variants.map((variant) => variant.format)).toEqual(['avif', 'webp']);
    for (const variant of transformed.variants) {
      const metadata = await sharp(variant.bytes).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
    }
    expect(
      (
        await pool.query('SELECT media_type,sha256 FROM content.media WHERE route=$1 AND media_id=$2', [
          row.route,
          row.mediaId,
        ])
      ).rows,
    ).toEqual([{ media_type: 'image/jpeg', sha256: createHash('sha256').update(bytes).digest('hex') }]);
  } finally {
    await http.close();
  }
});

test('checkGrowth bounds native import rows, statements and buffers independently of catalogue size', async () => {
  const { capture, checkGrowth, openGrowthDatabase, seed } = await import('../support/growth.ts');
  const { tupleRoute } = await import('../../src/content/imported-contract.ts');
  const sourceRoute = tupleRoute(routeKey, 'catalogue', 'growth-source');
  const db = await openGrowthDatabase(process.env.DATABASE_URL!);
  const bytes = await png();
  const http = await fixture(() => new Response(bytes));
  const targets: Awaited<ReturnType<typeof reserve>>[] = [];
  try {
    const operation = async () => {
      const target = targets.shift()!;
      expect(await processImportedMedia(deps(http.storage, db.pool), target.mediaId)).toMatchObject({
        state: 'uploaded',
      });
    };
    const report = await checkGrowth(db, {
      name: 'exact imported media work',
      rule: 'series',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async (_db, scale, previous) => {
        await seed(
          db,
          {
            name: 'unrelated and same partition import media',
            hotPartition: partitionOf(42112),
            rows: ({ route, ordinal }) => {
              const id = newId(route);
              return {
                'content.media': [
                  {
                    route,
                    media_id: id,
                    container_id: newId(route),
                    uploader_id: newId(10),
                    reservation_request_id: id,
                    purpose: 'post-image',
                    state: 'reserved',
                    key: `m/${id}/original`,
                    transaction_id: id,
                    byte_count: 1,
                    media_type: 'image/png',
                  },
                ],
                'content.source_fences': [
                  {
                    route,
                    source: 'catalogue',
                    external_id: `unrelated-${ordinal}`,
                    field_group: 'cover',
                    taken_down: false,
                    security_revision: 1,
                  },
                  {
                    route: sourceRoute,
                    source: 'catalogue',
                    external_id: `neighbour-${ordinal}`,
                    field_group: 'cover',
                    taken_down: false,
                    security_revision: 1,
                  },
                ],
              };
            },
          },
          { from: previous * 32, to: scale * 32 },
        );
        for (let i = 0; i < 6; i++) targets.push(await reserve(db.admin, { external_id: 'growth-source' }));
      },
      operation,
      async warmup() {
        const measured = await capture(db, operation);
        assertGrowthPointPlans(measured.capture, {
          'content.media': ['route', 'media_id'],
          'content.source_fences': ['route', 'source', 'external_id', 'field_group'],
        });
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
    expect(report.samples.every((sample) => sample.cost.rows > 0 && sample.cost.blocks > 0)).toBe(true);
    expect(http.requests).toHaveLength(18);
    expect(http.puts).toBe(18);
    expect([...http.objects.values()].reduce((total, object) => total + object.byteLength, 0)).toBe(
      18 * bytes.byteLength,
    );
  } finally {
    await http.close();
    await db.close();
  }
}, 90_000);

test('real HTTP streams and compressed false length are capped using delivered bytes, with linear successful input', async () => {
  const { gzipSync } = await import('node:zlib');
  const limit = 20 * 1024 * 1024;
  const compressed = gzipSync(new Uint8Array(limit + 1));
  let delivered = 0;
  let requests = 0;
  let signal: AbortSignal | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/compressed')
        return new Response(compressed, {
          headers: {
            'content-encoding': 'gzip',
            'content-length': String(compressed.byteLength),
          },
        });
      if (path.startsWith('/size/')) return new Response(new Uint8Array(Number(path.slice(6))));
      let remaining = limit + 1;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (!remaining) {
              controller.close();
              return;
            }
            const chunk = new Uint8Array(Math.min(64 * 1024, remaining));
            remaining -= chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      );
    },
  });
  const transport = globalThis.fetch;
  const boundary = spyOn(
    globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
    'fetch',
  ).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests++;
    signal = request.signal;
    const response = await transport(new URL(new URL(request.url).pathname, server.url), {
      signal,
      redirect: 'manual',
    });
    return new Response(
      response.body!.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            delivered += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      ),
      { status: response.status, headers: response.headers },
    );
  });
  try {
    for (const path of ['/stream', '/compressed']) {
      delivered = 0;
      await expect(fetched(`https://images.example.test${path}`)).rejects.toMatchObject({ code: 'source-bytes' });
      expect(delivered).toBeGreaterThan(limit);
      expect(signal!.aborted).toBe(true);
    }
    for (const size of [32, 256, 2048]) {
      delivered = 0;
      const result = await fetched(`https://images.example.test/size/${size}`);
      expect(delivered).toBe(size);
      expect(result.bytes.byteLength).toBe(size);
      expect(result.sha256).toBe(createHash('sha256').update(new Uint8Array(size)).digest('hex'));
    }
    expect(requests).toBe(5);
  } finally {
    boundary.mockRestore();
    await server.stop(true);
  }
});

test('HTTP transport rejection commits native rejected state and a single durable governance event', async () => {
  for (const mode of ['redirect', 'bytes', 'network']) {
    const row = await reserve();
    const http = await fixture(() =>
      mode === 'redirect'
        ? new Response(null, { status: 302, headers: { location: 'https://denied.example.test/' } })
        : mode === 'bytes'
          ? new Response('x', { headers: { 'content-length': String(21 * 1024 * 1024) } })
          : new Response(null, { status: 404 }),
    );
    try {
      expect(await processImportedMedia(deps(http.storage), row.mediaId)).toMatchObject({ state: 'rejected' });
      expect(http.puts).toBe(0);
      expect(http.requests).toHaveLength(1);
      expect(
        (
          await pool.query('SELECT state,collection_pending FROM content.media WHERE route=$1 AND media_id=$2', [
            row.route,
            row.mediaId,
          ])
        ).rows,
      ).toEqual([{ state: 'rejected', collection_pending: true }]);
      expect(
        (
          await pool.query('SELECT count(*) FROM core.outbox WHERE partition_no=$1 AND subject=$2', [
            partitionOf(row.route),
            row.mediaId,
          ])
        ).rows,
      ).toEqual([{ count: '1' }]);
    } finally {
      await http.close();
    }
  }
});
