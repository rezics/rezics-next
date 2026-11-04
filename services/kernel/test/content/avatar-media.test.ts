import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import sharp from 'sharp';
import { checkAvatarMedia, readAvatarSummaries } from '../../src/content/avatar.ts';
import { downloadMedia } from '../../src/content/media-download.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { eraseStandaloneMedia } from '../../src/content/moderation.ts';
import {
  completeMedia,
  readAvatarUploadAdvice,
  readReservation,
  reserveMedia,
  type MediaReservationInput,
} from '../../src/content/media.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { checkGrowth, measure, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { productionActions } from '../support/production-actions.ts';

let db: GrowthDatabase;
const accountId = newId(0x4312);
let owner: AccountActor;
const access = admittedAccess({ actions: productionActions() });
const context = () => ({
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  deadline: Date.now() + 30000,
});
const dependencies = () => ({ pool: db.pool, access });

beforeAll(async () => {
  db = await openGrowthDatabase();
  await db.admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(accountId), accountId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$2,'media:create','(,)',$2)`,
    [routeOf(accountId), accountId],
  );
  owner = await authenticateAccount(
    access,
    { pool: db.pool, deadline: Date.now() + 30000 },
    {
      accountId,
      clientId: 'rezics-website',
      scopes: ['media:create', 'media:complete', 'media:read_reservation', 'media:erase'],
    },
  );
});
afterAll(() => db?.close());

test('an account reserves and completes an avatar in its own account partition', async () => {
  const request = context();
  const reservation = await reserveMedia(
    dependencies(),
    owner,
    {
      containerId: accountId,
      purpose: 'avatar',
      mediaType: 'image/png',
      byteCount: 256,
    },
    request,
  );
  const id = reservation.value.mediaId;
  expect(routeOf(id)).toBe(routeOf(accountId));
  expect(await readReservation(dependencies(), id, { actor: owner, deadline: Date.now() + 30000 })).toMatchObject({
    id,
    containerId: accountId,
    uploaderId: accountId,
    purpose: 'avatar',
    state: 'reserved',
  });
  expect(
    (
      await completeMedia(
        dependencies(),
        owner,
        id,
        {
          containerId: accountId,
          reservationRequestId: request.idempotencyKey,
          byteCount: 256,
          sha256: 'a'.repeat(64),
        },
        context(),
      )
    ).value,
  ).toEqual({ mediaId: id, state: 'uploaded' });
});

async function reserve(containerId = accountId, actor = owner, overrides: Partial<MediaReservationInput> = {}) {
  const request = context();
  const result = await reserveMedia(
    dependencies(),
    actor,
    {
      containerId,
      purpose: 'avatar',
      mediaType: 'image/png',
      byteCount: 256,
      ...overrides,
    } as MediaReservationInput,
    request,
  );
  return { id: result.value.mediaId, request };
}

async function seedMedia(targetRoute: number, ids: string[], available = true, purpose = 'avatar') {
  const container = purpose === 'avatar' ? newId(targetRoute) : accountId;
  await db.admin.query(
    `INSERT INTO content.media
      (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,
       byte_count,actual_byte_count,sha256,state,key,transaction_id,width,height,thumbhash,average_color)
     SELECT $1,id,$3,$3,id::text,$4,'image/png',256,
       CASE WHEN $5 THEN 256 END,CASE WHEN $5 THEN repeat('a',64) END,
       CASE WHEN $5 THEN 'available' ELSE 'reserved' END,'m/'||id||'/original',id,
       CASE WHEN $5 THEN 64 END,CASE WHEN $5 THEN 64 END,
       CASE WHEN $5 THEN decode('010203','hex') END,CASE WHEN $5 THEN '#123456' END
     FROM unnest($2::uuid[]) ids(id)`,
    [targetRoute, ids, container, purpose, available],
  );
  if (available)
    await db.admin.query(
      `INSERT INTO content.media_variant(route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
     SELECT $1,id,format,64,64,'image/'||format,100,repeat('b',64),'m/'||id||'/'||format||'-64',id
     FROM unnest($2::uuid[]) ids(id) CROSS JOIN unnest(ARRAY['avif','webp']) formats(format)`,
      [targetRoute, ids],
    );
  return container;
}

const withClient = async <T>(operation: (client: PoolClient) => Promise<T>) => {
  const client = await db.pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
};

test('only the admitted website account can reserve and complete its own avatar', async () => {
  const otherId = newId(0x4313);
  await db.admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(otherId), otherId],
  );
  const claims = { accountId: otherId, clientId: 'rezics-website', scopes: owner.scopes };
  const other = await authenticateAccount(access, { pool: db.pool, deadline: Date.now() + 30000 }, claims);
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'media:create','(,)',$3)`,
    [routeOf(accountId), accountId, otherId],
  );
  await expect(reserve(accountId, other)).rejects.toThrow();
  await expect(reserve(otherId)).rejects.toThrow();
  await expect(reserve(accountId, { ...owner })).rejects.toThrow();
  const external = await authenticateAccount(
    access,
    { pool: db.pool, deadline: Date.now() + 30000 },
    {
      accountId,
      clientId: 'external-client',
      scopes: owner.scopes,
    },
  );
  await expect(reserve(accountId, external)).rejects.toThrow();
  const scopeless = await authenticateAccount(
    access,
    { pool: db.pool, deadline: Date.now() + 30000 },
    {
      accountId,
      clientId: 'rezics-website',
      scopes: [],
    },
  );
  await expect(reserve(accountId, scopeless)).rejects.toThrow();
  for (const overrides of [{ byteCount: 0 }, { byteCount: 20971521 }, { mediaType: 'text/plain' }])
    await expect(reserve(accountId, owner, overrides)).rejects.toThrow();
  const { id, request } = await reserve();
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'media:complete','(,)',$3)`,
    [routeOf(id), id, otherId],
  );
  const completion = {
    containerId: accountId,
    reservationRequestId: request.idempotencyKey,
    byteCount: 256,
    sha256: 'a'.repeat(64),
  };
  for (const actor of [other, external, scopeless, { ...owner }])
    await expect(completeMedia(dependencies(), actor, id, completion, context())).rejects.toThrow();
  await expect(
    completeMedia(dependencies(), owner, id, { ...completion, containerId: otherId }, context()),
  ).rejects.toThrow();
});

test('avatar processing publishes the image variants, placeholder and colour and serves them publicly', async () => {
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
  const request = context();
  const id = (
    await reserveMedia(
      dependencies(),
      owner,
      {
        containerId: accountId,
        purpose: 'avatar',
        mediaType: 'image/png',
        byteCount: bytes.byteLength,
      },
      request,
    )
  ).value.mediaId;
  const store = new Map<string, Uint8Array>([[`m/${id}/original`, bytes]]);
  const storage: MediaStorage = {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async deletePrefix(prefix) {
      for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
    },
  };
  expect(
    await downloadMedia(dependencies(), id, { kind: 'anonymous' }, 'webp-64', { deadline: Date.now() + 30000 }),
  ).toEqual({ allowed: false });
  await completeMedia(
    dependencies(),
    owner,
    id,
    {
      containerId: accountId,
      reservationRequestId: request.idempotencyKey,
      byteCount: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    context(),
  );
  expect(await downloadMedia(dependencies(), id, owner, 'original', { deadline: Date.now() + 30000 })).toEqual({
    allowed: false,
  });
  expect((await createImageJob(db.pool, storage).process(id)).state).toBe('available');
  const summary = (await withClient((client) => readAvatarSummaries(client, [id]))).get(id);
  expect(summary).toMatchObject({
    media: id,
    width: 64,
    height: 64,
    placeholder: { color: expect.stringMatching(/^#[0-9a-f]{6}$/), thumbhash: expect.any(String) },
    variants: [
      { format: 'avif', width: 64 },
      { format: 'webp', width: 64 },
    ],
    focalPoint: null,
    credit: null,
  });
  expect(await withClient((client) => checkAvatarMedia(client, id, accountId))).toBe(true);
  for (const actor of [{ kind: 'anonymous' } as const, owner]) {
    expect(await downloadMedia(dependencies(), id, actor, 'webp-64', { deadline: Date.now() + 30000 })).toMatchObject({
      allowed: true,
      key: `m/${id}/webp-64`,
    });
    expect(await downloadMedia(dependencies(), id, actor, 'original', { deadline: Date.now() + 30000 })).toEqual({
      allowed: false,
    });
  }
  await eraseStandaloneMedia(
    { ...dependencies(), routeKey: new Uint8Array(32) },
    owner,
    { mediaId: id, reason: 'Removed avatar' },
    context(),
  );
  expect(
    await downloadMedia(dependencies(), id, { kind: 'anonymous' }, 'webp-64', { deadline: Date.now() + 30000 }),
  ).toEqual({ allowed: false });
  expect(await withClient((client) => checkAvatarMedia(client, id, accountId))).toBe(false);
});

test('avatar readers and downloads reject other purposes, owners, unknown ids and unavailable states', async () => {
  const targetRoute = 0x4510;
  for (const assignment of [
    "state='reserved', actual_byte_count=NULL, sha256=NULL",
    "state='uploaded'",
    "state='rejected',decision='unsafe-image'",
    'taken_down=true,security_revision=1',
    'erased=true,security_revision=1',
    'collection_pending=true',
    "purpose='post-image'",
  ]) {
    const id = newId(targetRoute);
    const container = await seedMedia(targetRoute, [id]);
    expect(await withClient((client) => checkAvatarMedia(client, id, container))).toBe(true);
    expect(await withClient((client) => checkAvatarMedia(client, id, newId(targetRoute)))).toBe(false);
    expect(await withClient((client) => checkAvatarMedia(client, id, newId(targetRoute + 16)))).toBe(false);
    await db.admin.query(`UPDATE content.media SET ${assignment} WHERE route=$1 AND media_id=$2`, [targetRoute, id]);
    expect(await withClient((client) => checkAvatarMedia(client, id, container))).toBe(false);
    expect((await withClient((client) => readAvatarSummaries(client, [id]))).get(id)).toBeNull();
    expect(
      await downloadMedia(dependencies(), id, { kind: 'anonymous' }, 'webp-64', { deadline: Date.now() + 30000 }),
    ).toEqual({ allowed: false });
  }
  for (const id of ['not-an-id', newId(targetRoute)]) {
    expect(await withClient((client) => checkAvatarMedia(client, id, accountId))).toBe(false);
    expect((await withClient((client) => readAvatarSummaries(client, [id]))).get(id)).toBeNull();
  }
});

test('avatar summaries batch up to 256 ids with one statement per partition and cover summary fields', async () => {
  const ids = Array.from({ length: 254 }, () => newId(0x4610));
  await seedMedia(0x4610, ids);
  const neighbour = newId(0x4611);
  const remote = newId(0x4620);
  await seedMedia(0x4611, [neighbour]);
  await seedMedia(0x4620, [remote]);
  const all = [...ids, neighbour, remote];
  const result = await measure(db, () => withClient((client) => readAvatarSummaries(client, all)));
  expect(result.cost.statements).toBe(2);
  expect(result.value.size).toBe(256);
  for (const id of all)
    expect(result.value.get(id)).toEqual({
      media: id,
      width: 64,
      height: 64,
      placeholder: { thumbhash: 'AQID', color: '#123456' },
      variants: [
        { format: 'avif', width: 64 },
        { format: 'webp', width: 64 },
      ],
      focalPoint: null,
      credit: null,
    });
  expect((await withClient((client) => readAvatarSummaries(client, [ids[0]!, ids[0]!]))).size).toBe(1);
  await expect(withClient((client) => readAvatarSummaries(client, []))).rejects.toThrow(RangeError);
  await expect(withClient((client) => readAvatarSummaries(client, [...all, newId(0x4610)]))).rejects.toThrow(
    RangeError,
  );
});

for (const name of ['avatar summaries', 'avatar check'] as const)
  test(
    name,
    async () => {
      const targetRoute = name === 'avatar summaries' ? 0x4710 : 0x4810;
      const existing = Array.from({ length: 64 }, () => newId(targetRoute));
      const requested = [...existing, ...Array.from({ length: 192 }, () => newId(targetRoute))];
      const container = await seedMedia(targetRoute, existing);
      const report = await checkGrowth(db, {
        name,
        scales: [64, 512, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(_database, scale, previous) {
          const added = scale - Math.max(64, previous);
          if (added > 0)
            await seedMedia(
              targetRoute,
              Array.from({ length: added }, () => newId(targetRoute)),
              false,
            );
        },
        async operation() {
          if (name === 'avatar check')
            expect(await withClient((client) => checkAvatarMedia(client, existing[0]!, container))).toBe(true);
          else {
            const summaries = await withClient((client) => readAvatarSummaries(client, requested));
            expect(summaries.size).toBe(256);
            expect([...summaries.values()].filter(Boolean)).toHaveLength(64);
          }
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
      for (const sample of report.samples) {
        expect(sample.cost.statements).toBe(1);
        expect(sample.cost.rows).toBeGreaterThan(0);
      }
    },
    60000,
  );

const expectedAdvice = (actions: ['upload'] | []) => ({
  viewerState: 'signed_in',
  viewer: { accountId },
  target: { containerId: accountId, purpose: 'avatar' },
  constraints: {
    mediaTypes: ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'],
    maxByteCount: 20_971_520,
  },
  allowedActions: actions,
});

async function nativeEffects() {
  return (
    await db.admin.query(
      `SELECT
         (SELECT count(*)::integer FROM content.media WHERE container_id=$1) AS media,
         (SELECT count(*)::integer FROM core.receipt WHERE principal_id=$1 AND command_kind='content.media.reserve') AS receipts,
         (SELECT count(*)::integer FROM core.outbox WHERE type='com.rezics.content.media.reserved.v1') AS events`,
      [accountId],
    )
  ).rows[0];
}

test('avatar upload advice is the current self media:create observation and reservation replay adds no effect', async () => {
  expect(await readAvatarUploadAdvice(dependencies(), owner, Date.now() + 30000)).toEqual(expectedAdvice(['upload']));
  const request = context();
  const first = await reserveMedia(
    dependencies(),
    owner,
    { containerId: accountId, purpose: 'avatar', mediaType: 'image/png', byteCount: 256 },
    request,
  );
  const before = await nativeEffects();
  const replay = await reserveMedia(
    dependencies(),
    owner,
    { containerId: accountId, purpose: 'avatar', mediaType: 'image/png', byteCount: 256 },
    request,
  );
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(first.value);
  expect(await nativeEffects()).toEqual(before);
  expect(await readReservation(dependencies(), first.value.mediaId, { actor: owner, deadline: Date.now() + 30000 })).toMatchObject({
    id: first.value.mediaId,
    reservationRequestId: request.idempotencyKey,
    state: 'reserved',
  });

  await db.admin.query(
    "DELETE FROM access.resource_grant WHERE resource_id=$1 AND subject_id=$1 AND action='media:create'",
    [accountId],
  );
  expect(await readAvatarUploadAdvice(dependencies(), owner, Date.now() + 30000)).toEqual(expectedAdvice([]));
  await expect(
    reserveMedia(
      dependencies(),
      owner,
      { containerId: accountId, purpose: 'avatar', mediaType: 'image/png', byteCount: 256 },
      context(),
    ),
  ).rejects.toThrow();
  expect(await nativeEffects()).toEqual(before);
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$2,'media:create','(,)',$2)`,
    [routeOf(accountId), accountId],
  );

  await db.admin.query("UPDATE access.account SET state='suspended' WHERE account_id=$1", [accountId]);
  expect(await readAvatarUploadAdvice(dependencies(), owner, Date.now() + 30000)).toEqual(expectedAdvice([]));
  await db.admin.query("UPDATE access.account SET state='active' WHERE account_id=$1", [accountId]);
  await db.admin.query('UPDATE access.account SET authn_fenced=true WHERE account_id=$1', [accountId]);
  await expect(readAvatarUploadAdvice(dependencies(), owner, Date.now() + 30000)).rejects.toThrow();
  await db.admin.query('UPDATE access.account SET authn_fenced=false WHERE account_id=$1', [accountId]);
});

test(
  'avatar upload advice',
  async () => {
    const targetRoute = 0x4910;
    const report = await checkGrowth(db, {
      name: 'avatar upload advice',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        const added = scale - Math.max(64, previous);
        if (added > 0)
          await seedMedia(
            targetRoute,
            Array.from({ length: added }, () => newId(targetRoute)),
            false,
          );
      },
      async operation() {
        expect(await readAvatarUploadAdvice(dependencies(), owner, Date.now() + 30000)).toEqual(
          expectedAdvice(['upload']),
        );
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
    for (const sample of report.samples) expect(sample.cost.statements).toBeGreaterThan(0);
  },
  60000,
);
