import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { creationFixture, approval, button, dom, fill, flush, open, send } from './creation-page-fixture';
import { OperatorSessionOpeningPage } from '../src/routes/automated.open';
import * as opening from '../src/operator-session-opening';
import {
  markManagementOperationReturned,
  readPendingManagementOperationStepUp,
} from '../src/management-operation-step-up';
import { managementOperationProfile } from '../src/management-operations';

creationFixture();
const human = '11111111-1111-4111-8111-111111111111';
const operator = '22222222-2222-4222-8222-222222222222';
const subject = '33333333-3333-4333-8333-333333333333';
const operation = { kind: 'opening' as const, operatorAccountId: operator, subjectAccountId: subject };
const metadata = {
  kind: 'ready' as const,
  metadata: {
    viewer: { accountId: human, publicLabel: null },
    subject: { id: subject, kind: 'actor' as const, publicLabel: null },
    operator: { id: operator, kind: 'organization' as const, publicLabel: null },
    relation: { reservationId: '44444444-4444-4444-8444-444444444444', version: '7' },
  },
};
const proof = (accountId: string) => ({
  account_id: accountId,
  client_id: managementOperationProfile('opening').client_id,
  scope: ['account:manage'],
  auth_time: Math.floor(Date.now() / 1000),
  authn_epoch: 0,
  amr: ['operator'],
});
let read: ReturnType<typeof spyOn<typeof opening, 'loadOpeningMetadata'>> | undefined;
let browser: ReturnType<typeof createBrowserHistory> | undefined;
afterEach(() => {
  read?.mockRestore();
  read = undefined;
  browser?.destroy();
  browser = undefined;
});

async function setup() {
  window.sessionStorage.clear();
  const session = {
    account_id: human,
    client_id: managementOperationProfile('opening').client_id,
    scope: ['account:manage'],
    auth_time: Math.floor(Date.now() / 1000),
    authn_epoch: 0,
    amr: ['pwd'],
  };
  read = spyOn(opening, 'loadOpeningMetadata').mockResolvedValue(metadata);
  const root = createRootRoute();
  const routeTree = root.addChildren(
    ['/automated/open', '/security'].map((path) => createRoute({ getParentRoute: () => root, path })),
  );
  window.history.replaceState(null, '', '/automated/open');
  browser = createBrowserHistory({ window: dom });
  const router = createRouter({ routeTree, history: browser });
  const page = await open(
    <RouterContextProvider router={router}>
      <OperatorSessionOpeningPage />
    </RouterContextProvider>,
    session,
  );
  const click = (label: string) => flush(() => button(page.host, label)!.click());
  const review = async () => {
    await flush(() => {
      fill(page.host.querySelector<HTMLInputElement>('#opening-subject')!, subject);
      fill(page.host.querySelector<HTMLInputElement>('#opening-operator')!, operator);
    });
    await flush(() => send(page.host));
  };
  return { ...page, router, session, click, review };
}

async function submitUnconfirmed(page: Awaited<ReturnType<typeof setup>>) {
  await page.review();
  await flush(() => page.host.querySelector<HTMLInputElement>('#opening-confirm')!.click());
  await flush(() => send(page.host));
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(new Response(null, { status: 503 })));
  return readPendingManagementOperationStepUp();
}

test('native acknowledgement stays as generic history after cached retirement', async () => {
  const page = await setup();
  await page.review();
  await flush(() => page.host.querySelector<HTMLInputElement>('#opening-confirm')!.click());
  await flush(() => send(page.host));
  await flush(() => page.calls[0]!.resolve(approval()));
  await flush(() => page.calls[1]!.resolve(Response.json(proof(subject))));
  expect(page.host.querySelector('#opening-current-state-heading')).not.toBeNull();
  await flush(() => transition('pagehide'));
  const summary = page.host.querySelector('#opening-return-heading')?.parentElement;
  expect(summary?.textContent).toContain('native response to the opening acknowledged the request');
  expect(summary?.textContent).not.toContain(subject);
  expect(summary?.textContent).not.toContain('account:manage');
  expect(page.host.querySelector('#opening-current-state-heading')).toBeNull();
});

test('fresh review refusal leaves the earlier unknown opening in mounted history', async () => {
  const page = await setup();
  const original = await submitUnconfirmed(page);
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    await page.click('Sign in again for a new opening');
    const fresh = readPendingManagementOperationStepUp();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(fresh).toMatchObject({ phase: 'awaiting', operation });
    expect(fresh?.operationKey).not.toBe(original?.operationKey);
    expect(markManagementOperationReturned(fresh!)).toBe(true);
    read!.mockResolvedValueOnce({ kind: 'refused' });
    await flush(() => transition('pagehide'));
    await flush(() => transition('pageshow'));
    const summary = page.host.querySelector('#opening-return-heading')?.parentElement?.textContent;
    expect(summary).toContain('outcome remains unconfirmed');
    expect(summary).toContain('opening was refused');
    expect(summary).not.toContain(subject);
    expect(page.host.querySelector('#opening-confirm')).toBeNull();
    expect(page.calls.map((call) => call.path)).toEqual(['/account-operations/approve', '/operator-sessions/open']);
  } finally {
    assign.mockRestore();
  }
});

function transition(name: 'pagehide' | 'pageshow') {
  const event = new dom.Event(name);
  if (name === 'pageshow') Object.assign(event, { persisted: true });
  window.dispatchEvent(event as unknown as Event);
}

test('cached return keeps generic unknown history, ignores a late read and separates current readback', async () => {
  const page = await setup();
  const saved = await submitUnconfirmed(page);
  expect(saved).toMatchObject({ phase: 'submitted', operation });
  await flush(() => transition('pagehide'));
  const summary = page.host.querySelector('#opening-return-heading')?.parentElement;
  expect(summary?.textContent).toContain('outcome remains unconfirmed');
  expect(document.activeElement).toBe(summary);
  expect(summary?.textContent).not.toContain(human);
  expect(summary?.textContent).not.toContain(operator);
  expect(summary?.textContent).not.toContain(subject);
  expect(page.host.querySelector('#opening-confirm')).toBeNull();

  const current = proof(subject);
  const replacement = proof(operator);
  const late = Promise.withResolvers<Response>();
  const baseFetch = globalThis.fetch;
  let readbacks = 0;
  globalThis.fetch = ((path, init) => {
    if (String(path) === '/session') {
      readbacks++;
      if (readbacks === 1) return late.promise;
      return Promise.resolve(Response.json(readbacks === 2 ? replacement : current));
    }
    return baseFetch(path, init);
  }) as typeof fetch;

  await flush(() => transition('pageshow'));
  expect(readbacks).toBe(1);
  await flush(() => transition('pagehide'));
  await flush(() => late.resolve(Response.json(current)));
  expect(page.host.querySelector('#opening-current-state-heading')).toBeNull();
  expect(page.host.querySelector('#opening-return-heading')).not.toBeNull();

  await flush(() => transition('pageshow'));
  expect(readbacks).toBe(2);
  expect(page.host.querySelector('#opening-current-state-heading')).toBeNull();
  expect(page.host.textContent).toContain('Check current session');
  await page.click('Check current session');
  expect(readbacks).toBe(3);
  expect(page.host.querySelector('#opening-current-state-heading')?.textContent).toContain('Current operated session');
  expect(page.host.textContent).toContain('does not prove that the earlier request created it');
  expect(page.host.querySelector('#opening-return-heading')?.textContent).not.toContain(subject);
  expect(read).toHaveBeenCalledTimes(2);
  expect(page.calls.map((call) => call.path)).toEqual(['/account-operations/approve', '/operator-sessions/open']);
  expect(readPendingManagementOperationStepUp()).toEqual(saved);
  await page.click('Dismiss history');
  expect(page.host.querySelector('#opening-return-heading')).toBeNull();
  const currentState = page.host.querySelector('#opening-current-state-heading');
  expect(currentState).not.toBeNull();
  expect(document.activeElement).toBe(currentState);
});

for (const marker of ['absent', 'malformed'] as const)
  test(`${marker} continuation closes exact recovery without clearing cached unknown history`, async () => {
    const page = await setup();
    await submitUnconfirmed(page);
    await flush(() => transition('pagehide'));
    if (marker === 'absent') window.sessionStorage.clear();
    else window.sessionStorage.setItem('rezics.management-operation.step-up', '{');
    await flush(() => transition('pageshow'));
    expect(page.host.querySelector('#opening-return-heading')).not.toBeNull();
    expect(page.host.querySelector('#opening-confirm')).toBeNull();
    expect(page.host.querySelector<HTMLInputElement>('#opening-subject')?.value).toBe('');
    expect(page.host.querySelector<HTMLInputElement>('#opening-operator')?.value).toBe('');
    expect(page.host.querySelector('#opening-return-heading')?.textContent).not.toContain(subject);
    expect(read).toHaveBeenCalledTimes(2);
    expect(page.calls.map((call) => call.path)).toEqual(['/account-operations/approve', '/operator-sessions/open']);
  });
