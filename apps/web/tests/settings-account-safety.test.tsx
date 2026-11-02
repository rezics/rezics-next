import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountRenameRegion, AccountSafetyCard, readCurrentAccountRename } from '../src/settings/account-safety';
import { m } from '../src/paraglide/messages.js';

test('rename recovery refreshes only its read and retires expired credentials before dispatch', async () => {
  let token = 'expired';
  const sent: string[] = [];
  const refresh = Promise.withResolvers<void>();
  const context = { accountId: 'alice', handle: 'alice', available: true };
  const read = (credential: string, current: () => boolean) =>
    readCurrentAccountRename(credential, current, async () => ({
      readAccountRename: async (input) => {
        sent.push(input.headers['X-CSRF-Token']);
        return credential === 'expired'
          ? { context: null, failures: [{ kind: 'denied', status: 403 }] }
          : { context };
      },
    }) as never);
  const old = new AccountRenameRegion(() => read('expired', old.isCurrent), 'alice', () => token === 'expired', () => refresh.promise);
  const leave = old.mount();
  await old.reload();
  const retry = old.reload();
  expect(old.reload()).toBe(retry);
  expect(old.snapshot().context).toBeNull();
  token = 'fresh';
  refresh.resolve();
  await retry;
  expect(sent).toEqual(['expired']);
  const recovered = new AccountRenameRegion(() => read(token, recovered.isCurrent), 'alice');
  const done = recovered.mount();
  await recovered.reload();
  expect(sent).toEqual(['expired', 'fresh']);
  expect(recovered.snapshot().context).toEqual(context);
  leave();
  done();
});

test('failed and uncertain native sign-out recover independently without replay or a completion claim', async () => {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/en/settings#account' });
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, HTMLFormElement: window.HTMLFormElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.entries(globals).map(([key, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    return [key, descriptor] as const;
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let submitted = 0, renamed = 0, refreshed = 0, fail = true, refreshFails = false;
  window.HTMLFormElement.prototype.submit = function () {
    submitted++;
    expect(this.action).toBe('https://site.test/auth/sign-out');
    expect(this.method).toBe('post');
    expect(this.querySelector('input')?.value).toBe('fresh');
    if (fail) throw new Error('Submission failed');
  };
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => (node.getAttribute('aria-label') ?? node.textContent) === label)!;
  const click = async (label: string) => { await act(async () => button(label).click()); };
  const reload = `${m.settings_reload()}: ${m.account_sign_out()}`;
  try {
    await act(async () => root.render(<AccountSafetyCard state="signed-in" csrfToken="fresh" securityHref="https://auth.test/security"
      onReload={async () => { refreshed++; if (refreshFails) throw new Error('Session unavailable'); }}
      renameRead={{ loading: false, reload: () => { renamed++; }, failures: [{ kind: 'failed', status: 503 }] }} />));
    await click(m.account_sign_out());
    expect(host.textContent).toContain(m.settings_account_sign_out_failed());
    refreshFails = true;
    await click(reload);
    expect(host.textContent).toContain(m.settings_account_sign_out_failed());
    refreshFails = false;
    await click(`${m.settings_reload()}: ${m.settings_account_rename_heading()}`);
    expect(renamed).toBe(1);
    expect(submitted).toBe(1);
    await click(reload);
    expect(refreshed).toBe(2);
    expect(submitted).toBe(1);
    fail = false;
    await click(m.account_sign_out());
    expect(host.textContent).toContain(m.settings_account_sign_out_uncertain());
    expect(button(m.account_sign_out()).disabled).toBe(true);
    expect([...host.querySelectorAll('a')].map((a) => a.href)).toEqual(['https://auth.test/security', 'https://auth.test/account/delete']);
    await click(reload);
    expect(submitted).toBe(2);
    expect(renamed).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
