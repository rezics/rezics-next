import { expect } from 'bun:test';
import type { Page, Response as BrowserResponse } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest, settledWithin } from './lifecycle.ts';
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
const callerRequestMs = 30_000;
const noStore = { 'cache-control': 'no-store' };
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
         const review = document.querySelector('a');
         const status = document.querySelector('[role=status]');
         button.onclick = async () => {
           button.disabled = true;
           review.hidden = true;
           status.textContent = 'Requesting access';
           let message = 'Access unavailable';
           try {
             const response = await fetch(location.href, {
               method: 'POST', redirect: 'error', signal: AbortSignal.timeout(${callerRequestMs}),
             });
             const result = await response.json();
             if (response.status === 401 && result?.error === 'authentication_denied' &&
                 Object.keys(result).length === 1) {
               message = 'Permission required';
               review.hidden = false;
             } else if (response.status === 200 && typeof result?.account_id === 'string' &&
                 result.client_id === ${JSON.stringify(client.clientId)} &&
                 JSON.stringify(result.scope) === JSON.stringify(${JSON.stringify(requested)})) {
               message = 'Access granted';
             }
           } catch {
             // A failed or incomplete response cannot settle the caller's request.
           } finally {
             status.textContent = message;
             button.disabled = false;
           }
         };
       </script>`,
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          ...noStore,
          'referrer-policy': 'same-origin',
        },
      },
    );
  }
  if (request.method !== 'POST' || request.headers.get('origin') !== origin) return new Response(null, { status: 403 });

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(callerRequestMs)]);
  return authorizeCaller(caller, signal).catch(() => new Response(null, { status: 502, headers: noStore }));
}

async function authorizeCaller(caller: CallerRequest, signal: AbortSignal): Promise<Response> {
  const headers = { 'content-type': 'application/json', origin: auth.origin };
  const signIn = await fetch(new URL('/signin', auth.origin), {
    method: 'POST',
    headers,
    redirect: 'error',
    signal,
    body: JSON.stringify({
      account_id: caller.accountId,
      password: nativeAuthPassword,
      client_id: client.clientId,
      scope: requested,
    }),
  });
  if (!signIn.ok) return Response.json(await signIn.json(), { status: signIn.status, headers: noStore });

  const proof = (await signIn.json()) as { account_id: string; client_id: string; scope: string[] };
  if (
    proof.account_id !== caller.accountId ||
    proof.client_id !== client.clientId ||
    JSON.stringify(proof.scope) !== JSON.stringify(requested)
  )
    return new Response(null, { status: 502, headers: noStore });
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const issuance = await fetch(new URL('/token', auth.origin), {
    method: 'POST',
    headers: { ...headers, cookie },
    redirect: 'error',
    signal,
    body: '{}',
  });
  if (!issuance.ok) return Response.json(await issuance.json(), { status: issuance.status, headers: noStore });
  const result = (await issuance.json()) as { access_token?: unknown };
  if (typeof result.access_token !== 'string' || !result.access_token)
    return new Response(null, { status: 502, headers: noStore });
  return Response.json(
    { account_id: proof.account_id, client_id: proof.client_id, scope: proof.scope },
    { headers: noStore },
  );
}

async function continueRequest(page: Page, callerUrl: string, phase: 'initial' | 'return', expectedStatus: 200 | 401) {
  const [response] = await Promise.all([
    page.waitForResponse((reply) => reply.url() === callerUrl && reply.request().method() === 'POST', {
      timeout: callerRequestMs,
    }),
    page.getByRole('button', { name: 'Continue request', exact: true }).click(),
  ]);
  expect(response.status(), `${phase} caller response`).toBe(expectedStatus);
  // Require the caller document to settle from the body it received after this click.
  await browserExpect(page.getByRole('status'), `${phase} caller received HTTP ${response.status()}`).toHaveText(
    expectedStatus === 401 ? 'Permission required' : 'Access granted',
    { timeout: callerRequestMs },
  );
}

async function readConsentResponse(response: BrowserResponse, phase: 'review' | 'approval'): Promise<unknown> {
  const result = await settledWithin(
    response.json().then(
      (body: unknown) => ({ body }),
      () => null,
    ),
    callerRequestMs,
  );
  if (!result) throw new Error(`Native consent ${phase} HTTP ${response.status()} did not deliver readable JSON`);
  return result.body;
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
        expect((await page.goto(callerUrl))?.status(), 'caller document response').toBe(200);
        await continueRequest(page, callerUrl, 'initial', 401);
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
        expect(observed.status(), 'consent review response').toBe(200);
        expect(page.url()).toBe(review.href);
        await browserExpect(page.getByText(client.displayName, { exact: true })).toBeVisible();
        await browserExpect(page.getByText(`You’re signed in as ${email}.`, { exact: true })).toBeVisible();
        await browserExpect(page.getByText(requested[0], { exact: true }).and(page.locator('code'))).toBeVisible();
        expect(await readConsentResponse(observed, 'review')).toMatchObject({
          client_id: client.clientId,
          acting_account: { account_id: accountId },
          requested,
          granted: [],
        });

        if (persona === 'alice') {
          const [decision] = await Promise.all([
            page.waitForResponse(
              (response) =>
                response.url() === new URL('/consent', auth.origin).href && response.request().method() === 'POST',
            ),
            page.getByRole('button', { name: 'Approve', exact: true }).click(),
          ]);
          expect(decision.status(), 'consent approval response').toBe(200);
          await browserExpect(
            page.getByText('Access approved. You can return to the application.', { exact: true }),
          ).toBeVisible();
          expect(await readConsentResponse(decision, 'approval')).toEqual({
            account_id: accountId,
            client_id: client.clientId,
            requested,
            scope: requested,
          });
        } else {
          await page.getByRole('button', { name: 'Decline', exact: true }).click();
          await browserExpect(
            page.getByText('Access declined. This sends no approval.', { exact: true }),
          ).toBeVisible();
        }

        await page.goBack({ waitUntil: 'domcontentloaded' });
        expect(page.url()).toBe(callerUrl);
        await continueRequest(page, callerUrl, 'return', persona === 'alice' ? 200 : 401);
        if (persona === 'alice') {
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
