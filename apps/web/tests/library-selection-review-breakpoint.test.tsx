import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useRef, useState } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { SelectionReviewView } from '../src/library/selection-review-view';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

test('selection review hydrates to a phone sheet, crosses to Base UI dialog and restores its current opener', async () => {
  const browser = new Window({ url: 'https://site.test/en/library', width: 390, height: 844 });
  let width = 390;
  const listeners = new Set<(event?: Event) => void>();
  Object.defineProperty(browser, 'innerWidth', { configurable: true, get: () => width });
  browser.matchMedia = ((query: string) => ({
    media: query,
    matches: width < 768,
    onchange: null,
    addEventListener: (_type: string, listener: (event?: Event) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event?: Event) => void) => listeners.delete(listener),
  })) as unknown as typeof browser.matchMedia;

  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    Element: browser.Element,
    Node: browser.Node,
    DocumentFragment: browser.DocumentFragment,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  function Harness() {
    const [open, setOpen] = useState(false);
    const launcher = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={launcher} type="button" onClick={() => setOpen(true)}>
          Review selection
        </button>
        <output data-mobile={useIsMobile() ? 'true' : 'false'} />
        <SelectionReviewView
          open={open}
          onOpenChange={setOpen}
          items={[{ subjectId: 'subject-1', title: 'Current work' }]}
          statusChoices={[]}
          statusValue=""
          statusAllowed={false}
          statusBlocked={false}
          pending={false}
          hydrated
          onStatusChange={() => undefined}
          onReviewStatus={() => undefined}
          launcher={launcher}
          isCurrent={() => true}
        />
      </>
    );
  }

  const { useIsMobile } = await import('@rezics/ui/hooks/use-mobile');
  const host = browser.document.createElement('main');
  host.innerHTML = renderToString(createElement(Harness));
  browser.document.body.append(host);
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(host, createElement(Harness));
    });
    expect(host.querySelector('output')?.getAttribute('data-mobile')).toBe('true');
    await act(async () => host.querySelector('button')?.click());
    expect(browser.document.querySelector('[data-slot="drawer-popup"]')).not.toBeNull();

    await act(async () => {
      width = 1024;
      listeners.forEach((listener) => listener());
    });
    expect(host.querySelector('output')?.getAttribute('data-mobile')).toBe('false');
    expect(browser.document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();

    const done = [...browser.document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === m.library_selection_review_close(),
    );
    expect(done).toBeDefined();
    await act(async () => done?.click());
    await act(async () => new Promise<void>((resolve) => browser.requestAnimationFrame(() => resolve())));
    expect(browser.document.activeElement).toBe(host.querySelector('button'));
    expect(browser.document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  } finally {
    if (root) await act(async () => root?.unmount());
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
