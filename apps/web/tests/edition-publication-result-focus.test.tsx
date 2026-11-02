import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { EditionCommandRead } from '../src/content-editions/edition-create';

test('publication hands keyboard focus to admitted results and cancels superseded callers', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/editions/new' });
  const constructors = ['HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver'];
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    ...Object.fromEntries(constructors.map((key) => [key, Reflect.get(window, key)])),
    getComputedStyle: window.getComputedStyle.bind(window),
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
  mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { EditionPublicationPanel } = await import('../src/content-editions/edition-create-view');
  const { publicationFixture, subjectId } =
    await import('../src/stories/patterns/edition-publication/edition-publication-fixtures');
  const { m } = await import('../src/paraglide/messages.js');
  const { userEvent } = await import('storybook/test');
  const host = document.createElement('main');
  const outside = document.createElement('button');
  document.body.append(outside, host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'owner', csrfToken: 'csrf' });
  const mount = async () => {
    await act(async () => root.render(null));
    const fixture = await publicationFixture('selection');
    fixture.controller.chooseSubject(subjectId);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <EditionPublicationPanel api={fixture.api} controller={fixture.controller} />
        </QueryClientProvider>,
      ),
    );
    return fixture;
  };
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!;
  const press = async (label: string) =>
    act(async () => {
      button(label).focus();
      await userEvent.keyboard('{Enter}');
    });
  const focused = () => (document.activeElement?.tagName === 'H2' ? document.activeElement.textContent : null);
  try {
    outside.focus();
    const fixture = await mount();
    expect(document.activeElement).toBe(outside);
    await press(m.edition_publication_create());
    expect(focused()).toBe(m.edition_publication_draft_heading());
    expect(host.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(false);
    await act(async () => fixture.controller.refresh());
    expect(focused()).toBeNull();
    await press(m.edition_publication_accept_review());
    expect(focused()).toBe(m.edition_publication_draft_heading());
    expect(button(m.edition_publication_publish()).disabled).toBe(true);
    await act(async () => userEvent.click(host.querySelector('[type="checkbox"]')!));
    await press(m.edition_publication_publish());
    expect(focused()).toBe(m.edition_publication_published_heading());
    expect(fixture.calls.filter((call) => call.path.endsWith(':publish'))).toHaveLength(1);

    for (const cancel of ['focus', 'pointer', 'refresh', 'retire', 'unmount']) {
      const current = await mount();
      const pending = Promise.withResolvers<EditionCommandRead>();
      const send = current.api.command;
      current.api.command = () => pending.promise;
      await press(m.edition_publication_create());
      const result = await send(current.controller.snapshot().intent!);
      if (cancel === 'focus') outside.focus();
      if (cancel === 'pointer') document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      if (cancel === 'refresh') await act(async () => current.controller.refresh());
      if (cancel === 'retire') current.controller.retire();
      if (cancel === 'unmount') await act(async () => root.render(null));
      await act(async () => pending.resolve(result));
      expect(focused()).toBeNull();
      if (cancel === 'focus') expect(document.activeElement).toBe(outside);
    }
    await mount();
    await act(async () => userEvent.click(button(m.edition_publication_create())));
    expect(focused()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
});
