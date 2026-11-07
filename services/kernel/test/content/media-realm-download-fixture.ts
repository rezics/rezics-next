import { randomBytes, createHash } from 'node:crypto';
import { expect } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import sharp from 'sharp';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { threadTarget } from '../../src/content/commands.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import { createMediaStorage } from './support/storage.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf, newId } from '../../src/route/route.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { nativeFixture, cookies, password } from '../access/native-account-bindings-fixture.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { registerTestClient, testKernel, testRouteKey, type TestKernel } from '../support/test-kernel.ts';

const protocolScopes = ['openid', 'offline_access'];
const clientAssertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const issuer = 'https://ordinary.auth.test';
const receiptKey = () => crypto.randomUUID();
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export type MediaRealmPerson = Readonly<{ accountId: string; bearer: string; websiteBearer: string; name: string }>;
export type RealmBoard = Readonly<{ realmId: string; boardId: string; realmVisibility: 'public' | 'protected' }>;
export type NativeImage = Readonly<{
  id: string;
  threadId: string;
  boardId: string;
  reservationRequestId: string;
  bytes: Uint8Array;
  sha256: string;
  variants: readonly Readonly<{
    format: 'webp' | 'avif';
    width: number;
    sha256: string;
    byteCount: number;
    key: string;
  }>[];
}>;

export async function mediaRealmDownloadFixture() {
  const db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const auth = await nativeFixture(db.pool);
  const authConfig = {
    ...auth.host.service.verifier,
    fetch: (url: string | URL, init?: RequestInit) => auth.host.service.handler(new Request(url, init)),
  };
  const rateLimiter = createWriteRateLimiter({
    secret: 'media-realm-download-native-write-rate-secret',
    overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
  });
  const kernel = testKernel({
    pool: db.pool,
    auth: authConfig,
    writeRate: rateLimiter,
  });
  const mutationPool = db.openPool({ max: 4 });
  const mutationKernel = testKernel({
    pool: mutationPool,
    auth: authConfig,
    writeRate: rateLimiter,
  });
  const actions = [...actionCatalogue(kernel).keys()].sort();
  const ordinaryScopes = actions.filter((action) => action !== 'media:complete');
  const ordinaryClientId = `media_realm_${crypto.randomUUID()}`;
  await registerTestClient(auth.host.service, {
    clientId: ordinaryClientId,
    firstParty: true,
    scopes: ordinaryScopes,
  });

  const websiteKeyPair = await generateKeyPair('ES256', { extractable: true });
  const websiteKeyId = `media-realm-${crypto.randomUUID()}`;
  const callback = `${issuer}/media-realm-download/callback`;
  const audience = auth.host.service.verifier.audience;
  const websiteScopes = [...new Set([...protocolScopes, ...actions])].sort();
  const exportedWebsiteKey = await exportJWK(websiteKeyPair.publicKey);
  if (
    exportedWebsiteKey.kty !== 'EC' ||
    exportedWebsiteKey.crv !== 'P-256' ||
    typeof exportedWebsiteKey.x !== 'string' ||
    typeof exportedWebsiteKey.y !== 'string'
  )
    throw new Error('Native media fixture did not create an ES256 public key');
  await auth.host.service.internal.registerWebsiteClient({
    publicJwks: {
      keys: [
        {
          kty: 'EC',
          crv: 'P-256',
          x: exportedWebsiteKey.x,
          y: exportedWebsiteKey.y,
          kid: websiteKeyId,
          alg: 'ES256',
          use: 'sig',
        },
      ],
    },
    redirectUris: [callback],
    postLogoutRedirectUris: [`${issuer}/`],
    scopes: websiteScopes,
  });

  async function tokenRequest(fields: Record<string, string>) {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: websiteKeyId })
      .setIssuer('rezics-website')
      .setSubject('rezics-website')
      .setAudience(issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(randomBytes(24).toString('base64url'))
      .sign(websiteKeyPair.privateKey);
    const form = new URLSearchParams({
      client_id: 'rezics-website',
      client_assertion_type: clientAssertionType,
      client_assertion: assertion,
      resource: audience,
      ...fields,
    });
    const response = await auth.host.service.handler(
      new Request(`${issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { access_token: string; refresh_token: string };
  }

  async function websiteCredential(name: string) {
    const email = `${name}@ordinary.test`;
    const signed = await auth.request('/signin', {
      email,
      password,
      client_id: ordinaryClientId,
      scope: ordinaryScopes,
    });
    expect(signed.status).toBe(200);
    const cookie = cookies(signed).get('cookie');
    if (!cookie) throw new Error('Native Auth sign-in did not return a session cookie');
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const authorize = new URL(`${issuer}/authorize`);
    authorize.search = new URLSearchParams({
      client_id: 'rezics-website',
      redirect_uri: callback,
      response_type: 'code',
      scope: websiteScopes.join(' '),
      state,
      nonce: state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: audience,
    }).toString();
    const authorization = await auth.host.service.handler(new Request(authorize, { headers: { cookie } }));
    if (![302, 303].includes(authorization.status))
      throw new Error(`Website Auth authorization denied (${authorization.status}): ${await authorization.text()}`);
    const location = new URL(authorization.headers.get('location') ?? '');
    if (`${location.origin}${location.pathname}` !== callback || location.searchParams.get('state') !== state)
      throw new Error('Website Auth returned an invalid authorization redirect');
    const code = location.searchParams.get('code');
    if (!code) throw new Error('Website Auth did not return an authorization code');
    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callback,
      code_verifier: verifier,
    });
    return tokens.access_token;
  }

  async function person(role: string): Promise<MediaRealmPerson> {
    const name = `media_${role}_${crypto.randomUUID()}`;
    const registered = await auth.person(name);
    const signed = await auth.request('/signin', {
      email: `${name}@ordinary.test`,
      password,
      client_id: ordinaryClientId,
      scope: ordinaryScopes,
    });
    expect(signed.status).toBe(200);
    const ordinaryToken = await auth.request('/token', {}, cookies(signed));
    expect(ordinaryToken.status).toBe(200);
    const ordinaryBearer = ((await ordinaryToken.json()) as { access_token: string }).access_token;
    const websiteBearer = await websiteCredential(name);
    return {
      accountId: registered.accountId,
      name,
      bearer: ordinaryBearer,
      websiteBearer,
    };
  }

  const governor = await person('governor');
  const alice = await person('alice');
  const bob = await person('bob');
  const outsider = await person('outsider');
  await bootstrapGovernance(db.pool, governor.accountId);
  await bootstrapRelease(db.pool, bundledRelease);

  async function call(
    method: string,
    path: string,
    options: {
      bearer?: string | null;
      body?: unknown;
      key?: string;
      headers?: Record<string, string>;
      kernel?: TestKernel;
    } = {},
  ) {
    const headers = {
      ...(options.bearer === null ? {} : { authorization: `Bearer ${options.bearer ?? governor.bearer}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { [IDEMPOTENCY_HEADER]: JSON.stringify(options.key ?? receiptKey()) }),
      ...options.headers,
    };
    const response = await (options.kernel ?? kernel).handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
    const text = await response.text();
    return { response, value: text ? (JSON.parse(text) as Record<string, any>) : {} };
  }
  async function checked(
    method: string,
    path: string,
    body: unknown,
    expectedStatus = 201,
    options: { bearer?: string | null; key?: string; headers?: Record<string, string>; kernel?: TestKernel } = {},
  ) {
    const result = await call(method, path, { ...options, body });
    expect({
      status: result.response.status,
      ...(result.response.status === expectedStatus ? {} : { path, value: result.value }),
    }).toEqual({ status: expectedStatus });
    return result.value;
  }
  async function grant(accountId: string, resourceId: string, grantActions: readonly string[]) {
    await checked('POST', '/v1/grants', {
      resource: { route: routeOf(resourceId), id: resourceId },
      subject: { kind: 'account', id: accountId },
      actions: [...grantActions],
      valid: '(,)',
    });
  }
  async function allowGrantor(resourceId: string) {
    const route = routeOf(resourceId);
    if (route === null) throw new Error(`Invalid grant resource ${resourceId}`);
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id,subject_kind)
       VALUES ($1,$2,$3,'','access:grant','(,)'::tstzrange,$4,'identity') ON CONFLICT DO NOTHING`,
      [route, resourceId, governor.accountId, newId(route)],
    );
  }
  async function revoke(resourceId: string, accountId: string, grantActions: readonly string[]) {
    return checked(
      'POST',
      '/v1/grants:revoke',
      {
        resource: { route: routeOf(resourceId), id: resourceId },
        subject: { kind: 'account', id: accountId },
        actions: [...grantActions],
        valid: '(,)',
      },
      200,
      { bearer: governor.bearer, kernel: mutationKernel },
    );
  }

  for (const action of ['subject:create', 'space:create', 'realm:create'])
    await grant(governor.accountId, PLATFORM_RESOURCE.id, [action]);
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES (0,$1,$2,'board:create','(,)'::tstzrange,$2) ON CONFLICT DO NOTHING`,
    [GLOBAL_CONTEXT, governor.accountId],
  );

  const scheme = (
    await checked('POST', '/v1/subjects', {
      type: 'skos:ConceptScheme',
      labels: { en: 'Native media Realm scheme' },
    })
  ).subject;
  const concept = (
    await checked('POST', '/v1/subjects', {
      type: 'skos:Concept',
      labels: { en: 'Native media Realm concept' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
      },
    })
  ).subject;

  async function realmBoard(
    realmVisibility: 'public' | 'protected',
    boardVisibility: 'published' | 'protected',
  ): Promise<RealmBoard> {
    const space = (
      await checked('POST', '/v1/spaces', { title: 'Native media Realm space', summary: 'Native media Realm space' })
    ).space;
    const realm = (
      await checked('POST', '/v1/realms', {
        spaceId: space.spaceId,
        title: 'Native media Realm',
        summary: 'Native media Realm download fixture',
        visibility: realmVisibility,
        contextId: GLOBAL_CONTEXT,
      })
    ).realm;
    await checked('PUT', `/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, 200, {
      headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
    });
    const board = (
      await checked('POST', `/v1/realms/${realm.realmId}/boards`, {
        conceptId: concept.id,
        title: 'Native media Realm board',
        visibility: boardVisibility,
      })
    ).board;
    return { realmId: realm.realmId, boardId: board.id, realmVisibility };
  }

  const bytes = Uint8Array.from(
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#b52e64' } })
      .png()
      .toBuffer(),
  );
  const sha256 = digest(bytes);
  const storage = createMediaStorage();
  const imageJob = createImageJob(db.pool, storage.storage);

  async function uploadImage(uploader: MediaRealmPerson, boardId: string, title: string): Promise<NativeImage> {
    const boardRoute = routeOf(boardId);
    if (boardRoute === null) throw new Error(`Invalid native media fixture board ${boardId}`);
    let threadRequestId = receiptKey();
    for (
      let attempt = 0;
      attempt < 100 && threadTarget(testRouteKey(), uploader.accountId, threadRequestId).route === boardRoute;
      attempt++
    )
      threadRequestId = receiptKey();
    const target = threadTarget(testRouteKey(), uploader.accountId, threadRequestId);
    if (target.route === boardRoute) throw new Error('Could not independently route the fixture thread from its board');
    const thread = (
      await checked(
        'POST',
        '/v1/threads',
        {
          boardId,
          title,
          body: fromPlainText(`Native image for ${title}`),
          licence: 'MIT',
          subjectIds: [],
          visibility: 'published',
        },
        201,
        { bearer: uploader.bearer, key: threadRequestId },
      )
    ).thread;
    expect(thread.route).toBe(target.route);
    expect(routeOf(thread.id)).toBe(target.route);
    const reservationRequestId = receiptKey();
    const media = (
      await checked(
        'POST',
        '/v1/media',
        {
          containerId: thread.id,
          purpose: 'post-image',
          mediaType: 'image/png',
          byteCount: bytes.byteLength,
          sha256,
        },
        201,
        { bearer: uploader.websiteBearer, key: reservationRequestId },
      )
    ).media;
    expect(routeOf(media.id)).toBe(routeOf(thread.id));
    await storage.storage.put(media.key, bytes, { mediaType: 'image/png' });
    await checked(
      'POST',
      `/v1/media/${media.id}:complete`,
      {
        containerId: thread.id,
        reservationRequestId,
        byteCount: bytes.byteLength,
        sha256,
      },
      200,
      { bearer: uploader.websiteBearer },
    );
    const processed = await imageJob.process(media.id);
    expect(processed.state).toBe('available');
    expect(processed.variants.length).toBeGreaterThan(0);
    const post = await checked(
      'POST',
      `/v1/threads/${thread.id}/posts`,
      {
        body: fromPlainText(`Claimed native image ${media.id}`),
        licence: 'MIT',
        subjectIds: [],
        mediaIds: [media.id],
      },
      201,
      { bearer: uploader.bearer },
    );
    expect(post.post.id).toBeString();
    const claim = await db.admin.query<{ claimed_at: string | null; claimed_item_id: string | null }>(
      'SELECT claimed_at::text, claimed_item_id::text FROM content.media WHERE route=$1 AND media_id=$2',
      [routeOf(media.id), media.id],
    );
    expect(claim.rows[0]).toMatchObject({ claimed_item_id: post.post.id });
    expect(claim.rows[0]?.claimed_at).toBeString();
    const variants = await db.admin.query<NativeImage['variants'][number]>(
      `SELECT format, width, sha256, byte_count::integer AS "byteCount", key
       FROM content.media_variant WHERE route=$1 AND media_id=$2 ORDER BY format,width`,
      [routeOf(media.id), media.id],
    );
    expect(storage.inspect()).toContainEqual({ key: `m/${media.id}/original`, sha256 });
    return {
      id: media.id,
      threadId: thread.id,
      boardId,
      reservationRequestId,
      bytes,
      sha256,
      variants: variants.rows,
    };
  }

  const protectedRealm = await realmBoard('protected', 'protected');
  await allowGrantor(protectedRealm.realmId);
  await allowGrantor(protectedRealm.boardId);
  await grant(alice.accountId, protectedRealm.realmId, ['realm:read', 'realm:participate']);
  await grant(alice.accountId, protectedRealm.boardId, ['board:read', 'thread:create']);
  const privateImage = await uploadImage(alice, protectedRealm.boardId, 'Protected Realm media post');
  await allowGrantor(privateImage.id);
  await grant(alice.accountId, protectedRealm.boardId, ['board:read']);
  await grant(alice.accountId, privateImage.id, ['media:read']);
  await grant(bob.accountId, protectedRealm.realmId, ['realm:read']);
  await grant(bob.accountId, protectedRealm.boardId, ['board:read']);
  await grant(bob.accountId, privateImage.id, ['media:read']);

  const publicRealm = await realmBoard('public', 'protected');
  await allowGrantor(publicRealm.realmId);
  await allowGrantor(publicRealm.boardId);
  await grant(alice.accountId, publicRealm.boardId, ['board:read', 'thread:create']);
  await grant(alice.accountId, publicRealm.realmId, ['realm:participate']);
  const publicRealmImage = await uploadImage(alice, publicRealm.boardId, 'Public Realm media post');
  await allowGrantor(publicRealmImage.id);
  await grant(bob.accountId, publicRealm.boardId, ['board:read']);
  await grant(bob.accountId, publicRealmImage.id, ['media:read']);

  const globalBoard = (
    await checked('POST', '/v1/boards', {
      conceptId: concept.id,
      title: 'Native global media board',
      visibility: 'published',
    })
  ).board;
  const globalImage = await uploadImage(governor, globalBoard.id, 'Global board media post');

  async function download(
    imageId: string,
    variant: string,
    bearer: string | null,
    headers: Record<string, string> = {},
    through: TestKernel = kernel,
  ) {
    return call('GET', `/v1/media/${imageId}:authorizeDownload?variant=${variant}`, {
      bearer,
      headers,
      kernel: through,
    });
  }
  async function readRealm(realmId: string, bearer: string) {
    return call('GET', `/v1/realms/${realmId}`, { bearer });
  }

  return {
    db,
    auth,
    kernel,
    mutationKernel,
    mutationPool,
    storage,
    governor,
    alice,
    bob,
    outsider,
    protectedRealm,
    publicRealm,
    globalBoardId: globalBoard.id as string,
    privateImage,
    publicRealmImage,
    globalImage,
    call,
    checked,
    grant,
    revoke,
    download,
    readRealm,
    async close() {
      storage.close();
      await mutationPool.end();
      await auth.close();
      await db.close();
    },
  };
}

export function assertAbsentMetadata(value: Record<string, unknown>, privateValues: readonly string[] = []) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/(?:"key"|"sha256"|"digest"|"byteCount"|"byte_count"|"mediaType"|"size")\s*:/i);
  for (const secret of privateValues) if (secret) expect(serialized).not.toContain(secret);
}

export function normalizedProblem(value: Record<string, unknown>) {
  const { request_id: _requestId, requestId: _requestIdCamel, trace_id: _traceId, ...problem } = value;
  return problem;
}
