import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { creationFixture, approval, button, dom, fill, flush, open, send } from './creation-page-fixture';
import { OperatorSessionOpeningPage } from '../src/routes/automated.open';
import * as opening from '../src/operator-session-opening';
import { readPendingManagementOperationStepUp } from '../src/management-operation-step-up';
import { managementOperationProfile } from '../src/management-operations';
creationFixture();
const human = '11111111-1111-4111-8111-111111111111';
const operator = '22222222-2222-4222-8222-222222222222';
const subject = '33333333-3333-4333-8333-333333333333';
const identity = (id: string) => ({ id, kind: 'actor' as const, handle: null, displayName: null });
const metadata = { kind: 'ready' as const, metadata: { subject: identity(subject), operator: identity(operator) } };
let read: ReturnType<typeof spyOn<typeof opening, 'loadOpeningMetadata'>>;
afterEach(() => read.mockRestore());
async function setup(scopes = ['account:manage']) {
  const session = {
    account_id: human,
    client_id: managementOperationProfile('opening').client_id,
    scope: scopes,
    auth_time: Math.floor(Date.now() / 1000),
    authn_epoch: 0,
    amr: ['pwd'],
  };
  read = spyOn(opening, 'loadOpeningMetadata').mockResolvedValue(metadata);
  const root = createRootRoute();
  const routeTree = root.addChildren(
    ['/automated/open', '/security'].map((path) => createRoute({ getParentRoute: () => root, path })),
  );
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/automated/open'] }) });
  const page = await open(
    <RouterContextProvider router={router}>
      <OperatorSessionOpeningPage />
    </RouterContextProvider>,
    session,
  );
  const click = (name: string) => flush(() => button(document.body, name)!.click());
  const input = (id: string) => page.host.querySelector<HTMLInputElement>(`#opening-${id}`)!;
  const navigate = (to = '/security') =>
    flush(() => {
      void router.navigate({ to });
    });
  const unload = () => {
    const event = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  const review = async () => {
    await flush(() => {
      fill(input('subject'), subject);
      fill(input('operator'), operator);
    });
    await flush(() => send(page.host));
  };
  return { ...page, session, router, click, input, navigate, unload, review };
}
test('clean input leaves freely; invalid input, feedback and keyboard focus survive Stay', async () => {
  const p = await setup();
  expect(p.unload()).toBe(false);
  await p.navigate();
  expect(p.router.history.location.pathname).toBe('/security');
  await p.navigate('/automated/open');
  await flush(() => {
    fill(p.input('subject'), 'invalid');
    fill(p.input('operator'), operator);
  });
  await flush(() => send(p.host));
  const feedback = p.host.querySelector('[role=alert]')!.textContent;
  p.input('subject').focus();
  expect(p.unload()).toBe(true);
  await p.navigate();
  expect(document.querySelector('[role=alertdialog]')).not.toBeNull();
  await p.click('Stay');
  expect(p.input('subject').value).toBe('invalid');
  expect(p.host.querySelector('[role=alert]')!.textContent).toBe(feedback);
  expect(document.activeElement).toBe(p.input('subject'));
  await p.navigate();
  await p.click('Leave');
  expect(p.router.history.location.pathname).toBe('/security');
  expect(p.unload()).toBe(false);
});
test('Stay keeps the confirmed tuple and key; submitted departure returns through readback alone', async () => {
  const p = await setup();
  await p.review();
  const selected = read.mock.calls[0]![0];
  await flush(() => p.input('confirm').click());
  p.input('confirm').focus();
  await p.navigate();
  await p.click('Stay');
  expect(p.input('confirm').checked).toBe(true);
  expect(document.activeElement).toBe(p.input('confirm'));
  expect(read).toHaveBeenCalledTimes(1);
  await flush(() => send(p.host));
  expect(p.calls[0]!.body).toEqual(selected);
  await flush(() => p.calls[0]!.resolve(approval()));
  const saved = readPendingManagementOperationStepUp();
  expect(saved).toMatchObject({ ...selected, phase: 'submitted' });
  await p.navigate();
  await p.click('Stay');
  expect(p.unload()).toBe(true);
  await p.navigate();
  await p.click('Leave');
  await flush(() => p.calls[1]!.resolve(new Response(null, { status: 503 })));
  expect(readPendingManagementOperationStepUp()).toEqual(saved);
  Object.assign(p.session, { account_id: subject, amr: ['operator'] });
  await p.navigate('/automated/open');
  expect(p.host.querySelector('[role=status]')!.textContent).toContain(subject);
  expect(p.calls).toHaveLength(2);
  expect(p.unload()).toBe(false);
});
for (const stage of ['metadata', 'approval'] as const)
  test(`Leave retires pending ${stage} without starting another stage`, async () => {
    const p = await setup();
    const late = Promise.withResolvers<opening.OpeningRead>();
    if (stage === 'metadata') read.mockReturnValueOnce(late.promise);
    await p.review();
    if (stage === 'approval') {
      await flush(() => p.input('confirm').click());
      await flush(() => send(p.host));
    }
    await p.navigate();
    await p.click('Leave');
    await flush(() => (stage === 'metadata' ? late.resolve(metadata) : p.calls[0]!.resolve(approval())));
    expect(p.calls).toHaveLength(stage === 'metadata' ? 0 : 1);
  });
for (const change of ['caller', 'scope'] as const)
  test(`${change} replacement invalidates an open review prompt without offering old authority`, async () => {
    const p = await setup();
    await p.review();
    await p.navigate();
    Object.assign(p.session, change === 'caller' ? { account_id: operator } : { scope: [] });
    await flush(() => window.dispatchEvent(new dom.Event('focus') as unknown as Event));
    expect(p.router.history.location.pathname).toBe('/security');
    expect(p.unload()).toBe(false);
    expect(p.host.querySelector('#opening-confirm')).toBeNull();
  });
test('deliberate fresh-human authentication bypasses unload warnings and retains the original tuple', async () => {
  const p = await setup([]);
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    await p.review();
    await p.click('Sign in again');
    expect(assign).toHaveBeenCalledTimes(1);
    expect(p.unload()).toBe(false);
    expect(readPendingManagementOperationStepUp()).toMatchObject({
      accountId: human,
      phase: 'awaiting',
      operation: { kind: 'opening', operatorAccountId: operator, subjectAccountId: subject },
    });
  } finally {
    assign.mockRestore();
  }
});
