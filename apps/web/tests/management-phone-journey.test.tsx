import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { ReactNode } from 'react';
import { AccountManagementPage, ManagedAccountsPage, managementHref } from '../src/accounts/management/pages';
import type { Cursors, Detail, Inventory, Page, PageFailure } from '../src/accounts/management/data';
import { automation, detailExample, human, inventoryExample, organization } from '../src/accounts/management/story-api';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';

// UNRUN. Mounted actual-view coverage, with supplied data only. Happy DOM cannot establish pixel geometry;
// the additive canonical phone390/desktop1280/RTL story plays author that separate browser obligation.
test('directory, organization, account and recovery retain independent phone controls and supplied authority', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/accounts', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const previousLocale = getLocale();
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error('A supplied management presentation must not perform IO');
  }) as typeof fetch;
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const mount = async (view: ReactNode) => {
    await act(async () => root.render(view));
  };
  const link = (href: string) => {
    const found = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((item) => item.getAttribute('href') === href);
    expect(found).toBeDefined();
    return found!;
  };
  const text = () => host.textContent!;
  let retries = 0;
  const retry = () => {
    retries++;
  };
  const cursors: Cursors = {
    organizationsCursor: 'org +/=?& before',
    operatorsCursor: 'operator +/=?& before',
    membersCursor: 'member +/=?& before',
  };
  const ready = <T,>(value: T): Extract<Page<T>, { state: 'ready' }> => ({
    state: 'ready',
    value,
    issuer: 'https://auth.example.test',
    organizationsAvailable: true,
  });
  const inventory = inventoryExample();
  inventory.account = {
    ...human,
    displayName: 'Alexandria · 読書会 · Cercle de lecture · 독서 모임 · ' + 'HumanName'.repeat(24),
  };
  inventory.organizations.next = 'org +/=?& after';
  inventory.responsibilities.next = 'operator +/=?& after';
  // A reconciling identity may expose its supplied public profile, never management authority.
  inventory.responsibilities.items.push({
    ...inventory.responsibilities.items[0]!,
    reservationId: '01a1a000-0000-7000-8000-000000000188',
    state: 'reconciling',
    account: { ...automation, id: '01a1a000-0000-7000-8000-000000000189', handle: 'retired +/=?&' },
  });
  const detail = detailExample(organization.id);
  detail.members.items.push({ accountId: '01a1a000-0000-7000-8000-000000000199', account: null, role: 'member' });
  detail.members.next = 'member +/=?& after';
  detail.responsibilities!.next = inventory.responsibilities.next;
  const self = { ...detailExample(human.id), account: inventory.account };
  const operated = { ...detailExample(automation.id), operator: null };
  const directory = (page: Page<Inventory> = ready(inventory)) => (
    <ManagedAccountsPage page={page} cursors={cursors} retry={retry} />
  );
  const account = (value: Detail) => <AccountManagementPage page={ready(value)} cursors={cursors} retry={retry} />;
  const assertPaging = (field: keyof Cursors, next: string) => {
    const anchor = [...host.querySelectorAll<HTMLAnchorElement>('a[rel="next"]')].find(
      (item) => new URL(item.href).searchParams.get(field) === next,
    );
    expect(anchor).toBeDefined();
    const query = new URL(anchor!.href).searchParams;
    expect([...query.keys()].sort()).toEqual(Object.keys(cursors).sort());
    for (const key of Object.keys(cursors) as (keyof Cursors)[])
      expect(query.get(key)).toBe(key === field ? next : cursors[key]!);
  };
  const assertControls = () => {
    for (const control of host.querySelectorAll<HTMLElement>('a, button')) {
      expect(control.closest('a a, a button, button a, button button')).toBeNull();
      control.focus();
      expect(window.document.activeElement).toBe(control);
      if (control.matches('[data-slot="list-row-link"]')) continue;
      expect(control.classList.contains('min-h-11')).toBe(true);
      expect(control.classList.contains('whitespace-normal')).toBe(true);
      expect(control.classList.contains('wrap-anywhere')).toBe(true);
      if (control.tagName === 'BUTTON') expect(control.classList.contains('h-auto')).toBe(true);
      else expect(control.className).toContain('focus-visible:outline-2');
    }
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    for (const heading of host.querySelectorAll('h2'))
      expect(heading.getAttribute('data-content-item-slot')).toBe('title');
  };
  try {
    // One connected view walk: use the actual emitted destination to choose the next supplied page.
    setLocale('en', { reload: false });
    await mount(directory());
    assertControls();
    expect(text()).toContain(m.managed_owner());
    expect(text()).toContain(m.managed_current());
    expect(text()).toContain(m.managed_reconciling());
    expect(host.querySelector(`a[href="/en/accounts/01a1a000-0000-7000-8000-000000000189"]`)).toBeNull();
    link('/en/@retired%20%2B%2F%3D%3F%26');
    const nextPages = new Map<string, ReactNode>([
      [managementHref(organization), account(detail)],
      [managementHref(human), account(self)],
      [managementHref(automation), account(operated)],
      ['/en/accounts', directory()],
    ]);
    const follow = async (href: string) => {
      const emitted = link(href).getAttribute('href')!;
      expect(nextPages.has(emitted)).toBe(true);
      await mount(nextPages.get(emitted));
      assertControls();
    };
    assertPaging('organizationsCursor', inventory.organizations.next!);
    assertPaging('operatorsCursor', inventory.responsibilities.next!);
    link(`/en/accounts/${human.id}/verification`);
    link('/en/review/account-verifications');
    link('/en/settings');
    link('https://auth.example.test/organizations/new');
    await follow(managementHref(organization));
    link(`/en/@${human.handle}`);
    link(`/en/settings?managedAccount=${organization.id}#account`);
    assertPaging('membersCursor', detail.members.next!);
    assertPaging('operatorsCursor', detail.responsibilities!.next!);
    const unavailableHolder = [...host.querySelectorAll('li')].find((row) =>
      row.textContent!.includes(m.managed_member()),
    );
    expect(unavailableHolder!.querySelector('a')).toBeNull();
    expect(host.innerHTML).not.toContain('01a1a000-0000-7000-8000-000000000199');
    await follow('/en/accounts');
    await follow(managementHref(human));
    expect(text()).toContain(inventory.account.displayName!);
    expect(text()).toContain(m.managed_options_guidance());
    expect(text()).toContain(m.managed_operation_status());
    link('https://auth.example.test/account/delete');
    link('/en/settings');
    link(`/en/settings?managedAccount=${human.id}#account`);
    await follow('/en/accounts');
    await follow(managementHref(automation));
    expect(text()).toContain(m.managed_missing_title());
    expect(text()).toContain(m.managed_transfer_unavailable());
    expect(host.querySelector('a[href="https://auth.example.test/account/delete"]')).toBeNull();
    const refresh = host.querySelector<HTMLButtonElement>('button')!;
    expect(retries).toBe(0);
    await act(async () => refresh.click());
    expect(retries).toBe(1);
    expect(window.document.activeElement).toBe(refresh);

    for (const locale of locales) {
      window.history.replaceState(null, '', `/${locale}/accounts`);
      await setLocale(locale, { reload: false });
      for (const dir of ['ltr', 'rtl'] as const) {
        host.dir = dir;
        await mount(directory());
        assertControls();
        // A direct address has First but no invented Previous; a live visit supplies exact predecessors.
        expect(host.querySelector('a[rel="prev"]')).toBeNull();
        for (const view of [
          <ManagedAccountsPage
            page={ready(inventory)}
            cursors={cursors}
            retry={retry}
            navigation={{ previous: () => ({ cursor: undefined }), move: () => {} }}
          />,
          <AccountManagementPage
            page={ready(detail)}
            cursors={cursors}
            retry={retry}
            navigation={{ previous: () => ({ cursor: undefined }), move: () => {} }}
          />,
        ]) {
          await mount(view);
          assertControls();
          for (const region of host.querySelectorAll('[data-management-feed]')) {
            const field = region.getAttribute('data-management-feed') as keyof Cursors;
            const backward = [...region.querySelectorAll<HTMLAnchorElement>('nav a')].filter(
              (anchor) => anchor.rel !== 'next',
            );
            expect(backward.map((anchor) => anchor.textContent)).toEqual([
              m.prq_previous(),
              m.settings_managed_start_first_page(),
            ]);
            for (const anchor of backward) {
              const query = new URL(anchor.href).searchParams;
              expect(query.has(field)).toBe(false);
              for (const other of Object.keys(cursors) as (keyof Cursors)[])
                if (other !== field) expect(query.get(other)).toBe(cursors[other]!);
            }
          }
        }
        // Supplied capability, section preparation and page emptiness remain distinct.
        for (const available of [false, null] as const) {
          await mount(directory({ ...ready(inventory), organizationsAvailable: available }));
          expect(text()).toContain(
            available === false ? m.managed_creation_closed() : m.managed_creation_unavailable(),
          );
          expect(host.querySelector('a[href="https://auth.example.test/organizations/new"]')).toBeNull();
        }
        for (const next of [null, 'sparse-next']) {
          const empty = { ...inventory, organizations: { state: 'ready' as const, items: [], next } };
          await mount(directory(ready(empty)));
          expect(text()).toContain(next ? m.managed_no_current_page() : m.managed_no_organizations());
        }
        await mount(directory(ready({ ...inventory, organizations: { state: 'preparing', items: [], next: null } })));
        expect(text()).toContain(m.managed_preparing_text());
        expect(text()).not.toContain(m.managed_no_organizations());
        await mount(
          account({
            ...detail,
            role: 'member',
            members: { state: 'denied', items: [], next: null },
            responsibilities: null,
          }),
        );
        expect(text()).toContain(m.managed_holders_denied());
        expect(text()).toContain(m.managed_member());
        expect(text()).not.toContain(human.displayName);
        expect(host.innerHTML).not.toContain(human.id);
        for (const state of ['preparing', 'denied', 'missing', 'signed-out', 'unavailable'] as const) {
          const failure: PageFailure = { state };
          const messages = {
            preparing: [m.managed_preparing_title(), m.managed_preparing_text()],
            denied: [m.managed_denied_title(), m.managed_denied_text()],
            missing: [m.managed_missing_title(), m.managed_missing_text()],
            'signed-out': [m.managed_sign_in_title(), m.managed_sign_in_text()],
            unavailable: [m.managed_unavailable_title(), m.managed_unavailable_text()],
          };
          for (const view of [directory(failure), <AccountManagementPage page={failure} retry={retry} />]) {
            await mount(view);
            assertControls();
            expect(host.innerHTML).not.toContain(organization.id);
            expect(host.innerHTML).not.toContain('managedAccount=');
            expect(text()).not.toContain(m.managed_no_organizations());
            expect(host.querySelector('[role="alert"]')).not.toBeNull();
            for (const message of messages[state]) expect(text()).toContain(message);
            if (state === 'signed-out') {
              link(`/auth/sign-in?return_to=${encodeURIComponent(`/${locale}/accounts`)}`);
              expect(host.querySelector('button')).toBeNull();
            } else {
              const before = retries;
              await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
              expect(retries).toBe(before + 1);
            }
          }
        }
      }
    }
    // An external continuation outside the closed URL grammar cannot become a retained coordinate.
    await mount(
      directory(ready({ ...inventory, organizations: { ...inventory.organizations, next: 'x'.repeat(4097) } })),
    );
    expect(host.querySelector('[data-management-feed="organizationsCursor"] a[rel="next"]')).toBeNull();
    // Native management pages admit 20 candidates, so a 64-row witness would misrepresent the bound.
    // These supplied-data sizes establish construction only, not native query growth or measured render cost.
    for (const size of [1, 8, 20]) {
      const rows = Array.from({ length: size }, (_, index) => ({
        account: { ...organization, id: `01a1a000-0000-7000-8000-${String(index).padStart(12, '0')}` },
        role: 'owner' as const,
      }));
      await mount(
        directory(
          ready({
            ...inventory,
            organizations: { state: 'ready', items: rows, next: null },
            responsibilities: { items: [], next: null },
          }),
        ),
      );
      expect(host.querySelectorAll('li')).toHaveLength(size);
    }
    expect(requests).toBe(0);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    setLocale(previousLocale, { reload: false });
    globalThis.fetch = previousFetch;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
