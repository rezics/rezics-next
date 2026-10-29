import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import sharp from 'sharp';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { PublicJwks } from '@rezics/auth';
import { fromPlainText } from '@rezics/document';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { eraseAccountUploadsPage, type UploadErasureCursor } from '../../src/content/account-erasure-uploads.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { processImage } from '../../src/content/image-job.ts';
import { projectBatch } from '../../src/events/log.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { nativeFixture, cookies, password, issuer } from '../access/native-account-bindings-fixture.ts';
import { createPersonas, type Persona } from '../support/personas.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { testKernel } from '../support/test-kernel.ts';
import { productionActions } from '../support/production-actions.ts';
import { checkGrowth, openGrowthDatabase, seed } from '../support/growth.ts';

setDefaultTimeout(180_000);
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let app: ReturnType<typeof testKernel>;
let personas: Awaited<ReturnType<typeof createPersonas>>;
let websiteKey: Awaited<ReturnType<typeof generateKeyPair>>;
let png: Buffer;
const objects = new Map<string, Uint8Array>();
const storage: MediaStorage = {
  async get(key) {
    return objects.get(key) ?? null;
  },
  async put(key, bytes) {
    objects.set(key, bytes);
  },
  async deletePrefix(prefix) {
    for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key);
  },
};
const options = () => ({ version: 1 as const, pool: db.pool, auth });
async function call(persona: Persona | null, method: string, path: string, body?: unknown) {
  return app.handle(
    new Request(`https://ordinary.api.test${path}`, {
      method,
      headers: {
        ...(persona ? { authorization: `Bearer ${persona.bearer}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function ok(persona: Persona | null, method: string, path: string, body?: unknown, status = 201) {
  const response = await call(persona, method, path, body);
  const value = await response.json();
  expect({ status: response.status, ...(response.status === status ? {} : { body: value }) }).toEqual({ status });
  return value;
}
async function grant(persona: Persona, id: string, actions: string[]) {
  await ok(personas.staff, 'POST', '/v1/grants', {
    resource: { route: routeOf(id), id },
    subject: { kind: 'account', id: persona.accountId },
    actions,
    valid: '(,)',
  });
}
async function website(persona: Persona): Promise<Persona> {
  const actions = [...productionActions().keys()];
  const scopes = ['openid', 'offline_access', ...actions];
  const signed = await auth.request('/signin', {
    account_id: persona.accountId,
    password,
    client_id: 'uploads-login',
    scope: actions.filter((a) => a !== 'media:complete'),
  });
  expect(signed.status).toBe(200);
  const verifier = randomBytes(48).toString('base64url');
  const callback = `${issuer}/uploads/callback`;
  const url = new URL(`${issuer}/authorize`);
  url.search = new URLSearchParams({
    client_id: 'rezics-website',
    redirect_uri: callback,
    response_type: 'code',
    scope: scopes.join(' '),
    state: verifier,
    nonce: verifier,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: 'https://ordinary.api.test',
  }).toString();
  const approved = await auth.host.service.handler(new Request(url, { headers: cookies(signed) }));
  expect([302, 303]).toContain(approved.status);
  const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'uploads-website' })
    .setIssuer('rezics-website')
    .setSubject('rezics-website')
    .setAudience(issuer)
    .setIssuedAt()
    .setExpirationTime('2m')
    .setJti(crypto.randomUUID())
    .sign(websiteKey.privateKey);
  const token = await auth.host.service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'rezics-website',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback,
        code_verifier: verifier,
        resource: 'https://ordinary.api.test',
      }),
    }),
  );
  const value = await token.json();
  expect({ status: token.status, ...(token.ok ? {} : { body: value }) }).toEqual({ status: 200 });
  return { accountId: persona.accountId, bearer: value.access_token };
}
async function flush() {
  // Apply the actual producing outbox events through the same released projection boundary.
  const { createAccountUploadIndexEffect } = await import('../../src/content/account-erasure-uploads.ts');
  const effect = createAccountUploadIndexEffect(db.pool);
  const partitions = (await db.admin.query('SELECT partition_no FROM core.partition WHERE position > 0')).rows;
  for (const { partition_no } of partitions) {
    for (;;) {
      const result = await projectBatch(db.pool, {
        consumer: 'effects',
        partition: partition_no,
        apply: async (envelopes) => {
          for (const envelope of envelopes)
            for (const event of envelope.events) if (effect.types.includes(event.type)) await effect.run(event);
        },
      });
      if (result.status === 'read' && result.envelopes === 0) break;
      // projectBatch returns the count of consumed envelopes.
      const state = await db.admin.query(
        `SELECT p.position=c.position AS caught_up FROM core.partition p
        JOIN core.consumer_checkpoint c ON c.partition_no=p.partition_no AND c.consumer='effects'
        WHERE p.partition_no=$1`,
        [partition_no],
      );
      if (state.rows[0]?.caught_up) break;
    }
    await drainEffects(db.pool, partition_no);
  }
}
async function eraseAll(persona: Persona) {
  await deletePersona(options(), persona);
  await flush();
  let cursor: UploadErasureCursor | null = null;
  let found = 0;
  do {
    const result = await eraseAccountUploadsPage({ pool: db.pool, storage }, persona.accountId, cursor);
    expect(result.found).toBeLessThanOrEqual(50);
    expect(result.pending).toBe(0);
    found += result.found;
    cursor = result.next;
  } while (cursor);
  return found;
}
async function field(persona: Persona, name: string) {
  const created = await ok(persona, 'POST', '/v1/subjects', {
    type: 'schema:Recipe',
    labels: { en: name },
    statements: {
      'schema:abstract': [
        {
          property: { id: 'schema:abstract' },
          value: {
            type: 'value',
            content: {
              document: fromPlainText(name),
              licence: 'CC-BY-4.0',
              language: 'en',
            },
          },
          references: [
            {
              parts: [
                { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/recipe' } },
              ],
            },
          ],
        },
      ],
    },
  });
  const id = created.subject.id;
  const row = (
    await db.admin.query('SELECT id,candidate FROM content.authored_field WHERE route=$1 AND subject=$2', [
      routeOf(id),
      id,
    ])
  ).rows[0]!;
  expect(row.candidate).toBe(created.subject.statements['schema:abstract'][0].id);
  expect((await call(null, 'GET', `/v1/documents/${row.id}`)).status).toBe(200);
  return { ...row, subject: id } as { id: string; candidate: string; subject: string };
}
async function thread(persona: Persona) {
  const concept = (
    await ok(personas.staff, 'POST', '/v1/subjects', { type: 'skos:Concept', labels: { en: 'Upload erasure board' } })
  ).subject.id;
  const board = (
    await ok(personas.staff, 'POST', '/v1/boards', {
      conceptId: concept,
      title: 'Uploads',
      purpose: 'discussion',
      visibility: 'published',
    })
  ).board.id;
  await grant(persona, board, ['thread:create']);
  return (
    await ok(persona, 'POST', '/v1/threads', {
      boardId: board,
      subjectIds: [],
      title: 'Uploads',
      body: fromPlainText('Public contribution'),
      licence: 'CC0-1.0',
      visibility: 'published',
    })
  ).thread;
}
async function media(persona: Persona, containerId: string, purpose = 'post-image', complete = true) {
  const reservation = await ok(persona, 'POST', '/v1/media', {
    containerId,
    purpose,
    mediaType: 'image/png',
    byteCount: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
  });
  const id = reservation.media.id as string;
  objects.set(`m/${id}/original`, png);
  if (complete) {
    await ok(
      persona,
      'POST',
      `/v1/media/${id}:complete`,
      {
        containerId,
        reservationRequestId: reservation.media.reservationRequestId,
        byteCount: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
      },
      200,
    );
    await processImage(db.pool, storage, id);
  }
  return id;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await bootstrapRelease(db.pool, bundledRelease);
  auth = await nativeFixture(db.pool, undefined, undefined);
  app = testKernel({
    pool: db.pool,
    auth: {
      ...auth.host.service.verifier,
      fetch: (input, init) => auth.host.service.handler(new Request(input, init)),
    },
    writeRate: createWriteRateLimiter({
      secret: 'uploads-http-test-write-rate-secret-32-bytes',
      overrides: JSON.stringify({
        'new-account': {
          write: { maximum: 100000, seconds: 86400 },
          upload: { maximum: 10000, seconds: 86400 },
        },
      }),
    }),
  });
  personas = await createPersonas(app, options());
  for (const action of ['subject:create', 'board:create']) {
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES ($1,$2,$3,$4,'(,)'::tstzrange,$3) ON CONFLICT DO NOTHING`,
      [routeOf(GLOBAL_CONTEXT), GLOBAL_CONTEXT, personas.staff.accountId, action],
    );
  }
  for (const persona of [personas.alice, personas.bob, personas.orgOwner]) {
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES ($1,$2,$2,'media:create','(,)'::tstzrange,$2) ON CONFLICT DO NOTHING`,
      [routeOf(persona.accountId), persona.accountId],
    );
  }
  for (const persona of [personas.bob, personas.orgOwner]) {
    await grant(persona, GLOBAL_CONTEXT, ['subject:create', 'statement:propose']);
  }
  websiteKey = await generateKeyPair('ES256', { extractable: true });
  const scopes = [...productionActions().keys()];
  await auth.host.service.internal.registerClient({
    clientId: 'uploads-login',
    firstParty: true,
    scopes: scopes.filter((a) => a !== 'media:complete'),
  });
  await auth.host.service.internal.registerWebsiteClient({
    publicJwks: {
      keys: [{ ...(await exportJWK(websiteKey.publicKey)), kid: 'uploads-website', alg: 'ES256', use: 'sig' }],
    } as PublicJwks,
    redirectUris: [`${issuer}/uploads/callback`],
    postLogoutRedirectUris: [`${issuer}/`],
    scopes: ['openid', 'offline_access', ...scopes],
  });
  png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
});
afterAll(async () => {
  await auth?.close();
  await db?.close();
});

test("account erasure erases the account's avatar, standalone and unclaimed media with their stored objects and keeps media of a retained public post", async () => {
  const owner = await website(personas.alice);
  const other = await website(personas.bob);
  const post = await thread(owner);
  const avatar = await media(owner, owner.accountId, 'avatar');
  const standalone = await media(owner, post.id);
  const reserved = await media(owner, post.id, 'post-image', false);
  const retained = await media(owner, post.id);
  await ok(owner, 'POST', `/v1/threads/${post.id}/posts`, {
    body: fromPlainText('Image'),
    mediaIds: [retained],
    licence: 'CC0-1.0',
  });
  const otherMedia = await media(other, other.accountId, 'avatar');
  await flush();
  const before = (
    await db.admin.query('SELECT * FROM content.media WHERE route=$1 AND media_id=$2', [
      routeOf(otherMedia),
      otherMedia,
    ])
  ).rows;
  expect(await eraseAll(personas.alice)).toBe(4);
  for (const id of [avatar, standalone, reserved]) {
    expect(
      (await db.admin.query('SELECT erased FROM content.media WHERE route=$1 AND media_id=$2', [routeOf(id), id]))
        .rows[0],
    ).toEqual({ erased: true });
    expect([...objects.keys()].some((key) => key.startsWith(`m/${id}/`))).toBe(false);
  }
  expect((await call(null, 'GET', `/v1/media/${retained}:authorizeDownload?variant=webp-32`)).status).toBe(200);
  expect([...objects.keys()].some((key) => key.startsWith(`m/${retained}/`))).toBe(true);
  expect(
    (
      await db.admin.query('SELECT * FROM content.media WHERE route=$1 AND media_id=$2', [
        routeOf(otherMedia),
        otherMedia,
      ])
    ).rows,
  ).toEqual(before);
  const revisions = (
    await db.admin.query(
      'SELECT media_id,security_revision FROM content.media WHERE uploader_id=$1 ORDER BY media_id',
      [owner.accountId],
    )
  ).rows;
  await eraseAccountUploadsPage({ pool: db.pool, storage }, owner.accountId, null);
  expect(
    (
      await db.admin.query(
        'SELECT media_id,security_revision FROM content.media WHERE uploader_id=$1 ORDER BY media_id',
        [owner.accountId],
      )
    ).rows,
  ).toEqual(revisions);
});

test("account erasure keeps the account's authored fields an anonymous reader is served and erases its other authored fields", async () => {
  const kept = await field(personas.bob, 'Public field');
  const hidden = await field(personas.bob, 'Hidden candidate');
  await ok(
    personas.staff,
    'POST',
    `/v1/subjects/${hidden.subject}/candidates/${hidden.candidate}:hide`,
    { reason: 'Undisclosed field' },
    200,
  );
  expect((await call(null, 'GET', `/v1/documents/${hidden.id}`)).status).toBe(404);
  await eraseAll(personas.bob);
  expect((await ok(null, 'GET', `/v1/documents/${kept.id}`, undefined, 200)).document.author).toBe(
    personas.bob.accountId,
  );
  expect(
    (
      await db.admin.query(
        'SELECT availability,body,author_account_id FROM content.authored_field WHERE route=$1 AND id=$2',
        [routeOf(hidden.id), hidden.id],
      )
    ).rows[0],
  ).toEqual({ availability: 'erased', body: null, author_account_id: personas.bob.accountId });
});

test("an account upload and field erasure page stays within its bound as other uploaders' media and other authors' fields grow", async () => {
  const owner = personas.orgOwner;
  await field(owner, 'Growth field');
  const web = await website(owner);
  const post = await thread(web);
  const retained = await media(web, post.id);
  await ok(web, 'POST', `/v1/threads/${post.id}/posts`, {
    body: fromPlainText('Retained growth image'),
    mediaIds: [retained],
    licence: 'CC0-1.0',
  });
  await deletePersona(options(), owner);
  await flush();
  const body = Buffer.from(JSON.stringify(fromPlainText('Other author')));
  const report = await checkGrowth(db, {
    name: "an account upload and field erasure page stays within its bound as other uploaders' media and other authors' fields grow",
    rule: 'series',
    scales: [256, 1024, 4096],
    warmups: 1,
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(target, scale, previous) {
      await seed(
        target,
        {
          name: 'other uploads and fields',
          hotPartition: partitionOf(routeOf(owner.accountId)!),
          hotShare: 1,
          rows: ({ route }) => {
            const accountId = newId(route),
              id = newId(route),
              doc = newId(route);
            return {
              'content.media': [
                {
                  route,
                  media_id: id,
                  container_id: accountId,
                  uploader_id: accountId,
                  reservation_request_id: id,
                  purpose: 'avatar',
                  media_type: 'image/png',
                  byte_count: 1,
                  state: 'reserved',
                  key: `m/${id}/original`,
                  transaction_id: id,
                },
              ],
              'content.authored_field': [
                {
                  route,
                  id: doc,
                  subject: newId(route),
                  candidate: newId(route),
                  revision: 1,
                  author_account_id: accountId,
                  body,
                  body_sha256: createHash('sha256').update(body).digest(),
                  licence: 'CC0-1.0',
                  language: 'en',
                  availability: 'available',
                },
              ],
              'content.account_upload': [
                { route, account_id: accountId, phase: 'media', id },
                { route, account_id: accountId, phase: 'fields', id: doc },
              ],
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    async operation() {
      const mediaPage = await eraseAccountUploadsPage({ pool: db.pool, storage }, owner.accountId, null);
      expect(mediaPage.found).toBe(1);
      const fieldPage = await eraseAccountUploadsPage({ pool: db.pool, storage }, owner.accountId, {
        phase: 'fields',
        after: null,
      });
      expect(fieldPage.found).toBe(1);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
});
