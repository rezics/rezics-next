import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { act } from 'react';
import { useState } from 'react';
import type { AccountPage, Operation, OperationResult } from '../src/account-verification/transport';
import { request } from '../src/stories/pages/accounts-verification/fixtures';

test('verification departures preserve all reviewed drafts and original commands, then retire responses on Leave or authority replacement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/review' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    scrollTo: window.scrollTo.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { ReviewPageView, AccountVerificationPageView } = await import('../src/account-verification/pages');
  const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const oldLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const { waitFor } = await import(require.resolve('@testing-library/dom'));
  const user = userEvent.setup({ document });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const calls: { input: Operation; resolve: (result: OperationResult) => void }[] = [];
  const submit = (input: Operation) => new Promise<OperationResult>((resolve) => calls.push({ input, resolve }));
  let viewerId = 'reviewer-a',
    allowed = true,
    page = 0,
    refreshes = 0,
    movements = 0;
  let rerenderReview = () => {};
  const history: number[] = [];
  let caller = submit;
  const account: AccountPage = {
    account: null,
    latest: { state: 'ready', value: request },
    reviewer: true,
    publication: {
      state: 'verified',
      subject: { id: request.catalogueSubjectId, label: 'Author', type: 'schema:Person' },
    },
    operations: ['account.revoke_verification'],
  };
  const row = (id: string) => ({ request: { ...request, id }, account: null, subject: null });
  const review = () => {
    const [, update] = useState(0);
    rerenderReview = () => update((value) => value + 1);
    return (
      <ReviewPageView
        viewerId={viewerId}
        page={{
          state: 'ready',
          value: {
            requests: page ? [row('next-target')] : [row(request.id), row('other-target')],
            next: 'next',
          },
        }}
        operations={allowed ? ['verification_request.approve', 'verification_request.reject'] : []}
        submit={caller}
        refresh={() => refreshes++}
        canPrevious={history.length > 0}
        next={() => {
          movements++;
          history.push(page);
          page++;
          rerenderReview();
        }}
        previous={() => {
          if (history.length) {
            movements++;
            page = history.pop()!;
          }
          rerenderReview();
        }}
        first={() => {
          movements++;
          history.length = 0;
          page = 0;
          rerenderReview();
        }}
      />
    );
  };
  const base = createRootRoute({
    component: () => (
      <AuthoringDepartureProvider sessionBound={false}>
        <Outlet />
      </AuthoringDepartureProvider>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/en/review'] }),
    routeTree: base.addChildren([
      createRoute({ getParentRoute: () => base, path: '/en/review', component: review }),
      createRoute({
        getParentRoute: () => base,
        path: '/en/accounts/$id/verification',
        component: () => (
          <AccountVerificationPageView
            viewerId={viewerId}
            accountId={request.accountId}
            page={{ state: 'ready', value: account }}
            submit={caller}
            refresh={() => refreshes++}
          />
        ),
      }),
    ]),
  });
  const render = async () =>
    act(async () => {
      await router.invalidate();
      root.render(<RouterProvider router={router} />);
    });
  const click = async (node: HTMLElement) =>
    act(async () => {
      await user.click(node);
    });
  const keyClick = async (node: HTMLElement) =>
    act(async () => {
      node.focus();
      await user.keyboard('{Enter}');
    });
  const button = (label: string, scope: ParentNode = document) =>
    [...scope.querySelectorAll('button')].find((node) => node.textContent?.trim() === label) ??
    (() => {
      throw new Error(`Missing button: ${label}`);
    })();
  const fields = () => [...host.querySelectorAll('textarea')];
  const fill = async (index: number, value: string) =>
    act(async () => {
      const field = fields()[index]!;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const popup = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const unload = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const formSubmit = async (index = 0) =>
    act(async () => {
      host
        .querySelectorAll('form')
        [index]!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  const choose = async (leave: boolean, local = false) =>
    click(
      button(
        leave ? (local ? m.thread_authoring_discard() : m.thread_authoring_leave()) : m.thread_authoring_stay(),
        popup()!,
      ),
    );
  try {
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    expect(unload()).toBe(false);
    for (const details of host.querySelectorAll('details')) details.open = true;
    await fill(0, 'First evidence checked');
    await fill(1, 'Second evidence checked');
    await act(async () => {
      const select = host.querySelector('select')!;
      select.value = 'reject';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await formSubmit();
    expect(unload()).toBe(true);
    const next = button(m.av_next_page());
    await click(next);
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await choose(false);
    expect(page).toBe(0);
    expect(history).toEqual([]);
    expect(fields().map((field) => field.value)).toEqual(['First evidence checked', 'Second evidence checked']);
    expect(host.querySelector('select')!.value).toBe('reject');
    expect(host.textContent).toContain(m.av_confirm({ action: m.av_reject() }));
    expect(document.activeElement).toBe(next);
    await click(next);
    await choose(true, true);
    expect(page).toBe(1);
    expect(history).toEqual([0]);
    expect(movements).toBe(1);
    expect(fields()[0]!.value).toBe('');
    expect(unload()).toBe(false);
    await fill(0, 'Second window draft');
    await act(async () => {
      const select = host.querySelector('select')!;
      select.value = 'reject';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await formSubmit();
    expect(host.textContent).toContain(m.av_confirm({ action: m.av_reject() }));
    expect(unload()).toBe(true);
    const previous = await waitFor(() => button(m.av_previous_page(), host));
    await keyClick(previous);
    expect(page).toBe(1);
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    const beforePreviousLeave = movements;
    await choose(false);
    expect(document.activeElement).toBe(previous);
    expect(page).toBe(1);
    expect(history).toEqual([0]);
    expect(movements).toBe(beforePreviousLeave);
    expect(fields()[0]!.value).toBe('Second window draft');
    expect(host.querySelector('select')!.value).toBe('reject');
    expect(host.textContent).toContain(m.av_confirm({ action: m.av_reject() }));
    await click(await waitFor(() => button(m.av_previous_page(), host)));
    await choose(true, true);
    expect(page).toBe(0);
    expect(history).toEqual([]);
    expect(movements).toBe(beforePreviousLeave + 1);
    expect(fields()[0]!.value).toBe('');
    await fill(0, 'Unresolved original reason');
    await formSubmit();
    await formSubmit();
    expect(calls).toHaveLength(1);
    await act(async () => calls[0]!.resolve({ state: 'uncertain' }));
    await click(host.querySelector<HTMLAnchorElement>('a[href*="/verification"]')!);
    await choose(false);
    expect(router.state.location.pathname).toBe('/en/review');
    expect(fields()[0]!.value).toBe('Unresolved original reason');
    await click(button(m.av_resume({ action: m.av_approve() })));
    expect(calls[1]!.input).toEqual(calls[0]!.input);
    await click(host.querySelector<HTMLAnchorElement>('a[href*="/verification"]')!);
    await choose(true);
    const refreshed = refreshes;
    await act(async () => calls[1]!.resolve({ state: 'accepted' }));
    expect(refreshes).toBe(refreshed);
    expect(fields()[0]!.value).toBe('');
    await fill(0, 'Account revocation reason');
    expect(unload()).toBe(true);
    await formSubmit();
    await formSubmit();
    await act(async () => calls[2]!.resolve({ state: 'accepted', reversal: 'revoked' }));
    expect(unload()).toBe(false);
    await act(async () => {
      await router.navigate({ to: '/en/review' });
    });
    await fill(0, 'Detached window reason');
    const detachedNext = button(m.av_next_page());
    const selectedHistory = [...history];
    const selectedPage = page;
    const selectedMovements = movements;
    await click(detachedNext);
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await act(async () => {
      viewerId = 'reviewer-b';
      rerenderReview();
    });
    expect(page).toBe(selectedPage);
    expect(history).toEqual(selectedHistory);
    expect(movements).toBe(selectedMovements);
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(0);
    expect(fields()[0]!.value).toBe('');
    await fill(0, 'Old caller reason');
    await formSubmit();
    await formSubmit();
    caller = (input) => submit(input);
    await act(async () => rerenderReview());
    const beforeReplacement = refreshes;
    await act(async () => calls[3]!.resolve({ state: 'accepted' }));
    expect(refreshes).toBe(beforeReplacement);
    await act(async () => {
      allowed = false;
      rerenderReview();
    });
    expect(unload()).toBe(false);
    expect(popup()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    overwriteGetLocale(oldLocale);
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
