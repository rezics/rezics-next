import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { SecurityActionResult, SecurityReadback, SecurityTarget } from '../src/security-reconciliation';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/security' });
const globals = {
  ...Object.fromEntries(
    ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event'].map((key) => [
      key,
      dom[key as keyof typeof dom],
    ]),
  ),
  getComputedStyle: dom.getComputedStyle.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
  PublicKeyCredential: class {},
};
const original = new Map(
  [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { SecurityPage } = await import('../src/routes/security');
const { initial } = await import('../src/stories/accounts-security/security/security.stories');
const { emptyInventory, fill, button } = await import('../src/stories/accounts-operations/story');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
overwriteGetLocale(() => 'en');
const identitySource = async () => ({ kind: 'unavailable' as const });
const flush = (action: () => void) => act(async () => action());
const deferred = <T,>() => Promise.withResolvers<T>();
let host: HTMLDivElement, root: Root;
let calls: unknown[];
let requestBodies: unknown[];
let response: ReturnType<typeof deferred<Response>>, prompt: ReturnType<typeof deferred<Credential | null>>;
let action: ReturnType<typeof deferred<SecurityActionResult>>, read: ReturnType<typeof deferred<SecurityReadback>>;
const source = {
  act: (target: SecurityTarget) => {
    calls.push(target);
    return action.promise;
  },
  read: () => read.promise,
};
const props = { identitySource, inventorySource: emptyInventory, securitySource: source };
const render = (value = initial) => flush(() => root.render(<SecurityPage initial={value} {...props} />));
const click = (label: string) => button(host, label)!.click();
const writes = () => [...host.querySelectorAll<HTMLButtonElement>('form button[type="submit"], li button')];
const submit = (index: number) =>
  host
    .querySelectorAll('form')
    [index]!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
afterEach(async () => {
  await flush(() => root.unmount());
  host.remove();
});
afterAll(async () => {
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});
async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  requestBodies = [];
  action = deferred();
  read = deferred();
  response = deferred();
  prompt = deferred();
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create: () => prompt.promise } });
  window.confirm = () => true;
  globalThis.fetch = (async (path, init) => {
    calls.push(String(path));
    if (path === '/passkeys/register/options')
      return Response.json({
        challenge: 'Y2hhbGxlbmdl',
        rp: { id: 'auth.test', name: 'REZICS' },
        user: { id: 'YWNjb3VudA', name: 'reader', displayName: 'Reader' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      });
    if (String(path).startsWith('/credential-effects/'))
      requestBodies.push(JSON.parse(String(init?.body)));
    return response.promise;
  }) as typeof fetch;
  await render();
}

test('a reviewed password change blocks competing writes and duplicate confirmation starts one attempt', async () => {
  await mount();
  await flush(() => {
    fill(host.querySelector('#security-new-password')!, 'a secure password');
    fill(host.querySelector('#security-confirm-password')!, 'a secure password');
    submit(0);
  });
  expect(calls).toHaveLength(0);
  expect(writes().every((control) => control.disabled)).toBe(true);
  await flush(() => {
    const confirm = button(host, m.auth_security_password_confirm())!;
    confirm.click();
    confirm.click();
  });
  expect(writes().every((control) => control.disabled)).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBe('/credential-effects/stage');
  await flush(() =>
    response.resolve(Response.json({ error: 'credential_effect_denied', effect_status: 'not_applied' }, { status: 409 })),
  );
  expect(writes().every((control) => !control.disabled)).toBe(true);
});

test('a passkey prompt holds the boundary while password review and duplicate prompt submissions are ignored', async () => {
  await mount();
  await flush(() => {
    fill(host.querySelector('#security-new-password')!, 'a secure password');
    fill(host.querySelector('#security-confirm-password')!, 'a secure password');
    submit(1);
    submit(1);
    submit(0);
  });
  expect(writes().every((control) => control.disabled)).toBe(true);
  expect(calls).toEqual(['/passkeys/register/options']);
  await flush(() =>
    response.resolve(
      Response.json({
        challenge: 'Y2hhbGxlbmdl',
        rp: { id: 'auth.test', name: 'REZICS' },
        user: { id: 'YWNjb3VudA', name: 'reader', displayName: 'Reader' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      }),
    ),
  );
  await flush(() => {
    submit(1);
    submit(0);
  });
  expect(calls).toHaveLength(1);
  await flush(() => prompt.reject(Object.assign(new Error('dismissed'), { name: 'NotAllowedError' })));
  expect(writes().every((control) => !control.disabled)).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test('uncertain revocation holds the exact target through readback and retry, then returns to idle', async () => {
  await mount();
  await flush(() => click(m.auth_security_sign_out()));
  await flush(() => click(m.auth_security_confirm_session()));
  await flush(() => action.resolve({ kind: 'unknown' }));
  await flush(() => {
    submit(0);
    submit(1);
  });
  expect(calls).toHaveLength(1);
  expect(writes().every((control) => control.disabled)).toBe(true);
  await flush(() => click(m.auth_security_check_current()));
  const sessions = initial.kind === 'ready' ? initial.sessions : [];
  await flush(() => read.resolve({ kind: 'ready', presence: 'present', sessions, passkeys: null }));
  action = deferred();
  read = deferred();
  await flush(() => click(m.auth_security_retry_action()));
  await flush(() => click(m.auth_security_confirm_session()));
  expect(calls[1]).toEqual(calls[0]);
  await flush(() => action.resolve({ kind: 'unknown' }));
  expect(button(host, m.auth_security_retry_action())).toBeUndefined();
  await flush(() => click(m.auth_security_check_current()));
  await flush(() => read.resolve({ kind: 'ready', presence: 'absent', sessions: [], passkeys: null }));
  expect(writes().every((control) => !control.disabled)).toBe(true);
  action = deferred();
  await flush(() => click(m.auth_security_passkey_remove()));
  await flush(() => click(m.auth_security_confirm_passkey()));
  await flush(() => action.resolve({ kind: 'accepted' }));
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).toContain(m.auth_security_sign_in_required());
});

test('a late action result cannot restore private state after authority changes', async () => {
  await mount();
  await flush(() => click(m.auth_security_passkey_remove()));
  await flush(() => click(m.auth_security_confirm_passkey()));
  await render({ kind: 'signed-out' });
  await flush(() => action.resolve({ kind: 'unknown' }));
  expect(host.querySelector('form')).toBeNull();
  expect(button(host, m.auth_security_check_current())).toBeUndefined();
});

test('a late password stage reply from the previous account cannot advance or publish completion', async () => {
  await mount();
  await flush(() => {
    fill(host.querySelector('#security-new-password')!, 'a secure password');
    fill(host.querySelector('#security-confirm-password')!, 'a secure password');
    submit(0);
  });
  await flush(() => click(m.auth_security_password_confirm()));
  expect(calls).toEqual(['/credential-effects/stage']);
  const stage = requestBodies[0] as { key: string; subjectId: string };
  await render({ kind: 'signed-out' });
  await flush(() =>
    response.resolve(
      Response.json({
        effectRef: 'effect-ref',
        key: stage.key,
        subjectId: stage.subjectId,
        purpose: 'set-password',
        digest: 'a'.repeat(64),
      }),
    ),
  );
  expect(calls).toEqual(['/credential-effects/stage']);
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).not.toContain(m.auth_security_password_changed());
  expect(host.querySelector('a[href="/login"]')).not.toBeNull();
});
