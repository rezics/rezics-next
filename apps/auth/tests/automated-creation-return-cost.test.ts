import { expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { creationFixture, dom, flush, button } from './creation-page-fixture';
import { AutomatedAccountCreatePage } from '../src/routes/automated.new';
creationFixture();
const { createRoot } = await import('react-dom/client');

const human = '11111111-1111-4111-8111-111111111111';
const session = {
  account_id: human,
  client_id: 'rezics-auth-account-management',
  scope: ['account:manage'],
  auth_time: Math.floor(Date.now() / 1000),
  authn_epoch: 1,
  amr: ['pwd'],
};
const page = {
  viewer: { accountId: human },
  readiness: 'select-operator',
  operator: null,
  handleRules: {
    minLength: 3,
    maxLength: 64,
    normalization: 'lowercase',
    pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]',
  },
  action: 'select-operator',
};

test('entry, persisted return and visible Retry charge bounded reads and issue no commands', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let failPage = false;
  globalThis.fetch = (async (input) => {
    const path = String(input);
    requests.push(path);
    if (path === '/session') return Response.json(session);
    if (path === '/account-management/automated/operator')
      return failPage ? new Response(null, { status: 503 }) : Response.json(page);
    throw new Error(`Unexpected Auth request: ${path}`);
  }) as typeof fetch;
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  try {
    await flush(() => root.render(createElement(AutomatedAccountCreatePage)));
    expect(requests.filter((path) => path === '/session')).toHaveLength(4);
    expect(requests.filter((path) => path === '/account-management/automated/operator')).toHaveLength(1);

    failPage = true;
    await flush(() => {
      window.dispatchEvent(new dom.Event('pagehide'));
      const event = new dom.Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: true });
      window.dispatchEvent(event as unknown as PageTransitionEvent);
    });
    expect(host.textContent).toContain('service is unavailable');
    failPage = false;
    const beforeRetry = requests.length;
    await flush(() => button(host, 'Retry')!.click());
    const retry = requests.slice(beforeRetry);
    expect(retry.filter((path) => path === '/session')).toHaveLength(4);
    expect(retry.filter((path) => path === '/account-management/automated/operator')).toHaveLength(1);
    expect(retry.some((path) => path.startsWith('/account-operations/') || path === '/signin')).toBe(false);
    expect(requests.filter((path) => path === '/session')).toHaveLength(10);
    expect(requests.filter((path) => path === '/account-management/automated/operator')).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    globalThis.fetch = originalFetch;
  }
});
