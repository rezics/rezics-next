import { expect, test } from 'bun:test';
import { creationFixture, approval, button, dom, fill, flush, open, send } from './creation-page-fixture';
import { AutomatedAccountCreatePage } from '../src/routes/automated.new';
import { AUTOMATED_PROFILE, restoreAutomatedAttempt } from '../src/automated-account-create';
const { createBrowserHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
  await import('@tanstack/react-router');
creationFixture();
const human = '11111111-1111-4111-8111-111111111111';
const operator = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'organization',
  handle: 'team',
  displayName: null,
};
const session = {
  account_id: human,
  client_id: AUTOMATED_PROFILE.client_id,
  scope: AUTOMATED_PROFILE.scope,
  auth_time: Math.floor(Date.now() / 1000),
  authn_epoch: 1,
  amr: ['pwd'],
};
async function start() {
  window.history.replaceState(null, '', '/automated/new');
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: '/automated/new',
    component: AutomatedAccountCreatePage,
  });
  const away = createRoute({ getParentRoute: () => root, path: '/away', component: () => <p>Destination</p> });
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ history, routeTree: root.addChildren([route, away]) });
  await router.load();
  const page = await open(<RouterProvider router={router} />, session);
  const click = (text: string) => flush(() => button(page.host, text)!.click());
  const navigate = () =>
    flush(() => {
      void router.navigate({ to: '/away' });
    });
  const draft = () =>
    flush(() => {
      fill(page.host.querySelector('#automated-operator')!, operator.id);
      fill(page.host.querySelector('#automated-handle')!, 'robot-one');
    });
  const review = async () => {
    await draft();
    await flush(() => send(page.host));
    await flush(() => page.calls[0]!.resolve(Response.json(operator)));
  };
  return { ...page, router, click, navigate, draft, review };
}
function unloadWarns() {
  const event = new dom.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event as unknown as Event);
  return event.defaultPrevented;
}
test('clean visits do not warn; changed input survives Stay with focus and remains editable', async () => {
  const page = await start();
  expect(unloadWarns()).toBe(false);
  await page.draft();
  const input = page.host.querySelector<HTMLInputElement>('#automated-handle')!;
  input.focus();
  expect(unloadWarns()).toBe(true);
  await page.navigate();
  await page.click('Stay');
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('robot-one');
  expect(page.host.querySelector<HTMLInputElement>('#automated-operator')!.value).toBe(operator.id);
  await flush(() => fill(input, 'robot-two'));
  expect(input.value).toBe('robot-two');
  await page.navigate();
  await page.click('Leave');
  expect(page.host.textContent).toContain('Destination');
  expect(unloadWarns()).toBe(false);
});
test('Stay preserves the exact review and confirmation; Leave discards an unsent review', async () => {
  const page = await start();
  await page.review();
  const attempt = restoreAutomatedAttempt();
  await flush(() => page.host.querySelector<HTMLInputElement>('#automated-confirm')!.click());
  await page.navigate();
  await page.click('Stay');
  expect(restoreAutomatedAttempt()).toEqual(attempt);
  expect(page.host.querySelector<HTMLInputElement>('#automated-confirm')!.checked).toBe(true);
  await page.navigate();
  await page.click('Leave');
  expect(restoreAutomatedAttempt()).toBeNull();
});
test('Leave retains an unresolved command and retires its late approval before replacement work', async () => {
  const page = await start();
  await page.review();
  await flush(() => page.host.querySelector<HTMLInputElement>('#automated-confirm')!.click());
  await flush(() => send(page.host));
  const attempt = restoreAutomatedAttempt();
  await page.navigate();
  await page.click('Leave');
  expect(restoreAutomatedAttempt()).toEqual(attempt);
  await flush(() => {
    void page.router.navigate({ to: '/automated/new' });
  });
  expect(page.host.textContent).toContain('robot-one');
  await flush(() => page.calls[1]!.resolve(approval()));
  expect(restoreAutomatedAttempt()).toEqual(attempt);
  expect(page.calls).toHaveLength(2);
  expect(page.host.querySelector<HTMLInputElement>('#automated-confirm')!.checked).toBe(false);
});
