import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { slug } from '@rezics/definitions/slug';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BrowserContext, ConsoleMessage, Page, Request, Response as PlaywrightResponse } from 'playwright';
import type { NativeWebStack } from './stack.ts';
import { moduleContentType } from './web-document-modules.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const nativeAuthHost = 'auth.native.rezics.com';
const repositoryRoot = resolve(import.meta.dir, '../../../..');

export const nativeAuthPassword = 'semantic outcome registration password with enough entropy';

type SignupReceipt = { email: string; handle: string; accountId: string };

export type NativeAuthIssuerProxy = {
  origin: string;
  webTls: { certificate: string; key: string };
  setUpstream(origin: string): void;
  signupAccountId(email: string, handle: string): Promise<string>;
  stop(): Promise<void>;
};

/** Serve the real Auth listener through a reserved WebAuthn-capable native test origin. */
export async function startNativeAuthIssuerProxy(): Promise<NativeAuthIssuerProxy> {
  await mkdir(join(repositoryRoot, '.temp'), { recursive: true });
  const directory = await mkdtemp(join(repositoryRoot, '.temp', 'native-auth-issuer-'));
  const keyPath = join(directory, 'key.pem');
  const certificatePath = join(directory, 'certificate.pem');
  const generated = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certificatePath,
    '-days',
    '1',
    '-subj',
    `/CN=${nativeAuthHost}`,
    '-addext',
    `subjectAltName=DNS:${nativeAuthHost},DNS:web.native.rezics.com`,
  ]);
  if (generated.exitCode !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`Could not create native Auth TLS certificate: ${generated.stderr.toString()}`);
  }
  let upstreamOrigin: string | undefined;
  const signupReceipts: Promise<SignupReceipt | undefined>[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: await Bun.file(certificatePath).text(), key: await Bun.file(keyPath).text() },
    async fetch(request) {
      if (!upstreamOrigin) return new Response('Native Auth upstream is not ready', { status: 503 });
      const incoming = new URL(request.url);
      const target = new URL(incoming.pathname + incoming.search, upstreamOrigin);
      const forwarded = new Request(target, request);
      forwarded.headers.delete('host');
      if (request.method !== 'POST' || incoming.pathname !== '/signup') return fetch(forwarded, { redirect: 'manual' });

      const identity = forwarded.clone().json().then(
        (body: { email?: unknown; handle?: unknown } | null) => ({ email: body?.email, handle: body?.handle }),
        () => undefined,
      );
      const response = await fetch(forwarded, { redirect: 'manual' });
      if (response.status === 201) {
        // The browser can navigate as soon as it receives this receipt. Read a copy at the issuer boundary.
        const receipt = response.clone().json().then(
          (body: { accountId?: unknown } | null) => body?.accountId,
          () => undefined,
        );
        signupReceipts.push(
          Promise.all([identity, receipt]).then(([submitted, accountId]) => {
            const { email, handle } = submitted ?? {};
            if (typeof email === 'string' && typeof handle === 'string' && typeof accountId === 'string' && accountId)
              return { email, handle, accountId };
          }),
        );
      }
      return response;
    },
  });
  const origin = `https://${nativeAuthHost}:${server.port}`;
  const webTls = {
    certificate: await Bun.file(certificatePath).text(),
    key: await Bun.file(keyPath).text(),
  };
  let stopped: Promise<void> | undefined;
  return {
    origin,
    webTls,
    setUpstream(value) {
      const target = new URL(value);
      if (
        target.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
        target.origin !== value
      )
        throw new Error('Native Auth issuer proxy requires an owned loopback HTTP upstream');
      upstreamOrigin = target.origin;
    },
    async signupAccountId(email, handle) {
      const receipts = await Promise.all(signupReceipts);
      const submitted = receipts.find((receipt) => receipt?.email === email && receipt.handle === handle);
      if (!submitted) throw new Error('Native Auth did not return a valid signup receipt for the submitted account');
      return submitted.accountId;
    },
    stop() {
      return (stopped ??= (async () => {
        server.stop(true);
        await rm(directory, { recursive: true, force: true });
      })());
    },
  };
}

export type NativeAuthSecurityFixture = {
  accountIds: { alice: string; bob: string };
  book: { id: string; title: string; path: string; planned: { id: string; label: string } };
  libraryTarget: string;
};

function accountIdFromAuthorization(authorization: string): string {
  const token = authorization.match(/^Bearer ([^.]+)\.([^.]+)\./)?.[2];
  if (!token) throw new Error('Native fixture account did not receive a bearer token');
  const claims = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { sub?: unknown };
  if (typeof claims.sub !== 'string' || !/^[0-9a-f-]{36}$/.test(claims.sub))
    throw new Error('Native fixture bearer did not identify its account');
  return claims.sub;
}

async function required(response: Response, operation: string): Promise<Response> {
  if (!response.ok) throw new Error(`${operation} failed: ${response.status} ${await response.text()}`);
  return response;
}

/** Prepare one public Book and Alice's scoped admission to its private Library action. */
export async function provisionNativeAuthSecurityFixture(stack: NativeWebStack): Promise<NativeAuthSecurityFixture> {
  const bookType = 'schema:Book';
  const profileId = bundledRelease.types[bookType]?.library?.profileId;
  const planned = profileId
    ? bundledRelease.libraryProfiles[profileId]?.entryStateSet?.states.find(({ role }) => role === 'planned')
    : undefined;
  const plannedLabel = planned?.labels.en;
  if (!planned || !plannedLabel) throw new Error('Bundled Book Library profile lacks an English planned state');
  const active = (await required(await stack.kernel('/v1/definitions/active'), 'Read active definitions')) as Response;
  const activeDigest = ((await active.json()) as { digest?: unknown }).digest;
  if (activeDigest !== bundledDigest)
    throw new Error(`Native stack release mismatch: expected ${bundledDigest}, received ${String(activeDigest)}`);

  const [alice, bob] = await Promise.all([stack.authPersona('alice'), stack.authPersona('bob')]);
  await required(
    await stack.kernel(
      '/v1/grants',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        body: JSON.stringify({
          resource: { route: 0, id: globalContext },
          subject: { kind: 'account', id: alice.accountId },
          actions: ['gate:personal_library'],
          valid: '(,)',
        }),
      },
      'governor',
    ),
    'Admit Alice to the private Subject Library entry',
  );
  const writerAuthorization = await stack.credentials('native-auth-security-writer');
  const writerId = accountIdFromAuthorization(writerAuthorization.authorization);
  const grantKey = crypto.randomUUID();
  await required(
    await stack.kernel(
      '/v1/grants',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(grantKey) },
        body: JSON.stringify({
          resource: { route: 0, id: globalContext },
          subject: { kind: 'account', id: writerId },
          actions: ['subject:create', 'subject:batch_write'],
          valid: '(,)',
        }),
      },
      'governor',
    ),
    'Grant the fixture writer released catalogue creation',
  );

  const title = 'Native Auth security catalogue subject';
  const externalId = crypto.randomUUID();
  const created = await required(
    await stack.kernel(
      '/v1/subjects:batchWrite',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commands: [
            {
              op: 'create',
              key: externalId,
              source: {
                source: 'native-auth-security-fixture',
                external_id: externalId,
                record_revision: '1',
                digest: '0'.repeat(64),
                converter_revision: 'native-auth-security-fixture@1',
                field_group: 'facts',
              },
              subject: { type: bookType, labels: { en: title } },
            },
          ],
        }),
      },
      'native-auth-security-writer',
    ),
    'Create the released catalogue subject',
  );
  const result = (await created.json()) as {
    results?: { key?: string; status?: number; value?: { id?: string }; problem?: unknown }[];
  };
  const subject = result.results?.[0];
  if (subject?.key !== externalId || subject.status !== 201 || !subject.value?.id)
    throw new Error(`Catalogue API did not create the fixture subject: ${JSON.stringify(subject?.problem ?? result)}`);

  const subjectRead = await required(
    await stack.kernel(`/v1/subjects/${encodeURIComponent(subject.value.id)}`),
    'Read the created catalogue subject independently',
  );
  if (((await subjectRead.json()) as { subject?: { id?: string } }).subject?.id !== subject.value.id)
    throw new Error('The native subject read did not return the created catalogue identity');

  return {
    accountIds: { alice: alice.accountId, bob: bob.accountId },
    book: {
      id: subject.value.id,
      title,
      path: `/en/subjects/${encodeURIComponent(subject.value.id)}/${slug(title)}`,
      planned: { id: planned.id, label: plannedLabel },
    },
    libraryTarget: '/en/library?from=served-auth&empty=',
  };
}

export function navigationUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) urls.push(request.url());
  });
  return urls;
}

export function observePasskeySignInOptions(page: Page, issuer: string): PlaywrightResponse[] {
  const responses: PlaywrightResponse[] = [];
  page.on('response', (response) => {
    const { origin, pathname } = new URL(response.url());
    if (origin === issuer && pathname === '/signin/passkey/options' && response.request().method() === 'POST')
      responses.push(response);
  });
  return responses;
}

export async function visitLibrarySignIn(page: Page, stack: NativeWebStack, returnTo: string): Promise<void> {
  const target = `${stack.web}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`;
  const webOrigin = new URL(stack.web).origin;
  const issuerOrigin = new URL(stack.issuerOrigin).origin;
  const returnPath = new URL(returnTo, webOrigin).pathname;
  const route = ({ origin, pathname }: URL) => {
    if (origin === webOrigin) {
      if (pathname === '/auth/sign-in' || pathname === '/auth/callback') return pathname;
      return pathname === returnPath ? 'website-return' : 'website-other';
    }
    if (origin !== issuerOrigin) return 'outside';
    return ['/authorize', '/login', '/consent'].includes(pathname) ? pathname : 'issuer-other';
  };
  const module = ({ origin, pathname }: URL) => {
    const site = origin === issuerOrigin ? 'issuer' : origin === webOrigin ? 'website' : 'outside';
    if (site === 'outside') return site;
    if (pathname === '/__native-turnstile.js') return `${site}-turnstile`;
    if (pathname.startsWith('/@vite/') || pathname === '/@react-refresh') return `${site}-dev-client`;
    if (pathname.startsWith('/src/')) return `${site}-source`;
    if (pathname.startsWith('/auth-assets/') || pathname.startsWith('/assets/')) return `${site}-asset`;
    return `${site}-dependency`;
  };
  type Transfer = { category: string; status?: number; mime?: string; failure?: string };
  const documents: Transfer[] = [];
  const scripts = { requested: 0, finished: 0, failed: 0, aborted: 0 };
  const failures = new Map<string, Transfer>();
  const browserErrors = new Set<string>();
  const requests = new WeakMap<Request, Transfer>();
  const recordFailure = (details: Transfer) => {
    if (failures.size < 8) failures.set(JSON.stringify(details), { ...details });
  };
  const onRequest = (request: Request) => {
    const type = request.resourceType();
    if (type !== 'document' && type !== 'script') return;
    if (request.serviceWorker() || request.frame() !== page.mainFrame()) return;
    const url = new URL(request.url());
    const details = { category: type === 'document' ? route(url) : module(url) };
    requests.set(request, details);
    if (type === 'script') scripts.requested++;
    else if (documents.length < 8) documents.push(details);
  };
  const onResponse = (response: PlaywrightResponse) => {
    const request = response.request();
    const details = requests.get(request);
    if (!details) return;
    details.status = response.status();
    details.mime = moduleContentType(response.headers()['content-type']);
    if (
      request.resourceType() === 'script' &&
      (details.status >= 400 || (details.status < 300 && details.mime !== 'javascript'))
    )
      recordFailure(details);
  };
  const onFinished = (request: Request) => {
    if (requests.has(request) && request.resourceType() === 'script') scripts.finished++;
  };
  const onFailure = (request: Request) => {
    const details = requests.get(request);
    if (!details) return;
    const reason = request.failure()?.errorText ?? '';
    details.failure = /^net::ERR_[A-Z0-9_]{1,40}$/u.test(reason) ? reason : 'request-failed';
    if (request.resourceType() === 'script') {
      scripts.failed++;
      if (details.failure === 'net::ERR_ABORTED') scripts.aborted++;
      recordFailure(details);
    }
  };
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    if (/mime type/iu.test(message.text())) browserErrors.add('script-mime');
    if (/content security policy/iu.test(message.text())) browserErrors.add('script-policy');
  };
  const onPageError = ({ message }: Error) => {
    if (/dynamically imported module|module script/iu.test(message)) browserErrors.add('module-load');
    else if (/hydrat/iu.test(message)) browserErrors.add('hydration');
    else browserErrors.add('page-error');
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailure);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  let phase = 'navigation';
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    phase = 'hydration';
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  } catch (error) {
    const outcome = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'failed';
    const evidence = {
      currentRoute: route(new URL(page.url())),
      documents,
      scripts,
      failures: [...failures.values()],
      browserErrors: [...browserErrors],
    };
    throw new Error(`Native browser sign-in ${phase} ${outcome} ${JSON.stringify(evidence)}`);
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailure);
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
}

export async function submitPasswordSignIn(
  page: Page,
  identity: { email: string; password: string },
  target: string,
): Promise<PlaywrightResponse> {
  await page.getByLabel(/email/i).fill(identity.email);
  await page.locator('input[name="password"]').fill(identity.password);
  const response = page.waitForResponse(
    (item) => new URL(item.url()).pathname === '/signin' && item.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const submitted = await response;
  await page.waitForURL((url) => `${url.pathname}${url.search}` === target, { timeout: 30_000 });
  return submitted;
}

export function exactCookie(context: BrowserContext, origin: string, name: string) {
  return context.cookies(origin).then((cookies) => cookies.find((cookie) => cookie.name === name));
}
