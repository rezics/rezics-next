import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { createNativePrivateAttachmentFixture } from './native-private-attachment-fixture.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

setDefaultTimeout(600_000);

let originalImage: Buffer;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type NativeAttachment = {
  id: string;
  state: string;
  byteCount: number;
  sha256: string | null;
  containerId: string;
  uploaderId: string;
  reservationRequestId: string;
};

type ProblemBody = { request_id?: string; [key: string]: unknown };

async function downloadOutcome(response: {
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
}) {
  const bytes = await response.body();
  const contentType = response.headers()['content-type'] ?? null;
  if (contentType?.includes('json')) {
    let problem: ProblemBody;
    try {
      problem = JSON.parse(bytes.toString('utf8')) as ProblemBody;
    } catch {
      problem = { detail: bytes.toString('utf8') };
    }
    delete problem.request_id;
    return { status: response.status(), contentType, problem };
  }
  return { status: response.status(), contentType, byteCount: bytes.byteLength, sha256: sha256(bytes) };
}

async function expectVisible(
  locator: { waitFor: (options: { state: 'visible'; timeout: number }) => Promise<void> },
  timeout = 15_000,
) {
  await locator.waitFor({ state: 'visible', timeout });
}

async function waitForAvailableMedia(stack: NativeWebStack, id: string): Promise<NativeAttachment> {
  const deadline = Date.now() + 60_000;
  let lastState = 'unknown';
  while (Date.now() < deadline) {
    const response = await stack.kernel(`/v1/media/${id}`, undefined, 'alice');
    if (!response.ok)
      throw new Error(`Native media read failed while waiting for image processing (${response.status})`);
    const media = ((await response.json()) as { media: NativeAttachment }).media;
    lastState = media.state;
    if (media.state === 'available') return media;
    if (media.state === 'rejected' || media.state === 'erased')
      throw new Error(`Native image processing ended in ${media.state}`);
    await Bun.sleep(250);
  }
  throw new Error(`Native image processing did not become available within 60 seconds (last state: ${lastState})`);
}

function jwtClaims(authorization: string | null): Record<string, unknown> {
  const token = authorization?.match(/^Bearer [^.]+\.([^.]+)\./)?.[1];
  if (!token) throw new Error('Worker did not use a bearer token for the native media request');
  return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function downloadAuthorizations(stack: NativeWebStack, mediaId: string) {
  return stack
    .kernelRequests()
    .filter(({ method, url }) => method === 'GET' && url.startsWith(`/v1/media/${mediaId}:authorizeDownload`));
}

describe('native private attachment flow', () => {
  let stack: NativeWebStack;
  let auth: NativeAuthStack;
  let fixture: Awaited<ReturnType<typeof createNativePrivateAttachmentFixture>>;

  beforeAll(async () => {
    originalImage = await readFile(resolve(import.meta.dir, '../../public/cards/default.png'));
    stack = await startNativeWebStack();
    auth = await startAuthStack(stack);
    fixture = await createNativePrivateAttachmentFixture(stack);
    console.info(
      'native-private-attachment-growth: served-product-path-changed=false owner-evidence=apps/web/tests/new-thread-media-cost.test.ts',
    );
  });

  afterAll(async () => {
    await auth?.stop();
    await stack?.stop();
  });

  test('served composer publishes a private image and every download uses current native authorization', async () => {
    const alice = await auth.signIn('alice');
    expect((await alice.requestHeaders()).some((headers) => headers.has('authorization'))).toBe(false);
    const page = alice.context.pages()[0]!;
    const browserResponses: { path: string; method: string; status: number }[] = [];
    const credentialHeaderReads: Promise<Headers>[] = [];
    page.on('requestfinished', (request) => {
      const url = new URL(request.url());
      if (
        url.origin === stack.web &&
        (url.pathname === '/media' || url.pathname.startsWith('/media/') || url.pathname.startsWith('/_serverFn/'))
      )
        credentialHeaderReads.push(request.allHeaders().then((headers) => new Headers(headers)));
    });
    page.on('response', (response) => {
      browserResponses.push({
        path: new URL(response.url()).pathname,
        method: response.request().method(),
        status: response.status(),
      });
    });

    await page.goto(fixture.threadUrl, { waitUntil: 'domcontentloaded' });
    await expectVisible(page.getByRole('heading', { name: fixture.threadTitle }));
    const editor = page.locator('.ProseMirror[contenteditable="true"]').last();
    await expectVisible(editor);
    await editor.fill('A private image from Alice.');

    const reservationResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/media' && response.request().method() === 'POST',
    );
    const uploadResponsePromise = page.waitForResponse(
      (response) => /^\/media\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Image', exact: true }).click();
    await page.getByLabel('Choose image file', { exact: true }).setInputFiles({
      name: 'private-image.png',
      mimeType: 'image/png',
      buffer: originalImage,
    });
    await page.getByLabel('Alt text', { exact: true }).fill('A tiny test image');
    await page.getByRole('button', { name: 'Insert image', exact: true }).click();

    const reserved = await reservationResponse;
    expect(reserved.status()).toBe(201);
    const reservation = (await reserved.json()) as { media: NativeAttachment };
    const mediaId = reservation.media.id;
    const uploadResponse = await uploadResponsePromise;
    expect(new URL(uploadResponse.url()).pathname).toBe(`/media/${mediaId}`);
    expect(uploadResponse.status()).toBe(200);
    await waitForAvailableMedia(stack, mediaId);
    await expectVisible(page.getByRole('img', { name: 'A tiny test image' }));

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const publishedImage = page.locator(`img[src*="${mediaId}"]`).last();
    try {
      await expectVisible(publishedImage, 15_000);
    } catch (cause) {
      const postsRead = await stack.kernel(`/v1/threads/${fixture.threadId}/posts`, undefined, 'alice');
      const posts = postsRead.ok ? ((await postsRead.json()) as { posts: unknown[] }) : undefined;
      const latestWrite = stack
        .kernelRequests()
        .filter(({ method, url }) => method === 'POST' && url === `/v1/threads/${fixture.threadId}/posts`)
        .at(-1);
      const alerts = await page.getByRole('alert').allInnerTexts();
      throw new Error(
        `Served composer did not render the published attachment: url=${page.url()} alerts=${JSON.stringify(alerts)} ` +
          `writeFailure=${JSON.stringify(latestWrite?.failure ?? null)} nativePostCount=${posts?.posts.length ?? 'unavailable'} ` +
          `responses=${JSON.stringify(browserResponses.slice(-8))}`,
        { cause },
      );
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    const renderedImage = page.locator(`img[src*="${mediaId}"]`).last();
    await expectVisible(renderedImage, 30_000);

    await mkdir(resolve(import.meta.dir, '../../../../.temp/native-private-attachment'), { recursive: true });
    await page.screenshot({
      path: resolve(import.meta.dir, '../../../../.temp/native-private-attachment/rendered-thread.png'),
      fullPage: true,
    });
    await page.waitForFunction(
      (selector) => {
        const image = document.querySelector(selector);
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
      },
      `img[src*="${mediaId}"]`,
      { timeout: 15_000 },
    );
    await stack.flushKernelRequests();

    const imagePath = await renderedImage.getAttribute('src');
    expect(imagePath).toBe(`/media/${mediaId}/original`);
    const imageUrl = new URL(imagePath!, stack.web).href;
    const authorizationsBeforeAliceDownload = downloadAuthorizations(stack, mediaId).length;
    const imageResponse = await alice.context.request.get(imageUrl);
    expect(imageResponse.status()).toBe(200);
    expect(new Uint8Array(await imageResponse.body())).toEqual(new Uint8Array(originalImage));
    await stack.flushKernelRequests();
    const authorizationsAfterAliceDownload = downloadAuthorizations(stack, mediaId).length;
    if (authorizationsAfterAliceDownload !== authorizationsBeforeAliceDownload + 1) {
      const mediaRequests = stack
        .kernelRequests()
        .filter(({ url }) => url.includes(mediaId))
        .map(({ method, url }) => `${method} ${url}`);
      throw new Error(
        `Alice's private download did not make one fresh authorization request: before=${authorizationsBeforeAliceDownload} ` +
          `after=${authorizationsAfterAliceDownload} requests=${JSON.stringify(mediaRequests)}`,
      );
    }

    const storedResponse = await stack.kernel(`/v1/media/${mediaId}`, undefined, 'alice');
    expect(storedResponse.status).toBe(200);
    const stored = ((await storedResponse.json()) as { media: NativeAttachment }).media;
    expect(stored).toMatchObject({
      id: mediaId,
      byteCount: originalImage.byteLength,
      sha256: sha256(originalImage),
      containerId: fixture.threadId,
      uploaderId: fixture.aliceAccountId,
      state: 'available',
    });

    const postsResponse = await stack.kernel(`/v1/threads/${fixture.threadId}/posts`, undefined, 'alice');
    expect(postsResponse.status).toBe(200);
    const posts = (await postsResponse.json()) as { posts: { body: { doc: unknown }; mediaIds?: string[] }[] };
    expect(JSON.stringify(posts.posts)).toContain(mediaId);

    const completion = stack
      .kernelRequests()
      .filter((request) => request.url === `/v1/media/${mediaId}:complete` && request.method === 'POST')
      .at(-1);
    expect(completion).toBeDefined();
    const claims = jwtClaims(completion!.authorization);
    expect(claims.sub).toBe(fixture.aliceAccountId);
    expect(claims.client_id).toBe('rezics-website');
    expect(String(claims.scope).split(/\s+/)).toContain('media:complete');
    expect(String(claims.scope).split(/\s+/)).toContain('media:create');
    const reserve = stack
      .kernelRequests()
      .filter((request) => request.url === '/v1/media' && request.method === 'POST')
      .at(-1);
    expect(reserve).toBeDefined();
    const reserveClaims = jwtClaims(reserve!.authorization);
    expect(reserveClaims.sub).toBe(fixture.aliceAccountId);
    expect(reserveClaims.client_id).toBe('rezics-website');
    expect(String(reserveClaims.scope).split(/\s+/)).toContain('media:create');

    const visibleTokenState = await page.evaluate(() => ({
      cookie: document.cookie,
      local: Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
      session: Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
    }));
    expect(JSON.stringify(visibleTokenState)).not.toMatch(/access[_-]?token|refresh[_-]?token|eyJ[A-Za-z0-9_-]+\./i);
    const featureRequestHeaders = await Promise.race([
      Promise.all(credentialHeaderReads),
      Bun.sleep(15_000).then(() => {
        throw new Error('Browser requests for the media flow did not finish before header inspection');
      }),
    ]);
    expect(featureRequestHeaders.some((headers) => headers.has('authorization'))).toBe(false);
    expect(
      browserResponses.filter((response) => response.path.startsWith('/media/')).every(({ status }) => status < 400),
    ).toBe(true);

    const bob = await auth.signIn('bob');
    const authorizationsBeforeDeniedDownloads = downloadAuthorizations(stack, mediaId).length;
    const bobDenied = await bob.context.request.get(imageUrl);
    const anonymousDenied = await fetch(imageUrl);
    const bobOutcome = await downloadOutcome(bobDenied);
    const anonymousOutcome = await downloadOutcome({
      status: () => anonymousDenied.status,
      headers: () => Object.fromEntries(anonymousDenied.headers.entries()),
      body: async () => Buffer.from(await anonymousDenied.arrayBuffer()),
    });
    await stack.flushKernelRequests();
    expect(bobOutcome.status).toBe(404);
    expect(anonymousOutcome).toEqual(bobOutcome);
    expect(downloadAuthorizations(stack, mediaId).length).toBe(authorizationsBeforeDeniedDownloads + 2);

    const bobCompletion = await stack.kernel(
      `/v1/media/${mediaId}:complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(`bob-${mediaId}`) },
        body: JSON.stringify({
          containerId: stored.containerId,
          reservationRequestId: stored.reservationRequestId,
          byteCount: originalImage.byteLength,
          sha256: sha256(originalImage),
        }),
      },
      'bob',
    );
    expect([403, 404]).toContain(bobCompletion.status);

    const bobAttach = await stack.kernel(
      `/v1/threads/${fixture.threadId}/posts`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(`bob-attach-${mediaId}`) },
        body: JSON.stringify({
          body: fromPlainText("Bob cannot attach Alice's reservation."),
          licence: 'LicenseRef-rezics-terms',
          subjectIds: [],
          mediaIds: [mediaId],
        }),
      },
      'bob',
    );
    expect(bobAttach.status).toBe(409);
    expect((await bobAttach.json()).code).toBe('media_unavailable');

    const failureImage = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/media' && response.request().method() === 'POST',
    );
    const failureUploadPromise = page.waitForResponse(
      (response) => /^\/media\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === 'PUT',
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    const failureEditor = page.locator('.ProseMirror[contenteditable="true"]').last();
    await failureEditor.fill('This draft must not publish an erased image.');
    await page.getByRole('button', { name: 'Image', exact: true }).click();
    await page.getByLabel('Choose image file', { exact: true }).setInputFiles({
      name: 'unclaimable-image.png',
      mimeType: 'image/png',
      buffer: originalImage,
    });
    await page.getByLabel('Alt text', { exact: true }).fill('Image that will be removed');
    await page.getByRole('button', { name: 'Insert image', exact: true }).click();
    const unavailableReservation = await failureImage;
    const unavailableId = ((await unavailableReservation.json()) as { media: NativeAttachment }).media.id;
    const failureUpload = await failureUploadPromise;
    expect(new URL(failureUpload.url()).pathname).toBe(`/media/${unavailableId}`);
    expect(failureUpload.status()).toBe(200);
    await waitForAvailableMedia(stack, unavailableId);
    await expectVisible(page.getByRole('img', { name: 'Image that will be removed' }));
    const erased = await stack.kernel(
      `/v1/media/${unavailableId}`,
      { method: 'DELETE', headers: { 'idempotency-key': JSON.stringify(`erase-${unavailableId}`) } },
      'alice',
    );
    expect(erased.status).toBe(204);

    const beforeFailure = posts.posts.length;
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expectVisible(page.getByRole('alert').filter({ hasText: 'An image in this draft cannot be used yet.' }));
    await expectVisible(page.getByRole('alert').filter({ hasText: 'This image can no longer be used.' }));
    await expectVisible(page.getByRole('button', { name: 'Try again', exact: true }));
    await expectVisible(page.getByRole('button', { name: 'Remove image', exact: true }));
    const failedPublish = stack
      .kernelRequests()
      .filter((request) => request.method === 'POST' && request.url === `/v1/threads/${fixture.threadId}/posts`)
      .at(-1);
    expect(failedPublish?.failure?.status).toBe(409);
    expect(JSON.parse(failedPublish!.failure!.body).code).toBe('media_unavailable');
    const erasedMediaResponse = await stack.kernel(`/v1/media/${unavailableId}`, undefined, 'alice');
    expect(erasedMediaResponse.status).toBe(200);
    expect(((await erasedMediaResponse.json()) as { media: { state: string } }).media.state).toBe('erased');
    const afterFailureResponse = await stack.kernel(`/v1/threads/${fixture.threadId}/posts`, undefined, 'alice');
    expect(afterFailureResponse.status).toBe(200);
    const afterFailure = (await afterFailureResponse.json()) as { posts: unknown[] };
    expect(afterFailure.posts).toHaveLength(beforeFailure);
    await page.getByRole('button', { name: 'Remove image', exact: true }).click();
    expect(await page.getByRole('img', { name: 'Image that will be removed' }).count()).toBe(0);

    await fixture.revokeAliceRealmRead();
    const revokedRealmRead = await stack.kernel(`/v1/realms/${fixture.realmId}`, undefined, 'alice');
    expect(revokedRealmRead.status).toBe(404);
    const authorizationsBeforeRevokedDownload = downloadAuthorizations(stack, mediaId).length;
    const revokedAliceDownload = await alice.context.request.get(imageUrl);
    const revokedDownloadOutcome = await downloadOutcome(revokedAliceDownload);
    await stack.flushKernelRequests();
    expect(downloadAuthorizations(stack, mediaId).length).toBe(authorizationsBeforeRevokedDownload + 1);

    await fixture.restoreAliceRealmRead();
    const directRealmRead = await stack.kernel(`/v1/realms/${fixture.realmId}`, undefined, 'alice');
    expect(directRealmRead.status).toBe(200);
    await fixture.banAlice();
    const authorizationsBeforeBanDenial = downloadAuthorizations(stack, mediaId).length;
    const bannedAliceDenied = await alice.context.request.get(imageUrl);
    const bannedDownloadOutcome = await downloadOutcome(bannedAliceDenied);
    await stack.flushKernelRequests();
    expect(downloadAuthorizations(stack, mediaId).length).toBe(authorizationsBeforeBanDenial + 1);
    const bannedRealmRead = await stack.kernel(`/v1/realms/${fixture.realmId}`, undefined, 'alice');
    expect(bannedRealmRead.status).toBe(404);

    const authorizationDecisions = downloadAuthorizations(stack, mediaId)
      .slice(-2)
      .map((request) => ({
        method: request.method,
        url: request.url,
        response: request.authorizationDecision,
      }));
    expect(
      {
        permissionRevoked: revokedDownloadOutcome,
        realmBanned: bannedDownloadOutcome,
        nativeAuthorizationDecisions: authorizationDecisions,
      },
      `Expected current Realm permission revocation and ban to deny the same URL; native authorization evidence: ${JSON.stringify(authorizationDecisions)}`,
    ).toEqual({
      permissionRevoked: bobOutcome,
      realmBanned: bobOutcome,
      nativeAuthorizationDecisions: authorizationDecisions.map((decision) => ({
        method: 'GET',
        url: `/v1/media/${mediaId}:authorizeDownload?variant=original`,
        response: { status: 404, body: expect.stringContaining('not_found') },
      })),
    });
  });
});
