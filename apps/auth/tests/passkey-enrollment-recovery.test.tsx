import { afterAll, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import type { PasskeyRegistrationReview } from '../src/security';
import { creationFixture, dom, flush, open, button } from './creation-page-fixture';

creationFixture();
const additions = { getComputedStyle: dom.getComputedStyle.bind(dom), PublicKeyCredential: class {} };
const originals = new Map(Object.keys(additions).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(additions))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const { SecurityPage } = await import('../src/routes/security');
const { initial } = await import('../src/stories/accounts-security/security/security.stories');
const { emptyInventory } = await import('../src/stories/accounts-operations/story');
const { m } = await import('../src/paraglide/messages.js');
const { AUTH_POST_TIMEOUT_MS } = await import('../src/api');
let host: HTMLDivElement, ceremonies: number, requests: { path: string; init: RequestInit }[];
let rerender: (page: ReactNode) => Promise<void>;
let response: ReturnType<typeof Promise.withResolvers<Response>>;
let review: ReturnType<typeof Promise.withResolvers<PasskeyRegistrationReview>>;
let reviews: string[];
const source = {
  load: async () => initial,
  act: async () => ({ kind: 'failure' as const }),
  read: async () => ({ kind: 'unavailable' as const }),
  reviewRegistration: async (accountId: string) => {
    reviews.push(accountId);
    return review.promise;
  },
};
const props = {
  securitySource: source,
  inventorySource: emptyInventory,
  identitySource: async () => ({ kind: 'unavailable' as const }),
};
const render = (value = initial) => rerender(<SecurityPage initial={value} {...props} />);
const submit = () =>
  host
    .querySelectorAll('form')[1]!
    .dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
const click = (label: string) => button(host, label)!.click();
const locked = () =>
  [...host.querySelectorAll<HTMLButtonElement>('form button[type="submit"], li button')].every(
    (control) => control.disabled,
  );
async function mount() {
  ({ host, render: rerender } = await open(<SecurityPage initial={initial} {...props} />, {}));
  ceremonies = 0;
  requests = [];
  reviews = [];
  response = Promise.withResolvers();
  review = Promise.withResolvers();
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      create: async () => {
        ceremonies++;
        const bytes = Uint8Array.of(1).buffer;
        return {
          id: 'browser-credential',
          rawId: bytes,
          type: 'public-key',
          response: { attestationObject: bytes, clientDataJSON: bytes },
          getClientExtensionResults: () => ({}),
        };
      },
    },
  });
  globalThis.fetch = (async (path, init = {}) => {
    requests.push({ path: String(path), init });
    if (path === '/passkeys/register/options')
      return Response.json({
        challenge: 'Y2hhbGxlbmdl',
        rp: { id: 'auth.test', name: 'REZICS' },
        user: { id: 'YWNjb3VudA', name: 'reader', displayName: 'Reader' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      });
    return response.promise;
  }) as typeof fetch;
}

test.each(['headers', 'created body', 'error body'])(
  '%s stall releases waiting into recovery without replay',
  async (stage) => {
    await mount();
    if (stage !== 'headers')
      response.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
          }),
          { status: stage === 'created body' ? 201 : 503 },
        ),
      );
    await flush(submit);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, AUTH_POST_TIMEOUT_MS + 30));
    });
    expect(host.textContent).toContain(m.auth_security_passkey_registration_unknown());
    expect(locked()).toBe(true);
    expect(requests.map(({ path }) => path)).toEqual(['/passkeys/register/options', '/passkeys/register']);
    expect(requests[1]!.init.signal!.aborted).toBe(true);
    await flush(() =>
      response.resolve(
        Response.json({ id: 'late-native-row', name: 'Late key', created_at: '2026-11-01' }, { status: 201 }),
      ),
    );
    expect(host.textContent).not.toContain('Late key');
    expect(ceremonies).toBe(1);
  },
  AUTH_POST_TIMEOUT_MS + 3000,
);

test('lost acknowledgement requires a successful current inventory and review before a fresh explicit ceremony', async () => {
  await mount();
  await flush(submit);
  await flush(() => response.reject(new TypeError('connection lost')));
  expect(host.querySelector('#security-passkey-name')).toBeNull();
  expect(requests.filter(({ path }) => path === '/passkeys/register')).toHaveLength(1);
  expect(locked()).toBe(true);
  await flush(() => {
    click(m.auth_security_passkey_check_current());
    click(m.auth_security_passkey_check_current());
  });
  expect(reviews).toEqual([initial.kind === 'ready' ? initial.accountId : '']);
  await flush(() => review.resolve({ kind: 'unavailable' }));
  expect(button(host, m.auth_security_passkey_registration_continue())).toBeUndefined();
  expect(host.textContent).toContain(m.auth_security_readback_unavailable());
  review = Promise.withResolvers();
  await flush(() => click(m.auth_security_passkey_check_current()));
  await flush(() =>
    review.resolve({
      kind: 'ready',
      passkeys: [
        { id: 'unrelated-native-id', name: 'Security key', created_at: '2026-11-01T00:00:00Z', last_used_at: null },
      ],
      truncated: false,
    }),
  );
  expect(host.textContent).toContain(m.auth_security_passkey_registration_reviewed());
  expect(host.textContent).not.toContain(m.auth_security_passkey_added());
  expect(locked()).toBe(true);
  expect(ceremonies).toBe(1);
  await flush(() => click(m.auth_security_passkey_registration_continue()));
  expect(locked()).toBe(false);
  response = Promise.withResolvers();
  await flush(submit);
  expect(ceremonies).toBe(2);
  expect(requests.filter(({ path }) => path === '/passkeys/register')).toHaveLength(2);
});

test('an empty possibly truncated review stays unverified until the person finishes it', async () => {
  await mount();
  response.resolve(Response.json(null, { status: 201 }));
  await flush(submit);
  await flush(() => click(m.auth_security_passkey_check_current()));
  review.resolve({ kind: 'ready', passkeys: [], truncated: true });
  await flush(() => Promise.resolve());
  expect(host.textContent).toContain(m.auth_security_inventory_truncated());
  expect(host.textContent).toContain(m.auth_security_passkey_registration_reviewed());
  expect(host.textContent).toContain(m.auth_security_passkeys_empty());
  expect(host.textContent).not.toContain(m.auth_security_passkey_added());
  expect(button(host, m.auth_security_passkey_registration_continue())).toBeDefined();
  expect(requests.filter(({ path }) => path === '/passkeys/register')).toHaveLength(1);
});

test.each(['signed-out', 'denied', 'replaced'])(
  '%s authority discards registration recovery and late private rows',
  async (kind) => {
    await mount();
    response.resolve(Response.json(null, { status: 201 }));
    await flush(submit);
    await flush(() => click(m.auth_security_passkey_check_current()));
    if (kind === 'replaced') await render({ kind: 'signed-out' });
    await flush(() =>
      review.resolve(
        kind === 'replaced'
          ? {
              kind: 'ready',
              passkeys: [
                { id: 'old-native-id', name: 'Private old key', created_at: '2026-11-01', last_used_at: null },
              ],
              truncated: false,
            }
          : { kind },
      ),
    );
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).not.toContain('Private old key');
    expect(button(host, m.auth_security_passkey_registration_continue())).toBeUndefined();
  },
);
