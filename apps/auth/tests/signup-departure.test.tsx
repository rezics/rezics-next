import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { creationFixture, button, dom, fill, flush, open, send } from './creation-page-fixture';
import { Route } from '../src/routes/signup';
creationFixture();
const originalScroll = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
beforeAll(() => Object.defineProperty(globalThis, 'scrollTo', { value: dom.scrollTo.bind(dom), configurable: true }));
afterAll(() => {
  if (originalScroll) Object.defineProperty(globalThis, 'scrollTo', originalScroll);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});
const append = document.head.appendChild.bind(document.head);
document.head.appendChild = <T extends Node>(node: T): T => {
  if (node instanceof dom.HTMLScriptElement) (node as unknown as HTMLScriptElement).type = 'application/x-test';
  return append(node);
};
let serial = 0;
async function setup() {
  const root = createRootRoute({ component: Outlet });
  const config = { siteKey: 'key', scriptUrl: `https://challenge.test/signup-${++serial}.js` };
  const route = Route.update({
    id: '/signup',
    path: '/signup',
    getParentRoute: () => root,
    loader: () => config,
  } as never);
  const query = '?state=original&resource=one&resource=two';
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/signup${query}`] }),
  });
  await router.load();
  const page = await open(<RouterProvider router={router} />, {});
  let token!: (value: string) => void;
  window.turnstile = {
    ready: (callback) => callback(),
    render: (_element, options) => {
      token = options.callback;
      return 'widget';
    },
    reset: () => {},
    remove: () => {},
  };
  await flush(() =>
    document
      .querySelector<HTMLScriptElement>(`script[src="${config.scriptUrl}"]`)!
      .dispatchEvent(new dom.Event('load') as unknown as Event),
  );
  const input = (name: string) => page.host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const edit = (name: string, value: string) => flush(() => fill(input(name), value));
  const choose = (label: string) => flush(() => button(document.body, label)!.click());
  const navigate = () => flush(() => router.history.replace('/signup?state=new'));
  const unload = () => {
    const event = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  const submit = () => flush(() => send(page.host));
  const ready = async () => {
    await edit('handle', 'Reader_1');
    await edit('email', 'reader@example.test');
    await edit('password', 'private-password');
    await flush(() => token('fresh-token'));
    await submit();
  };
  return {
    ...page,
    query,
    router,
    input,
    edit,
    choose,
    navigate,
    unload,
    submit,
    ready,
    token: (value: string) => flush(() => token(value)),
  };
}
test('empty and whitespace-only details do not warn; Stay preserves invalid input, errors and focus', async () => {
  const p = await setup();
  p.input('handle').focus();
  expect(p.unload()).toBe(false);
  await p.edit('handle', '  ');
  await p.edit('email', '  ');
  expect(p.unload()).toBe(false);
  await p.edit('handle', 'bad!');
  await p.edit('password', ' ');
  await p.submit();
  const error = p.input('handle').getAttribute('aria-describedby');
  expect(error).toBe('signup-handle-error');
  expect(p.unload()).toBe(true);
  await flush(() => p.host.querySelector<HTMLAnchorElement>('a[href^="/login"]')!.click());
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
  expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  await p.choose('Stay');
  expect(p.router.history.location.search).toBe(p.query);
  expect(p.input('handle').value).toBe('bad!');
  expect(p.input('password').value).toBe(' ');
  expect(p.input('handle').getAttribute('aria-describedby')).toBe(error);
  expect(document.activeElement).toBe(p.input('handle'));
  await p.edit('handle', '');
  await p.edit('email', '');
  expect(p.unload()).toBe(true); // Even a whitespace password is private entered data.
  await p.navigate();
  await p.choose('Leave');
  expect(p.input('password').value).toBe('');
  expect(p.unload()).toBe(false);
});
test('Stay retains a pending creation and retry key; Leave fences late creation and clears secrets', async () => {
  const p = await setup();
  await p.ready();
  await p.navigate();
  await p.choose('Stay');
  expect(p.input('password').value).toBe('private-password');
  await flush(() => p.calls[0]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  await p.submit();
  expect(p.calls).toHaveLength(1); // A failed request consumes its token.
  await p.token('retry-token');
  await p.submit();
  expect(p.calls[1]!.body.key).toBe(p.calls[0]!.body.key);
  expect(p.calls[1]!.body.turnstile_token).toBe('retry-token');
  const secret = p.input('password');
  await p.navigate();
  await p.choose('Leave');
  expect(secret.value).toBe('');
  await flush(() => p.calls[1]!.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  expect(p.calls).toHaveLength(2);
  expect(p.input('password').value).toBe('');
  expect(p.unload()).toBe(false);
});
