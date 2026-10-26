import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import sharp from 'sharp';
import {
  checkMediaImportRequest,
  checkMediaImportStatus,
  type MediaImportRequest,
} from '@rezics/definitions/media-import';
import { createAccess, resourceAuthorization } from '../../src/access/index.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError, principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import {
  importMediaFromUrl,
  readMediaImportStatus,
  type MediaImportDependencies,
} from '../../src/content/media-import.ts';
import { processImportedMedia } from '../../src/content/media-import-job.ts';
import { processImage } from '../../src/content/image-job.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { accessCheck, type AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { productionActions } from '../support/production-actions.ts';

const root = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
const route = 42000;
const accountId = newId(42016);
const containerId = newId(route);
const actions = [
  'media:import_from_url',
  'source_fence:read',
  'media:read_reservation',
  'media:read',
  'media:complete',
  'media:erase',
];
const request: MediaImportRequest = {
  containerId,
  sourceUrl: 'https://images.example.test/cover.jpg',
  crop: 'xywh=0,0,100,60',
  focalPoint: { x: 0.25, y: 0.75 },
  credit: {
    rightsHolder: 'Cover Artist',
    via: { name: 'Catalogue', url: 'https://catalogue.example.test/42' },
    license: 'LicenseRef-unknown',
    obligations: [],
  },
  provenance: {
    source: 'catalogue',
    external_id: '42',
    record_revision: '3',
    digest: 'b'.repeat(64),
    converter_revision: '2',
    field_group: 'cover',
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://catalogue.example.test/42' } },
          { property: { id: 'schema:author' }, value: { type: 'somevalue' } },
          { property: { id: 'schema:datePublished' }, value: { type: 'novalue' } },
        ],
      },
    ],
  },
};
let db: GrowthDatabase;
let deps: MediaImportDependencies;
let issue: (scopes?: readonly string[]) => Promise<AccountActor>;
const context = (key = Bun.randomUUIDv7()) => ({
  deadline: Date.now() + 10000,
  idempotencyKey: key,
  requestId: Bun.randomUUIDv7(),
});

class MemoryStorage implements MediaStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  async get(key: string) {
    const object = this.objects.get(key);
    return object ? Uint8Array.from(object.bytes) : null;
  }
  async put(key: string, bytes: Uint8Array, options: { mediaType: string }) {
    this.objects.set(key, { bytes: Uint8Array.from(bytes), mediaType: options.mediaType });
  }
  async deletePrefix(prefix: string) {
    for (const key of this.objects.keys()) if (key.startsWith(prefix)) this.objects.delete(key);
  }
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', kid: 'media-import-fixture' };
  const issuer = 'https://auth.example.test';
  const audience = 'https://api.example.test';
  const access = createAccess({
    actions: productionActions(),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  deps = {
    pool: db.pool,
    access,
    routeKey: new Uint8Array(32).fill(7),
    clock: () => new Date(),
    fetchConfig: { allowedHosts: ['images.example.test'] },
  };
  await db.admin.query(
    `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
     VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(accountId), accountId],
  );
  await db.admin.query(
    `INSERT INTO semantic.subject (route,subject_id,type,recorded_transaction_id)
     VALUES ($1,$2,'schema:Book',$2)`,
    [route, containerId],
  );
  issue = async (scopes = actions) => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      client_id: 'importer',
      scope: scopes.join(' '),
      authn_epoch: 1,
      auth_time: now,
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(accountId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
    return access.authenticate(token, { pool: db.pool, deadline: Date.now() + 30000 });
  };
  for (const action of ['media:import_from_url', 'source_fence:read'])
    await db.admin.query(
      `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
       VALUES (0,$1,$2,$3,'(,)'::tstzrange,$2)`,
      [root.id, accountId, action],
    );
  expect(checkMediaImportRequest(request)).toEqual([]);
});
afterAll(async () => {
  await db?.close();
});

test('required Access source-fence authorization executes on the existing Global Context', async () => {
  const actor = await issue();
  const boundary = { pool: db.pool, deadline: Date.now() + 10000 };
  // Establish that real credentials, scope and the existing root grant permit
  // the formula independently of the required action-general command port.
  const check = await accessCheck(deps.access, actor, 'source_fence:read', root, boundary);
  expect(await check(db.pool)).toBe(true);
  const authorization = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'source_fence:read',
    anchor: {
      resource: root,
      async validate(client) {
        return (
          (
            await client.query("SELECT 1 FROM semantic.context WHERE route=0 AND context_id=$1 AND kind='global'", [
              root.id,
            ])
          ).rowCount === 1
        );
      },
    },
    context: { ...boundary, partition: partitionOf(route) },
  });
  const effects = () =>
    db.admin.query(
      `SELECT
         (SELECT count(*) FROM content.media WHERE route=$1) AS media,
         (SELECT count(*) FROM core.outbox WHERE partition_no=$2) AS outbox`,
      [route, partitionOf(route)],
    );
  const before = await effects();
  const authorized = new Error('Authorized source-fence rollback probe');
  let bodyReached = false;
  await expect(
    runCommand(
      db.pool,
      {
        ...principalCommandIdentity(actor),
        partition: partitionOf(route),
        deadline: boundary.deadline,
        authorization,
      },
      async () => {
        bodyReached = true;
        // Probe real authorization at T without committing an eventless command.
        throw authorized;
      },
    ),
  ).rejects.toBe(authorized);
  expect(bodyReached).toBe(true);
  expect((await effects()).rows).toEqual(before.rows);
});

test('focused native outcomes preserve current authorization and partition bounds', async () => {
  const actor = await issue();
  const attempt = context();
  const result = await importMediaFromUrl(deps, actor, request, attempt);
  const id = result.value.mediaId;
  expect(Object.keys(result.value)).toEqual(['mediaId']);
  expect(routeOf(id)).toBe(route);
  expect(result.partition).toBe(partitionOf(route));
  expect(result.replayed).toBe(false);
  const replay = await importMediaFromUrl(deps, actor, request, {
    ...context(),
    idempotencyKey: attempt.idempotencyKey,
  });
  expect(replay.value).toEqual(result.value);
  expect(replay.replayed).toBe(true);
  await expect(
    importMediaFromUrl(
      deps,
      actor,
      { ...request, sourceUrl: 'https://images.example.test/changed.jpg' },
      { ...context(), idempotencyKey: attempt.idempotencyKey },
    ),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  const rows = await db.admin.query(
    `SELECT media_id,byte_count,actual_byte_count,media_type,sha256,source_url,credit,provenance,crop,focal_x,focal_y
     FROM content.media WHERE route=$1 AND media_id=$2`,
    [route, id],
  );
  expect(rows.rows).toEqual([
    {
      media_id: id,
      byte_count: null,
      actual_byte_count: null,
      media_type: null,
      sha256: null,
      source_url: request.sourceUrl,
      credit: request.credit,
      provenance: request.provenance,
      crop: [0, 0, 100, 60],
      focal_x: 0.25,
      focal_y: 0.75,
    },
  ]);
  const grants = await db.admin.query(
    `SELECT grant_role FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3`,
    [route, id, accountId],
  );
  expect(grants.rows).toEqual([{ grant_role: 'content.media.owner' }]);
  const status = await readMediaImportStatus(deps, actor, id, context());
  expect(status).toEqual({
    media: {
      id,
      containerId,
      purpose: 'cover',
      state: 'reserved',
      byteCount: null,
      mediaType: null,
      sha256: null,
      credit: request.credit,
      provenance: request.provenance,
      crop: request.crop!,
      focalPoint: request.focalPoint!,
    },
  });
  expect(checkMediaImportStatus(status)).toEqual([]);
  await db.admin.query(
    'DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3',
    [root.id, accountId, 'media:import_from_url'],
  );
  try {
    await expect(
      importMediaFromUrl(deps, actor, request, { ...context(), idempotencyKey: attempt.idempotencyKey }),
    ).rejects.toBeInstanceOf(GrantDeniedError);
  } finally {
    await db.admin.query(
      `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
       VALUES (0,$1,$2,'media:import_from_url','(,)'::tstzrange,$2)`,
      [root.id, accountId],
    );
  }
});

test('missing scope and anonymous identity deny; unknown reservation stays hidden', async () => {
  const limited = await issue(['media:read_reservation']);
  await expect(importMediaFromUrl(deps, limited, request, context())).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(importMediaFromUrl(deps, { kind: 'anonymous' }, request, context())).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  expect(await readMediaImportStatus(deps, limited, newId(route), context())).toBeNull();
  expect(await readMediaImportStatus(deps, { kind: 'anonymous' }, newId(route), context())).toBeNull();
});

test('out of bounds imported crops reject with a pollable crop decision', async () => {
  const actor = await issue();
  const input: MediaImportRequest = {
    ...request,
    sourceUrl: 'https://images.example.test/out-of-bounds.png',
    crop: 'xywh=90,0,20,20',
    provenance: { ...request.provenance, external_id: 'out-of-bounds' },
  };
  const reserved = await importMediaFromUrl(deps, actor, input, context());
  const bytes = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#2030e0' } })
    .png()
    .toBuffer();
  const originalFetch = globalThis.fetch;
  const fetchMock = spyOn(
    globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
    'fetch',
  ).mockImplementation(async () => new Response(bytes));
  try {
    const outcome = await processImportedMedia({ ...deps, storage: new MemoryStorage() }, reserved.value.mediaId);
    expect(outcome).toMatchObject({ state: 'rejected', rejection: { code: 'crop_out_of_bounds' } });
    const status = await readMediaImportStatus(deps, actor, reserved.value.mediaId, context());
    expect(status).toMatchObject({ media: { state: 'rejected', rejection: { code: 'crop_out_of_bounds' } } });
    const row = await db.admin.query('SELECT decision FROM content.media WHERE route=$1 AND media_id=$2', [
      route,
      reserved.value.mediaId,
    ]);
    expect(row.rows[0]?.decision).toMatch(/^crop_out_of_bounds:/);
  } finally {
    fetchMock.mockRestore();
    expect(globalThis.fetch).toBe(originalFetch);
  }
});

test('the image publication statement stores the imported crop and focal point', async () => {
  const actor = await issue();
  const input: MediaImportRequest = {
    ...request,
    sourceUrl: 'https://images.example.test/published.png',
    crop: 'xywh=100,50,180,220',
    focalPoint: { x: 0.4, y: 0.6 },
    provenance: { ...request.provenance, external_id: 'published-crop' },
  };
  const reserved = await importMediaFromUrl(deps, actor, input, context());
  const bytes = await sharp({ create: { width: 500, height: 400, channels: 3, background: '#2020e0' } })
    .png()
    .toBuffer();
  const originalFetch = globalThis.fetch;
  const fetchMock = spyOn(
    globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
    'fetch',
  ).mockImplementation(async () => new Response(bytes));
  const storage = new MemoryStorage();
  try {
    expect(await processImportedMedia({ ...deps, storage }, reserved.value.mediaId)).toMatchObject({
      state: 'uploaded',
    });
    expect(await processImage(db.pool, storage, reserved.value.mediaId as never)).toMatchObject({ state: 'available' });
    const row = await db.admin.query(
      'SELECT crop,focal_x,focal_y,width,height,state FROM content.media WHERE route=$1 AND media_id=$2',
      [route, reserved.value.mediaId],
    );
    expect(row.rows[0]).toMatchObject({
      crop: [100, 50, 180, 220],
      focal_x: 0.4,
      focal_y: 0.6,
      width: 500,
      height: 400,
      state: 'available',
    });
    const status = await readMediaImportStatus(deps, actor, reserved.value.mediaId, context());
    expect(status).toMatchObject({ media: { crop: input.crop, focalPoint: input.focalPoint, state: 'available' } });
  } finally {
    fetchMock.mockRestore();
    expect(globalThis.fetch).toBe(originalFetch);
  }
});

test('checkGrowth proves rows statements and buffers match declared cost', async () => {
  const report = await checkGrowth(db, {
    name: 'native URL import and exact reservation poll',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    warmups: 1,
    async grow(database, scale, previous) {
      await seed(
        database,
        {
          name: 'unrelated and same-partition media',
          hotPartition: partitionOf(route),
          rows(placement) {
            const id = newId(placement.route);
            return {
              'content.media': [
                {
                  route: placement.route,
                  media_id: id,
                  container_id: newId(placement.route),
                  uploader_id: accountId,
                  reservation_request_id: id,
                  purpose: 'post-image',
                  media_type: 'image/jpeg',
                  byte_count: 128,
                  state: 'reserved',
                  key: `m/${id}/original`,
                  transaction_id: id,
                },
              ],
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    async operation() {
      const actor = await issue();
      const result = await importMediaFromUrl(deps, actor, request, context());
      const status = await readMediaImportStatus(deps, actor, result.value.mediaId, context());
      expect(status?.media.id).toBe(result.value.mediaId);
      expect(checkMediaImportStatus(status)).toEqual([]);
    },
  });
  expect(report.samples).toHaveLength(3);
  expect(report.samples.every((sample) => sample.cost.statements > 0 && sample.cost.blocks > 0)).toBe(true);
});
