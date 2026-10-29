import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { checkMediaObject, checkMediaObjects } from '../../src/content/cover-reference.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase;
const sourceUrl = 'https://images.example.test/cover.jpg';
const credit = {
  rightsHolder: 'Image Artist',
  via: { name: 'Example Catalogue', url: 'https://catalogue.example.test/record/42' },
  license: 'LicenseRef-unknown',
  obligations: [],
};
const provenance: MediaImportRequest['provenance'] = {
  source: 'example-catalogue',
  external_id: 'record-42',
  record_revision: 'edition-3',
  digest: 'b'.repeat(64),
  converter_revision: 'converter-2',
  field_group: 'cover',
  references: [
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/42' } },
        { property: { id: 'schema:author' }, value: { type: 'somevalue' } },
        { property: { id: 'schema:datePublished' }, value: { type: 'novalue' } },
      ],
    },
  ],
};

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
});
afterAll(async () => {
  await db?.close();
});

type CoverOptions = {
  readonly crop?: readonly [number, number, number, number] | null;
  readonly focalPoint?: Readonly<{ x: number; y: number }> | null;
  readonly width?: number;
  readonly height?: number;
  readonly variants?: readonly number[];
};

async function insertCover(id: string, options: CoverOptions = {}): Promise<void> {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Test cover id must have a route');
  const containerId = newId(route);
  const uploaderId = newId(route);
  const transactionId = newId(route);
  const crop = options.crop ?? null;
  const focalPoint = options.focalPoint ?? null;
  const width = options.width ?? 1200;
  const height = options.height ?? 1800;
  const variants = options.variants ?? [320, 640];
  await db.admin.query(
    `INSERT INTO content.media
       (route, media_id, container_id, uploader_id, reservation_request_id, purpose,
        media_type, byte_count, actual_byte_count, sha256, state, key, transaction_id,
        source_url, credit, provenance, width, height, thumbhash, average_color,
        crop, focal_x, focal_y)
     VALUES ($1,$2::uuid,$3,$4,$2::uuid::text,'cover','image/jpeg',256,256,$5,'available',$6,$7,
       $8,$9,$10,$11,$12,decode('AQID','base64'),'#5a4632',$13,$14,$15)`,
    [
      route,
      id,
      containerId,
      uploaderId,
      'a'.repeat(64),
      `m/${id}/original`,
      transactionId,
      sourceUrl,
      credit,
      provenance,
      width,
      height,
      crop,
      focalPoint?.x ?? null,
      focalPoint?.y ?? null,
    ],
  );
  for (const variantWidth of variants) {
    for (const format of ['avif', 'webp'] as const) {
      await db.admin.query(
        `INSERT INTO content.media_variant
           (route, media_id, format, width, height, media_type, byte_count, sha256, key, transaction_id)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9)`,
        [
          route,
          id,
          format,
          variantWidth,
          Math.max(1, Math.round((height * variantWidth) / width)),
          `image/${format}`,
          'c'.repeat(64),
          `m/${id}/${format}-${variantWidth}`,
          transactionId,
        ],
      );
    }
  }
}

async function insertGrowthCovers(ids: readonly string[]): Promise<void> {
  const records = ids.map((mediaId) => {
    const route = routeOf(mediaId)!;
    return {
      route,
      media_id: mediaId,
      container_id: newId(route),
      uploader_id: newId(route),
      transaction_id: newId(route),
    };
  });
  await db.admin.query(
    `INSERT INTO content.media
       (route, media_id, container_id, uploader_id, reservation_request_id, purpose,
        media_type, byte_count, actual_byte_count, sha256, state, key, transaction_id,
        source_url, credit, provenance, width, height, thumbhash, average_color)
     SELECT requested.route, requested.media_id, requested.container_id, requested.uploader_id,
            requested.media_id::text, 'cover', 'image/jpeg', 256, 256, $2, 'available',
            'm/' || requested.media_id::text || '/original', requested.transaction_id,
            $3, $4::jsonb, $5::jsonb, 1200, 1800, decode('AQID','base64'), '#5a4632'
     FROM jsonb_to_recordset($1::jsonb) AS requested(
       route integer, media_id uuid, container_id uuid, uploader_id uuid, transaction_id uuid
     )`,
    [JSON.stringify(records), 'a'.repeat(64), sourceUrl, JSON.stringify(credit), JSON.stringify(provenance)],
  );
  await db.admin.query(
    `INSERT INTO content.media_variant
       (route, media_id, format, width, height, media_type, byte_count, sha256, key, transaction_id)
     SELECT requested.route, requested.media_id, format.format, 320, 480,
            'image/' || format.format, 1, $2,
            'm/' || requested.media_id::text || '/' || format.format || '-320', requested.transaction_id
     FROM jsonb_to_recordset($1::jsonb) AS requested(
       route integer, media_id uuid, transaction_id uuid
     )
     CROSS JOIN (VALUES ('avif'::text), ('webp'::text)) AS format(format)`,
    [JSON.stringify(records), 'c'.repeat(64)],
  );
}

async function insertUnrelatedMedia(count: number, routes: readonly number[]): Promise<void> {
  const records = Array.from({ length: count }, (_, index) => {
    const route = routes[index % routes.length]!;
    return {
      route,
      media_id: newId(route),
      container_id: newId(route),
      uploader_id: newId(route),
      transaction_id: newId(route),
    };
  });
  await db.admin.query(
    `INSERT INTO content.media
       (route, media_id, container_id, uploader_id, reservation_request_id, purpose,
        media_type, byte_count, state, key, transaction_id)
     SELECT requested.route, requested.media_id, requested.container_id, requested.uploader_id,
            requested.media_id::text, 'post-image', 'image/jpeg', 256, 'reserved',
            'm/' || requested.media_id::text || '/original', requested.transaction_id
     FROM jsonb_to_recordset($1::jsonb) AS requested(
       route integer, media_id uuid, container_id uuid, uploader_id uuid, transaction_id uuid
     )`,
    [JSON.stringify(records)],
  );
  await db.admin.query(
    `INSERT INTO content.media_variant
       (route, media_id, format, width, height, media_type, byte_count, sha256, key, transaction_id)
     SELECT requested.route, requested.media_id, format.format, 320, 480,
            'image/' || format.format, 1, $2,
            'm/' || requested.media_id::text || '/' || format.format || '-320', requested.transaction_id
     FROM jsonb_to_recordset($1::jsonb) AS requested(
       route integer, media_id uuid, transaction_id uuid
     )
     CROSS JOIN (VALUES ('avif'::text), ('webp'::text)) AS format(format)`,
    [JSON.stringify(records), 'c'.repeat(64)],
  );
}

test('a cover reference returns crop display dimensions and all metadata with its existing credit', async () => {
  const route = 42000;
  const croppedId = newId(route);
  const plainId = newId(route);
  await insertCover(croppedId, { crop: [10, 20, 300, 500], focalPoint: { x: 0.25, y: 0.75 } });
  await insertCover(plainId, { focalPoint: null, variants: [960] });

  const client = await db.pool.connect();
  try {
    expect(await checkMediaObject(client, croppedId, 'cover')).toEqual({
      id: croppedId,
      digest: 'a'.repeat(64),
      containerId: expect.any(String),
      rights: {
        license: 'LicenseRef-unknown',
        obligations: [],
        attribution: '(c) Image Artist; via [Example Catalogue](https://catalogue.example.test/record/42)',
      },
      source: provenance,
      credit,
      width: 300,
      height: 500,
      placeholder: { thumbhash: 'AQID', color: '#5a4632' },
      variants: [
        { format: 'avif', width: 320 },
        { format: 'webp', width: 320 },
        { format: 'avif', width: 640 },
        { format: 'webp', width: 640 },
      ],
      focalPoint: { x: 0.25, y: 0.75 },
    });
    expect(await checkMediaObject(client, plainId, 'cover')).toMatchObject({
      width: 1200,
      height: 1800,
      focalPoint: null,
      variants: [
        { format: 'avif', width: 960 },
        { format: 'webp', width: 960 },
      ],
    });
  } finally {
    client.release();
  }
});

test('unavailable, erased, taken-down and collection-pending covers remain null', async () => {
  const route = 42000;
  const states = [
    { id: newId(route), assignment: "state='uploaded'" },
    { id: newId(route), assignment: 'erased=true, security_revision=security_revision+1' },
    { id: newId(route), assignment: 'taken_down=true, security_revision=1' },
    { id: newId(route), assignment: 'collection_pending=true' },
  ];
  for (const state of states) {
    await insertCover(state.id);
    await db.admin.query(`UPDATE content.media SET ${state.assignment} WHERE route=$1 AND media_id=$2`, [
      route,
      state.id,
    ]);
  }
  const client = await db.pool.connect();
  try {
    for (const state of states) expect(await checkMediaObject(client, state.id, 'cover')).toBeNull();
  } finally {
    client.release();
  }
});

test('a cover batch deduplicates ids, preserves single-read answers and uses one statement per partition', async () => {
  const routes = [42000, 42001, 42016] as const;
  const ids = routes.map((route) => newId(route)) as [string, string, string];
  for (const id of ids) await insertCover(id);
  const invalid = 'not-an-id';
  const client = await db.pool.connect();
  try {
    const answers = await checkMediaObjects(client, [ids[0]!, ids[1]!, ids[0]!, ids[2]!, invalid], 'cover');
    expect([...answers.keys()]).toEqual([ids[0], ids[1], ids[2], invalid]);
    expect(answers.get(invalid)).toBeNull();
    for (const id of ids) expect(answers.get(id)).toEqual(await checkMediaObject(client, id, 'cover'));
  } finally {
    client.release();
  }
});

test('cover batches touch one statement per partition and rows grow linearly with ids', async () => {
  const routes = [42000, 42016, 42032, 42048] as const;
  // Fix stored M/V before the first sample; only the requested batch N grows.
  const ids = Array.from({ length: 256 }, (_, index) => newId(routes[index % routes.length]!));
  await insertUnrelatedMedia(8192, routes);
  await insertGrowthCovers(ids);
  const report = await checkGrowth(db, {
    name: 'batched cover reference',
    rule: 'series',
    scales: [16, 64, 256],
    bounds: { rows: 'linear', statements: 'constant', blocks: 'linear' },
    // read-cover-reference.sql descends into fixed media/variant indexes, so
    // its two probes per requested id are linear without a growth staircase.
    grow: async () => {},
    async operation(_database, scale) {
      const client = await db.pool.connect();
      try {
        const answers = await checkMediaObjects(client, ids.slice(0, scale), 'cover');
        expect(answers.size).toBe(scale);
        expect([...answers.values()].every((answer) => answer !== null)).toBe(true);
      } finally {
        client.release();
      }
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([16, 64, 256]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(
      new Set(ids.slice(0, sample.scale).map((id) => partitionOf(routeOf(id)!))).size,
    );
    expect(sample.cost.rows).toBeGreaterThanOrEqual(sample.scale * 3);
    expect(sample.cost.rows).toBeLessThanOrEqual(sample.scale * 4);
  }
});
