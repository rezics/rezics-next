import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { RENAME_PROFILE, type RenameRead, type RenameSource, type RenameTarget } from '../src/account-rename';
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/account/rename' });
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: dom.getComputedStyle.bind(dom),
};
const previous = new Map(
  [...Object.keys(globals), 'fetch'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const),
);
for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { RenameAccountPage } = await import('../src/routes/account.rename');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');
const target: RenameTarget = {
  accountId: '00000000-0000-4000-8000-000000000001',
  handle: null,
  clientId: RENAME_PROFILE.client_id,
  scopes: ['account:update'],
};
const source = (changes: Partial<RenameSource> = {}): RenameSource => ({
  readCurrent: async () => ({ kind: 'ready', target }),
  run: async () => ({ kind: 'denied' }),
  stepUp: async () => false,
  ...changes,
});
async function flush(action: () => void) {
  await act(async () => action());
}
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  window.sessionStorage.clear();
});
afterAll(async () => {
  for (const [name, value] of previous) {
    if (value) Object.defineProperty(globalThis, name, value);
    else Reflect.deleteProperty(globalThis, name);
  }
  await dom.happyDOM.close();
});
async function mount(initial: RenameSource) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  close = async () => {
    await flush(() => root.unmount());
    host.remove();
  };
  await flush(() => root.render(<RenameAccountPage source={initial} />));
  return host;
}

test('ordinary session gets the exact authentication continuation without profile disclosure', async () => {
  let continued = '';
  const host = await mount(
    source({
      readCurrent: async (): Promise<RenameRead> => ({ kind: 'management-auth-required', accountId: target.accountId }),
      stepUpForReview: async (accountId) => {
        continued = accountId;
        return true;
      },
    }),
  );
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).toContain('Continue with the rename management session');
  expect(host.textContent).not.toContain(target.handle ?? 'private_handle');
  await flush(() => host.querySelector('button')!.click());
  expect(continued).toBe(target.accountId);
  expect(host.querySelector('form')).toBeNull();
});

test('signed-out page offers the existing sign-in path', async () => {
  const host = await mount(source({ readCurrent: async (): Promise<RenameRead> => ({ kind: 'signed-out' }) }));
  expect(host.textContent).toContain('Sign in to rename your own account');
  expect(host.querySelector<HTMLAnchorElement>('a[href="/login"]')).not.toBeNull();
  expect(host.querySelector('form')).toBeNull();
});

test('refusal hides an undisclosed profile', async () => {
  const host = await mount(source({ readCurrent: async (): Promise<RenameRead> => ({ kind: 'refused' }) }));
  expect(host.textContent).toContain('Your current session cannot rename this account');
  expect(host.textContent).not.toContain('private_handle');
  expect(host.querySelector('form')).toBeNull();
});

test('dependency recovery reloads an admitted handleless actor and requires a new confirmation', async () => {
  let reads = 0;
  const host = await mount(
    source({
      readCurrent: async (): Promise<RenameRead> =>
        reads++ === 0
          ? { kind: 'unavailable' }
          : reads === 2
            ? { kind: 'unavailable', target: { ...target, handle: 'private_handle' } }
            : { kind: 'ready', target: { ...target, managementReviewReturned: true } },
    }),
  );
  expect(host.textContent).toContain('We could not read or confirm your current account securely');
  await flush(() => host.querySelector('button')!.click());
  expect(host.textContent).toContain('private_handle');
  await flush(() => host.querySelector('button')!.click());
  expect(host.textContent).toContain(target.accountId);
  expect(host.textContent).toContain('No handle');
  expect(host.textContent).toContain('Returning here did not submit a rename');
  expect(host.querySelector<HTMLInputElement>('#rename-handle')?.value).toBe('');
  expect(host.querySelector<HTMLInputElement>('#rename-confirm')?.checked).toBe(false);
  expect(host.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);
});
