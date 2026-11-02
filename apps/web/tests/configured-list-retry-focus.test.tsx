import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';

test('configured-list Retry follows a settled recovery and retires after movement or reader replacement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/search/list' });
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
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const [{ createRoot }, { useConfiguredListRetryFocus }] = await Promise.all([
    import('react-dom/client'),
    import('../src/features/pages/configured-list-retry-focus'),
  ]);
  type Outcome = 'pending' | 'unavailable' | 'ready';
  type Owner = {
    route: string;
    reader: string;
    queryClient: object;
    incarnation: string;
    isCurrent(): boolean;
  };
  function Harness({ owner, outcome, retrying }: { owner: Owner; outcome: Outcome; retrying: boolean }) {
    const focus = useConfiguredListRetryFocus(owner, outcome, retrying);
    return createElement(
      'div',
      null,
      outcome === 'ready'
        ? createElement('section', { ref: focus.resultRef, role: 'region', 'aria-label': 'Book results', tabIndex: -1 })
        : createElement('p', { ref: focus.statusRef, role: 'status', tabIndex: -1 }, outcome),
      outcome === 'unavailable'
        ? createElement(
            'button',
            {
              ref: focus.retryRef,
              disabled: retrying,
              onClick: (event: React.MouseEvent<HTMLButtonElement>) => focus.noteActivation(event.currentTarget),
            },
            'Retry',
          )
        : null,
    );
  }

  const host = window.document.createElement('div');
  const outside = window.document.createElement('button');
  window.document.body.append(host, outside);
  const root = createRoot(host as unknown as HTMLElement);
  const client = {};
  const render = async (owner: Owner, outcome: Outcome, retrying = false) =>
    act(async () => root.render(createElement(Harness, { owner, outcome, retrying })));
  const publicOwner: Owner = {
    route: 'public-list',
    reader: 'public',
    queryClient: client,
    incarnation: 'public',
    isCurrent: () => true,
  };

  try {
    await render(publicOwner, 'unavailable');
    let retry = host.querySelector('button')!;
    await act(async () => {
      retry.focus();
      retry.click();
    });
    await render(publicOwner, 'pending', true);
    expect(window.document.activeElement).toBe(host.querySelector('[role="status"]'));
    await render(publicOwner, 'unavailable');
    retry = host.querySelector('button')!;
    expect(window.document.activeElement).toBe(retry);

    await act(async () => {
      retry.focus();
      retry.click();
    });
    await render(publicOwner, 'pending', true);
    outside.focus();
    await render(publicOwner, 'ready');
    expect(window.document.activeElement).toBe(outside);

    const realmOwner: Owner = {
      ...publicOwner,
      route: 'realm-list',
      reader: 'signed-in:reader-a',
      incarnation: 'realm-incarnation-a',
    };
    await render(realmOwner, 'unavailable');
    retry = host.querySelector('button')!;
    await act(async () => {
      retry.focus();
      retry.click();
    });
    await render(realmOwner, 'pending', true);
    const refreshedRealmOwner = { ...realmOwner, incarnation: 'realm-incarnation-b' };
    await render(refreshedRealmOwner, 'pending', true);
    expect(window.document.activeElement).toBe(host.querySelector('[role="status"]'));
    await render(refreshedRealmOwner, 'ready');
    expect(window.document.activeElement).toBe(host.querySelector('[role="region"][aria-label="Book results"]'));

    await render(refreshedRealmOwner, 'unavailable');
    retry = host.querySelector('button')!;
    await act(async () => {
      retry.focus();
      retry.click();
    });
    await render(refreshedRealmOwner, 'pending', true);
    await render({ ...refreshedRealmOwner, reader: 'signed-in:reader-b' }, 'ready');
    expect(window.document.activeElement).not.toBe(host.querySelector('[role="region"][aria-label="Book results"]'));
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.happyDOM.abort();
  }
});
