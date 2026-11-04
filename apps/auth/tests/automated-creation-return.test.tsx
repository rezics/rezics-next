import { expect, test } from 'bun:test';
import {
  automatedOperatorPage,
  approval,
  button,
  creationFixture,
  dom,
  fill,
  flush,
  leave,
  open,
  send,
} from './creation-page-fixture';
import { AutomatedAccountCreatePage } from '../src/routes/automated.new';
import {
  AUTOMATED_PROFILE,
  createAutomatedAttempt,
  restoreAutomatedAttempt,
  saveAutomatedAttempt,
} from '../src/automated-account-create';
creationFixture();

const human = '11111111-1111-4111-8111-111111111111';
const operator = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'organization' as const,
  handle: 'operator-private',
  displayName: 'Private operator',
};
const created = '33333333-3333-4333-8333-333333333333';
const session = {
  account_id: human,
  client_id: AUTOMATED_PROFILE.client_id,
  scope: AUTOMATED_PROFILE.scope,
  auth_time: Math.floor(Date.now() / 1000),
  authn_epoch: 1,
  amr: ['pwd'],
};

async function review(page: Awaited<ReturnType<typeof open>>) {
  await flush(() => {
    fill(page.host.querySelector('#automated-operator')!, operator.id);
    fill(page.host.querySelector('#automated-handle')!, 'private-handle');
    send(page.host);
  });
  const read = page.calls.at(-1)!;
  expect(read.path).toBe('/account-management/automated/operator');
  await flush(() => read.resolve(automatedOperatorPage(human, operator)));
}

async function complete(page: Awaited<ReturnType<typeof open>>) {
  await flush(() => page.host.querySelector<HTMLInputElement>('#automated-confirm')!.click());
  await flush(() => send(page.host));
  const approve = page.calls.at(-1)!;
  expect(approve.path).toBe('/account-operations/approve');
  await flush(() => approve.resolve(approval()));
  const execute = page.calls.at(-1)!;
  expect(execute.path).toBe('/account-operations/execute');
  await flush(() => execute.resolve(Response.json({ accountId: created })));
}

function returned() {
  const event = new dom.Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: true });
  window.dispatchEvent(event as unknown as PageTransitionEvent);
}

function expectPrivateViewCleared(host: HTMLElement, privateValues: string[]) {
  for (const value of privateValues) expect(host.textContent).not.toContain(value);
  expect(host.querySelector('#automated-operator')).toBeNull();
  expect(host.querySelector('#automated-handle')).toBeNull();
  expect(host.querySelector('#automated-email')).toBeNull();
  expect(host.querySelector('#automated-password')).toBeNull();
  expect(host.querySelector('#automated-confirm')).toBeNull();
}

test('native acknowledgement survives synchronous retirement and an unavailable return read', async () => {
  const page = await open(<AutomatedAccountCreatePage />, session);
  await review(page);
  await complete(page);
  const attempt = restoreAutomatedAttempt();
  if (!attempt || attempt === 'invalid') throw new Error('Expected the completed continuation to remain stored.');
  expect(page.host.textContent).toContain('The native creation workflow acknowledged completion.');
  expect(page.host.textContent).toContain(created);

  await flush(leave);
  expectPrivateViewCleared(page.host, [
    human,
    operator.id,
    operator.handle,
    'private-handle',
    created,
    attempt.operationKey,
    attempt.reference!,
  ]);
  expect(page.host.textContent).toContain('The native creation workflow acknowledged completion.');
  expect(page.host.querySelector('a[href="/security"]')).not.toBeNull();
  expect(page.host.querySelector('a[href="/"]')).not.toBeNull();

  const fetch = globalThis.fetch;
  globalThis.fetch = ((input, init) =>
    String(input) === '/account-management/automated/operator'
      ? Promise.resolve(new Response(null, { status: 503 }))
      : fetch(input, init)) as typeof fetch;
  try {
    await flush(returned);
    expect(page.host.textContent).toContain('The native creation workflow acknowledged completion.');
    expect(page.host.textContent).toContain('service is unavailable');
    expectPrivateViewCleared(page.host, [human, operator.id, operator.handle, 'private-handle', created]);
    expect(page.calls.filter((call) => call.path.startsWith('/account-operations/'))).toHaveLength(2);
  } finally {
    globalThis.fetch = fetch;
  }
  await flush(() => button(page.host, 'Retry')!.click());
  expect(page.host.textContent).toContain('The native creation workflow acknowledged completion.');
  expect(page.host.textContent).not.toContain('The result is uncertain.');
  expect(page.calls.filter((call) => call.path.startsWith('/account-operations/'))).toHaveLength(2);

  await flush(() => button(page.host, 'Dismiss history')!.click());
  await flush(leave);
  await flush(returned);
  expect(page.host.textContent).toContain('The displayed history was dismissed.');
  expect(page.host.textContent).not.toContain('The result is uncertain.');
  expect(page.calls.filter((call) => call.path.startsWith('/account-operations/'))).toHaveLength(2);
});

test('current matching advice and a later acknowledgement keep an earlier unknown and its exact retry', async () => {
  const original = createAutomatedAttempt(human, operator, 'private-handle')!;
  saveAutomatedAttempt({ ...original, reference: 'old-native-reference', submitted: true });
  const page = await open(<AutomatedAccountCreatePage />, session);
  expect(page.host.textContent).toContain('A creation may have been sent; its result remains unresolved.');
  await complete(page);

  const execute = page.calls.at(-1)!;
  expect(execute.body).toMatchObject({
    accountId: original.accountId,
    operationKey: original.operationKey,
    operation: original.operation,
  });
  expect(page.host.textContent).toContain('A creation may have been sent; its result remains unresolved.');
  expect(page.host.textContent).toContain('The native creation workflow acknowledged completion.');

  const retained = restoreAutomatedAttempt();
  if (!retained || retained === 'invalid') throw new Error('Expected the submitted continuation to remain stored.');
  await flush(leave);
  expectPrivateViewCleared(page.host, [
    human,
    operator.id,
    operator.handle,
    'private-handle',
    created,
    retained!.operationKey,
  ]);
  expect(page.host.textContent).toContain('A creation may have been sent; its result remains unresolved.');
  expect(page.host.textContent).toContain('The native creation workflow acknowledged completion.');
  expect(restoreAutomatedAttempt()).toMatchObject({
    accountId: original.accountId,
    operationKey: original.operationKey,
    operation: original.operation,
    submitted: true,
  });
});

test('missing or malformed continuation and later refusal cannot erase unknown history or unlock fresh creation', async () => {
  saveAutomatedAttempt({
    ...createAutomatedAttempt(human, operator, 'private-handle')!,
    reference: 'native-reference',
    submitted: true,
  });
  const page = await open(<AutomatedAccountCreatePage />, session);
  expect(page.host.textContent).toContain('A creation may have been sent; its result remains unresolved.');
  await flush(leave);
  window.sessionStorage.removeItem('rezics.automated-create.attempt');

  const fetch = globalThis.fetch;
  let pageReads = 0;
  globalThis.fetch = ((input, init) => {
    if (String(input) === '/account-management/automated/operator') {
      pageReads++;
      if (pageReads === 1) return Promise.resolve(new Response(null, { status: 403 }));
      return Promise.resolve(
        Response.json({
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
        }),
      );
    }
    return fetch(input, init);
  }) as typeof fetch;
  try {
    await flush(returned);
    expect(page.host.textContent).toContain('A creation may have been sent; its result remains unresolved.');
    expect(page.host.textContent).toContain('Creation was refused');
    await flush(() => button(page.host, 'Dismiss history')!.click());
    expect(page.host.textContent).toContain('The displayed history was dismissed.');
    expect(restoreAutomatedAttempt()).toBeNull();

    await flush(() => button(page.host, 'Retry')!.click());
    expect(pageReads).toBe(2);
    expect(page.host.textContent).toContain('An earlier creation remains unresolved.');
    expect(page.host.querySelector('#automated-operator')).toBeNull();
    expect(page.calls.filter((call) => call.path.startsWith('/account-operations/'))).toHaveLength(0);

    window.sessionStorage.setItem('rezics.automated-create.attempt', '{malformed');
    await flush(() => button(page.host, 'Retry')!.click());
    expect(pageReads).toBe(3);
    expect(page.host.textContent).toContain('An earlier creation remains unresolved.');
    expect(page.host.querySelector('#automated-operator')).toBeNull();
    expect(window.sessionStorage.getItem('rezics.automated-create.attempt')).toBe('{malformed');
    expect(page.calls.filter((call) => call.path.startsWith('/account-operations/'))).toHaveLength(0);
  } finally {
    globalThis.fetch = fetch;
  }
});

test('released selected-operator I/O cannot repopulate the synchronously retired view', async () => {
  const page = await open(<AutomatedAccountCreatePage />, session);
  const fetch = globalThis.fetch;
  const pending = Promise.withResolvers<Response>();
  globalThis.fetch = ((input, init) =>
    String(input) === '/account-management/automated/operator' ? pending.promise : fetch(input, init)) as typeof fetch;
  try {
    await flush(() => {
      fill(page.host.querySelector('#automated-operator')!, operator.id);
      fill(page.host.querySelector('#automated-handle')!, 'private-handle');
      send(page.host);
    });
    await flush(leave);
    expectPrivateViewCleared(page.host, [human, operator.id, operator.handle, 'private-handle']);
    expect(page.host.textContent).toContain('The creation review was interrupted before anything was sent.');
    await flush(() => pending.resolve(automatedOperatorPage(human, operator)));
    expectPrivateViewCleared(page.host, [human, operator.id, operator.handle, 'private-handle']);
    expect(page.host.textContent).toContain('The creation review was interrupted before anything was sent.');
  } finally {
    globalThis.fetch = fetch;
  }
});

test('a native completion released after pagehide stays generic and cannot navigate or restore details', async () => {
  const page = await open(<AutomatedAccountCreatePage />, session);
  await review(page);
  await flush(() => page.host.querySelector<HTMLInputElement>('#automated-confirm')!.click());
  await flush(() => send(page.host));
  const approve = page.calls.at(-1)!;
  await flush(() => approve.resolve(approval()));
  const execute = page.calls.at(-1)!;
  expect(execute.path).toBe('/account-operations/execute');

  await flush(leave);
  expect(page.host.textContent).toContain('A creation may have been sent; its result remains unresolved.');
  await flush(() => execute.resolve(Response.json({ accountId: created })));
  expect(page.host.textContent).toContain('A creation may have been sent; its result remains unresolved.');
  expectPrivateViewCleared(page.host, [human, operator.id, operator.handle, 'private-handle', created]);
  expect(page.host.querySelector('a[href="/security"]')).not.toBeNull();
  expect(page.host.querySelector('a[href="/"]')).not.toBeNull();
  expect(page.calls.filter((call) => call.path === '/account-operations/execute')).toHaveLength(1);
  expect(restoreAutomatedAttempt()).toMatchObject({ submitted: true });
});

test('pagehide clears credentials from an interrupted authentication review', async () => {
  const ordinary = { ...session, client_id: 'login', scope: [] as string[] };
  const page = await open(<AutomatedAccountCreatePage />, ordinary);
  await flush(() => {
    fill(page.host.querySelector('#automated-operator')!, operator.id);
    fill(page.host.querySelector('#automated-handle')!, 'private-handle');
    send(page.host);
  });
  await flush(() => {
    fill(page.host.querySelector('#automated-email')!, 'person@example.com');
    fill(page.host.querySelector('#automated-password')!, 'private-password');
  });
  await flush(leave);
  expectPrivateViewCleared(page.host, [
    human,
    operator.id,
    operator.handle,
    'private-handle',
    'person@example.com',
    'private-password',
  ]);
  expect(page.host.textContent).toContain('The creation review was interrupted before anything was sent.');
});
