import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { createErasureJob, purgeObject } from '../../src/content/erasure-job.ts';
import { processImage } from '../../src/content/image-job.ts';
import { processImportedMedia } from '../../src/content/media-import-job.ts';
import { R2Storage, MediaStorageError } from '../../src/content/r2-storage.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const route = 0x6810;
const bytes = new Uint8Array([1, 2, 3]);
const hash = createHash('sha256').update(bytes).digest('hex');
afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

function mediaRow(state = 'reserved', erased = false, pending = false, takenDown = false, atRoute = route) {
  const id = newId(atRoute);
  return {
    route: atRoute,
    media_id: id,
    container_id: newId(atRoute),
    uploader_id: newId(12),
    reservation_request_id: id,
    purpose: 'post-image',
    media_type: 'image/png',
    byte_count: bytes.length,
    actual_byte_count: state === 'reserved' ? null : bytes.length,
    sha256: state === 'reserved' ? null : hash,
    state,
    decision: state === 'rejected' ? 'unsafe-image' : null,
    key: `m/${id}/original`,
    transaction_id: id,
    erased,
    collection_pending: pending,
    taken_down: takenDown,
  };
}
async function insert<T extends Record<string, unknown>>(row: T, db = admin) {
  await db.query(
    `INSERT INTO content.media SELECT * FROM jsonb_populate_record(NULL::content.media,
    $1::jsonb || jsonb_build_object('created_at',statement_timestamp(),'security_revision',0))`,
    [JSON.stringify(row)],
  );
  return row;
}

// Only the external HTTP boundary is substituted: real signed storage owns listing,
// key validation, deletes and failure propagation, with actual bytes behind it.
function storageFixture() {
  const objects = new Map<string, Uint8Array>();
  const requests: { method: string; key: string; prefix: string | null }[] = [];
  let failAt = -1;
  let deletes = 0;
  let beforeGet: (() => Promise<void>) | undefined;
  const storage = new R2Storage({
    endpoint: 'https://fixture.r2.cloudflarestorage.com',
    bucket: 'bucket',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    maxObjectBytes: 20 * 1024 * 1024,
    fetch: async (request) => {
      const url = new URL(request.url);
      const key = decodeURIComponent(url.pathname.slice('/bucket/'.length));
      const prefix = url.searchParams.get('prefix');
      requests.push({ method: request.method, key, prefix });
      expect(request.headers.get('authorization')).toStartWith('AWS4-HMAC-SHA256');
      if (request.method === 'DELETE') {
        if (deletes++ === failAt) return new Response(null, { status: 503 });
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (prefix !== null) {
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
        return new Response(
          `<ListBucketResult><EncodingType>url</EncodingType><Prefix>${encodeURIComponent(prefix)}</Prefix><IsTruncated>false</IsTruncated><KeyCount>${keys.length}</KeyCount>${keys.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join('')}</ListBucketResult>`,
        );
      }
      await beforeGet?.();
      return objects.has(key) ? new Response(Uint8Array.from(objects.get(key)!)) : new Response(null, { status: 404 });
    },
  });
  return {
    storage,
    objects,
    requests,
    failAfter(count: number) {
      failAt = deletes + count;
    },
    onGet(callback: () => Promise<void>) {
      beforeGet = callback;
    },
    populate(id: string) {
      const keys = [
        `m/${id}/original`,
        ...['avif', 'webp'].flatMap((format) =>
          [320, 640, 960, 1280, 1920, 2560].map((width) => `m/${id}/${format}-${width}`),
        ),
      ];
      for (const key of keys) objects.set(key, bytes.slice());
      return keys;
    },
  };
}

test('factory is inert and invalid IDs fail closed before native checkout or storage', async () => {
  const http = storageFixture();
  const connect = spyOn(pool, 'connect');
  try {
    const job = createErasureJob(pool, http.storage);
    expect(connect).not.toHaveBeenCalled();
    for (const id of [
      '',
      '../',
      newId(route).toUpperCase(),
      '00000000-0000-4000-8000-681000000000',
      `m/${newId(route)}/`,
    ]) {
      await expect(job.purgeObject(id)).rejects.toBeInstanceOf(RangeError);
    }
    expect(connect).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(0);
  } finally {
    connect.mockRestore();
  }
});

test('every persisted lifecycle and flag combination trusts only erased or terminal rejected media', async () => {
  const http = storageFixture();
  const job = createErasureJob(pool, http.storage);
  for (const state of ['reserved', 'uploaded', 'available', 'rejected']) {
    for (const [erased, pending] of [
      [false, false],
      [false, true],
      [true, false],
    ] as const) {
      for (const takenDown of [false, true]) {
        const row = await insert(mediaRow(state, erased, pending, takenDown));
        const keys = http.populate(row.media_id);
        const before = http.requests.length;
        const outcome = erased || state === 'rejected' ? 'purged' : 'fenced';
        expect(await job.purgeObject(row.media_id)).toEqual({ mediaId: row.media_id, outcome });
        expect(http.requests.length - before).toBe(outcome === 'purged' ? 14 : 0);
        for (const key of keys) expect(http.objects.has(key)).toBe(outcome === 'fenced');
        expect(
          (await admin.query('SELECT * FROM content.media WHERE route=$1 AND media_id=$2', [route, row.media_id]))
            .rowCount,
        ).toBe(1);
      }
    }
  }
});

test('repeat and missing work are idempotent; stale work leaves an active replacement and its bytes intact', async () => {
  const http = storageFixture();
  const erased = await insert(mediaRow('available', true));
  const replacement = await insert({ ...mediaRow('available'), container_id: erased.container_id });
  http.populate(erased.media_id);
  const replacementKeys = http.populate(replacement.media_id);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await purgeObject(pool, http.storage, erased.media_id)).toEqual({
      mediaId: erased.media_id,
      outcome: 'purged',
    });
    expect(await purgeObject(pool, http.storage, replacement.media_id)).toEqual({
      mediaId: replacement.media_id,
      outcome: 'fenced',
    });
  }
  const missing = newId(route);
  const before = http.requests.length;
  expect(await purgeObject(pool, http.storage, missing)).toEqual({ mediaId: missing, outcome: 'already_absent' });
  expect(http.requests).toHaveLength(before);
  expect([...http.objects.keys()]).toEqual(replacementKeys);
});

test('first and partial storage failures throw, retain durable authority and retry without another pending store', async () => {
  for (const erased of [false, true]) {
    for (const deleted of [0, 5]) {
      const http = storageFixture();
      const row = await insert(mediaRow(erased ? 'available' : 'rejected', erased, !erased));
      http.populate(row.media_id);
      http.failAfter(deleted);
      await expect(purgeObject(pool, http.storage, row.media_id)).rejects.toBeInstanceOf(MediaStorageError);
      expect(http.objects.size).toBe(13 - deleted);
      expect(
        (
          await admin.query(
            'SELECT erased,state,collection_pending FROM content.media WHERE route=$1 AND media_id=$2',
            [route, row.media_id],
          )
        ).rows,
      ).toEqual([{ erased, state: row.state, collection_pending: !erased }]);
      // A new job instance has no process-local receipt or actor dependency.
      expect(await createErasureJob(pool, http.storage).purgeObject(row.media_id)).toMatchObject({ outcome: 'purged' });
      expect(http.objects.size).toBe(0);
    }
  }
});

test('native import rejection without measurements retains no original or sample after cleanup retry', async () => {
  const http = storageFixture();
  const row = await insert({
    ...mediaRow(),
    purpose: 'cover',
    byte_count: null,
    media_type: null,
    source_url: 'https://images.example.test/image',
    credit: {
      rightsHolder: 'Artist',
      via: { name: 'Catalogue', url: 'https://catalogue.example.test/' },
      license: 'LicenseRef-unknown',
      obligations: [],
      extra: true,
    },
    provenance: {
      source: 'catalogue',
      external_id: 'cover',
      record_revision: '1',
      digest: hash,
      converter_revision: '1',
      field_group: 'cover',
      references: [{}],
    },
  });
  http.populate(row.media_id);
  http.failAfter(5);
  await expect(
    processImportedMedia(
      {
        pool,
        storage: http.storage,
        access: createAccess({ actions: new Map() }),
        routeKey: new Uint8Array(32).fill(7),
        clock: () => new Date(),
        fetchConfig: { allowedHosts: [] },
      },
      row.media_id,
    ),
  ).rejects.toBeInstanceOf(MediaStorageError);
  expect(
    (
      await admin.query('SELECT state,actual_byte_count,sha256 FROM content.media WHERE route=$1 AND media_id=$2', [
        route,
        row.media_id,
      ])
    ).rows,
  ).toEqual([{ state: 'rejected', actual_byte_count: null, sha256: null }]);
  expect(http.objects.size).toBe(8);
  expect(await purgeObject(pool, http.storage, row.media_id)).toMatchObject({ outcome: 'purged' });
  expect(http.objects.size).toBe(0);
});

test('native image publication lock precedes irreversible rejection; committed cleanup survives uploader revocation', async () => {
  const http = storageFixture();
  const row = await insert(mediaRow('uploaded'));
  await admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES (12,$1,'actor','active',$1)`,
    [row.uploader_id],
  );
  http.populate(row.media_id);
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  http.onGet(async () => {
    started.resolve();
    await resume.promise;
  });
  http.failAfter(0);
  const processing = processImage(pool, http.storage, row.media_id);
  const failure = processing.catch((error: unknown) => error);
  try {
    await started.promise;
    const lock = await admin.connect();
    try {
      await lock.query('BEGIN');
      await expect(
        lock.query('SELECT 1 FROM content.media WHERE route=$1 AND media_id=$2 FOR UPDATE NOWAIT', [
          route,
          row.media_id,
        ]),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    const before = http.requests.length;
    expect(await purgeObject(pool, http.storage, row.media_id)).toMatchObject({ outcome: 'fenced' });
    expect(http.requests).toHaveLength(before);
    resume.resolve();
    expect(await failure).toBeInstanceOf(MediaStorageError);
    expect(
      (
        await admin.query('SELECT state,collection_pending FROM content.media WHERE route=$1 AND media_id=$2', [
          route,
          row.media_id,
        ])
      ).rows,
    ).toEqual([{ state: 'rejected', collection_pending: true }]);
    // Revoke the uploader after the native logical commit, before retrying bytes.
    await suspendAccount(admin, row.uploader_id);
    expect(await purgeObject(pool, http.storage, row.media_id)).toMatchObject({ outcome: 'purged' });
    expect(http.objects.size).toBe(0);
    expect(await processImage(pool, http.storage, row.media_id)).toMatchObject({ state: 'already_terminal' });
    expect(http.objects.size).toBe(0);
    expect(http.requests.some((request) => request.method === 'PUT')).toBe(false);
    expect(
      (
        await admin.query('SELECT count(*) FROM core.outbox WHERE partition_no=$1 AND subject=$2', [
          partitionOf(route),
          row.media_id,
        ])
      ).rows,
    ).toEqual([{ count: '1' }]);
  } finally {
    resume.resolve();
    await processing.catch(() => {});
  }
});

test('native point reads and growth stay bounded with no content sequential scans', async () => {
  const db = await openGrowthDatabase(url);
  const http = storageFixture();
  const row = await insert(mediaRow('available', true), db.admin);
  const keys = http.populate(row.media_id);
  try {
    const report = await checkGrowth(db, {
      name: 'exact erased media prefix',
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async (_db, scale, previous) => {
        await seed(
          db,
          {
            name: 'media neighbours',
            hotPartition: partitionOf(route),
            rows: ({ route }) => ({
              'content.media': [
                mediaRow('available', false, false, false, route),
                mediaRow('reserved', false, false, false, route),
              ],
            }),
          },
          { from: previous, to: scale },
        );
        expect(
          Number((await db.admin.query('SELECT count(*) FROM content.media')).rows[0].count),
        ).toBeGreaterThanOrEqual(500);
        expect(
          Number((await db.admin.query('SELECT count(*) FROM core.partition')).rows[0].count),
        ).toBeGreaterThanOrEqual(500);
      },
      operation: async () => {
        expect(await purgeObject(db.pool, http.storage, row.media_id)).toMatchObject({ outcome: 'purged' });
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    for (const sample of report.samples) {
      expect(sample.cost.rows).toBe(2);
      expect(sample.cost.statements).toBe(2);
      expect(Object.keys(sample.cost.relations!)).toEqual(['core.partition', 'content.media']);
      expect(sample.cost.relations!['content.media']!.sequentialScans).toBe(0);
      expect(sample.cost.relations!['content.media']!.rows).toBe(1);
    }
    expect(http.requests.filter((request) => request.method === 'DELETE').map((request) => request.key)).toEqual(keys);
    expect(http.requests.filter((request) => request.prefix !== null)).toHaveLength(18);
    expect(http.objects.size).toBe(0);
  } finally {
    await db.close();
  }
}, 90_000);
