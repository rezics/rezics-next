import { afterAll, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { button, creationFixture, dom, fill, flush, open, send } from './creation-page-fixture';
import { recoveryPage } from '../../../services/auth/src/recovery-page';

creationFixture();
const previousScrollTo = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
Object.defineProperty(globalThis, 'scrollTo', { value: dom.scrollTo.bind(dom), configurable: true, writable: true });
afterAll(() => {
  if (previousScrollTo) Object.defineProperty(globalThis, 'scrollTo', previousScrollTo);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});
const { m } = await import('../src/paraglide/messages.js');
const { Route } = await import('../src/routes/recovery');
const transition = (type: string) =>
  window.dispatchEvent(Object.assign(new dom.Event(type), { persisted: true }) as unknown as Event);
async function setup(complete = false) {
  window.history.replaceState(
    null,
    '',
    `/recovery${complete ? '#account_id=private-account&token=private-token' : ''}`,
  );
  const root = createRootRoute();
  const route = Route.update({ id: '/recovery', path: '/recovery', getParentRoute: () => root } as never);
  const away = createRoute({ getParentRoute: () => root, path: '/away', component: () => 'Away' });
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ history, routeTree: root.addChildren([route, away]) });
  await router.load();
  const page = await open(createElement(RouterProvider, { router }), {});
  return {
    ...page,
    router,
    async close() {
      await page.render(null);
      history.destroy();
    },
  };
}
const submit = async (host: HTMLElement, value: string) => {
  await flush(() => fill(host.querySelector<HTMLInputElement>('input')!, value));
  await flush(() => {
    send(host);
    send(host);
  });
};
const refused = () => Response.json({ code: 'rate_limited' }, { status: 429 });

test('cached completion drops credentials, aborts reads, rejects late writes and retries only advice before deliberate fresh work', async () => {
  const page = await setup(true);
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    const input = page.host.querySelector<HTMLInputElement>('input')!;
    await submit(page.host, 'private-password');
    expect(page.calls).toHaveLength(1);
    await flush(() => transition('pagehide'));
    expect(input.value).toBe('');
    expect(page.host.querySelector('input')).toBeNull();
    expect(window.location.hash).toBe('');
    let finish!: (response: Response) => void;
    let readSignal: AbortSignal | undefined;
    let reads = 0;
    globalThis.fetch = (async (_path, init) => {
      expect(_path).toBe('/recovery/page');
      expect(JSON.parse(String(init?.body))).toEqual({ stage: 'complete' });
      reads++;
      readSignal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }) as typeof fetch;
    await flush(() => transition('pageshow'));
    expect(page.host.textContent).toContain('Checking current recovery advice');
    expect(button(page.host, 'Request a new recovery link')!.disabled).toBe(true);
    await flush(() => transition('pagehide'));
    expect(readSignal!.aborted).toBe(true);
    await flush(() =>
      finish(Response.json(recoveryPage('complete', { minPasswordLength: 8, maxPasswordLength: 128 }))),
    );
    await flush(() => transition('pageshow'));
    // A replacement viewer is malformed for anonymous recovery advice; never disclose it.
    await flush(() =>
      finish(
        Response.json({
          ...recoveryPage('complete', { minPasswordLength: 8, maxPasswordLength: 128 }),
          viewer: { kind: 'signed-in', account_id: 'replacement', email: 'other@example.test' },
        }),
      ),
    );
    expect(page.host.textContent).not.toContain('other@example.test');
    expect(button(page.host, m.auth_login_retry())).toBeDefined();
    await flush(() => { const control = button(page.host, m.auth_login_retry())!; control.focus(); control.click(); });
    await flush(() =>
      finish(Response.json(recoveryPage('complete', { minPasswordLength: 8, maxPasswordLength: 128 }))),
    );
    expect(document.activeElement?.id).toBe('recovery-return-heading');
    expect(reads).toBe(3);
    expect(page.host.textContent).toContain('earlier password reset may have completed');
    expect(page.host.textContent).not.toContain('Retry original submission');
    expect(page.host.textContent).not.toMatch(/private-account|private-token|private-password/);
    await flush(() => page.calls[0]!.resolve(Response.json({ success: true })));
    expect(assign).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('auth.recovery.complete')).toBeNull();
    globalThis.fetch = (async (_path, init) =>
      Response.json(
        recoveryPage(JSON.parse(String(init?.body)).stage, { minPasswordLength: 8, maxPasswordLength: 128 }),
      )) as typeof fetch;
    await flush(() => { const control = button(page.host, 'Request a new recovery link')!; control.focus(); control.click(); });
    expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('');
    expect(document.activeElement?.id).toBe('recovery-email');
    expect(page.calls).toHaveLength(1);
    await flush(() => void page.router.navigate({ to: '/away' }));
    expect(document.body.textContent).toContain('A request already sent may still finish.');
    await flush(() => button(document.body, 'Stay')!.click());
    expect(document.activeElement?.id).toBe('recovery-email');
    await flush(() => void page.router.navigate({ to: '/away' }));
    await flush(() => button(document.body, 'Leave')!.click());
    expect(page.host.querySelector('input')).toBeNull();
  } finally {
    assign.mockRestore();
    await page.close();
  }
});

for (const unknown of [false, true])
  test(`start refusal ${unknown ? 'after unknown preserves earlier send' : 'first establishes unsent work'}`, async () => {
    const page = await setup();
    try {
      await submit(page.host, 'private@example.test');
      expect(page.calls).toHaveLength(1);
      if (unknown) {
        await flush(() => page.calls[0]!.resolve(new Response('', { status: 503 })));
        expect(page.host.textContent).toContain('does not confirm that an account exists');
        await flush(() => button(page.host, 'Request a new recovery link')!.click());
        expect(page.calls).toHaveLength(1);
        expect(page.host.textContent).toContain('This sends a new request');
        await flush(() => send(page.host));
        expect(page.calls).toHaveLength(2);
      }
      await flush(() => page.calls.at(-1)!.resolve(refused()));
      const warning = new dom.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(warning as unknown as Event);
      expect(warning.defaultPrevented).toBe(unknown);
      await flush(() => transition('pagehide'));
      await flush(() => transition('pageshow'));
      expect(Boolean(page.host.querySelector('input'))).toBe(!unknown);
      if (unknown) expect(page.host.textContent).toContain('result is unknown');
      expect(page.host.textContent).not.toContain('private@example.test');
    } finally {
      await page.close();
    }
  });

test('acknowledged start retains generic history; a new document without mounted evidence makes no historical claim', async () => {
  let page = await setup();
  await submit(page.host, 'private@example.test');
  await flush(() => page.calls[0]!.resolve(Response.json({ success: true })));
  await flush(() => transition('pagehide'));
  await flush(() => transition('pageshow'));
  expect(page.host.textContent).toContain('Your recovery request was accepted');
  expect(page.host.textContent).not.toContain('private@example.test');
  expect(page.host.querySelector('input')).toBeNull();
  await flush(() => { const control = button(page.host, 'Request a new recovery link')!; control.focus(); control.click(); });
  expect(document.activeElement?.id).toBe('recovery-email');
  await page.close();
  page = await setup();
  try {
    expect(page.host.querySelector('input')).not.toBeNull();
    expect(page.host.textContent).not.toContain('Earlier recovery activity');
  } finally {
    await page.close();
  }
});

test('a deliberate newer start acknowledgement does not settle an earlier unknown send', async () => {
  const page = await setup();
  try {
    await submit(page.host, 'private@example.test');
    expect(page.calls).toHaveLength(1);
    await flush(() => page.calls[0]!.resolve(new Response('', { status: 503 })));
    expect(page.host.textContent).toContain('result is unknown');
    await flush(() => button(page.host, 'Request a new recovery link')!.click());
    expect(page.host.textContent).toContain('This sends a new request');
    await flush(() => send(page.host));
    expect(page.calls).toHaveLength(2);
    await flush(() => page.calls[1]!.resolve(Response.json({ success: true })));
    expect(page.host.textContent).toContain('result is unknown');

    await flush(() => transition('pagehide'));
    await flush(() => transition('pageshow'));
    expect(page.host.textContent).toContain('result is unknown');
    expect(page.host.textContent).not.toContain('private@example.test');
    expect(page.calls).toHaveLength(2);
  } finally {
    await page.close();
  }
});

test('historical fresh recovery keeps its trigger pending and cancels keyboard ownership on Tab or pointer', async () => {
  for (const complete of [false, true]) for (const modality of ['keyboard', 'pointer', 'tab']) for (const status of complete ? [200, 503] : [200]) {
    const page = await setup(complete);
    try {
      await submit(page.host, complete ? 'private-password' : 'reader@example.test');
      await flush(() => page.calls[0]!.resolve(new Response('', { status: 503 })));
      await flush(() => transition('pagehide'));
      await flush(() => transition('pageshow'));
      const trigger = button(page.host, 'Request a new recovery link')!;
      let finish!: (response: Response) => void;
      globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
      await flush(() => {
        trigger.focus();
        trigger.dispatchEvent(new dom.MouseEvent('click', { bubbles: true, detail: modality === 'pointer' ? 1 : 0 }));
      });
      const reader = page.host.querySelector<HTMLAnchorElement>('a[href="/login"]')!;
      if (complete) {
        expect(trigger.isConnected).toBe(true);
        expect(trigger.disabled).toBe(false);
        expect(document.activeElement).toBe(trigger);
        if (modality === 'tab') await flush(() => reader.focus());
        await flush(() => finish(status === 200
          ? Response.json(recoveryPage('start', { minPasswordLength: 8, maxPasswordLength: 128 }))
          : new Response('', { status })));
      }
      if (status !== 200) {
        expect(document.activeElement === button(page.host, m.auth_login_retry())!.parentElement).toBe(modality === 'keyboard');
        continue;
      }
      const input = page.host.querySelector<HTMLInputElement>('[name="email"]')!;
      expect(input.value).toBe('');
      expect(document.activeElement === input).toBe(modality === 'keyboard' || (!complete && modality === 'tab'));
      expect(page.host.textContent).toContain('result is unknown');
      expect(page.calls).toHaveLength(1);
    } finally { await page.close(); }
  }
});
