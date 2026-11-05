import { bundledRelease } from '@rezics/definitions/bundled';
import { slug } from '@rezics/definitions/slug';
import type { Page, APIResponse, Response as BrowserResponse } from 'playwright';
import type {
  AuthVisit,
  PageObservation,
  PersonalFixture,
  Persona,
  Target,
  Visit,
  WebPersonalDriver,
} from '../../../../specs/web-personal-driver.ts';
import { startNativeWebStack } from './stack.ts';
import { startAuthStack } from './auth-stack.ts';
import { currentNativeLifecycle, NativeTestLifecycle } from './lifecycle.ts';
import { nativeAuthPassword, startNativeAuthIssuerProxy } from './native-auth-security-fixture.ts';
import { startFakeStripe } from '../../../../services/kernel/test/commerce/support/fake-stripe.ts';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import {
  nativePersonalJson,
  personalFactsObserver,
  personalGrant,
  personalRequest,
  provisionPersonalFixture,
} from './web-personal-fixture.ts';

/** Preserve the actual network status, repeated headers, URL and bytes at the browser boundary. */
async function httpResponse(source: BrowserResponse | APIResponse): Promise<Response> {
  const headers = new Headers();
  for (const header of await source.headersArray()) headers.append(header.name, header.value);
  const status = source.status();
  const response = new Response([204, 205, 304].includes(status) ? null : new Uint8Array(await source.body()), {
    status,
    statusText: source.statusText(),
    headers,
  });
  Object.defineProperty(response, 'url', { value: source.url() });
  return response;
}

async function hydrated(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
}

/** Only rendered content is observed here. Missing identity/count/receipt UI stays missing. */
async function observePage(page: Page): Promise<PageObservation> {
  return page.evaluate(() => {
    const visible = (node: Element) =>
      node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const text = document.body.innerText;
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(visible);
    const members = document.querySelector(
      '[aria-labelledby="collection-members-heading"], [aria-labelledby="tracked-entries-heading"], [data-zone-members], [data-dynamic-members], [data-zone-page] [data-slot="type-list"]',
    );
    // One title link per actual displayed row; covers often link the same subject.
    // Never deduplicate across rows, since that would hide duplicated membership.
    const candidates = members
      ? [
          ...members.querySelectorAll('[data-member], [data-slot="list-row"], [data-slot="cover-card"], tbody tr'),
        ].filter(visible)
      : [];
    const rows = candidates.filter((row) => !candidates.some((other) => other !== row && other.contains(row)));
    const subjectId = (href: string | null) =>
      href ? (/\/subjects\/([^/?#]+)/.exec(new URL(href, location.href).pathname)?.[1] ?? null) : null;
    const memberSubjectIds = rows
      .map((row) => subjectId(row.querySelector('a[href*="/subjects/"]')?.getAttribute('href') ?? null))
      .filter((id): id is string => id !== null);
    const identity = [...document.querySelectorAll<HTMLElement>('[data-account-id]')].find(visible);
    const accountLink = links.find(
      (link) => /\/accounts\/[0-9a-f-]{36}(?:\/|$)/i.test(new URL(link.href).pathname) && link.closest('#account-menu'),
    );
    const signedInAccountId =
      identity?.dataset.accountId ??
      (accountLink ? (/\/accounts\/([^/]+)/.exec(new URL(accountLink.href).pathname)?.[1] ?? null) : null);
    const stateSelect = document.querySelector('[data-library-entry] select');
    const state =
      (stateSelect && 'value' in stateSelect && typeof stateSelect.value === 'string'
        ? stateSelect.value
        : undefined) ??
      document.querySelector<HTMLInputElement>('[data-library-entry] input[name="state"]')?.value ??
      document.querySelector<HTMLInputElement>('[data-library-entry] input[aria-hidden="true"]')?.value ??
      document.querySelector<HTMLElement>('[data-library-entry-state]')?.dataset.state ??
      null;
    const labels = [...document.querySelectorAll('[data-subject-label-chip] a')]
      .filter(visible)
      .map((node) => node.textContent?.trim() ?? '');
    const copyCount = document.querySelector<HTMLElement>('[data-copy-count]');
    const progress = document.querySelector<HTMLProgressElement>('progress[data-subject-progress]');
    const next = links.find(
      (link) =>
        /^(next(?: page)?|more (?:members|entries))$/i.test(link.innerText.trim()) &&
        (!members || members.contains(link)),
    );
    const orderPath = /\/orders\/([^/]+)/.exec(location.pathname);
    const settlement = /\b(payment received|paid)\b/i.test(document.querySelector('h1')?.textContent ?? '')
      ? ('paid' as const)
      : /\b(failed|declined|unsuccessful)\b/i.test(document.querySelector('h1')?.textContent ?? '')
        ? ('failed' as const)
        : /\b(pending|processing|awaiting)\b/i.test(text)
          ? ('pending' as const)
          : null;
    return {
      url: location.href,
      text,
      heading: document.querySelector('h1,h2')?.textContent?.trim() ?? '',
      signedInAccountId,
      memberSubjectIds,
      nextHref: next?.href ?? null,
      filterBarVisible: [...document.querySelectorAll('button')].some(
        (button) => visible(button) && /^filters$/i.test(button.innerText.trim()),
      ),
      preparing: [...document.querySelectorAll('[role="status"]')].some(
        (node) => visible(node) && /preparing|updating/i.test(node.textContent ?? ''),
      ),
      personal: {
        state,
        labels,
        copies: copyCount ? Number(copyCount.innerText) : 0,
        progress: progress?.value ?? null,
      },
      order:
        orderPath && settlement
          ? {
              id: orderPath[1]!,
              settlement,
              receiptHref: links.find((link) => /receipt/i.test(link.innerText))?.href ?? null,
              entitlementVisible: [...document.querySelectorAll('[data-entitlement], [role="status"]')].some(
                (node) => visible(node) && /entitlement|access granted/i.test(node.textContent ?? ''),
              ),
            }
          : null,
      security: {
        stepUpRequired: /verify your identity|step.up required/i.test(text),
        changed: /Personal journey passkey/.test(text),
      },
    };
  });
}

export async function createWebPersonalDriver(): Promise<WebPersonalDriver> {
  const lifecycle = new NativeTestLifecycle('native web personal driver', currentNativeLifecycle());
  try {
    return await lifecycle.run(
      'start native web personal driver',
      180_000,
      async () => {
        const stripe = startFakeStripe();
        lifecycle.register({
          label: 'personal payment provider fixture',
          close: () => stripe.stop(),
          force: () => stripe.stop(),
        });
        const issuer = await startNativeAuthIssuerProxy();
        lifecycle.register({ label: 'personal Auth TLS issuer', close: () => issuer.stop() });
        const stack = await startNativeWebStack({
          observePersonalAccess: true,
          issuerOrigin: issuer.origin,
          webTls: issuer.webTls,
          commerce: {
            apiHost: `http://127.0.0.1:${stripe.port}`,
            webhookSecret: stripe.webhookSecret,
            successUrl: 'https://rezics.example.test/en/orders/{ORDER_ID}?checkout=success',
            cancelUrl: 'https://rezics.example.test/en/orders/{ORDER_ID}?checkout=canceled',
          },
        });
        issuer.setUpstream(stack.authIssuer);
        const auth = await startAuthStack(stack);
        const facts = personalFactsObserver(stack);
        lifecycle.register({ label: 'personal read-only database observers', close: () => facts.close() });
        let fixture: PersonalFixture | undefined;
        let authOffsetSeconds = 0;
        let observedRequests = 0;
        const deliveredOrders = new Set<string>();
        const pages = new Map<Persona, Promise<Page>>();
        const responses = new Map<Page, BrowserResponse[]>();
        const navigations = new Map<Page, string[]>();
        const fixtureRequired = () => {
          if (!fixture) throw new Error('Personal fixture must be provisioned before browser actions');
          return fixture;
        };
        const pageFor = async (persona: Persona): Promise<Page> => {
          lifecycle.assertOpen('use personal browser page');
          let pending = pages.get(persona);
          if (!pending) {
            pending = (async () => {
              const context = await auth.context(persona);
              const page = await context.newPage();
              page.setDefaultTimeout(15_000);
              const webauthn = await context.newCDPSession(page);
              await webauthn.send('WebAuthn.enable');
              const authenticator = await webauthn.send('WebAuthn.addVirtualAuthenticator', {
                options: {
                  protocol: 'ctap2',
                  transport: 'internal',
                  hasResidentKey: true,
                  hasUserVerification: true,
                  isUserVerified: true,
                  automaticPresenceSimulation: true,
                },
              });
              lifecycle.register({
                label: `personal ${persona} authenticator`,
                async close() {
                  await webauthn.send('WebAuthn.removeVirtualAuthenticator', {
                    authenticatorId: authenticator.authenticatorId,
                  });
                  await webauthn.detach();
                },
              });
              const network: BrowserResponse[] = [];
              const urls: string[] = [];
              responses.set(page, network);
              navigations.set(page, urls);
              page.on('request', (request) => {
                if (request.isNavigationRequest() && request.frame() === page.mainFrame()) urls.push(request.url());
              });
              page.on('response', (response) => {
                const request = response.request();
                if (
                  (request.isNavigationRequest() && request.frame() === page.mainFrame()) ||
                  request.method() !== 'GET'
                )
                  network.push(response);
              });
              return page;
            })();
            pages.set(persona, pending);
          }
          return pending;
        };
        const pathFor = (target: Target): string => {
          const f = fixtureRequired();
          switch (target.kind) {
            case 'subject': {
              const subject = Object.values(f.subjects).find((s) => s.id === target.subjectId);
              return `/en/subjects/${encodeURIComponent(target.subjectId)}${subject ? `/${slug(subject.title)}` : ''}`;
            }
            case 'members': {
              const params = new URLSearchParams({ limit: String(target.limit) });
              if (target.state) params.set('state', target.state);
              const path =
                target.surface === 'collection'
                  ? `/en/collections/${f.collectionId}`
                  : target.surface === 'zone'
                    ? `/en/zones/${f.zoneId}`
                    : '/en/library';
              return `${path}?${params}`;
            }
            case 'thread':
              return `/en/threads/${target.threadId}`;
            case 'offer':
              return `/en/offers/${target.offerId}`;
            case 'order':
              return `/en/orders/${target.orderId}${target.checkoutReturn ? '?checkout=success' : ''}`;
            // The original oracle requires a web security return. A missing real
            // route must remain its 404, never a test-only security page.
            case 'security':
              return '/en/security';
          }
        };
        const visitResponse = async (page: Page, response: BrowserResponse | null): Promise<Visit> => {
          if (!response) throw new Error(`No document response at ${page.url()}`);
          if (response.ok() && (response.headers()['content-type'] ?? '').includes('text/html')) await hydrated(page);
          return { response: await httpResponse(response), page: await observePage(page) };
        };
        const navigate = async (persona: Persona, path: string) => {
          const url = new URL(path, stack.web);
          if (url.origin !== stack.web) throw new Error(`Personal web navigation left its owned origin: ${url.href}`);
          const page = await pageFor(persona);
          return visitResponse(page, await page.goto(url.href, { waitUntil: 'domcontentloaded' }));
        };
        const failure = async (page: Page, action: string, error: unknown): Promise<never> => {
          await stack.syncKernelRequests();
          const refused = stack.kernelRequests().findLast((request) => request.failure);
          throw new Error(
            `${action} at ${page.url()}: ${refused ? `${refused.method} ${refused.url}: HTTP ${refused.failure!.status} ${refused.failure!.body}` : await page.locator('body').innerText()}`,
            { cause: error },
          );
        };
        const submit = async (page: Page, control: () => Promise<unknown>): Promise<Visit> => {
          const response = page.waitForResponse(
            (item) =>
              item.request().method() !== 'GET' && [stack.web, auth.origin].includes(new URL(item.url()).origin),
          );
          // Attach rejection handling immediately, including when a missing control
          // refuses before any HTTP request is made.
          void response.catch(() => {});
          await control();
          const submitted = await response;
          await submitted.finished();
          await page.waitForLoadState('domcontentloaded');
          await page.locator('[data-library-entry] [aria-busy="true"]').waitFor({ state: 'hidden' });
          await stack.syncKernelRequests();
          return { response: await httpResponse(submitted), page: await observePage(page) };
        };
        const accountProof = async (page: Page): Promise<AuthVisit['session']> => {
          const response = await page.context().request.get(`${auth.origin}/session`);
          if (response.status() === 401) return { accountId: null, freshAuthentication: false, websiteConsent: false };
          const body = await nativePersonalJson<{ account_id: string; auth_time: number; scope: string[] }>(
            await httpResponse(response),
            200,
            'GET Auth /session',
          );
          const sessionsResponse = await page.context().request.get(`${auth.origin}/sessions`);
          const sessions = await nativePersonalJson<{ sessions: { client_id: string }[] }>(
            await httpResponse(sessionsResponse),
            200,
            'GET Auth /sessions',
          );
          return {
            accountId: body.account_id,
            freshAuthentication: Date.now() / 1000 + authOffsetSeconds - body.auth_time <= 600,
            websiteConsent: sessions.sessions.some((s) => s.client_id === 'rezics-website'),
          };
        };
        const openSecurity = async (page: Page) => {
          await page.locator('#account-menu-button').click();
          await page.locator('[data-account-security-settings]').click();
          await page.waitForURL((url) => url.origin === auth.origin && url.pathname === '/security');
          await hydrated(page);
        };
        const signIn = async (page: Page, persona: Exclude<Persona, 'anonymous'>, target: string, signup = false) => {
          await page.goto(`${stack.web}/auth/sign-in?return_to=${encodeURIComponent(target)}`, {
            waitUntil: 'domcontentloaded',
          });
          await hydrated(page);
          // Existing standing Auth sessions can complete the production code flow
          // without a form. A refused/suspended session still reaches the form.
          if (new URL(page.url()).origin === stack.web) return;
          if (signup) {
            await page
              .getByRole('link', { name: /create an account|sign up/i })
              .first()
              .click();
            await hydrated(page);
            await page.getByLabel('Handle', { exact: true }).fill(`personal-${crypto.randomUUID().slice(0, 8)}`);
            await page.getByLabel('Email', { exact: true }).fill(`personal-${crypto.randomUUID()}@example.test`);
            await page.getByLabel('Password', { exact: true }).fill(`Personal-${crypto.randomUUID()}-Secure`);
            const created = page.waitForResponse(
              (r) => new URL(r.url()).pathname === '/signup' && r.request().method() === 'POST',
            );
            await page.getByRole('button', { name: 'Create an account', exact: true }).click();
            const result = await created;
            if (result.status() >= 400) return;
          } else {
            const identity = await stack.authPersona(persona);
            await page.getByLabel('Email', { exact: true }).fill(identity.email);
            await page.locator('input[name="password"]').fill(nativeAuthPassword);
            const posted = page.waitForResponse(
              (r) => new URL(r.url()).pathname === '/signin' && r.request().method() === 'POST',
            );
            await page.getByRole('button', { name: 'Sign in', exact: true }).click();
            if ((await posted).status() >= 400) return;
          }
          await page.waitForURL((url) => url.origin === stack.web && url.pathname !== '/auth/callback');
          await hydrated(page);
        };
        const driver: WebPersonalDriver = {
          origins: { web: stack.web, auth: auth.origin },
          close: () => lifecycle.close(),
          async provision(data) {
            if (fixture) throw new Error('Each personal factory provisions exactly one independent fixture');
            try {
              fixture = await provisionPersonalFixture(stack, data);
              return fixture;
            } catch (error) {
              await lifecycle.close();
              throw error;
            }
          },
          visit: (persona, target) => navigate(persona, pathFor(target)),
          async follow(persona, href) {
            const page = await pageFor(persona);
            const allowed = await page
              .locator('a[href]')
              .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));
            if (href !== page.url() && !allowed.includes(new URL(href, page.url()).href))
              throw new Error(`Link was not emitted by ${page.url()}: ${href}`);
            return navigate(persona, href);
          },
          async act(persona, action) {
            const page = await pageFor(persona);
            try {
              await hydrated(page);
              if (
                ['track', 'copy', 'progress', 'label'].includes(action.kind) &&
                'subjectId' in action &&
                !new URL(page.url()).pathname.includes(`/subjects/${action.subjectId}`)
              ) {
                // Follow an actual subject link from the current shelf/copy page.
                await page.locator(`a[href*="/subjects/${action.subjectId}"]`).first().click();
                await hydrated(page);
              }
              switch (action.kind) {
                case 'track': {
                  const f = fixtureRequired();
                  const key = Object.entries(f.subjects).find(([, subject]) => subject.id === action.subjectId)?.[0];
                  const type = key?.startsWith('R-') ? 'schema:Recipe' : 'schema:Book';
                  const profileId = bundledRelease.types[type]?.library?.profileId;
                  const state = profileId
                    ? bundledRelease.libraryProfiles?.[profileId]?.entryStateSet?.states.find(
                        (s) => s.id === action.state,
                      )
                    : undefined;
                  if (!state?.labels.en) throw new Error(`No released ${type} state ${action.state}`);
                  await page.getByRole('combobox', { name: 'Library state', exact: true }).click();
                  return await submit(page, () =>
                    page.getByRole('option', { name: state.labels.en, exact: true }).click(),
                  );
                }
                case 'label':
                  await page.getByRole('button', { name: /add.*label/i }).click();
                  await page.locator('[data-subject-label-picker]').getByRole('textbox').fill(action.name);
                  return await submit(page, () =>
                    page.getByRole('button', { name: `Create “${action.name}”`, exact: true }).click(),
                  );
                case 'copy':
                  await page.getByRole('link', { name: 'Your copies', exact: true }).click();
                  await hydrated(page);
                  await page.getByRole('button', { name: 'Add a copy', exact: true }).click();
                  await page.getByLabel('Kind', { exact: true }).selectOption(action.copyKind);
                  await page.getByLabel('Status', { exact: true }).selectOption(action.status);
                  await page.getByRole('button', { name: 'More', exact: true }).click();
                  await page.getByLabel('Note', { exact: true }).fill(action.note);
                  return await submit(page, () => page.getByRole('button', { name: 'Add copy', exact: true }).click());
                case 'progress':
                  await page.getByRole('link', { name: 'Start progress', exact: true }).click();
                  await hydrated(page);
                  await page.getByLabel('Unit', { exact: true }).selectOption(action.unit);
                  await submit(page, () => page.getByRole('button', { name: 'Start', exact: true }).click());
                  await page.waitForURL((url) => /\/library\/progress\/[^/]+$/.test(url.pathname));
                  await page.getByRole('button', { name: 'Update progress', exact: true }).click();
                  await page.getByRole('spinbutton', { name: 'Amount', exact: true }).fill(String(action.value));
                  // Do not drop the original note oracle when the actual form lacks it.
                  await page.getByLabel('Note', { exact: true }).fill(action.note);
                  return await submit(page, () => page.getByRole('button', { name: 'Record', exact: true }).click());
                case 'publish-collection':
                  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
                  await page.getByRole('radio', { name: 'Public', exact: true }).click();
                  return await submit(page, () => page.getByRole('button', { name: 'Save', exact: true }).click());
                case 'filter': {
                  await page.getByRole('button', { name: 'Filters', exact: true }).click();
                  const form = page.locator('form').filter({ has: page.locator('input[name="type"]') });
                  const type = await form.locator('input[name="type"]').inputValue();
                  if (type !== action.type)
                    throw new Error(`Rendered filter type ${type} cannot express ${action.type}`);
                  // The current range form has an inclusive From; an integer-only
                  // word count strictly above n is exactly From n+1.
                  await form
                    .locator('input[name="range.from.schema:wordCount"]')
                    .fill(String(action.wordCountGreaterThan + 1));
                  const tag = fixtureRequired().subjects.harem;
                  if (!tag || tag.id !== action.tagSubjectId)
                    throw new Error('Filter must select the actual fixture concept');
                  await form.getByRole('combobox').fill(tag.title);
                  await page.getByRole('option').filter({ hasText: tag.title }).first().click();
                  return await visitResponse(
                    page,
                    await (async () => {
                      const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
                      await form.getByRole('button', { name: 'Apply', exact: true }).click();
                      return navigation;
                    })(),
                  );
                }
                case 'upload-and-attach':
                  await page.locator('[contenteditable="true"]').last().fill(action.text);
                  await page.getByRole('button', { name: 'Image', exact: true }).click();
                  await page.locator('input[type="file"]').setInputFiles({
                    name: action.image.name,
                    mimeType: action.image.mimeType,
                    buffer: Buffer.from(action.image.bytes),
                  });
                  await page.getByRole('button', { name: 'Insert image', exact: true }).click();
                  // The actual composer disables Send until reserve/stream/complete finishes.
                  return await submit(page, () =>
                    page.getByRole('button', { name: /^(send|reply|post reply)$/i }).click(),
                  );
                case 'reply':
                  await page.locator('[contenteditable="true"]').last().fill(action.text);
                  return await submit(page, () =>
                    page.getByRole('button', { name: /^(send|reply|post reply)$/i }).click(),
                  );
                case 'start-checkout':
                  return await submit(page, () => page.getByRole('button', { name: 'Buy', exact: true }).click());
                case 'change-security-setting': {
                  if (new URL(page.url()).origin === stack.web) await openSecurity(page);
                  await page.getByLabel('Passkey name (optional)', { exact: true }).fill('Personal journey passkey');
                  const options = page.waitForResponse(
                    (r) =>
                      new URL(r.url()).pathname === '/passkeys/register/options' && r.request().method() === 'POST',
                  );
                  const registered = page.waitForResponse(
                    (r) => new URL(r.url()).pathname === '/passkeys/register' && r.request().method() === 'POST',
                  );
                  void registered.catch(() => {});
                  await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
                  const offered = await options;
                  if (offered.status() >= 400) {
                    await page.waitForURL((url) => url.origin === auth.origin && url.pathname === '/step-up');
                    await hydrated(page);
                    return { response: await httpResponse(offered), page: await observePage(page) };
                  }
                  const saved = await registered;
                  await saved.finished();
                  if (saved.ok())
                    await page.getByRole('heading', { name: 'Personal journey passkey', exact: true }).waitFor();
                  return { response: await httpResponse(saved), page: await observePage(page) };
                }
              }
            } catch (error) {
              return failure(page, action.kind, error);
            }
          },
          async auth(persona, journey, returnTo) {
            const page = await pageFor(persona);
            const start = responses.get(page)!.length;
            const urlsStart = navigations.get(page)!.length;
            const path = pathFor(returnTo);
            try {
              if (journey === 'sign-in' || journey === 'sign-up' || journey === 'consent') {
                await signIn(page, persona, path, journey === 'sign-up');
                if (journey === 'consent' && new URL(page.url()).origin === stack.web) {
                  await openSecurity(page);
                  await page.getByRole('region', { name: 'Sessions', exact: true }).waitFor({ state: 'visible' });
                  await page.getByRole('listitem').filter({ hasText: 'REZICS' }).first().waitFor({ state: 'visible' });
                  await page.goBack({ waitUntil: 'domcontentloaded' });
                  await hydrated(page);
                }
              } else if (journey === 'step-up') {
                if (new URL(page.url()).pathname !== '/step-up') {
                  await navigate(persona, path);
                  await openSecurity(page);
                  await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
                  await page.waitForURL((url) => url.origin === auth.origin && url.pathname === '/step-up');
                }
                await page.getByLabel('Email', { exact: true }).fill((await stack.authPersona(persona)).email);
                await page.locator('input[name="password"]').fill(nativeAuthPassword);
                await submit(page, () =>
                  page.getByRole('button', { name: 'Verify your identity', exact: true }).click(),
                );
                await page.waitForURL((url) => url.origin === auth.origin && url.pathname === '/security');
                // A web return must be emitted by the served Auth security page.
                // Never repair a lost return target with a driver-made navigation.
                await page.locator(`a[href="${new URL(path, stack.web).href}"]`).click();
                await hydrated(page);
              } else {
                await navigate(persona, path);
                await page.locator('#account-menu-button').click();
                await submit(page, () => page.getByRole('button', { name: 'Sign out', exact: true }).click());
                await page.waitForURL((url) => url.origin === stack.web);
                await hydrated(page);
              }
              const network = responses.get(page)!.slice(start);
              const lastDocument = network.findLast((r) => r.request().isNavigationRequest());
              if (!lastDocument) throw new Error(`Auth ${journey} received no document response`);
              // Retain only form submissions and redirects/documents, in the actual
              // observed network order, including a refused correct-password /signin.
              return {
                response: await httpResponse(lastDocument),
                page: await observePage(page),
                responses: await Promise.all(network.map(httpResponse)),
                visitedUrls: navigations.get(page)!.slice(urlsStart),
                session: await accountProof(page),
              };
            } catch (error) {
              return failure(page, `Auth ${journey}`, error);
            }
          },
          async facts(persona) {
            const page = await pageFor(persona);
            const id =
              persona === 'newcomer' ? (await accountProof(page)).accountId : fixtureRequired().accounts[persona];
            if (!id) throw new Error(`No native account for ${persona}`);
            return facts.read(id, fixtureRequired());
          },
          async transport() {
            await stack.syncKernelRequests();
            const requests = stack.kernelRequests();
            const batch = requests.slice(observedRequests);
            observedRequests = requests.length;
            return {
              requests: batch
                .filter((request) => !request.fixtureRequest)
                .map((request) => ({
                  method: request.method,
                  path: request.url,
                  actorId: request.access?.actorId ?? null,
                  authenticated: request.access?.authenticated ?? false,
                  authorized: request.access?.authorized ?? false,
                })),
            };
          },
          async ageAuthentication(seconds) {
            await stack.advanceAuthClock(seconds);
            authOffsetSeconds += seconds;
          },
          async revokeSession(persona) {
            const context = (await pageFor(persona)).context();
            const sessions = await nativePersonalJson<{ sessions: { id: string; client_id: string }[] }>(
              await httpResponse(await context.request.get(`${auth.origin}/sessions`)),
              200,
              'GET Auth /sessions',
            );
            const session = sessions.sessions.find((s) => s.client_id === 'rezics-website');
            if (!session) throw new Error('Native Auth has no website session to revoke');
            return httpResponse(
              await context.request.post(`${auth.origin}/sessions/revoke`, {
                headers: { origin: auth.origin },
                data: { session_id: session.id },
              }),
            );
          },
          suspend: (persona) =>
            stack.kernel(
              `/v1/accounts/${fixtureRequired().accounts[persona]}:suspend`,
              personalRequest({ reason: 'Personal journey suspension' }),
              'governor',
            ),
          async grantIndependentRead(persona) {
            const f = fixtureRequired();
            let response: Response | undefined;
            for (const id of [f.protected.realmId, f.protected.threadId]) {
              response = await personalGrant(
                stack,
                { route: routeOf(id)!, id },
                f.accounts[persona],
                [id === f.protected.realmId ? 'realm:read' : 'thread:read'],
                'independent-grantor',
              );
              if (!response.ok) return response;
            }
            return response!;
          },
          ban: (persona) =>
            stack.kernel(
              `/v1/realms/${fixtureRequired().protected.realmId}/bans/${fixtureRequired().accounts[persona]}`,
              personalRequest({ reason: 'Personal journey ban' }, 'PUT'),
              'moderator',
            ),
          async download(persona, href) {
            const url = new URL(href, stack.web);
            if (url.origin !== stack.web) throw new Error(`Download left the owned web origin: ${url.href}`);
            return httpResponse(await (await pageFor(persona)).context().request.get(url.href, { maxRedirects: 0 }));
          },
          async payment(orderId, outcome) {
            const session = [...stripe.sessions.values()].find((s) => s.client_reference_id === orderId);
            if (!session) throw new Error(`Native provider has no Checkout Session for ${orderId}`);
            if (outcome === 'paid') stripe.pay(session.id);
            else {
              stripe.pay(session.id, 'async');
              stripe.failPayment(session.id);
            }
            const event = await stripe.event(
              outcome === 'paid' ? 'checkout.session.completed' : 'checkout.session.async_payment_failed',
              session.id,
            );
            await nativePersonalJson(
              await stack.kernel('/v1/webhooks/stripe', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
                body: event.bytes,
              }),
              200,
              'POST /v1/webhooks/stripe',
            );
            deliveredOrders.add(orderId);
          },
          async settle() {
            // The stack's production worker already owns execution. Wait only for
            // exact fixture orders; never drain/project global queues or apply effects.
            const f = fixtureRequired();
            for (let poll = 0; poll < 8; poll++) {
              const current = await facts.read(f.accounts.alice, f);
              if (
                [...deliveredOrders].every((id) =>
                  current.orders.some((o) => o.id === id && o.settlement !== 'pending'),
                )
              )
                return;
              await Bun.sleep(100);
            }
            throw new Error('Native settlement did not converge for the fixture orders in eight bounded observations');
          },
        };
        return driver;
      },
      false,
    );
  } catch (error) {
    await lifecycle.close();
    throw error;
  }
}
