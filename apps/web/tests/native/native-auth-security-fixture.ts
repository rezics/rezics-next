import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { slug } from '@rezics/definitions/slug';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page, Response as PlaywrightResponse } from 'playwright';
import type { NativeWebStack } from './stack.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const nativeAuthHost = 'auth.native.rezics.com';
const repositoryRoot = resolve(import.meta.dir, '../../../..');

export const nativeAuthPassword = 'semantic outcome registration password with enough entropy';

export type NativeAuthIssuerProxy = {
  origin: string;
  webTls: { certificate: string; key: string };
  setUpstream(origin: string): void;
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
      return fetch(forwarded, { redirect: 'manual' });
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
  book: { id: string; title: string; path: string };
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

/** Create one public catalogue resource through the released API in this owned native stack. */
export async function provisionNativeAuthSecurityFixture(stack: NativeWebStack): Promise<NativeAuthSecurityFixture> {
  if (!bundledRelease.types['schema:Book']) throw new Error('Bundled release lacks schema:Book');
  const active = (await required(await stack.kernel('/v1/definitions/active'), 'Read active definitions')) as Response;
  const activeDigest = ((await active.json()) as { digest?: unknown }).digest;
  if (activeDigest !== bundledDigest)
    throw new Error(`Native stack release mismatch: expected ${bundledDigest}, received ${String(activeDigest)}`);

  const [alice, bob] = await Promise.all([stack.authPersona('alice'), stack.authPersona('bob')]);
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
              subject: { type: 'schema:Book', labels: { en: title } },
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

export async function visitLibrarySignIn(page: Page, stack: NativeWebStack, returnTo: string): Promise<void> {
  const target = `${stack.web}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`;
  const failures: string[] = [];
  const onFailure = (request: import('playwright').Request) => {
    failures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`);
  };
  page.on('requestfailed', onFailure);
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    let responseDetails = 'unavailable';
    try {
      const response = await stack.request(target, 'anonymous');
      responseDetails = `${response.status} ${response.headers.get('location') ?? ''} ${(await response.text()).slice(
        0,
        500,
      )}`;
    } catch (probeError) {
      responseDetails = `probe failed: ${probeError instanceof Error ? probeError.message : String(probeError)}`;
    }
    throw new Error(
      `Native browser sign-in navigation failed; requests=${failures.join(' | ')}; Worker response=${responseDetails}`,
      { cause: error },
    );
  } finally {
    page.off('requestfailed', onFailure);
  }
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
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
