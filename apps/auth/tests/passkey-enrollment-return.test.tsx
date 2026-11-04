import { afterAll, expect, test } from 'bun:test';
import { creationFixture, dom, flush, open, fill, button, leave } from './creation-page-fixture';
import { SecurityPage } from '../src/routes/security';
import { initial } from '../src/stories/accounts-security/security/security.stories';
import { populatedInventory } from '../src/stories/accounts-operations/story';
import type { SecurityLoadResult, PasskeyRegistrationReview } from '../src/security';
import type { SecurityActionResult, SecuritySource } from '../src/security-reconciliation';
import { m } from '../src/paraglide/messages.js';

creationFixture();
const previous = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: class {} });
afterAll(() => {
  if (previous) Object.defineProperty(globalThis, 'PublicKeyCredential', previous);
  else Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
});

const optionBody = {
  challenge: 'Y2hhbGxlbmdl',
  rp: { id: 'auth.test', name: 'REZICS' },
  user: { id: 'YWNjb3VudA', name: 'reader', displayName: 'Reader' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
};
const identitySource = async () => ({ kind: 'unavailable' as const });
const tick = () => flush(() => new Promise((resolve) => setTimeout(resolve, 0)));
const restore = () => window.dispatchEvent(new dom.Event('pageshow') as unknown as Event);

async function mount() {
  const reads: ReturnType<typeof Promise.withResolvers<SecurityLoadResult>>[] = [];
  const reviews: ReturnType<typeof Promise.withResolvers<PasskeyRegistrationReview>>[] = [];
  const reviewedAccounts: string[] = [];
  const securitySource: SecuritySource & { reviewRegistration: typeof reviewRegistration } = {
    load: async () => {
      const next = Promise.withResolvers<SecurityLoadResult>();
      reads.push(next);
      return next.promise;
    },
    act: async (): Promise<SecurityActionResult> => ({ kind: 'denied' }),
    read: async () => ({ kind: 'unavailable' }),
    reviewRegistration,
  };
  async function reviewRegistration(accountId: string) {
    reviewedAccounts.push(accountId);
    const next = Promise.withResolvers<PasskeyRegistrationReview>();
    reviews.push(next);
    return next.promise;
  }
  const ui = await open(
    <SecurityPage
      initial={initial}
      inventorySource={populatedInventory}
      identitySource={identitySource}
      securitySource={securitySource}
    />,
    {},
  );
  return { ...ui, reads, reviews, reviewedAccounts };
}

function registrationPaths(calls: { path: string }[]) {
  return calls.filter(({ path }) => path === '/passkeys/register').length;
}

test.each(['options', 'prompt'] as const)(
  'return after leaving during %s never dispatches a registration or restores the private name',
  async (stage) => {
    const ceremony = Promise.withResolvers<Credential | null>();
    let ceremonySignal: AbortSignal | undefined;
    let ceremonyCalls = 0;
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: (options: CredentialCreationOptions) => {
          ceremonyCalls++;
          ceremonySignal = options.signal;
          return ceremony.promise;
        },
      },
    });
    const { host, calls, reads } = await mount();
    await flush(() => {
      fill(host.querySelector<HTMLInputElement>('#security-passkey-name')!, 'Private passkey label');
      host.querySelectorAll('form')[1]!.requestSubmit();
    });
    expect(host.textContent).toContain(m.auth_security_passkey_options_pending());
    if (stage === 'prompt') {
      await flush(() => calls[0]!.resolve(Response.json(optionBody)));
      await tick();
      expect(host.textContent).toContain(m.auth_security_passkey_prompt_pending());
      expect(ceremonyCalls).toBe(1);
    }
    await flush(leave);
    expect(host.querySelector('#security-passkey-name')).toBeNull();
    expect(host.textContent).not.toContain('Private passkey label');
    if (stage === 'prompt') expect(ceremonySignal?.aborted).toBe(true);
    await flush(restore);
    await flush(() => reads[0]!.resolve(initial));
    if (stage === 'options') await flush(() => calls[0]!.resolve(Response.json(optionBody)));
    await flush(() =>
      ceremony.resolve({
        id: 'late-browser-credential',
        rawId: new ArrayBuffer(1),
        type: 'public-key',
        getClientExtensionResults: () => ({}),
        response: { attestationObject: new ArrayBuffer(1), clientDataJSON: new ArrayBuffer(1) },
      } as unknown as Credential),
    );
    await tick();
    expect(registrationPaths(calls)).toBe(0);
    const restoredName = host.querySelector<HTMLInputElement>('#security-passkey-name');
    expect(restoredName).not.toBeNull();
    expect(restoredName?.value).not.toBe('Private passkey label');
  },
);

test('pagehide after registration dispatch restores an unknown review without publishing a late success', async () => {
  const prompt = Promise.withResolvers<Credential | null>();
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { create: async () => prompt.promise },
  });
  const { host, calls, reads, reviews, reviewedAccounts } = await mount();
  await flush(() => {
    fill(host.querySelector<HTMLInputElement>('#security-passkey-name')!, 'Private passkey label');
    host.querySelectorAll('form')[1]!.requestSubmit();
  });
  await flush(() => calls[0]!.resolve(Response.json(optionBody)));
  await tick();
  await flush(() =>
    prompt.resolve({
      id: 'browser-credential',
      rawId: new ArrayBuffer(1),
      type: 'public-key',
      getClientExtensionResults: () => ({}),
      response: { attestationObject: new ArrayBuffer(1), clientDataJSON: new ArrayBuffer(1) },
    } as unknown as Credential),
  );
  await tick();
  expect(registrationPaths(calls)).toBe(1);
  expect(host.textContent).toContain(m.auth_security_passkey_registration_saving());

  await flush(leave);
  expect(host.textContent).not.toContain('Private passkey label');
  expect(host.querySelector('#security-passkey-name')).toBeNull();
  await flush(restore);
  await flush(() => reads[0]!.resolve(initial));
  expect(host.textContent).toContain(m.auth_security_passkey_registration_unknown());
  expect(button(host, m.auth_security_passkey_add())).toBeUndefined();
  expect(registrationPaths(calls)).toBe(1);
  await flush(leave);
  await flush(restore);
  await flush(() => reads[1]!.resolve(initial));
  expect(host.textContent).toContain(m.auth_security_passkey_registration_unknown());
  expect(registrationPaths(calls)).toBe(1);

  await flush(() =>
    calls[1]!.resolve(
      Response.json({ id: 'late-native-id', name: 'Late key', created_at: '2026-11-01' }, { status: 201 }),
    ),
  );
  expect(host.textContent).not.toContain('Late key');
  expect(host.textContent).not.toContain(m.auth_security_passkey_added());

  await flush(() => button(host, m.auth_security_passkey_check_current())!.click());
  expect(reviewedAccounts).toEqual([initial.kind === 'ready' ? initial.accountId : '']);
  expect(host.textContent).toContain(m.auth_security_passkey_registration_checking());
  await flush(() =>
    reviews[0]!.resolve({
      kind: 'ready',
      passkeys: [
        {
          id: 'current-native-row',
          name: 'Private passkey label',
          created_at: '2026-11-01T00:00:00Z',
          last_used_at: null,
          remove: 'allowed',
        },
      ],
      truncated: true,
    }),
  );
  expect(host.textContent).toContain(m.auth_security_inventory_truncated());
  expect(host.textContent).toContain(m.auth_security_passkey_registration_reviewed());
  expect(host.textContent).not.toContain(m.auth_security_passkey_added());
  expect(host.querySelector('[data-passkey-enrollment-history]')?.textContent).toContain(
    m.auth_security_passkey_history_unknown(),
  );
  expect(host.querySelector('[data-passkey-enrollment-history]')?.textContent).not.toContain('Private passkey label');

  await flush(() => button(host, m.auth_security_passkey_registration_continue())!.click());
  await flush(() => reads[2]!.resolve(initial));
  expect(host.querySelector('[data-passkey-enrollment-history]')?.textContent).toContain(
    m.auth_security_passkey_history_unknown(),
  );
  expect(host.querySelector('#security-passkey-name')).not.toBeNull();
  expect(registrationPaths(calls)).toBe(1);
  await flush(() => button(host, m.auth_security_passkey_add())!.click());
  expect(calls.filter(({ path }) => path === '/passkeys/register/options')).toHaveLength(2);
  expect(registrationPaths(calls)).toBe(1);
});

test('a replacement account gets no review action or private result from the earlier account', async () => {
  const prompt = Promise.withResolvers<Credential | null>();
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { create: async () => prompt.promise },
  });
  const { host, calls, reads } = await mount();
  await flush(() => host.querySelectorAll('form')[1]!.requestSubmit());
  await flush(() => calls[0]!.resolve(Response.json(optionBody)));
  await tick();
  await flush(() =>
    prompt.resolve({
      id: 'browser-credential',
      rawId: new ArrayBuffer(1),
      type: 'public-key',
      getClientExtensionResults: () => ({}),
      response: { attestationObject: new ArrayBuffer(1), clientDataJSON: new ArrayBuffer(1) },
    } as unknown as Credential),
  );
  await tick();
  expect(registrationPaths(calls)).toBe(1);
  await flush(leave);
  await flush(restore);
  const replacement: SecurityLoadResult =
    initial.kind === 'ready'
      ? {
          ...initial,
          accountId: 'replacement-account',
          page: initial.page
            ? { ...initial.page, viewer: { ...initial.page.viewer, account_id: 'replacement-account' } }
            : undefined,
        }
      : initial;
  await flush(() => reads[0]!.resolve(replacement));
  expect(host.textContent).toContain(m.auth_security_passkey_account_changed());
  expect(host.textContent).toContain(m.auth_security_passkey_history_unknown());
  expect(button(host, m.auth_security_passkey_check_current())).toBeUndefined();
  expect(host.querySelector<HTMLInputElement>('#security-passkey-name')?.value).toBe('');
  expect(button(host, m.auth_security_passkey_add())?.disabled).toBe(false);
  expect(registrationPaths(calls)).toBe(1);
  await flush(() =>
    calls[1]!.resolve(
      Response.json({ id: 'old-account-row', name: 'Old account key', created_at: '2026-11-01' }, { status: 201 }),
    ),
  );
  expect(host.textContent).not.toContain('Old account key');
  expect(registrationPaths(calls)).toBe(1);
});

test.each(['failure', 'signed-out'] as const)(
  'confirmed history remains generic after Security readback returns %s',
  async (outcome) => {
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: async () =>
          ({
            id: 'browser-credential',
            rawId: new ArrayBuffer(1),
            type: 'public-key',
            getClientExtensionResults: () => ({}),
            response: { attestationObject: new ArrayBuffer(1), clientDataJSON: new ArrayBuffer(1) },
          }) as unknown as Credential,
      },
    });
    const { host, calls, reads } = await mount();
    await flush(() => {
      fill(host.querySelector<HTMLInputElement>('#security-passkey-name')!, 'Private registration label');
      host.querySelectorAll('form')[1]!.requestSubmit();
    });
    await flush(() => calls[0]!.resolve(Response.json(optionBody)));
    await tick();
    await tick();
    await flush(() =>
      calls[1]!.resolve(
        Response.json(
          { id: 'native-row-id', name: 'Private registration label', created_at: '2026-11-01' },
          { status: 201 },
        ),
      ),
    );
    expect(host.textContent).toContain(m.auth_security_passkey_history_acknowledged());
    expect(reads).toHaveLength(1);
    await flush(() =>
      reads[0]!.resolve(
        outcome === 'signed-out' ? { kind: 'signed-out' } : { kind: 'failure', message: 'Inventory unavailable.' },
      ),
    );
    expect(host.textContent).toContain(m.auth_security_passkey_history_acknowledged());
    expect(host.textContent).not.toContain('Private registration label');
    expect(host.textContent).not.toContain('native-row-id');
    expect(button(host, m.auth_security_passkey_dismiss_history())).toBeDefined();
  },
);
