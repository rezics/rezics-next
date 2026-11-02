import { expect, spyOn, test } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { creationFixture, approval, button, dom, fill, flush, open, send, session } from './creation-page-fixture';
import { DeleteAccountContent } from '../src/routes/account.delete';
import { emptyInventory } from '../src/stories/accounts-operations/story';
import { readPendingAccountOperationStepUp } from '../src/account-operation-step-up';
creationFixture();
const initial = session('delete');
const body = { account_id: initial.accountId, client_id: initial.clientId, scope: initial.scopes };
const props = {
  privacyContact: 'mailto:privacy@example.test',
  inventorySource: emptyInventory,
  identitySource: async () => ({ kind: 'unavailable' as const }),
};
async function setup() {
  const root = createRootRoute();
  const routeTree = root.addChildren(
    ['/account/delete', '/security'].map((path) => createRoute({ getParentRoute: () => root, path })),
  );
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/account/delete'] }) });
  const view = (value = initial, source = props.identitySource) => (
    <RouterContextProvider router={router}>
      <DeleteAccountContent {...props} initial={value} identitySource={source} />
    </RouterContextProvider>
  );
  const page = await open(view(), body);
  const navigate = () =>
    flush(() => {
      void router.navigate({ to: '/security' });
    });
  const choose = (label: string) => flush(() => button(document.body, label)!.click());
  const unload = () => {
    const event = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  const type = (value = 'delete my account') => flush(() => fill(page.host.querySelector('input')!, value));
  return { ...page, router, view, navigate, choose, unload, type };
}
test('clean input leaves freely; Stay keeps the exact invalid confirmation, feedback and keyboard focus', async () => {
  const page = await setup();
  await page.type('   ');
  expect(page.unload()).toBe(false);
  await page.navigate();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await flush(() => {
    void page.router.navigate({ to: '/account/delete' });
  });
  await page.type('  unfinished DELETE  ');
  await flush(() => send(page.host));
  const input = page.host.querySelector('input')!;
  const feedback = input.getAttribute('aria-describedby');
  expect(feedback).toBe('account-delete-confirmation-error');
  expect(page.unload()).toBe(true);
  await flush(() => page.host.querySelector<HTMLAnchorElement>('a[href="/security"]')!.click());
  expect(page.router.history.location.pathname).toBe('/account/delete');
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await page.choose('Stay');
  expect(input.value).toBe('  unfinished DELETE  ');
  expect(input.getAttribute('aria-describedby')).toBe(feedback);
  expect(document.activeElement).toBe(input);
  await page.navigate();
  await page.choose('Leave');
  expect(page.router.history.location.pathname).toBe('/security');
  expect(page.host.querySelector('input')).toBeNull();
  expect(page.unload()).toBe(false);
  expect(page.calls).toHaveLength(0);
});
test('Stay preserves unresolved deletion; Leave retires late execution and recovery keeps the original command', async () => {
  const page = await setup();
  await page.type();
  await flush(() => send(page.host));
  const original = readPendingAccountOperationStepUp()!;
  await page.navigate();
  await page.choose('Stay');
  expect(document.activeElement).toBe(page.host.querySelector('form'));
  expect(page.host.querySelector('input')!.value).toBe('delete my account');
  expect(readPendingAccountOperationStepUp()).toEqual(original);
  await flush(() => page.calls[0]!.resolve(approval()));
  await page.navigate();
  await page.choose('Leave');
  await flush(() => page.calls[1]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  expect(page.calls).toHaveLength(2);
  expect(readPendingAccountOperationStepUp()).toEqual(original);
  await page.render(page.view({ ...initial }));
  expect(page.host.querySelector('input')!.value).toBe('');
  expect(page.unload()).toBe(true);
  await page.type();
  await flush(() => send(page.host));
  expect(page.calls[2]!.body).toEqual({ operationKey: original.operationKey, operation: original.operation });
});
test('intended step-up and accepted deletion leave freely; unknown outcomes warn without typed input', async () => {
  const page = await setup();
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    await page.type();
    await flush(() => send(page.host));
    await flush(() => page.calls[0]!.resolve(Response.json({ error: 'step_up_required' }, { status: 401 })));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(page.unload()).toBe(false);
    const original = readPendingAccountOperationStepUp()!;
    await page.render(page.view({ ...initial }));
    await page.type();
    await flush(() => send(page.host));
    expect(page.calls[1]!.body.operationKey).toBe(original.operationKey);
    await flush(() => page.calls[1]!.resolve(approval()));
    await flush(() => page.calls[2]!.resolve(Response.json({ error: 'timeout' }, { status: 503 })));
    expect(page.host.querySelector('input')!.value).toBe('');
    expect(page.unload()).toBe(true);
    await page.type();
    await flush(() => send(page.host));
    await flush(() => page.calls[3]!.resolve(approval()));
    await flush(() => page.calls[4]!.resolve(Response.json({ accountId: initial.accountId })));
    expect(page.unload()).toBe(false);
    await page.navigate();
    expect(page.router.history.location.pathname).toBe('/security');
    expect(readPendingAccountOperationStepUp()).toBeNull();
  } finally {
    assign.mockRestore();
  }
});
test.each(['replacement', 'permission'] as const)(
  '%s immediately releases the prompt and retires approval',
  async (kind) => {
    const page = await setup();
    await page.type();
    await flush(() => send(page.host));
    await page.navigate();
    if (kind === 'replacement') await page.render(page.view({ kind: 'signed-out' }));
    else await page.render(page.view(initial, async () => ({ kind: 'denied' as never })));
    expect(page.unload()).toBe(false);
    expect(page.router.history.location.pathname).toBe('/security');
    await flush(() => page.calls[0]!.resolve(approval()));
    expect(page.calls).toHaveLength(1);
  },
);
