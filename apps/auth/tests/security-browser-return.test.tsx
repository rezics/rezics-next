import { afterAll, expect, test } from 'bun:test';
import { creationFixture, open, flush, fill, button, leave, dom } from './creation-page-fixture';
import { SecurityPage } from '../src/routes/security';
import { initial } from '../src/stories/accounts-security/security/security.stories';
import { populatedInventory } from '../src/stories/accounts-operations/story';
import type { SecurityLoadResult } from '../src/security';
import type { SecurityActionResult, SecuritySource } from '../src/security-reconciliation';
import { m } from '../src/paraglide/messages.js';

creationFixture();
const previous = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: class {} });
afterAll(() => {
  if (previous) Object.defineProperty(globalThis, 'PublicKeyCredential', previous);
  else Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
});
const identitySource = async () => ({ kind: 'unavailable' as const });
const restore = () => window.dispatchEvent(new dom.Event('pageshow') as unknown as Event);
async function mount(provided: SecurityLoadResult | undefined = initial) {
  const reads: ReturnType<typeof Promise.withResolvers<SecurityLoadResult>>[] = [];
  const action = Promise.withResolvers<SecurityActionResult>();
  const targets: unknown[] = [],
    inventories: string[] = [];
  const source: SecuritySource = {
    load: async () => {
      const next = Promise.withResolvers<SecurityLoadResult>();
      reads.push(next);
      return next.promise;
    },
    act: async (target) => {
      targets.push(target);
      return action.promise;
    },
    read: async () => ({ kind: 'unavailable' }),
  };
  const inventorySource: typeof populatedInventory = async (view, cursor) => {
    inventories.push(view);
    return populatedInventory(view, cursor);
  };
  const page = await open(
    <SecurityPage
      {...(provided ? { initial: provided } : {})}
      identitySource={identitySource}
      inventorySource={inventorySource}
      securitySource={source}
    />,
    {},
  );
  return { ...page, reads, action, targets, inventories };
}

test.each(['password', 'prompt'])('departure retires %s and reloads private reviews before reuse', async (kind) => {
  const prompt = Promise.withResolvers<Credential | null>();
  let ceremony: AbortSignal | undefined;
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      create: (options: CredentialCreationOptions) => {
        ceremony = options.signal;
        return prompt.promise;
      },
    },
  });
  const { host, calls, reads, inventories } = await mount();
  await flush(() => {
    fill(host.querySelector('#security-new-password')!, 'a secure password');
    host.querySelectorAll('form')[kind === 'password' ? 0 : 1]!.requestSubmit();
    button(host, m.auth_inventory_remove_named({ name: 'Reading companion' }))!.click();
  });
  expect(calls).toHaveLength(1);
  if (kind === 'prompt')
    await flush(() =>
      calls[0]!.resolve(
        Response.json({
          challenge: 'Y2hhbGxlbmdl',
          rp: { id: 'auth.test', name: 'REZICS' },
          user: { id: 'YWNjb3VudA', name: 'reader', displayName: 'Reader' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        }),
      ),
    );
  await flush(leave);
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).not.toContain('Reading companion');
  if (kind === 'prompt') expect(ceremony?.aborted).toBe(true);
  await flush(restore);
  expect(host.querySelector('form')).toBeNull();
  await flush(() => reads[0]!.resolve(initial));
  await flush(() => {
    if (kind === 'password')
      calls[0]!.resolve(
        Response.json({ ...calls[0]!.body, effectRef: 'effect', purpose: 'set-password', digest: 'digest' }),
      );
    else
      prompt.resolve({
        id: 'late',
        rawId: new ArrayBuffer(1),
        type: 'public-key',
        getClientExtensionResults: () => ({}),
        response: { attestationObject: new ArrayBuffer(1), clientDataJSON: new ArrayBuffer(1) },
      } as unknown as Credential);
  });
  expect(calls).toHaveLength(1);
  expect((host.querySelector('#security-new-password') as HTMLInputElement).value).toBe('');
  expect(host.querySelector('fieldset')).toBeNull();
  expect(inventories).toEqual(['clients', 'consents', 'clients', 'consents']);
  expect(host.textContent).not.toContain(m.auth_security_passkey_added());
});

test.each([false, true])(
  'return preserves only the unresolved native target for the same account: %s',
  async (different) => {
    const { host, reads, action, targets } = await mount();
    await flush(() => button(host, m.auth_security_passkey_remove())!.click());
    await flush(() => button(host, m.auth_security_confirm_passkey())!.click());
    await flush(leave);
    await flush(restore);
    await flush(() => action.resolve({ kind: 'accepted' }));
    expect(host.querySelector('form')).toBeNull();
    await flush(() =>
      reads[0]!.resolve(
        initial.kind === 'ready' ? { ...initial, accountId: different ? 'another' : initial.accountId } : initial,
      ),
    );
    expect(!!button(host, m.auth_security_check_current())).toBe(!different);
    expect(button(host, m.auth_security_retry_action())).toBeUndefined();
    expect(targets).toHaveLength(1);
    if (different) {
      await flush(() => button(host, m.auth_security_passkey_remove())!.click());
      await flush(leave);
      expect(button(host, m.auth_security_confirm_passkey())).toBeUndefined();
      expect(targets).toHaveLength(1);
    }
  },
);

test('departure invalidates pending reads; unavailable retry and signed-out return remain usable', async () => {
  const { host, reads } = await mount();
  await flush(leave);
  await flush(restore);
  await flush(leave);
  await flush(restore);
  await flush(() => reads[0]!.resolve(initial));
  expect(host.querySelector('form')).toBeNull();
  await flush(() => reads[1]!.resolve({ kind: 'failure', message: 'Unavailable' }));
  await flush(() => button(host, m.auth_inventory_reload())!.click());
  await flush(() => reads[2]!.resolve({ kind: 'signed-out' }));
  expect(host.querySelector('a[href="/login"]')).not.toBeNull();
  expect(host.querySelector('form')).toBeNull();
});

test('cached return discards an unsent review and its description without dispatch', async () => {
  const { host, reads, targets } = await mount();
  await flush(() => button(host, m.auth_security_passkey_remove())!.click());
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  await flush(leave);
  expect(host.textContent).not.toContain('Security key');
  await flush(restore);
  await flush(() => reads[0]!.resolve(initial));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(button(host, m.auth_security_check_current())).toBeUndefined();
  expect(targets).toHaveLength(0);
});
