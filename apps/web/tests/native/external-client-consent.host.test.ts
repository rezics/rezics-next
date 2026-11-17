import { expect } from 'bun:test';
import type { Page } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import { nativeAuthPassword } from './native-auth-security-fixture.ts';
import { launchPrivateBrowser, type PrivateBrowser } from './private-browser.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const lifecycle = new NativeTestLifecycle('external application consent');
const client = {
  clientId: 'native-reading-app',
  displayName: 'Reading app',
  scopes: ['account:read', 'account:update'],
};
const requested = ['account:read'] as const;
type CallerRequest = { accountId: string; path: string; session: string };
const callers = new Map<string, CallerRequest>();

let stack: NativeWebStack;
let auth: NativeAuthStack;
let browser: PrivateBrowser;
let origin: string;
let review: URL;

// Each caller session owns one request. Continue asks Auth for that actor and scope again after browser Back.
async function serveCaller(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const caller = callers.get(url.pathname);
  if (url.origin !== origin || url.search || !caller || request.headers.get('cookie') !== `caller=${caller.session}`) {
    return new Response(null, { status: 404 });
  }
  if (request.method === 'GET') {
    return new Response(
      `<!doctype html><title>Reading app request</title><main><h1>Reading app request</h1>
       <button>Continue request</button><p role="status"></p>
       <a hidden href="${review.href.replaceAll('&', '&amp;')}">Review permissions</a></main>
       <script>
         const button = document.querySelector('button');
         button.onclick = async () => {
           button.disabled = true;
           try {
             const response = await fetch(location.href, { method: 'POST', redirect: 'error' });
             document.querySelector('a').hidden = response.status !== 401;
             document.querySelector('[role=status]').textContent =
               response.ok ? 'Access granted' : response.status === 401 ? 'Permission required' : 'Access unavailable';
           } finally {
             button.disabled = false;
           }
         };
       </script>`,
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'same-origin',
        },
      },
    );
  }
  if (request.method !== 'POST' || request.headers.get('origin') !== origin) return new Response(null, { status: 403 });

  const headers = { 'content-type': 'application/json', origin: auth.origin };
  const signIn = await fetch(new URL('/signin', auth.origin), {
    method: 'POST',
    headers,
    redirect: 'error',
    body: JSON.stringify({
      account_id: caller.accountId,
      password: nativeAuthPassword,
      client_id: client.clientId,
      scope: requested,
    }),
  });
  const noStore = { 'cache-control': 'no-store' };
  if (!signIn.ok) return Response.json(await signIn.json(), { status: signIn.status, headers: noStore });

  const proof = (await signIn.json()) as { account_id: string; client_id: string; scope: string[] };
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const issuance = await fetch(new URL('/token', auth.origin), {
    method: 'POST',
    headers: { ...headers, cookie },
    redirect: 'error',
    body: '{}',
  });
  if (!issuance.ok) return Response.json(await issuance.json(), { status: issuance.status, headers: noStore });
  const result = (await issuance.json()) as { access_token?: unknown };
  if (typeof result.access_token !== 'string' || !result.access_token) return new Response(null, { status: 502 });
  return Response.json(
    { account_id: proof.account_id, client_id: proof.client_id, scope: proof.scope },
    { headers: noStore },
  );
}

async function continueRequest(page: Page, callerUrl: string) {
  const [response] = await Promise.all([
    page.waitForResponse((reply) => reply.url() === callerUrl && reply.request().method() === 'POST'),
    page.getByRole('button', { name: 'Continue request', exact: true }).click(),
  ]);
  return response;
}

nativeBeforeAll(lifecycle, 420_000, async () => {
  stack = await startNativeWebStack({ externalConsentClient: client });
  auth = await startAuthStack(stack);
  review = new URL('/consent', auth.origin);
  review.search = new URLSearchParams({ client_id: client.clientId, scope: requested.join(' ') }).toString();
  // A distinct loopback host prevents the caller from receiving issuer or website cookies.
  const listener = Bun.serve({ hostname: '127.0.0.2', port: 0, fetch: serveCaller });
  origin = listener.url.origin;
  lifecycle.register({
    label: 'external consent caller',
    close: () => listener.stop(true),
    force: () => listener.stop(true),
  });
  browser = await launchPrivateBrowser([origin, auth.origin, stack.web]);
});

nativeAfterAll(lifecycle, 180_000);

nativeTest(
  'a personal decision applies to the exact external request on caller return',
  420_000,
  async () => {
    for (const persona of ['alice', 'bob'] as const) {
      const { accountId, email } = await stack.authPersona(persona);
      const caller = { accountId, path: `/requests/${crypto.randomUUID()}`, session: crypto.randomUUID() };
      callers.set(caller.path, caller);
      const callerUrl = new URL(caller.path, origin).href;
      const context = await browser.browser.newContext({ locale: 'en' });
      try {
        const journey = await auth.signIn(persona, { context, sessionOnly: true });
        const page = journey.continueOnPage();
        await context.addCookies([
          { name: 'caller', value: caller.session, url: origin, httpOnly: true, sameSite: 'Lax' },
        ]);
        expect((await page.goto(callerUrl))?.status()).toBe(200);
        const initial = await continueRequest(page, callerUrl);
        expect(initial.status()).toBe(401);
        expect(await initial.json()).toEqual({ error: 'authentication_denied' });
        await browserExpect(page.getByRole('status')).toHaveText('Permission required');
        const writes: unknown[] = [];
        page.on('request', (request) => {
          if (request.method() === 'POST' && request.url() === new URL('/consent', auth.origin).href) {
            writes.push(request.postDataJSON());
          }
        });
        const projection = new URL(`/consent/${client.clientId}`, auth.origin);
        projection.searchParams.set('scope', requested.join(' '));
        const [observed] = await Promise.all([
          page.waitForResponse((response) => response.url() === projection.href),
          page.getByRole('link', { name: 'Review permissions', exact: true }).click(),
        ]);
        expect(observed.status()).toBe(200);
        expect(await observed.json()).toMatchObject({
          client_id: client.clientId,
          acting_account: { account_id: accountId },
          requested,
          granted: [],
        });
        expect(page.url()).toBe(review.href);
        await browserExpect(page.getByText(client.displayName, { exact: true })).toBeVisible();
        await browserExpect(page.getByText(`You’re signed in as ${email}.`, { exact: true })).toBeVisible();
        await browserExpect(page.getByText(requested[0], { exact: true }).and(page.locator('code'))).toBeVisible();

        if (persona === 'alice') {
          const [decision] = await Promise.all([
            page.waitForResponse(
              (response) =>
                response.url() === new URL('/consent', auth.origin).href && response.request().method() === 'POST',
            ),
            page.getByRole('button', { name: 'Approve', exact: true }).click(),
          ]);
          expect(decision.status()).toBe(200);
          expect(await decision.json()).toEqual({
            account_id: accountId,
            client_id: client.clientId,
            requested,
            scope: requested,
          });
          await browserExpect(
            page.getByText('Access approved. You can return to the application.', { exact: true }),
          ).toBeVisible();
        } else {
          await page.getByRole('button', { name: 'Decline', exact: true }).click();
          await browserExpect(
            page.getByText('Access declined. This sends no approval.', { exact: true }),
          ).toBeVisible();
        }

        await page.goBack({ waitUntil: 'domcontentloaded' });
        expect(page.url()).toBe(callerUrl);
        const returned = await continueRequest(page, callerUrl);
        if (persona === 'alice') {
          expect(returned.status()).toBe(200);
          await browserExpect(page.getByRole('status')).toHaveText('Access granted');
          expect(await returned.json()).toEqual({
            account_id: accountId,
            client_id: client.clientId,
            scope: requested,
          });
          expect(writes).toEqual([
            {
              client_id: client.clientId,
              scope: requested,
              reviewed_account_id: accountId,
              reviewed_scopes: [],
              reviewed_requested: requested,
            },
          ]);
        } else {
          expect(returned.status()).toBe(401);
          await browserExpect(page.getByRole('status')).toHaveText('Permission required');
          expect(await returned.json()).toEqual({ error: 'authentication_denied' });
          expect(writes).toEqual([]);
        }
      } finally {
        callers.delete(caller.path);
        await context.close();
      }
    }
  },
  lifecycle,
);
