import { expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { creationFixture, dom, flush, button, fill, send } from './creation-page-fixture';
creationFixture();
const { AutomatedAccountCreatePage } = await import('../src/routes/automated.new');
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
    const path = new URL(String(input), 'https://auth.test').pathname;
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

test('fresh creation keeps the existing eleven sessions, two advice reads and two exact command posts', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { path: string; init?: RequestInit }[] = [];
  const operator = {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'organization',
    handle: 'operator',
    displayName: null,
  };
  const created = '33333333-3333-4333-8333-333333333333';
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), 'https://auth.test').pathname;
    requests.push({ path, init });
    if (path === '/session') return Response.json(session);
    if (path === '/account-management/automated/operator') {
      const { operatorAccountId } = JSON.parse(String(init?.body));
      return Response.json({
        viewer: { accountId: human },
        readiness: operatorAccountId === null ? 'select-operator' : 'review',
        operator: operatorAccountId === null ? null : operator,
        handleRules: {
          minLength: 3,
          maxLength: 64,
          normalization: 'lowercase',
          pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]',
        },
        action: operatorAccountId === null ? 'select-operator' : 'confirm',
      });
    }
    if (path === '/account-operations/approve')
      return Response.json({ reference: 'native-approval', expiresAt: new Date(Date.now() + 60000).toISOString() });
    if (path === '/account-operations/execute') return Response.json({ accountId: created });
    throw new Error(`Unexpected Auth request: ${path}`);
  }) as typeof fetch;
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  try {
    await flush(() => root.render(createElement(AutomatedAccountCreatePage)));
    await flush(() => {
      fill(host.querySelector('#automated-operator')!, operator.id);
      fill(host.querySelector('#automated-handle')!, 'robot-one');
      send(host);
    });
    await flush(() => {
      host.querySelector<HTMLInputElement>('#automated-confirm')!.click();
      send(host);
    });

    const sessions = requests.filter(({ path }) => path === '/session');
    const advice = requests.filter(({ path }) => path === '/account-management/automated/operator');
    const commands = requests.filter(({ path }) => path.startsWith('/account-operations/'));
    expect({ sessions: sessions.length, advice: advice.length, commands: commands.map(({ path }) => path) }).toEqual({
      sessions: 11,
      advice: 2,
      commands: ['/account-operations/approve', '/account-operations/execute'],
    });
    expect(host.textContent).toContain(created);
    expect(commands[0]!.init?.credentials).toBe('same-origin');
    expect(commands[0]!.init?.cache).toBe('no-store');
    expect(commands[0]!.init?.redirect).toBe('error');
    expect(commands[0]!.init?.body).toBe(
      JSON.stringify({
        operation: {
          kind: 'automated',
          registrationId: '',
          operationKey: JSON.parse(String(commands[0]!.init?.body)).operation.operationKey,
          operatorAccountId: operator.id,
          handle: 'robot-one',
        },
        operationKey: JSON.parse(String(commands[0]!.init?.body)).operationKey,
        accountId: human,
      }),
    );
    expect(JSON.parse(String(commands[1]!.init?.body))).toMatchObject({
      operation: JSON.parse(String(commands[0]!.init?.body)).operation,
      operationKey: JSON.parse(String(commands[0]!.init?.body)).operationKey,
      accountId: human,
      reference: 'native-approval',
    });
    for (const { init } of commands)
      expect({
        credentials: init?.credentials,
        cache: init?.cache,
        redirect: init?.redirect,
        signal: init?.signal instanceof AbortSignal,
      }).toEqual({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: true });
  } finally {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    globalThis.fetch = originalFetch;
  }
});
