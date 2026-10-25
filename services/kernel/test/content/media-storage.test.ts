import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
});

let sequence = 0;
function uuidAtRoute(route: number): string {
  const suffix = (++sequence).toString(16).padStart(8, '0');
  return `00000000-0000-8000-8000-${route.toString(16).padStart(4, '0')}${suffix}`;
}

const sha256 = 'a'.repeat(64);
const transactionId = () => randomUUID();

async function failure(sql: string, values: unknown[] = []): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await client.query(sql, values).then(
      () => null,
      (error: unknown) => error,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function insertMedia(
  patch: Partial<{
    route: number;
    mediaId: string;
    containerId: string;
    uploaderId: string;
    reservationRequestId: string;
    purpose: string;
    mediaType: string;
    byteCount: number;
    declaredSha256: string | null;
    actualByteCount: number | null;
    sha256: string | null;
    state: string;
    decision: string | null;
    key: string;
    claimedAt: string | null;
    transactionId: string;
    erased: boolean;
    collectionPending: boolean;
  }> = {},
) {
  const route = patch.route ?? 321;
  const mediaId = patch.mediaId ?? uuidAtRoute(route);
  const containerId = patch.containerId ?? uuidAtRoute(route);
  const uploaderId = patch.uploaderId ?? uuidAtRoute(route + 1);
  const id = ++sequence;
  const values = {
    route,
    mediaId,
    containerId,
    uploaderId,
    reservationRequestId: patch.reservationRequestId ?? `media-reservation-${id}`,
    purpose: patch.purpose ?? 'post-image',
    mediaType: patch.mediaType ?? 'image/jpeg',
    byteCount: patch.byteCount ?? 256,
    declaredSha256: patch.declaredSha256 === undefined ? sha256 : patch.declaredSha256,
    actualByteCount: patch.actualByteCount === undefined ? null : patch.actualByteCount,
    sha256: patch.sha256 === undefined ? null : patch.sha256,
    state: patch.state ?? 'reserved',
    decision: patch.decision === undefined ? null : patch.decision,
    key: patch.key ?? `m/${mediaId}/original`,
    claimedAt: patch.claimedAt === undefined ? null : patch.claimedAt,
    transactionId: patch.transactionId ?? transactionId(),
    erased: patch.erased ?? false,
    collectionPending: patch.collectionPending ?? false,
  };
  await pool.query(
    `INSERT INTO content.media (
      route, media_id, container_id, uploader_id, reservation_request_id, purpose, media_type,
      byte_count, declared_sha256, actual_byte_count, sha256, state, decision, key, claimed_at,
      transaction_id, erased, collection_pending
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
    )`,
    [
      values.route,
      values.mediaId,
      values.containerId,
      values.uploaderId,
      values.reservationRequestId,
      values.purpose,
      values.mediaType,
      values.byteCount,
      values.declaredSha256,
      values.actualByteCount,
      values.sha256,
      values.state,
      values.decision,
      values.key,
      values.claimedAt,
      values.transactionId,
      values.erased,
      values.collectionPending,
    ],
  );
  return values;
}

test('content media tables expose route-leading identity, lifecycle, and variant storage metadata', async () => {
  const { rows: columns } = await pool.query(`
    SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'content' AND table_name IN ('media', 'media_variant')
    ORDER BY table_name, ordinal_position
  `);
  const nullability = new Map(
    columns.map((column) => [`${column.table_name}.${column.column_name}`, column.is_nullable]),
  );
  for (const name of [
    'media.route',
    'media.media_id',
    'media.container_id',
    'media.uploader_id',
    'media.reservation_request_id',
    'media.purpose',
    'media.media_type',
    'media.byte_count',
    'media.state',
    'media.key',
    'media.created_at',
    'media.transaction_id',
    'media.erased',
    'media.collection_pending',
    'media_variant.route',
    'media_variant.media_id',
    'media_variant.format',
    'media_variant.width',
    'media_variant.height',
    'media_variant.media_type',
    'media_variant.byte_count',
    'media_variant.sha256',
    'media_variant.key',
    'media_variant.transaction_id',
  ])
    expect(nullability.get(name)).toBe('NO');
  for (const name of [
    'media.declared_sha256',
    'media.actual_byte_count',
    'media.sha256',
    'media.claimed_at',
    'media.decision',
  ])
    expect(nullability.get(name)).toBe('YES');

  const { rows: indexes } = await pool.query(`
    SELECT indexrelid::regclass::text AS name,
      array_agg(attribute.attname::text ORDER BY key.ordinality) AS columns
    FROM pg_index index
    CROSS JOIN LATERAL unnest(index.indkey) WITH ORDINALITY AS key(attnum, ordinality)
    JOIN pg_attribute attribute ON attribute.attrelid = index.indrelid AND attribute.attnum = key.attnum
    WHERE index.indrelid IN ('content.media'::regclass, 'content.media_variant'::regclass)
      AND key.ordinality <= index.indnkeyatts
    GROUP BY indexrelid
  `);
  expect(indexes.length).toBeGreaterThanOrEqual(6);
  for (const index of indexes) expect(index.columns[0]).toBe('route');
  expect(indexes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'content.media_pkey', columns: ['route', 'media_id'] }),
      expect.objectContaining({
        name: 'content.media_variant_pkey',
        columns: ['route', 'media_id', 'format', 'width'],
      }),
    ]),
  );

  const { rows: checks } = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid IN ('content.media'::regclass, 'content.media_variant'::regclass)
      AND contype = 'c'
  `);
  const definitions = checks.map((row) => row.definition).join('\n');
  expect(definitions).toContain("'reserved'");
  expect(definitions).toContain("'uploaded'");
  expect(definitions).toContain("'available'");
  expect(definitions).toContain("'rejected'");
  expect(definitions).toContain('collection_pending');
  expect(definitions).toContain('erased');
});

test('media route identity and lifecycle storage combinations are constrained', async () => {
  const route = 321;
  const mediaId = uuidAtRoute(route);
  const containerId = uuidAtRoute(route);
  const uploaderId = uuidAtRoute(route + 1);
  const reservationRequestId = `identity-${++sequence}`;
  await pool.query(
    `
    INSERT INTO content.media (
      route, media_id, container_id, uploader_id, reservation_request_id, purpose, media_type,
      byte_count, declared_sha256, state, transaction_id, key
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reserved', $10, $11)
  `,
    [
      route,
      mediaId,
      containerId,
      uploaderId,
      reservationRequestId,
      'post-image',
      'image/jpeg',
      256,
      sha256,
      transactionId(),
      `m/${mediaId}/original`,
    ],
  );
  const wrongMediaId = uuidAtRoute(route + 1);
  expect(
    await failure(
      `
    INSERT INTO content.media (
      route, media_id, container_id, uploader_id, reservation_request_id, purpose, media_type,
      byte_count, state, transaction_id, key
    ) VALUES ($1, $2, $3, $4, $5, 'post-image', 'image/jpeg', 256, 'reserved', $6, $7)
  `,
      [
        route,
        wrongMediaId,
        containerId,
        uploaderId,
        `wrong-media-${++sequence}`,
        transactionId(),
        `m/${wrongMediaId}/original`,
      ],
    ),
  ).toMatchObject({ code: '23514' });
  const wrongContainerId = uuidAtRoute(route + 1);
  const otherMediaId = uuidAtRoute(route);
  expect(
    await failure(
      `
    INSERT INTO content.media (
      route, media_id, container_id, uploader_id, reservation_request_id, purpose, media_type,
      byte_count, state, transaction_id, key
    ) VALUES ($1, $2, $3, $4, $5, 'post-image', 'image/jpeg', 256, 'reserved', $6, $7)
  `,
      [
        route,
        otherMediaId,
        wrongContainerId,
        uploaderId,
        `wrong-container-${++sequence}`,
        transactionId(),
        `m/${otherMediaId}/original`,
      ],
    ),
  ).toMatchObject({ code: '23514' });

  const invalidRows = [
    { state: 'unknown' },
    { state: 'uploaded' },
    { state: 'available' },
    { state: 'rejected', decision: null, actualByteCount: 256, sha256 },
    { state: 'reserved', actualByteCount: 256, sha256 },
    { state: 'reserved', claimedAt: '2030-01-02T00:00:00Z' },
    { state: 'available', actualByteCount: 256, sha256, claimedAt: '2030-01-02T00:00:00Z', collectionPending: true },
    { state: 'available', actualByteCount: 256, sha256, erased: true, collectionPending: true },
    { state: 'available', actualByteCount: 256, sha256: 'not-a-digest' },
    { purpose: 'arbitrary-binary' },
    { mediaType: 'application/octet-stream' },
    { byteCount: 0 },
  ];
  for (const patch of invalidRows) {
    const values = {
      route: 321,
      mediaId: uuidAtRoute(route),
      containerId,
      uploaderId,
      reservationRequestId: `invalid-${++sequence}`,
      purpose: 'post-image',
      mediaType: 'image/jpeg',
      byteCount: 256,
      actualByteCount: null as number | null,
      sha256: null as string | null,
      state: 'reserved',
      decision: null as string | null,
      key: '',
      claimedAt: null as string | null,
      erased: false,
      collectionPending: false,
      ...patch,
    };
    values.key = `m/${values.mediaId}/original`;
    expect(
      await failure(
        `
      INSERT INTO content.media (
        route, media_id, container_id, uploader_id, reservation_request_id, purpose, media_type,
        byte_count, actual_byte_count, sha256, state, decision, key, claimed_at, transaction_id,
        erased, collection_pending
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `,
        [
          values.route,
          values.mediaId,
          values.containerId,
          values.uploaderId,
          values.reservationRequestId,
          values.purpose,
          values.mediaType,
          values.byteCount,
          values.actualByteCount,
          values.sha256,
          values.state,
          values.decision,
          values.key,
          values.claimedAt,
          transactionId(),
          values.erased,
          values.collectionPending,
        ],
      ),
    ).toMatchObject({ code: '23514' });
  }
});

test('variants retain actual output metadata and route-scoped media ownership', async () => {
  const media = await insertMedia({ state: 'available', actualByteCount: 256, sha256 });
  await pool.query(
    `
    INSERT INTO content.media_variant (
      route, media_id, format, width, height, media_type, byte_count, sha256, key, transaction_id
    ) VALUES ($1, $2, 'webp', 127, 61, 'image/webp', 83, $3, $4, $5)
  `,
    [media.route, media.mediaId, 'b'.repeat(64), `m/${media.mediaId}/webp-127`, transactionId()],
  );
  const { rows } = await pool.query(
    `
    SELECT format, width, height, media_type, byte_count, sha256, key
    FROM content.media_variant WHERE route = $1 AND media_id = $2
  `,
    [media.route, media.mediaId],
  );
  expect(rows).toEqual([
    {
      format: 'webp',
      width: 127,
      height: 61,
      media_type: 'image/webp',
      byte_count: '83',
      sha256: 'b'.repeat(64),
      key: `m/${media.mediaId}/webp-127`,
    },
  ]);

  const invalidVariants = [
    { format: 'jpeg', width: 320, type: 'image/jpeg', key: `m/${media.mediaId}/jpeg-320` },
    { format: 'avif', width: 320, type: 'image/webp', key: `m/${media.mediaId}/avif-320` },
    { format: 'webp', width: 0, type: 'image/webp', key: `m/${media.mediaId}/webp-0` },
    { format: 'webp', width: 320, type: 'image/webp', key: `m/${media.mediaId}/webp-640` },
  ];
  for (const variant of invalidVariants) {
    expect(
      await failure(
        `
      INSERT INTO content.media_variant (
        route, media_id, format, width, height, media_type, byte_count, sha256, key, transaction_id
      ) VALUES ($1, $2, $3, $4, 100, $5, 80, $6, $7, $8)
    `,
        [
          media.route,
          media.mediaId,
          variant.format,
          variant.width,
          variant.type,
          'c'.repeat(64),
          variant.key,
          transactionId(),
        ],
      ),
    ).toMatchObject({ code: '23514' });
  }
  expect(
    await failure(
      `
    INSERT INTO content.media_variant (
      route, media_id, format, width, height, media_type, byte_count, sha256, key, transaction_id
    ) VALUES ($1, $2, 'webp', 320, 100, 'image/webp', 80, $3, $4, $5)
  `,
      [media.route + 1, media.mediaId, 'd'.repeat(64), `m/${media.mediaId}/webp-320`, transactionId()],
    ),
  ).toMatchObject({ code: '23503' });
});

test('collection fences and erased tombstones survive committed transactions', async () => {
  const pending = await insertMedia({ state: 'available', actualByteCount: 256, sha256, collectionPending: true });
  const erased = await insertMedia({ state: 'available', actualByteCount: 256, sha256, erased: true });
  const { rows } = await pool.query(
    `
    SELECT media_id, collection_pending, erased, state, sha256
    FROM content.media WHERE route = $1 AND media_id = ANY($2::uuid[])
    ORDER BY media_id
  `,
    [pending.route, [pending.mediaId, erased.mediaId]],
  );
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        media_id: pending.mediaId,
        collection_pending: true,
        erased: false,
        state: 'available',
        sha256,
      }),
      expect.objectContaining({
        media_id: erased.mediaId,
        collection_pending: false,
        erased: true,
        state: 'available',
        sha256,
      }),
    ]),
  );
});
