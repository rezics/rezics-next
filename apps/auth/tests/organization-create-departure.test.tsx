import { expect, spyOn, test } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { creationFixture, approval, button, dom, fill, flush, open, send, session } from './creation-page-fixture';
import { NewOrganizationPage } from '../src/routes/organizations.new';
import { readPendingAccountOperationStepUp } from '../src/account-operation-step-up';
import { readPendingOrganizationHandle } from '../src/account-operations';
creationFixture();
const initial = session('organization');
const body = { account_id: initial.accountId, client_id: initial.clientId, scope: initial.scopes };
async function setup() {
  const root = createRootRoute();
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/organizations/new' }),
    createRoute({ getParentRoute: () => root, path: '/security' }),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/organizations/new'] }) });
  const view = (value = initial) => (
    <RouterContextProvider router={router}>
      <NewOrganizationPage initial={value} />
    </RouterContextProvider>
  );
  const page = await open(view(), body);
  const navigate = () =>
    flush(() => {
      void router.navigate({ to: '/security' });
    });
  const unload = () => {
    const event = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  const choose = (label: string) => flush(() => button(document.body, label)!.click());
  return { ...page, router, view, navigate, unload, choose, input: page.host.querySelector('input')! };
}
test('changed draft warns; Stay preserves invalid input, feedback and usable focus; Leave discards it', async () => {
  const page = await setup();
  page.input.focus();
  expect(page.unload()).toBe(false);
  await flush(() => fill(page.input, 'bad!'));
  await flush(() => send(page.host));
  const feedback = page.host.querySelector('[aria-invalid="true"]')?.getAttribute('aria-describedby');
  expect(feedback).toContain('organization-handle-error');
  expect(page.unload()).toBe(true);
  await page.navigate();
  expect(page.router.history.location.pathname).toBe('/organizations/new');
  expect(document.body.innerHTML).toContain('Leave organization creation?');
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await page.choose('Stay');
  expect(page.router.history.location.pathname).toBe('/organizations/new');
  expect(page.input.value).toBe('bad!');
  expect(page.input.getAttribute('aria-describedby')).toBe(feedback);
  expect(document.activeElement).toBe(page.input);
  await flush(() => fill(page.input, 'team-alpha'));
  await page.navigate();
  await page.choose('Leave');
  expect(page.router.history.location.pathname).toBe('/security');
  expect(readPendingOrganizationHandle()).toBe('');
  expect(page.unload()).toBe(false);
});
test('Stay retains unresolved command identity; Leave retires late approval and preserves original recovery', async () => {
  const page = await setup();
  await flush(() => fill(page.input, 'team-alpha'));
  await flush(() => send(page.host));
  const original = readPendingAccountOperationStepUp();
  expect(original).not.toBeNull();
  await page.navigate();
  await page.choose('Stay');
  expect(readPendingAccountOperationStepUp()).toEqual(original);
  expect(page.input.readOnly).toBe(true);
  await page.navigate();
  await page.choose('Leave');
  await flush(() => page.calls[0]!.resolve(approval()));
  expect(page.calls).toHaveLength(1);
  expect(readPendingAccountOperationStepUp()).toEqual(original);
  await page.render(page.view({ ...initial }));
  await flush(() => send(page.host));
  expect(page.calls[1]!.body.operationKey).toBe(original!.operationKey);
});
test('step-up continuation and completed destination bypass departure warnings', async () => {
  const page = await setup();
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    await flush(() => fill(page.input, 'team-alpha'));
    await flush(() => send(page.host));
    await flush(() => page.calls[0]!.resolve(Response.json({ error: 'step_up_required' }, { status: 401 })));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(page.unload()).toBe(false);
    await page.render(page.view({ ...initial }));
    await flush(() => send(page.host));
    await flush(() => page.calls[1]!.resolve(approval()));
    await flush(() => page.calls[2]!.resolve(Response.json({ accountId: 'created-organization' })));
    expect(page.host.textContent).toContain('@team-alpha');
    expect(page.unload()).toBe(false);
    await page.navigate();
    expect(page.router.history.location.pathname).toBe('/security');
  } finally {
    assign.mockRestore();
  }
});
