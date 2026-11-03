import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { SecurityActionResult } from '../src/security-reconciliation';
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/security' });
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  PublicKeyCredential: class {},
  getComputedStyle: dom.getComputedStyle.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const original = new Map(
  [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { SecurityPage } = await import('../src/routes/security');
const { initial, Denied } = await import('../src/stories/accounts-security/security/security.stories');
const { populatedInventory, button, fill } = await import('../src/stories/accounts-operations/story');
const { m } = await import('../src/paraglide/messages.js');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');
let host: HTMLDivElement, root: Root, calls: { path: string; body: unknown }[];
let response: ReturnType<typeof Promise.withResolvers<Response>>;
let action: ReturnType<typeof Promise.withResolvers<SecurityActionResult>>;
const flush = (fn: () => void) => act(async () => fn());
const control = (label: string) => button(host, label)!;
const choose = () => control(m.auth_inventory_remove_named({ name: 'Reading companion' })).click();
const writes = () => [
  ...host.querySelectorAll<HTMLButtonElement>(
    'form button[type="submit"], #security-sessions-heading ~ * button, #security-passkeys-heading ~ * li button',
  ),
];
const submit = () =>
  host
    .querySelector('form')!
    .dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
afterEach(async () => {
  await flush(() => root.unmount());
  host.remove();
});
afterAll(async () => {
  for (const [key, descriptor] of original)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  await dom.happyDOM.close();
});
async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  response = Promise.withResolvers<Response>();
  action = Promise.withResolvers<SecurityActionResult>();
  globalThis.fetch = (async (path, init) => {
    calls.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : null });
    return response.promise;
  }) as typeof fetch;
  window.confirm = () => true;
  await flush(() =>
    root.render(
      <SecurityPage
        initial={initial}
        inventorySource={populatedInventory}
        identitySource={async () => ({ kind: 'unavailable' })}
        securitySource={{ act: () => action.promise, read: async () => ({ kind: 'unavailable' }) }}
      />,
    ),
  );
  await flush(() => fill(host.querySelector('#security-new-password')!, 'a secure password'));
}

test('denied security story preserves credentials without exposing connected applications', async () => {
  await mount();
  await flush(() => root.render(Denied.render()));
  expect(host.textContent).toContain(m.auth_inventory_denied());
  expect(host.textContent).toContain('Security key');
  expect(host.textContent).not.toContain('Reading companion');
});

test.each([200, 401, 403, 503])('consent review serializes security writes and preserves native %i', async (status) => {
  await mount();
  await flush(choose);
  expect(writes().every((item) => item.disabled)).toBe(true);
  const reloads = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
    (item) => item.textContent === m.auth_inventory_reload(),
  );
  expect(reloads.map((item) => item.disabled)).toEqual([false, true]);
  await flush(() => reloads[0]!.click());
  expect(control(m.auth_inventory_remove()).disabled).toBe(false);
  await flush(() => control(m.auth_inventory_cancel()).click());
  expect(writes().every((item) => !item.disabled)).toBe(true);
  await flush(() => {
    choose();
    submit();
  }); // Acquisition precedes the next React render.
  const confirm = control(m.auth_inventory_remove());
  await flush(() => {
    confirm.click();
    confirm.click();
    submit();
  });
  expect(calls).toEqual([{ path: '/consent', body: { client_id: 'third-party', scope: [] } }]);
  expect(writes().every((item) => item.disabled)).toBe(true);
  await flush(() =>
    response.resolve(
      Response.json(status === 200 ? { client_id: 'third-party', scope: [] } : { error: 'unavailable' }, { status }),
    ),
  );
  if (status === 200 || status === 401) {
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).not.toContain('Security key');
    if (status === 200) expect(host.textContent).toContain(m.auth_inventory_reduced());
  } else {
    expect(host.textContent).toContain(status === 503 ? m.auth_inventory_unknown() : m.auth_inventory_denied());
    expect(writes().every((item) => item.disabled === (status === 503))).toBe(true);
    if (status === 503) await flush(submit);
  }
  expect(calls).toHaveLength(1);
});

test.each(['password', 'session'])('%s prevents a consent review without blocking owned-client reads', async (kind) => {
  await mount();
  const review = control(m.auth_inventory_remove_named({ name: 'Reading companion' }));
  await flush(() => {
    if (kind === 'password') submit();
    else control(m.auth_security_sign_out()).click();
    review.click();
  });
  expect(review.disabled).toBe(true);
  expect(host.querySelector('fieldset')).toBeNull();
  if (kind === 'session') await flush(() => action.resolve({ kind: 'unknown' }));
  expect(review.disabled).toBe(true);
  expect(control(m.auth_inventory_next()).disabled).toBe(false);
  expect(calls.map((call) => call.path)).not.toContain('/consent');
});
