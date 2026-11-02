import { expect, spyOn, test } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { creationFixture, approval, button, dom, fill, flush, open, send, session } from './creation-page-fixture';
import { OrganizationDeleteContent } from '../src/routes/organizations.delete';
import { readOrganizationDeleteStepUp, readOrganizationDeleteUnknown } from '../src/organization-delete-step-up';
import type { OrganizationDeletionRead, OrganizationDeletionReader } from '../src/organization-deletion';

creationFixture();
const human = '10000000-0000-0000-0000-000000000000';
const first = '20000000-0000-0000-0000-000000000000';
const second = '30000000-0000-0000-0000-000000000000';
const body = { account_id: human, client_id: session('delete').clientId, scope: session('delete').scopes };
const ready = (id: string): OrganizationDeletionRead => ({
  kind: 'ready',
  account: { id, kind: 'organization', handle: id === first ? 'first' : 'second', displayName: null },
});

async function setup(read: OrganizationDeletionReader = async ({ organizationId }) => ready(organizationId)) {
  const root = createRootRoute();
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/organizations/delete' }),
    createRoute({ getParentRoute: () => root, path: '/away' }),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/organizations/delete'] }) });
  const view = (id = first, reader = read) => (
    <RouterContextProvider router={router}>
      <OrganizationDeleteContent
        organizationId={id}
        privacyContact="mailto:privacy@example.test"
        read={reader}
      />
    </RouterContextProvider>
  );
  const page = await open(view(), body);
  const navigate = (to = '/away') => flush(() => void router.navigate({ to }));
  const choose = (label: string) => flush(() => button(document.body, label)!.click());
  const unload = () => {
    const event = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  return { ...page, router, view, navigate, choose, unload, input: page.host.querySelector<HTMLInputElement>('input')! };
}

test('clean review leaves freely', async () => {
  const page = await setup();
  expect(page.unload()).toBe(false);
  await page.navigate();
  expect(page.router.history.location.pathname).toBe('/away');
});

test('Stay keeps typed confirmation and Leave discards it', async () => {
  const page = await setup();
  page.input.focus();
  await flush(() => fill(page.input, '@first'));
  expect(page.unload()).toBe(true);
  await page.navigate();
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await page.choose('Stay');
  expect(page.router.history.location.pathname).toBe('/organizations/delete');
  expect(page.input.value).toBe('@first');
  expect(document.activeElement).toBe(page.input);
  expect(page.host.textContent).toContain(first);
  await page.navigate();
  await page.choose('Leave');
  expect(page.router.history.location.pathname).toBe('/away');
  expect(page.host.querySelector('form')).toBeNull();
  expect(page.unload()).toBe(false);
});

test('Leave retires callbacks but keeps the identity of an uncertain dispatched command', async () => {
  const page = await setup();
  await flush(() => {
    fill(page.input, '@first');
    send(page.host);
  });
  await flush(() => page.calls[0]!.resolve(approval()));
  const operationKey = page.calls[0]!.body.operationKey as string;
  await page.navigate();
  await page.choose('Stay');
  expect(page.input.value).toBe('@first');
  expect(page.calls).toHaveLength(2);
  await page.navigate();
  await page.choose('Leave');
  expect(page.router.history.location.pathname).toBe('/away');
  await flush(() => page.calls[1]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  expect(page.calls).toHaveLength(2);
  expect(readOrganizationDeleteUnknown(first)).toMatchObject({
    kind: 'pending',
    value: { humanAccountId: human, organizationId: first, operationKey },
  });
});

test('accepted deletion releases an open departure prompt', async () => {
  const page = await setup();
  await flush(() => {
    fill(page.input, '@first');
    send(page.host);
  });
  await flush(() => page.calls[0]!.resolve(approval()));
  await page.navigate();
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await flush(() => page.calls[1]!.resolve(Response.json({ accountId: first })));
  expect(page.router.history.location.pathname).toBe('/away');
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(page.host.textContent).toContain('command was accepted');
  expect(page.unload()).toBe(false);
});

test('changed target releases the old review prompt immediately', async () => {
  const page = await setup();
  await flush(() => fill(page.input, '@first'));
  await page.navigate();
  await page.render(page.view(second));
  expect(page.router.history.location.pathname).toBe('/away');
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(page.unload()).toBe(false);
});

test('lost authority releases an open prompt without sending a native command', async () => {
  const lost = Promise.withResolvers<OrganizationDeletionRead>();
  let reads = 0;
  const page = await setup(async ({ organizationId }) => (++reads === 2 ? lost.promise : ready(organizationId)));
  await flush(() => {
    fill(page.input, '@first');
    send(page.host);
  });
  await page.navigate();
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await flush(() => lost.resolve({ kind: 'denied' }));
  expect(page.router.history.location.pathname).toBe('/away');
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(page.calls).toHaveLength(0);
  expect(page.unload()).toBe(false);
});

test('step-up navigation bypasses the departure warning and keeps its continuation', async () => {
  const page = await setup();
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    await flush(() => {
      fill(page.input, '@first');
      send(page.host);
    });
    await flush(() => page.calls[0]!.resolve(Response.json({ error: 'step_up_required' }, { status: 401 })));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(readOrganizationDeleteStepUp().kind).toBe('pending');
    expect(page.unload()).toBe(false);
  } finally {
    assign.mockRestore();
  }
});
