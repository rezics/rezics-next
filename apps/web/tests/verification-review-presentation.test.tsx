import { expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Operation, OperationResult, ReviewPage } from '../src/account-verification/transport';
import { request } from '../src/stories/pages/accounts-verification/fixtures';

test('management review keeps evidence, failed drafts and delayed decisions attached to their application and viewer', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/review/account-verifications' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { ReviewPageView, AccountManagementPageView, reviewHref } = await import('../src/account-verification/pages');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const oldLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const secondId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
  const rows: ReviewPage['requests'] = [request.id, secondId].map((id) => ({
    request: { ...request, id },
    account: { id: request.accountId, name: 'Mira', handle: 'mira' },
    subject: { id: request.catalogueSubjectId, name: 'Author' },
  }));
  let requests = rows,
    viewer = 'reviewer-a',
    mount = 0,
    canWrite = true,
    unavailable = false,
    refreshes = 0;
  const calls: { input: Operation; resolve: (result: OperationResult) => void }[] = [];
  const submit = (input: Operation) => new Promise<OperationResult>((resolve) => calls.push({ input, resolve }));
  const render = () =>
    act(async () =>
      root.render(
        <ReviewPageView
          key={`${viewer}:${mount}`}
          page={unavailable ? { state: 'unavailable' } : { state: 'ready', value: { requests, next: 'signed-next' } }}
          viewerId={viewer}
          operations={['verification_request.approve', 'verification_request.reject']}
          canWrite={canWrite}
          submit={submit}
          refresh={() => {
            refreshes++;
          }}
          next={() => {
            requests = [rows[1]!];
          }}
          first={() => {
            requests = rows;
          }}
        />,
      ),
    );
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  const textarea = () => host.querySelector('textarea')!;
  const fill = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value);
      textarea().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const decide = async () => {
    for (let i = 0; i < 2; i++)
      await act(async () => {
        host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
  };
  const settle = (index: number, result: OperationResult) => act(async () => calls[index]!.resolve(result));
  try {
    await act(async () =>
      root.render(<AccountManagementPageView page={{ state: 'ready', value: viewer }} refresh={() => {}} />),
    );
    expect(
      [...host.querySelectorAll('a')].find((a) => a.textContent === m.av_review_title())?.getAttribute('href'),
    ).toBe(reviewHref());
    await render();
    const proof = host.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(proof.href).toBe(request.links[0]!.url);
    expect(proof.closest('form')).toBeNull();
    expect(calls).toHaveLength(0);
    const reason = 'Confirmed through an independently contacted publisher.';
    await fill(reason);
    const schedule = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) =>
      schedule(fn, ms === 25_000 ? 1 : ms, ...args)) as typeof setTimeout);
    try {
      await decide();
      await act(async () => { await new Promise((resolve) => schedule(resolve, 15)); });
    } finally {
      timer.mockRestore();
    }
    expect(calls[0]!.input).toMatchObject({ action: 'approve', targetId: request.id, reason });
    expect(host.textContent).toContain(m.av_uncertain());
    await settle(0, { state: 'accepted', request: { ...request, state: 'approving' } });
    expect(host.textContent).toContain(m.av_uncertain());
    unavailable = true;
    await render();
    expect(host.textContent).toContain(request.id);
    expect(host.textContent).toContain(reason);
    unavailable = false;
    await render();
    expect(textarea().value).toBe(reason);
    canWrite = false;
    await render();
    expect(button(m.av_resume({ action: m.av_approve() })).disabled).toBe(true);
    canWrite = true;
    await render();
    await act(async () => button(m.av_resume({ action: m.av_approve() })).click());
    await settle(1, { state: 'uncertain' });
    requests = [rows[1]!];
    mount++;
    await render();
    expect(host.textContent).toContain(request.id);
    expect(host.textContent).toContain(reason);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async () => button(m.av_resume({ action: m.av_approve() })).click());
    expect(calls[2]!.input).toEqual(calls[0]!.input);
    expect(calls[1]!.input).toEqual(calls[0]!.input);
    await settle(2, { state: 'accepted', request: { ...request, state: 'approving' } });
    expect(host.textContent).toContain(m.av_approval_accepted());
    expect(textarea().disabled).toBe(false);
    await fill('Second application evidence checked.');
    await decide();
    expect(calls[3]!.input.targetId).toBe(secondId);
    viewer = 'reviewer-b';
    await render();
    const before = refreshes;
    await settle(3, { state: 'accepted', request: { ...request, id: secondId, state: 'approving' } });
    expect(refreshes).toBe(before);
    expect(host.textContent).not.toContain(m.av_approval_accepted());
    expect(textarea().value).toBe('');
    viewer = 'reviewer-a';
    await render();
    expect(host.textContent).toContain(secondId);
    expect(host.textContent).toContain('Second application evidence checked.');
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
