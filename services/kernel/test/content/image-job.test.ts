import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp, { type SharpInput, type SharpOptions } from 'sharp';
import { thumbHashToAverageRGBA } from 'thumbhash';
import { Value } from 'typebox/value';
import { createPool } from '../../src/database/pool.ts';
import { CONTENT_EVENTS } from '../../src/events/contracts/content.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { readBatch } from '../../src/events/log.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const realSharp = sharp;
const calls: (SharpOptions | undefined)[] = [];
mock.module('sharp', () => ({
  default: (input: SharpInput, options?: SharpOptions) => {
    calls.push(options);
    return realSharp(input, options);
  },
}));
const { createImageJob, processImage } = await import('../../src/content/image-job.ts');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 3 });
const route = 0x4810;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let growth: GrowthDatabase | undefined;
afterAll(async () => {
  mock.restore();
  await Promise.all([pool.end(), admin.end(), growth?.close()]);
});

class ByteStore implements MediaStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  readonly writes: string[] = [];
  readonly deletes: string[] = [];
  onGet: (() => Promise<void>) | undefined;
  onPut: ((key: string) => Promise<void>) | undefined;
  onDelete: (() => Promise<void>) | undefined;
  async get(key: string): Promise<Uint8Array | null> {
    await this.onGet?.();
    const object = this.objects.get(key);
    return object ? Uint8Array.from(object.bytes) : null;
  }
  async put(key: string, bytes: Uint8Array, options: { mediaType: string }): Promise<void> {
    await this.onPut?.(key);
    this.objects.set(key, { bytes: Uint8Array.from(bytes), mediaType: options.mediaType });
    this.writes.push(key);
  }
  async deletePrefix(prefix: string): Promise<void> {
    this.deletes.push(prefix);
    await this.onDelete?.();
    for (const key of this.objects.keys()) if (key.startsWith(prefix)) this.objects.delete(key);
  }
}

async function source(width = 127, height = 61, orientation = 1): Promise<Buffer> {
  return realSharp({ create: { width, height, channels: 3, background: '#e02020' } })
    .composite([
      {
        input: await realSharp({
          create: { width: Math.floor(width / 2), height, channels: 3, background: '#2020e0' },
        })
          .png()
          .toBuffer(),
        left: Math.floor(width / 2),
        top: 0,
      },
    ])
    .withMetadata({ orientation })
    .withExifMerge({
      IFD0: { Artist: 'Private photographer' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '25/1 2/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '121/1 3/1 0/1' },
    })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">Private location</x:xmpmeta>')
    .jpeg()
    .toBuffer();
}

async function uploaded(bytes: Uint8Array, store = new ByteStore(), targetRoute = route, db = admin) {
  const id = newId(targetRoute);
  const containerId = newId(targetRoute);
  const key = `m/${id}/original`;
  await db.query(
    `INSERT INTO content.media (
       route, media_id, container_id, uploader_id, reservation_request_id, purpose, media_type,
       byte_count, actual_byte_count, sha256, state, key, transaction_id
     ) VALUES ($1,$2,$3,$4,$5,'post-image','image/jpeg',$6,$6,$7,'uploaded',$8,$9)`,
    [
      targetRoute,
      id,
      containerId,
      newId(targetRoute + 1),
      randomUUID(),
      bytes.byteLength,
      hash(bytes),
      key,
      randomUUID(),
    ],
  );
  store.objects.set(key, { bytes: Uint8Array.from(bytes), mediaType: 'image/jpeg' });
  return { id, containerId, route: targetRoute, key, store, bytes };
}
type Fixture = Awaited<ReturnType<typeof uploaded>>;
async function inspect(fixture: Fixture) {
  const values = [fixture.route, fixture.id];
  const media = await admin.query('SELECT * FROM content.media WHERE route=$1 AND media_id=$2', values);
  const variants = await admin.query(
    'SELECT * FROM content.media_variant WHERE route=$1 AND media_id=$2 ORDER BY format,width',
    values,
  );
  const events = await admin.query(
    'SELECT * FROM core.outbox WHERE partition_no=$1 AND subject=$2 ORDER BY position,event_seq',
    [partitionOf(fixture.route), fixture.id],
  );
  return { media: media.rows[0], variants: variants.rows, events: events.rows };
}

async function assertOutputs(bytes: Uint8Array, width: number, height: number, widths: number[]) {
  const fixture = await uploaded(bytes);
  calls.length = 0;
  const result = await createImageJob(pool, fixture.store).process(fixture.id);
  const boundary = [...calls];
  expect(result.state).toBe('available');
  expect(realSharp.versions.sharp).toMatch(/^0\.35\./);
  expect(boundary.length).toBeGreaterThan(0);
  for (const options of boundary) expect(options).toMatchObject({ limitInputPixels: 40_000_000, failOn: 'warning' });
  expect(boundary.find((options) => !options?.raw)).toMatchObject({ autoOrient: true });
  const snapshot = await inspect(fixture);
  expect(snapshot.media).toMatchObject({
    state: 'available',
    sha256: hash(bytes),
    decision: null,
    collection_pending: false,
    width,
    height,
  });
  expect(snapshot.media.thumbhash).toBeInstanceOf(Buffer);
  expect(snapshot.media.thumbhash.byteLength).toBeLessThanOrEqual(32);
  expect(snapshot.media.average_color).toMatch(/^#[0-9a-f]{6}$/);
  const average = thumbHashToAverageRGBA(snapshot.media.thumbhash);
  const expectedColor = `#${[average.r, average.g, average.b]
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
  expect(snapshot.media.average_color).toBe(expectedColor);
  expect(snapshot.variants).toHaveLength(widths.length * 2);
  expect(result.variants.map((variant) => `${variant.format}:${variant.width}`).sort()).toEqual(
    widths.flatMap((size) => [`avif:${size}`, `webp:${size}`]).sort(),
  );
  expect(fixture.store.objects.get(fixture.key)?.bytes).toEqual(bytes);
  expect(fixture.store.writes).not.toContain(fixture.key);
  for (const variant of result.variants) {
    const object = fixture.store.objects.get(variant.key)!;
    expect(variant.key).toBe(`m/${fixture.id}/${variant.format}-${variant.width}`);
    expect(variant.key).not.toBe(fixture.key);
    expect(variant.sha256).toBe(hash(object.bytes));
    expect(variant.sha256).not.toBe(hash(bytes));
    expect(variant.byteCount).toBe(object.bytes.byteLength);
    expect(variant.mediaType).toBe(`image/${variant.format}`);
    expect(object.mediaType).toBe(variant.mediaType);
    expect(snapshot.variants).toContainEqual(
      expect.objectContaining({
        format: variant.format,
        width: variant.width,
        height: variant.height,
        media_type: variant.mediaType,
        byte_count: String(variant.byteCount),
        sha256: variant.sha256,
        key: variant.key,
        transaction_id: snapshot.media.transaction_id,
      }),
    );
    const metadata = await realSharp(object.bytes).metadata();
    expect(metadata.format).toBe(variant.format === 'avif' ? 'heif' : 'webp');
    if (variant.format === 'avif') expect(metadata.compression).toBe('av1');
    expect([metadata.width, metadata.height]).toEqual([variant.width, variant.height]);
    expect(variant.width).toBeLessThanOrEqual(width);
    expect(variant.height).toBe(Math.round((height * variant.width) / width));
    for (const field of ['exif', 'xmp', 'icc', 'iptc', 'orientation', 'comments'] as const)
      expect(metadata[field]).toBeUndefined();
    const decoded = await realSharp(object.bytes, { failOn: 'warning' }).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.data.length).toBe(variant.width * variant.height * decoded.info.channels);
    if (height > width) {
      const top =
        (Math.floor(variant.width / 2) + variant.width * Math.floor(variant.height / 4)) * decoded.info.channels;
      const bottom =
        (Math.floor(variant.width / 2) + variant.width * Math.floor((variant.height * 3) / 4)) * decoded.info.channels;
      expect(decoded.data[top]!).toBeGreaterThan(decoded.data[top + 2]! + 100);
      expect(decoded.data[bottom + 2]!).toBeGreaterThan(decoded.data[bottom]! + 100);
    }
  }
  expect(snapshot.events).toHaveLength(1);
  expect(snapshot.events[0]).toMatchObject({
    type: 'com.rezics.content.media.available.v1',
    subject: fixture.id,
    partition_no: partitionOf(fixture.route),
    event_seq: 0,
    event_count: 1,
    data: { mediaId: fixture.id, containerId: fixture.containerId },
  });
  expect(Value.Check(CONTENT_EVENTS['com.rezics.content.media.available.v1'], snapshot.events[0].data)).toBe(true);
  expect(snapshot.events[0].id).toMatch(/^[0-9a-f-]{36}$/);
  const position = await admin.query('SELECT epoch,position FROM core.partition WHERE partition_no=$1', [
    partitionOf(fixture.route),
  ]);
  expect(snapshot.events[0].epoch).toBe(position.rows[0].epoch);
  expect(snapshot.events[0].position).toBe(position.rows[0].position);
  const publishedMetadata = {
    width: snapshot.media.width,
    height: snapshot.media.height,
    thumbhash: snapshot.media.thumbhash,
    average_color: snapshot.media.average_color,
    keys: result.variants.map(({ key }) => key),
  };
  await admin.query(
    `UPDATE content.media SET purpose='cover', source_url='https://source.example.test/cover',
       credit='{"rightsHolder":"Test artist","via":{"name":"Source","url":"https://source.example.test"},"license":"CC0-1.0","obligations":[]}'::jsonb,
       provenance='{"source":"test","external_id":"cover-1","record_revision":"1","digest":"0000000000000000000000000000000000000000000000000000000000000000","converter_revision":"1","field_group":"cover","references":[{"url":"https://source.example.test/cover"}]}'::jsonb
     WHERE route=$1 AND media_id=$2`,
    [fixture.route, fixture.id],
  );
  await expect(
    admin.query('UPDATE content.media SET average_color=NULL WHERE route=$1 AND media_id=$2', [
      fixture.route,
      fixture.id,
    ]),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'media_image_display_metadata_check',
  });
  await admin.query('DELETE FROM content.media_variant WHERE route=$1 AND media_id=$2', [fixture.route, fixture.id]);
  await admin.query(
    `UPDATE content.media SET state='uploaded', width=NULL, height=NULL, thumbhash=NULL, average_color=NULL
     WHERE route=$1 AND media_id=$2`,
    [fixture.route, fixture.id],
  );
  const reprocessed = await processImage(pool, fixture.store, fixture.id);
  expect(reprocessed.state).toBe('available');
  const repeated = await inspect(fixture);
  expect({
    width: repeated.media.width,
    height: repeated.media.height,
    thumbhash: repeated.media.thumbhash,
    average_color: repeated.media.average_color,
    keys: reprocessed.variants.map(({ key }) => key),
  }).toEqual(publishedMetadata);
  expect(
    repeated.variants.map(({ format, width: variantWidth, sha256: variantHash, key }) => [
      format,
      variantWidth,
      variantHash,
      key,
    ]),
  ).toEqual(
    snapshot.variants.map(({ format, width: variantWidth, sha256: variantHash, key }) => [
      format,
      variantWidth,
      variantHash,
      key,
    ]),
  );
  const writesAfterReprocessing = [...fixture.store.writes];
  expect((await processImage(pool, fixture.store, fixture.id)).state).toBe('already_terminal');
  expect(await inspect(fixture)).toEqual(repeated);
  expect(fixture.store.writes).toEqual(writesAfterReprocessing);
}

test('real Sharp emits exact AVIF WebP width ladder with orientation and metadata removal', async () => {
  await assertOutputs(await source(3000, 1500), 3000, 1500, [320, 640, 960, 1280, 1920, 2560]);
  const oriented = await source(1200, 800, 6);
  const metadata = await realSharp(oriented).metadata();
  expect([metadata.width, metadata.height, metadata.orientation]).toEqual([1200, 800, 6]);
  for (const tag of [0x8825, 1, 2, 3, 4])
    expect(metadata.exif?.includes(Buffer.from([tag & 255, tag >> 8]))).toBe(true);
  expect(metadata.xmp).toBeDefined();
  await assertOutputs(oriented, 800, 1200, [320, 640]);
  await assertOutputs(await source(), 127, 61, [127]);
}, 60_000);

test('malformed over-pixel and truncated images reject without retaining samples', async () => {
  const full = await source(1200, 800);
  const truncated = full.subarray(0, full.length - 100);
  expect((await realSharp(truncated).metadata()).width).toBe(1200);
  const oversized = await realSharp({ create: { width: 8000, height: 5001, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  for (const bytes of [Buffer.from([1, 2, 3]), oversized, truncated]) {
    const fixture = await uploaded(bytes);
    fixture.store.objects.set(`m/${fixture.id}/webp-320`, { bytes: Buffer.from('partial'), mediaType: 'image/webp' });
    expect((await processImage(pool, fixture.store, fixture.id)).state).toBe('rejected');
    const snapshot = await inspect(fixture);
    expect(snapshot.media).toMatchObject({ state: 'rejected', sha256: hash(bytes), claimed_at: null });
    expect(snapshot.media.decision).toBeTruthy();
    expect(snapshot.variants).toEqual([]);
    expect([...fixture.store.objects.keys()]).toEqual([]);
    expect(fixture.store.deletes).toEqual([`m/${fixture.id}/`]);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({ type: 'com.rezics.content.media.rejected.v1', subject: fixture.id });
    expect(Value.Check(CONTENT_EVENTS['com.rezics.content.media.rejected.v1'], snapshot.events[0].data)).toBe(true);
    expect((await processImage(pool, fixture.store, fixture.id)).state).toBe('already_terminal');
    expect(await inspect(fixture)).toEqual(snapshot);
    expect([...fixture.store.objects.keys()]).toEqual([]);
  }
}, 30_000);

test('actual byte count and digest are checked before transformation or publication', async () => {
  const bytes = await source();
  for (const corrupt of [
    bytes.subarray(0, bytes.length - 1),
    Uint8Array.from(bytes, (byte, i) => (i === bytes.length - 1 ? byte ^ 1 : byte)),
  ]) {
    const fixture = await uploaded(bytes);
    fixture.store.objects.set(fixture.key, { bytes: corrupt, mediaType: 'image/jpeg' });
    calls.length = 0;
    expect((await processImage(pool, fixture.store, fixture.id)).state).toBe('rejected');
    expect(calls).toEqual([]);
    expect((await inspect(fixture)).media).toMatchObject({ state: 'rejected', sha256: hash(bytes) });
    expect(fixture.store.objects.size).toBe(0);
  }
});

test('storage and encoder failures retry without rejection or duplicate effects', async () => {
  const failure = new Error('Transient provider failure');
  const fixture = await uploaded(await source());
  fixture.store.onGet = async () => {
    throw failure;
  };
  await expect(processImage(pool, fixture.store, fixture.id)).rejects.toBe(failure);
  fixture.store.onGet = undefined;
  const before = await inspect(fixture);
  expect(before.media.state).toBe('uploaded');
  expect(before.events).toEqual([]);
  const toBuffer = spyOn(realSharp.prototype, 'toBuffer').mockImplementation(() => {
    throw failure;
  });
  try {
    await expect(processImage(pool, fixture.store, fixture.id)).rejects.toBe(failure);
  } finally {
    toBuffer.mockRestore();
  }
  expect(await inspect(fixture)).toEqual(before);
  fixture.store.onPut = async () => {
    if (fixture.store.writes.length === 1) throw failure;
  };
  await expect(processImage(pool, fixture.store, fixture.id)).rejects.toBe(failure);
  expect(await inspect(fixture)).toEqual(before);
  expect(fixture.store.writes).toHaveLength(1);
  expect(fixture.store.objects.has(fixture.key)).toBe(true);
  fixture.store.onPut = undefined;
  expect((await processImage(pool, fixture.store, fixture.id)).state).toBe('available');
  const after = await inspect(fixture);
  expect(after.variants).toHaveLength(2);
  expect(after.events).toHaveLength(1);
  expect(fixture.store.objects.size).toBe(3);
  fixture.store.onGet = async () => {
    throw failure;
  };
  expect((await processImage(pool, fixture.store, fixture.id)).state).toBe('already_terminal');
  expect(await inspect(fixture)).toEqual(after);
  const absent = await uploaded(await source());
  absent.store.objects.clear();
  await expect(processImage(pool, absent.store, absent.id)).rejects.toBeInstanceOf(Error);
  expect((await inspect(absent)).media.state).toBe('uploaded');
  expect((await inspect(absent)).events).toEqual([]);
});

test('failed deletion leaves durable rejection and pending purge for retry', async () => {
  const fixture = await uploaded(Buffer.from('malformed image'));
  const failure = new Error('Delete failed after a partial purge');
  fixture.store.objects.set(`m/${fixture.id}/webp-320`, { bytes: Buffer.from('partial'), mediaType: 'image/webp' });
  fixture.store.onDelete = async () => {
    fixture.store.objects.delete(fixture.key);
    throw failure;
  };
  await expect(processImage(pool, fixture.store, fixture.id)).rejects.toBe(failure);
  const rejected = await inspect(fixture);
  expect(rejected.media).toMatchObject({ state: 'rejected', collection_pending: true, sha256: hash(fixture.bytes) });
  expect(rejected.events).toHaveLength(1);
  expect(rejected.media.decision).toBeTruthy();
  fixture.store.onDelete = undefined;
  expect((await processImage(pool, fixture.store, fixture.id)).state).toBe('already_terminal');
  expect(fixture.store.objects.size).toBe(0);
  expect(await inspect(fixture)).toEqual(rejected);
});

function barrier() {
  let signal!: () => void;
  const promise = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { promise, signal };
}

test('processing holds the real row lock until every put has settled; following collection removes all outputs', async () => {
  const fixture = await uploaded(await source());
  const entered = barrier();
  const release = barrier();
  let active = 0;
  fixture.store.onPut = async () => {
    active++;
    entered.signal();
    await release.promise;
    active--;
  };
  const processing = processImage(pool, fixture.store, fixture.id);
  await entered.promise;
  const collector = await admin.connect();
  try {
    await collector.query('BEGIN');
    const conflict = await collector
      .query('SELECT media_id FROM content.media WHERE route=$1 AND media_id=$2 FOR UPDATE NOWAIT', [
        fixture.route,
        fixture.id,
      ])
      .catch((error: unknown) => error);
    expect(conflict).toMatchObject({ code: '55P03' });
    await collector.query('ROLLBACK');
    await collector.query('BEGIN');
    const fenced = collector.query(
      'UPDATE content.media SET collection_pending=true WHERE route=$1 AND media_id=$2 RETURNING state',
      [fixture.route, fixture.id],
    );
    release.signal();
    expect((await processing).state).toBe('available');
    expect((await fenced).rows[0].state).toBe('available');
    await collector.query('COMMIT');
    expect(active).toBe(0);
    await fixture.store.deletePrefix(`m/${fixture.id}/`);
    expect((await processImage(pool, fixture.store, fixture.id)).state).toBe('already_terminal');
    expect(fixture.store.objects.size).toBe(0);
    expect(active).toBe(0);
  } finally {
    release.signal();
    await collector.query('ROLLBACK');
    collector.release();
    await processing;
  }
});

test('processing cannot publish after a collection fence or process reserved, erased or absent media', async () => {
  for (const kind of ['pending', 'erased', 'reserved', 'absent'] as const) {
    const fixture = await uploaded(await source());
    if (kind === 'absent')
      await admin.query('DELETE FROM content.media WHERE route=$1 AND media_id=$2', [fixture.route, fixture.id]);
    else
      await admin.query(
        `UPDATE content.media SET collection_pending=$3, erased=$4,
         state=CASE WHEN $5 THEN 'reserved' ELSE state END,
         actual_byte_count=CASE WHEN $5 THEN NULL ELSE actual_byte_count END,
         sha256=CASE WHEN $5 THEN NULL ELSE sha256 END,
         security_revision=CASE WHEN $4 THEN security_revision+1 ELSE security_revision END
         WHERE route=$1 AND media_id=$2`,
        [fixture.route, fixture.id, kind === 'pending', kind === 'erased', kind === 'reserved'],
      );
    const before = await inspect(fixture);
    fixture.store.onGet = async () => {
      throw new Error('Ineligible object was fetched');
    };
    if (kind === 'reserved') await expect(processImage(pool, fixture.store, fixture.id)).rejects.toBeInstanceOf(Error);
    else expect((await processImage(pool, fixture.store, fixture.id)).state).toBe('already_terminal');
    expect(await inspect(fixture)).toEqual(before);
    expect(fixture.store.writes).toEqual([]);
  }
});

test('partition fence rolls back publication and retries safely without late output writes', async () => {
  const fixture = await uploaded(await source(), new ByteStore(), route + 16);
  let writes = 0;
  fixture.store.onPut = async () => {
    if (++writes === 1)
      await admin.query("UPDATE core.partition SET write_state='moved', moved_to='elsewhere' WHERE partition_no=$1", [
        partitionOf(fixture.route),
      ]);
  };
  try {
    await expect(processImage(pool, fixture.store, fixture.id)).rejects.toMatchObject({ reason: 'moved' });
    const snapshot = await inspect(fixture);
    expect(snapshot.media.state).toBe('uploaded');
    expect(snapshot.events).toEqual([]);
    expect(snapshot.variants).toEqual([]);
    expect(writes).toBe(2);
    await admin.query('UPDATE content.media SET collection_pending=true WHERE route=$1 AND media_id=$2', [
      fixture.route,
      fixture.id,
    ]);
    await fixture.store.deletePrefix(`m/${fixture.id}/`);
    expect(fixture.store.objects.size).toBe(0);
    expect(writes).toBe(2);
  } finally {
    await admin.query("UPDATE core.partition SET write_state='active', moved_to=NULL WHERE partition_no=$1", [
      partitionOf(fixture.route),
    ]);
  }
});

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  growth = await openGrowthDatabase(url);
  const bytes = await source();
  const store = new ByteStore();
  const targets = new Map<number, Fixture[]>();
  async function grow(db: GrowthDatabase, scale: number, previous: number) {
    // Setup is outside capture. Both the target route and another partition grow;
    // unrelated variants grow too, so a media-only anchor cannot hide their scan.
    const ids = Array.from({ length: (previous === 0 ? 512 : 0) + scale - previous }, (_, index) =>
      newId(index % 2 ? route : route + 32),
    );
    await db.admin.query(
      `INSERT INTO content.media (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,
         byte_count,actual_byte_count,sha256,state,key,transaction_id)
       SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,id,id,id::text,'post-image','image/jpeg',
         1,1,$2,'available','m/'||id::text||'/original',$3 FROM unnest($1::uuid[]) AS id`,
      [ids, hash(bytes), randomUUID()],
    );
    await db.admin.query(
      `INSERT INTO content.media_variant (route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
       SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,'webp',127,61,'image/webp',1,$2,
         'm/'||id::text||'/webp-127',$3 FROM unnest($1::uuid[]) AS id`,
      [ids, hash(bytes), randomUUID()],
    );
    const fresh: Fixture[] = [];
    for (let index = 0; index < 4; index++) fresh.push(await uploaded(bytes, store, route, db.admin));
    targets.set(scale, fresh);
    await db.admin.query('ANALYZE content.media');
    await db.admin.query('ANALYZE content.media_variant');
  }
  const report = await checkGrowth(growth, {
    name: 'image job fixed input and two outputs',
    scales: [32, 256, 2048],
    repetitions: 3,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow,
    operation: async (db, scale, repetition) => {
      const fixture = targets.get(scale)![repetition % 4]!;
      const result = await processImage(db.pool, store, fixture.id);
      expect(result.state).toBe('available');
      expect(result.variants).toHaveLength(2);
      return result;
    },
  });
  console.info('image job GrowthReport', JSON.stringify(report));
  expect(report.samples.map(({ scale }) => scale)).toEqual([32, 256, 2048]);
  expect(report.samples.every(({ cost }) => cost.statements > 0 && cost.rows > 0)).toBe(true);
  expect(report.samples.every(({ cost }) => cost.relations?.['content.media']?.rows !== undefined)).toBe(true);
}, 60_000);

test('closed media schemas preserve command payloads and the actual consumer accepts registered media events', async () => {
  const fixture = await uploaded(await source(), new ByteStore(), route + 48);
  await processImage(pool, fixture.store, fixture.id);
  for (const name of ['reserved', 'uploaded'] as const) {
    const schema = CONTENT_EVENTS[`com.rezics.content.media.${name}.v1`];
    const data = { mediaId: fixture.id, containerId: fixture.containerId, actorId: newId(route) };
    expect(Value.Check(schema, data)).toBe(true);
    expect(Value.Check(schema, { ...data, body: 'private' })).toBe(false);
    expect(Value.Check(schema, { mediaId: fixture.id })).toBe(false);
  }
  const applied: string[] = [];
  const result = await readBatch(pool, {
    consumer: 'image_job_media',
    partition: partitionOf(fixture.route),
    apply: async (envelopes) => {
      for (const envelope of envelopes) for (const event of envelope.events) applied.push(event.type);
    },
  });
  expect(result.status).toBe('read');
  expect(applied).toEqual(['com.rezics.content.media.available.v1']);
  const schema = CONTENT_EVENTS['com.rezics.content.media.available.v1'];
  expect(Value.Check(schema, { mediaId: fixture.id, containerId: fixture.containerId, unexpected: true })).toBe(false);
  expect(Value.Check(schema, { mediaId: 3, containerId: fixture.containerId })).toBe(false);
});
