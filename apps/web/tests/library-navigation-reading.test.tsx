import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { LibraryPinsRead } from '../src/library/pins-read';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library', width: 1280, height: 900 });
const document = window.document as unknown as Document;
const globals = {
  window,
  document,
  navigator: window.navigator,
  ...Object.fromEntries(
    [
      'HTMLElement',
      'HTMLButtonElement',
      'HTMLInputElement',
      'HTMLAnchorElement',
      'Element',
      'Node',
      'Document',
      'DocumentFragment',
      'MutationObserver',
      'ResizeObserver',
      'Event',
      'MouseEvent',
      'KeyboardEvent',
    ].map((key) => [key, Reflect.get(window, key)]),
  ),
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { within, waitFor } = await import('@testing-library/dom');
const { default: userEvent } = await import('@testing-library/user-event');
const { LibraryNavigation } = await import('../src/library/library-nav');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const originalLocale = getLocale();
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
const currentId = 'current/旅?#';
const prefix = 'Archive reading collection with a long common prefix — international annotated edition — ';
const pins: Extract<LibraryPinsRead, { state: 'loaded' }> = {
  state: 'loaded',
  revision: 7,
  next: 'unread-next-page',
  pins: Array.from({ length: 9 }, (_, index) => {
    const id = index === 8 ? currentId : `pin-${index}`;
    return {
      collectionId: id,
      target:
        index === 5
          ? null
          : {
              id,
              title: index === 2 ? 'UnbrokenTitle'.repeat(24) : `${prefix}${index}`,
              membershipKind: 'curated' as const,
            },
    };
  }),
};
async function frames() {
  await act(
    async () =>
      new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
      }),
  );
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});
afterAll(() => {
  host.remove();
  setLocale(originalLocale, { reload: false });
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test.each([390, 1280])(
  'one Library surface at %ipx reads exact supplied destinations and returns focus',
  async (width) => {
    window.happyDOM.setWindowSize({ width, height: 900 });
    setLocale('en', { reload: false });
    const user = userEvent.setup({ document });
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <LibraryNavigation current={{ collectionId: currentId }} pins={pins} collections={[]} locale="en" />,
      ),
    );
    const trigger = within(host).getByRole('button');
    trigger.focus();
    await act(async () => user.keyboard('{Enter}'));
    await frames();
    const surface = await within(document.body).findByRole('dialog', { name: m.library_nav_selector() });
    expect(document.querySelectorAll('[data-library-destinations]')).toHaveLength(1);
    expect(
      [...surface.querySelectorAll<HTMLElement>('[data-library-pin]')].map((row) => row.dataset.libraryPin),
    ).toEqual(pins.pins.map((pin) => pin.collectionId));
    for (const pin of pins.pins) {
      const row = [...surface.querySelectorAll<HTMLElement>('[data-library-destination]')].find(
        (row) => row.dataset.libraryDestination === pin.collectionId,
      )!;
      if (pin.target) {
        const link = within(row).getByRole('link', { name: pin.target.title! });
        expect(link.getAttribute('href')).toBe(`/en/collections/${encodeURIComponent(pin.collectionId)}`);
        expect(row.querySelector('div span')!.textContent).toBe(pin.target.title);
        expect(link.getAttribute('aria-current')).toBe(pin.collectionId === currentId ? 'page' : null);
      } else {
        expect(row.textContent).toContain(m.library_pin_unavailable());
        expect(row.textContent).toContain(pin.collectionId);
        expect(row.querySelector('a, button, [tabindex]')).toBeNull();
      }
    }
    within(surface).getByRole('link', { name: pins.pins[4]!.target!.title! }).focus();
    await act(async () => user.tab());
    expect(document.activeElement).toBe(within(surface).getByRole('link', { name: pins.pins[6]!.target!.title! }));
    const current = within(surface).getByRole('link', { name: pins.pins[8]!.target!.title! });
    expect(current.closest('li')!.querySelector('svg')).not.toBeNull();
    current.focus();
    await act(async () => user.keyboard('{Escape}'));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(within(document.body).queryByRole('dialog', { name: m.library_nav_selector() })).toBeNull();
    await act(async () => user.click(trigger));
    await frames();
    const reopened = await within(document.body).findByRole('dialog', { name: m.library_nav_selector() });
    await act(async () =>
      root!.render(<LibraryNavigation current={{ collectionId: 'pin-5' }} pins={pins} collections={[]} locale="en" />),
    );
    const unavailableCurrent = reopened.querySelector('[data-library-destination="pin-5"]')!;
    expect(unavailableCurrent.getAttribute('aria-current')).toBe('page');
    expect(unavailableCurrent.querySelector('svg')).not.toBeNull();
    expect(reopened.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    // Follow the real href without asking Happy DOM to navigate to another document.
    const destination = within(reopened).getByRole('link', { name: m.library_nav_all_collections() });
    destination.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await act(async () => user.click(destination));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(pins.next).toBe('unread-next-page');
  },
);
