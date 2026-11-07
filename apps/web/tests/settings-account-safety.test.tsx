import { AccountsQueryProvider as QueryClientProvider } from './fixtures/accounts-composition';
import { expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { sessionQuery } from '../src/session/query';
import { AccountRenameRegion, AccountSafetyCard, AccountSafetySection } from '../src/settings/account-safety';
import { m } from '../src/paraglide/messages.js';

const accountId = '123e4567-e89b-42d3-a456-426614174000';
const renameHref = 'https://auth.test/account/rename';

test('rename recovery refreshes only its read and retires expired credentials before dispatch', async () => {
  let token = 'expired';
  const sent: string[] = [];
  let refreshes = 0;
  const refresh = Promise.withResolvers<void>();
  const context = { accountId: 'alice', handle: 'alice', available: true };
  const old = new AccountRenameRegion(
    async () => {
      sent.push('expired');
      return { context: null, failures: [{ kind: 'denied', status: 403 }] };
    },
    'alice',
    () => token === 'expired',
    () => {
      refreshes++;
      return refresh.promise;
    },
  );
  const leave = old.mount();
  await old.reload();
  const retry = old.reload();
  expect(old.reload()).toBe(retry);
  expect(old.snapshot().context).toBeNull();
  await Promise.resolve();
  expect(refreshes).toBe(1);
  token = 'fresh';
  refresh.resolve();
  await retry;
  expect(sent).toEqual(['expired']);
  const recovered = new AccountRenameRegion(async () => {
    sent.push(token);
    return { context };
  }, 'alice');
  const done = recovered.mount();
  await recovered.reload();
  expect(sent).toEqual(['expired', 'fresh']);
  expect(recovered.snapshot().context).toEqual(context);
  leave();
  done();
});

test('failed and uncertain native sign-out recover independently without replay or a completion claim', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/settings#account' });
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.entries(globals).map(([key, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    return [key, descriptor] as const;
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let submitted = 0,
    renamed = 0,
    refreshed = 0,
    fail = true,
    current = false,
    refreshFails = false;
  window.HTMLFormElement.prototype.submit = function () {
    submitted++;
    if (fail) throw new Error('Submission failed');
  };
  const click = async (selector: string) => {
    await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
  };
  const reload = `button[aria-label="${m.settings_reload()}: ${m.account_sign_out()}"]`;
  try {
    const managedClient = new QueryClient();
    managedClient.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: null });
    await act(async () =>
      root.render(
        <QueryClientProvider client={managedClient}>
          <AccountSafetySection
            state="signed-in"
            accountId="alice"
            csrfToken={null}
            securityHref="https://auth.test/security"
            onReload={async () => {}}
          />
        </QueryClientProvider>,
      ),
    );
    const security = host.querySelector<HTMLAnchorElement>('a[href="https://auth.test/security"]')!;
    const deletion = host.querySelector<HTMLAnchorElement>('a[href="https://auth.test/account/delete"]')!;
    const visit = (link: HTMLAnchorElement, type: 'click' | 'auxclick', button = 0) => {
      const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    };
    let liveNavigationAllowed = false;
    security.addEventListener(
      'click',
      (event) => {
        liveNavigationAllowed = !event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    visit(security, 'click');
    expect(liveNavigationAllowed).toBe(true);
    await act(async () => {
      managedClient.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      expect(security.isConnected).toBe(true);
      expect(visit(security, 'click')).toBe(true);
      expect(visit(deletion, 'auxclick', 1)).toBe(true);
      root.render(
        <QueryClientProvider client={managedClient}>
          <AccountSafetySection state="signed-out" returnTo="/en/settings" />
        </QueryClientProvider>,
      );
    });

    await act(async () =>
      root.render(
        <AccountSafetyCard
          state="signed-in"
          csrfToken="fresh"
          securityHref="https://auth.test/security"
          isCurrent={() => current}
          onReload={async () => {
            refreshed++;
            if (refreshFails) throw new Error('Session unavailable');
            current = true;
          }}
          renameRead={{
            loading: false,
            reload: () => {
              renamed++;
            },
            failures: [{ kind: 'failed', status: 503 }],
          }}
        />,
      ),
    );
    await click('button[type="submit"]');
    expect(submitted).toBe(0);
    expect(host.textContent).not.toContain(m.settings_account_csrf_unavailable());
    current = true;
    await click('button[type="submit"]');
    expect(host.textContent).toContain(m.settings_account_sign_out_failed());
    refreshFails = true;
    await click(reload);
    expect(host.textContent).toContain(m.settings_account_sign_out_failed());
    refreshFails = false;
    await click(`button[aria-label="${m.settings_reload()}: ${m.settings_account_rename_heading()}"]`);
    expect(renamed).toBe(1);
    expect(submitted).toBe(1);
    await click(reload);
    expect(refreshed).toBe(2);
    expect(submitted).toBe(1);
    fail = false;
    await click('button[type="submit"]');
    expect(host.textContent).toContain(m.settings_account_sign_out_uncertain());
    expect(host.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
    current = false;
    await click(reload);
    expect(submitted).toBe(2);
    expect(refreshed).toBe(2);
    expect(renamed).toBe(1);
    expect(host.textContent).toContain(m.settings_account_sign_out_uncertain());
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

async function withAccountSafetyDom(
  run: (host: HTMLElement, window: { HTMLFormElement: { prototype: { submit: () => void } } }) => Promise<void>,
) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/settings#account' });
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.entries(globals).map(([key, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    return [key, descriptor] as const;
  });
  const host = document.createElement('div');
  document.body.append(host);
  try {
    await run(host, window);
  } finally {
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('a never-settling session recovery finishes visibly without another sign-out or native discovery', async () => {
  await withAccountSafetyDom(async (host, window) => {
    const root = createRoot(host);
    let submitted = 0;
    let renamed = 0;
    window.HTMLFormElement.prototype.submit = function () {
      submitted++;
    };
    const hang = Promise.withResolvers<void>();
    const schedule = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) =>
      schedule(callback, delay === 10_000 ? 0 : delay, ...args)) as typeof setTimeout);
    try {
      await act(async () =>
        root.render(
          <AccountSafetyCard
            state="signed-in"
            csrfToken="fresh"
            securityHref="https://auth.test/security"
            onReload={() => hang.promise}
            renameRead={{
              loading: false,
              reload: () => {
                renamed++;
              },
            }}
          />,
        ),
      );
      await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
      expect(host.textContent).toContain(m.settings_account_sign_out_uncertain());
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(`button[aria-label="${m.settings_reload()}: ${m.account_sign_out()}"]`)!
          .click(),
      );
      await act(async () => new Promise((resolve) => schedule(resolve, 0)));
      expect(host.textContent).toContain(m.settings_account_sign_out_uncertain());
      expect(host.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
      expect(
        host.querySelector<HTMLButtonElement>(`button[aria-label="${m.settings_reload()}: ${m.account_sign_out()}"]`)
          ?.disabled,
      ).toBe(false);
      expect(submitted).toBe(1);
      expect(renamed).toBe(0);
    } finally {
      hang.resolve();
      timer.mockRestore();
      await act(async () => root.unmount());
    }
  });
});

test('old-viewer late completion cannot restore a link or unlock an old form', async () => {
  await withAccountSafetyDom(async (host, window) => {
    const root = createRoot(host);
    let submitted = 0;
    let current = true;
    const hang = Promise.withResolvers<void>();
    window.HTMLFormElement.prototype.submit = function () {
      submitted++;
    };
    const available = {
      accountId,
      handle: 'alice',
      available: true as const,
      href: renameHref,
    };
    await act(async () =>
      root.render(
        <AccountSafetyCard
          state="signed-in"
          csrfToken="fresh"
          securityHref="https://auth.test/security"
          isCurrent={() => current}
          onReload={() => hang.promise}
          renameAccount={available}
          renameRead={{ loading: false, reload() {} }}
        />,
      ),
    );
    expect(host.querySelector(`a[href="${renameHref}"]`)).toBeTruthy();
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(`button[aria-label="${m.settings_reload()}: ${m.account_sign_out()}"]`)!
        .click(),
    );
    current = false;
    await act(async () =>
      root.render(
        <AccountSafetyCard
          state="signed-in"
          csrfToken="fresh"
          securityHref="https://auth.test/security"
          isCurrent={() => current}
          onReload={() => hang.promise}
          renameAccount={available}
          renameRead={{ loading: false, reload() {} }}
        />,
      ),
    );
    expect(host.querySelector(`a[href="${renameHref}"]`)).toBeNull();
    hang.resolve();
    await act(async () => await Promise.resolve());
    expect(host.querySelector(`a[href="${renameHref}"]`)).toBeNull();
    expect(host.textContent).toContain(m.settings_account_sign_out_uncertain());
    expect(host.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(`button[aria-label="${m.settings_reload()}: ${m.account_sign_out()}"]`)
        ?.click(),
    );
    expect(submitted).toBe(1);
    await act(async () => root.unmount());
  });
});

test('same-viewer return after an Auth destination keeps current native links and retires the previous episode', async () => {
  await withAccountSafetyDom(async (host) => {
    const root = createRoot(host);
    const available = {
      accountId,
      handle: 'alice',
      available: true as const,
      href: renameHref,
    };
    await act(async () =>
      root.render(
        <AccountSafetyCard
          state="signed-in"
          csrfToken="fresh"
          securityHref="https://auth.test/security"
          onReload={() => {}}
          renameAccount={available}
          renameRead={{ loading: false, reload() {} }}
        />,
      ),
    );
    expect(host.querySelector(`a[href="${renameHref}"]`)).toBeTruthy();
    expect(host.querySelector('a[href="https://auth.test/security"]')).toBeTruthy();
    await act(async () =>
      root.render(
        <AccountSafetyCard
          state="signed-in"
          csrfToken="fresh"
          securityHref="https://auth.test/security"
          isCurrent={() => false}
          onReload={() => {}}
          renameAccount={available}
          renameRead={{ loading: false, reload() {} }}
        />,
      ),
    );
    expect(host.querySelector(`a[href="${renameHref}"]`)).toBeNull();
    await act(async () =>
      root.render(
        <AccountSafetyCard
          state="signed-in"
          csrfToken="fresh"
          securityHref="https://auth.test/security"
          onReload={() => {}}
          renameAccount={available}
          renameRead={{ loading: false, reload() {} }}
        />,
      ),
    );
    expect(host.querySelectorAll(`a[href="${renameHref}"]`)).toHaveLength(1);
    expect(host.querySelector('a[href="https://auth.test/security"]')).toBeTruthy();
    await act(async () => root.unmount());
  });
});

test('deliberate current recovery renders the native available destination once or the honest unavailable outcome', async () => {
  await withAccountSafetyDom(async (host) => {
    const root = createRoot(host);
    let outcome: 'failed' | 'available' | 'unavailable' = 'failed';
    const render = () => (
      <AccountSafetyCard
        state="signed-in"
        csrfToken="fresh"
        securityHref="https://auth.test/security"
        onReload={() => {}}
        renameAccount={
          outcome === 'available'
            ? { accountId, handle: 'alice', available: true, href: renameHref }
            : { accountId, handle: 'alice', available: true, href: null }
        }
        renameRead={{
          loading: false,
          reload() {
            outcome = outcome === 'failed' ? 'available' : 'unavailable';
          },
          failures:
            outcome === 'failed'
              ? [{ kind: 'failed', status: 503 }]
              : outcome === 'unavailable'
                ? [{ kind: 'unavailable', status: 501 }]
                : undefined,
        }}
      />
    );
    await act(async () => root.render(render()));
    expect(host.querySelector(`a[href="${renameHref}"]`)).toBeNull();
    expect(host.textContent).toContain(m.settings_account_rename_failed());
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          `button[aria-label="${m.settings_reload()}: ${m.settings_account_rename_heading()}"]`,
        )!
        .click(),
    );
    await act(async () => root.render(render()));
    expect(host.querySelectorAll(`a[href="${renameHref}"]`)).toHaveLength(1);
    expect(host.textContent).not.toContain(m.settings_account_rename_failed());
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          `button[aria-label="${m.settings_reload()}: ${m.settings_account_rename_heading()}"]`,
        )!
        .click(),
    );
    await act(async () => root.render(render()));
    expect(host.querySelector(`a[href="${renameHref}"]`)).toBeNull();
    expect(host.textContent).toContain(m.settings_account_rename_unavailable());
    await act(async () => root.unmount());
  });
});
