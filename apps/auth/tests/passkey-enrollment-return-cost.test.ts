import { afterAll, expect, test } from 'bun:test';
import { createElement } from 'react';
import { creationFixture, flush, open, button } from './creation-page-fixture';
import { SecurityPage } from '../src/routes/security';
import { initial } from '../src/stories/accounts-security/security/security.stories';
import { populatedInventory } from '../src/stories/accounts-operations/story';
import type { SecurityLoadResult } from '../src/security';
import type { SecuritySource, SecurityActionResult } from '../src/security-reconciliation';
import { m } from '../src/paraglide/messages.js';

creationFixture();
const previousCredentials = Object.getOwnPropertyDescriptor(navigator, 'credentials');
const previousPublicKey = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: class {} });
afterAll(() => {
  if (previousCredentials) Object.defineProperty(navigator, 'credentials', previousCredentials);
  else Reflect.deleteProperty(navigator, 'credentials');
  if (previousPublicKey) Object.defineProperty(globalThis, 'PublicKeyCredential', previousPublicKey);
  else Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
});

test('acknowledged history return and dismissal add no registration calls', async () => {
  let ceremonies = 0;
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      create: async () => {
        ceremonies++;
        return {
          id: 'browser-credential',
          rawId: new ArrayBuffer(1),
          type: 'public-key',
          getClientExtensionResults: () => ({}),
          response: { attestationObject: new ArrayBuffer(1), clientDataJSON: new ArrayBuffer(1) },
        } as unknown as Credential;
      },
    },
  });
  const reads: ReturnType<typeof Promise.withResolvers<SecurityLoadResult>>[] = [];
  const source: SecuritySource = {
    load: async () => {
      const next = Promise.withResolvers<SecurityLoadResult>();
      reads.push(next);
      return next.promise;
    },
    act: async (): Promise<SecurityActionResult> => ({ kind: 'denied' }),
    read: async () => ({ kind: 'unavailable' }),
  };
  const ui = await open(
    createElement(SecurityPage, {
      initial,
      identitySource: async () => ({ kind: 'unavailable' as const }),
      inventorySource: populatedInventory,
      securitySource: source,
    }),
    {},
  );
  await flush(() => ui.host.querySelectorAll('form')[1]!.requestSubmit());
  await flush(() =>
    ui.calls[0]!.resolve(
      Response.json({
        challenge: 'Y2hhbGxlbmdl',
        rp: { id: 'auth.test', name: 'REZICS' },
        user: { id: 'YWNjb3VudA', name: 'reader', displayName: 'Reader' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      }),
    ),
  );
  await flush(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await flush(() =>
    ui.calls[1]!.resolve(
      Response.json({ id: 'native-row-id', name: 'Private key label', created_at: '2026-11-01' }, { status: 201 }),
    ),
  );
  await flush(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(reads).toHaveLength(1);
  await flush(() => reads[0]!.resolve({ kind: 'failure', message: 'Inventory unavailable.' }));
  expect(ui.host.textContent).toContain(m.auth_security_passkey_history_acknowledged());

  await flush(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
  });
  expect(reads).toHaveLength(2);
  await flush(() => reads[1]!.resolve(initial));
  expect(ui.host.textContent).toContain(m.auth_security_passkey_history_acknowledged());
  await flush(() => button(ui.host, m.auth_security_passkey_dismiss_history())!.click());
  expect(ui.host.querySelector('[data-passkey-enrollment-history]')).toBeNull();
  expect(reads).toHaveLength(2);
  expect(ui.calls.filter(({ path }) => path === '/passkeys/register/options')).toHaveLength(1);
  expect(ui.calls.filter(({ path }) => path === '/passkeys/register')).toHaveLength(1);
  expect(ceremonies).toBe(1);
});
