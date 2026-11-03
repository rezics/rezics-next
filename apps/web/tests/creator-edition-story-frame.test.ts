import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
afterAll(() => mock.restore());

const editionId = '019a2100-0000-7000-8000-000000000001';

async function withFrame(node: ReactNode, run: (host: HTMLElement) => Promise<void>) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test/en/creator/offers/new?editionId=${editionId}` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { overwriteGetLocale, getLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(node);
    });
    await run(host);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    overwriteGetLocale(previousLocale);
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
}

function mainOf(host: HTMLElement) {
  const main = host.querySelector<HTMLElement>('main#main-content');
  expect(main).toBeTruthy();
  return main!;
}

test('selected-edition editor stays inside the shared frame and cannot create after typing or retirement', async () => {
  const stories = await import('../src/stories/creator-edition-disclosure.stories');
  const offers = await import('../src/checkout/creator-offers');
  const { m } = await import('../src/paraglide/messages.js');
  const transport = spyOn(offers, 'manageCreatorOffer').mockRejectedValue(new Error('creation must not dispatch'));
  try {
    await withFrame(stories.Normal.render!({}), async (host) => {
      const main = mainOf(host);
      expect(main.textContent).toContain(m.creator_new_offer());
      expect(main.textContent).toContain('CC-BY-4.0');
      expect(main.textContent).toContain(editionId);
      const create = main.querySelector<HTMLButtonElement>('button[type="submit"]');
      expect(create?.textContent).toBe(m.creator_create());
      expect(create?.disabled).toBe(true);
      const title = main.querySelector<HTMLInputElement>('input[name="title"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, 'My offer title');
        title.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      expect(title.value).toBe('My offer title');
      expect(create?.disabled).toBe(true);
      expect(host.querySelector('.max-w-xs')).toBeNull();
    });
    await withFrame(stories.NarrowLongText.render!({}), async (host) => {
      const main = mainOf(host);
      expect(main.textContent).toContain('https://creativecommons.org/licenses/by/4.0/legalcode.en');
      expect(main.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
      expect(host.querySelector('.max-w-xs')).toBeNull();
    });
    await withFrame(stories.ChooseEdition.render!({}), async (host) => {
      const main = mainOf(host);
      expect(main.textContent).toContain(m.creator_choose_edition());
      expect(main.querySelector('input[name="title"]')).toBeNull();
      expect(main.textContent).not.toContain('CC-BY-4.0');
    });
    await withFrame(stories.Unavailable.render!({}), async (host) => {
      const main = mainOf(host);
      expect(main.textContent).toContain(m.creator_unavailable());
      expect(main.querySelector('button[type="submit"]')).toBeNull();
    });
    await withFrame(stories.AuthorityRetired.render!({}), async (host) => {
      const main = mainOf(host);
      expect(main.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
      const retire = [...main.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retire supplied authority',
      );
      expect(retire).toBeTruthy();
      await act(async () => {
        retire!.click();
      });
      expect(mainOf(host).textContent).toContain(m.creator_denied());
      expect(host.querySelector('button[type="submit"]')).toBeNull();
    });
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});
