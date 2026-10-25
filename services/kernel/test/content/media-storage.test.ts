import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
let growthDatabase: GrowthDatabase | undefined;
const growthMediaIds: string[] = [];
const growthRoute = 60_000;
const growthRoutes = Array.from({ length: 16 }, (_, offset) => growthRoute + offset);
const growthBaselineDistractors = 256;
const growthCutoff = '2030-01-02T00:00:00.000Z';
const growthOld = '2020-01-01T00:00:00.000Z';
const growthYoung = '2030-01-03T00:00:00.000Z';
let growthTargets: { eligible: Map<number, string>; pending: Map<number, string> } | undefined;

let sequence = 0;
function uuidAtRoute(route: number): string {
  const suffix = (++sequence).toString(16).padStart(8, '0');
  return `00000000-0000-8000-8000-${route.toString(16).padStart(4, '0')}${suffix}`;
}

const sha256 = 'a'.repeat(64);
const transactionId = () => randomUUID();

afterAll(async () => {
  try {
    if (growthDatabase && growthMediaIds.length > 0) {
      await growthDatabase.admin.query(
        'DELETE FROM content.media WHERE route = ANY($1::integer[]) AND media_id = ANY($2::uuid[])',
        [growthRoutes, growthMediaIds],
      );
    }
  } finally {
    if (growthDatabase) await growthDatabase.close();
    await pool.end();
  }
});

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
  expect(columns.filter((column) => column.table_name === 'media').map((column) => column.column_name)).toEqual([
    'route',
    'media_id',
    'container_id',
    'uploader_id',
    'reservation_request_id',
    'purpose',
    'media_type',
    'byte_count',
    'declared_sha256',
    'actual_byte_count',
    'sha256',
    'state',
    'decision',
    'key',
    'claimed_at',
    'created_at',
    'transaction_id',
    'erased',
    'collection_pending',
  ]);
  expect(columns.filter((column) => column.table_name === 'media_variant').map((column) => column.column_name)).toEqual(
    [
      'route',
      'media_id',
      'format',
      'width',
      'height',
      'media_type',
      'byte_count',
      'sha256',
      'key',
      'transaction_id',
      'created_at',
    ],
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
      array_agg(attribute.attname::text ORDER BY key.ordinality) AS columns,
      pg_get_expr(index.indpred, index.indrelid) AS predicate
    FROM pg_index index
    CROSS JOIN LATERAL unnest(index.indkey) WITH ORDINALITY AS key(attnum, ordinality)
    JOIN pg_attribute attribute ON attribute.attrelid = index.indrelid AND attribute.attnum = key.attnum
    WHERE index.indrelid IN ('content.media'::regclass, 'content.media_variant'::regclass)
      AND key.ordinality <= index.indnkeyatts
    GROUP BY indexrelid
  `);
  expect(indexes.length).toBeGreaterThanOrEqual(7);
  for (const index of indexes) expect(index.columns[0]).toBe('route');
  expect(indexes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'content.media_pkey', columns: ['route', 'media_id'] }),
      expect.objectContaining({
        name: 'content.media_variant_pkey',
        columns: ['route', 'media_id', 'format', 'width'],
      }),
      expect.objectContaining({
        name: 'content.media_collection_eligible_idx',
        columns: ['route', 'created_at', 'media_id'],
      }),
      expect.objectContaining({
        name: 'content.media_collection_pending_idx',
        columns: ['route', 'created_at', 'media_id'],
      }),
    ]),
  );
  const eligibleIndex = indexes.find((index) => index.name === 'content.media_collection_eligible_idx');
  const eligiblePredicate = eligibleIndex?.predicate?.replaceAll(/[()\s]/g, '').toLowerCase();
  expect(eligiblePredicate).toContain('claimed_atisnull');
  expect(eligiblePredicate).toContain('noterased');
  expect(eligiblePredicate).toContain('notcollection_pending');
  const pendingPredicate = indexes
    .find((index) => index.name === 'content.media_collection_pending_idx')
    ?.predicate?.replaceAll(/[()\s]/g, '');
  expect(pendingPredicate).toBe('collection_pending');

  const { rows: checks } = await pool.query(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
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
  expect(definitions).toContain('20971520');
  expect(checks.map((check) => check.conname)).toContain('media_variant_width_ladder_check');

  const { rows: foreignKeys } = await pool.query(`
    SELECT constraint_row.conrelid::regclass::text AS source,
      constraint_row.confrelid::regclass::text AS target,
      array_agg(source_column.attname::text ORDER BY source_key.ordinality) AS source_columns,
      array_agg(target_column.attname::text ORDER BY target_key.ordinality) AS target_columns
    FROM pg_constraint constraint_row
    CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS source_key(attnum, ordinality)
    JOIN pg_attribute source_column
      ON source_column.attrelid = constraint_row.conrelid AND source_column.attnum = source_key.attnum
    CROSS JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY AS target_key(attnum, ordinality)
    JOIN pg_attribute target_column
      ON target_column.attrelid = constraint_row.confrelid AND target_column.attnum = target_key.attnum
      AND target_key.ordinality = source_key.ordinality
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid IN ('content.media'::regclass, 'content.media_variant'::regclass)
    GROUP BY constraint_row.conrelid, constraint_row.confrelid
  `);
  expect(foreignKeys.filter((key) => key.source === 'content.media')).toEqual([]);
  expect(foreignKeys).toEqual([
    {
      source: 'content.media_variant',
      target: 'content.media',
      source_columns: ['route', 'media_id'],
      target_columns: ['route', 'media_id'],
    },
  ]);
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
    { declaredSha256: 'not-a-digest' },
    { state: 'available', actualByteCount: 256, sha256: 'b'.repeat(64) },
    { purpose: 'arbitrary-binary' },
    { mediaType: 'application/octet-stream' },
    { byteCount: 0 },
    { byteCount: 20_971_521 },
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
      declaredSha256: sha256 as string | null,
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
        byte_count, declared_sha256, actual_byte_count, sha256, state, decision, key, claimed_at, transaction_id,
        erased, collection_pending
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
          values.declaredSha256,
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
    { format: 'webp', width: 321, type: 'image/webp', key: `m/${media.mediaId}/webp-321` },
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

test('media collection indexes keep fixed old and pending reads bounded across same-partition growth', async () => {
  growthDatabase = await openGrowthDatabase(databaseUrl);

  async function seed(scale: number, previous: number): Promise<void> {
    const rows: {
      readonly route: number;
      readonly mediaId: string;
      readonly reservationRequestId: string;
      readonly claimed: boolean;
      readonly createdAt: string;
      readonly collectionPending: boolean;
    }[] = [];

    function addDistractor(ordinal: number): void {
      const route = growthRoutes[ordinal % growthRoutes.length]!;
      const claimed = ordinal % 2 === 1;
      rows.push({
        route,
        mediaId: uuidAtRoute(route),
        reservationRequestId: `media-growth-distractor-${ordinal}`,
        claimed,
        createdAt: claimed ? growthOld : growthYoung,
        collectionPending: false,
      });
    }

    if (previous === 0) {
      const eligible = new Map<number, string>();
      const pending = new Map<number, string>();
      growthTargets = { eligible, pending };
      for (const route of growthRoutes) {
        const eligibleId = uuidAtRoute(route);
        const pendingId = uuidAtRoute(route);
        eligible.set(route, eligibleId);
        pending.set(route, pendingId);
        rows.push(
          {
            route,
            mediaId: eligibleId,
            reservationRequestId: `media-growth-target-${route}`,
            claimed: false,
            createdAt: growthOld,
            collectionPending: false,
          },
          {
            route,
            mediaId: pendingId,
            reservationRequestId: `media-growth-pending-${route}`,
            claimed: false,
            createdAt: growthOld,
            collectionPending: true,
          },
        );
      }
      for (let ordinal = 0; ordinal < growthBaselineDistractors; ordinal++) addDistractor(ordinal);
    }

    for (let ordinal = previous; ordinal < scale; ordinal++) addDistractor(growthBaselineDistractors + ordinal);
    await insertGrowthMedia(growthDatabase!, rows);
    await growthDatabase!.admin.query('ANALYZE content.media');
  }

  async function operation(database: GrowthDatabase): Promise<unknown> {
    if (!growthTargets) throw new Error('Media growth targets were not seeded');
    let eligibleCount = 0;
    let pendingCount = 0;
    for (const route of growthRoutes) {
      const eligible = await database.pool.query(
        `SELECT media_id FROM content.media
         WHERE route = $1 AND claimed_at IS NULL AND NOT erased AND NOT collection_pending
           AND created_at <= $2::timestamptz
         ORDER BY created_at, media_id
         LIMIT 100`,
        [route, growthCutoff],
      );
      const pending = await database.pool.query(
        `SELECT media_id FROM content.media
         WHERE route = $1 AND collection_pending
         ORDER BY created_at, media_id
         LIMIT 100`,
        [route],
      );
      if (eligible.rows.length !== 1 || eligible.rows[0]?.media_id !== growthTargets.eligible.get(route))
        throw new Error('The bounded eligible lookup did not return its fixed old target');
      if (pending.rows.length !== 1 || pending.rows[0]?.media_id !== growthTargets.pending.get(route))
        throw new Error('The bounded retry lookup did not return its fixed pending target');
      eligibleCount += eligible.rows.length;
      pendingCount += pending.rows.length;
    }
    return { eligibleCount, pendingCount };
  }

  const report = await checkGrowth(growthDatabase, {
    name: 'media collection route seeks',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: async (_database, scale, previous) => seed(scale, previous),
    operation,
  });

  console.info('media storage growth evidence', JSON.stringify(report));
  expect(report.samples.map(({ scale }) => scale)).toEqual([32, 256, 2048]);
  expect(report.samples.every(({ cost }) => cost.statements === 32)).toBe(true);
  expect(report.samples.every(({ cost }) => cost.rows <= 64)).toBe(true);
  expect(report.samples.every(({ cost }) => cost.relations?.['content.media']?.rows === 32)).toBe(true);
}, 60_000);

async function insertGrowthMedia(
  database: GrowthDatabase,
  rows: readonly {
    readonly route: number;
    readonly mediaId: string;
    readonly reservationRequestId: string;
    readonly claimed: boolean;
    readonly createdAt: string;
    readonly collectionPending: boolean;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  const mediaIds = rows.map(({ mediaId }) => mediaId);
  growthMediaIds.push(...mediaIds);
  await database.admin.query(
    `INSERT INTO content.media (
       route, media_id, container_id, uploader_id, reservation_request_id, purpose, media_type,
       byte_count, actual_byte_count, sha256, state, decision, key, claimed_at, created_at,
       transaction_id, erased, collection_pending
     )
     SELECT seeded.route, seeded.media_id, seeded.container_id, seeded.uploader_id,
       seeded.reservation_request_id, 'post-image', 'image/jpeg',
       256,
       CASE WHEN seeded.claimed THEN 256::bigint ELSE NULL::bigint END,
       CASE WHEN seeded.claimed THEN $9::text ELSE NULL::text END,
       CASE WHEN seeded.claimed THEN 'available'::text ELSE 'reserved'::text END,
       NULL,
       'm/' || seeded.media_id::text || '/original',
       CASE WHEN seeded.claimed THEN $10::timestamptz ELSE NULL::timestamptz END,
       seeded.created_at, $11::uuid, false, seeded.collection_pending
     FROM unnest(
       $1::integer[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::boolean[], $7::timestamptz[],
       $8::boolean[]
     ) AS seeded(route, media_id, container_id, uploader_id, reservation_request_id, claimed, created_at, collection_pending)`,
    [
      rows.map(({ route }) => route),
      mediaIds,
      rows.map(({ route }) => uuidAtRoute(route)),
      rows.map(({ route }) => uuidAtRoute(route + 1)),
      rows.map(({ reservationRequestId }) => reservationRequestId),
      rows.map(({ claimed }) => claimed),
      rows.map(({ createdAt }) => createdAt),
      rows.map(({ collectionPending }) => collectionPending),
      sha256,
      '2021-01-01T00:00:00.000Z',
      transactionId(),
    ],
  );
}
