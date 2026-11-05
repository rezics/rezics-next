import { afterAll, expect, mock, test } from 'bun:test';
import { act, createElement, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import type {
  RealmAppearanceAdapter,
  RealmAppearanceRead,
  RealmAppearanceSnapshot,
} from '../src/community/realm-presentation';
import type { RealmAppearanceCallerLifetime } from '../src/community/realm-appearance-caller-lifetime';
import { available, image } from '../src/kernel/fake/community';
import { realmImageSource } from '../src/community/realm-presentation';

const { Window } = await import(Bun.resolveSync('happy-dom', import.meta.dir));
const window = new Window({ url: 'https://site.test/en/spaces/quiet-novel-club-appearance' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  Event: window.Event,
  Element: window.Element,
  Node: window.Node,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('../src/community/realm-appearance-departure', () => ({
  RealmAppearanceDeparture: ({ children }: { children: ReactNode }) => children,
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const [{ createRoot }, { within, userEvent }, { RealmAppearanceSettings }, { m }] = await Promise.all([
  import('react-dom/client'),
  import('storybook/test'),
  import('../src/community/realm-presentation-settings'),
  import('../src/paraglide/messages.js'),
]);
const credited = {
  ...image,
  credit: {
    rightsHolder: 'A. Maker',
    via: { name: 'Openverse', url: 'https://images.example/photo' },
    license: 'CC BY 4.0',
  },
};
const replacement = {
  ...credited,
  id: '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0002',
  credit: {
    ...credited.credit,
    via: { name: 'Archive source', url: 'https://images.example/replacement' },
  },
  variants: [...credited.variants, { format: 'webp' as const, width: 640, height: 960 }],
};
const url = realmImageSource({ state: 'available', value: replacement })!;
const read = (
  avatar: RealmAppearanceSnapshot['avatar'] = { state: 'available', value: credited },
): RealmAppearanceRead => ({ kind: 'ready', snapshot: { ...available, avatar } });
let apiCalls = 0;
const adapter: RealmAppearanceAdapter = {
  read: async () => {
    apiCalls++;
    return read();
  },
  change: async () => {
    apiCalls++;
    return { kind: 'unavailable' };
  },
  select: async () => {
    apiCalls++;
    return { kind: 'unavailable' };
  },
  upload: async () => {
    apiCalls++;
    return { id: image.id };
  },
  resume: async () => {
    apiCalls++;
    return { id: image.id };
  },
};
const host = window.document.createElement('main');
window.document.body.append(host);
const user = userEvent.setup({ document: window.document as unknown as Document });
let root: Root | undefined;
const paint = (initial: RealmAppearanceRead, lifetime?: RealmAppearanceCallerLifetime) =>
  act(async () =>
    root!.render(createElement(RealmAppearanceSettings, { realmId: available.realmId, initial, adapter, lifetime })),
  );
const emit = (target: HTMLImageElement, type: 'error' | 'load') =>
  act(async () => {
    target.dispatchEvent(new window.Event(type));
  });
const preview = (src: string) => host.querySelector(`img[src="${src}"]`) as HTMLImageElement;
const retry = () => within(host).queryByRole('button', { name: m.realm_appearance_retry_image_preview() });
const clear = async (index: number) => {
  await user.click(within(host).getAllByRole('button', { name: m.realm_appearance_clear() })[index]!);
  await user.click(
    within(within(host).getByRole('group', { name: m.realm_appearance_clear_confirm() })).getByRole('button', {
      name: m.realm_appearance_clear(),
    }),
  );
};
afterAll(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
});
test('retry keeps the draft and fences replaced, cleared, revoked, and retired images', async () => {
  root = createRoot(host);
  await paint(read());
  const old = preview(realmImageSource({ state: 'available', value: credited })!);
  await clear(1);
  expect(host.textContent).toContain(m.realm_appearance_no_image());
  await paint(read({ state: 'available', value: replacement }));
  const current = preview(url);
  await emit(old, 'error');
  await emit(old, 'load');
  expect(retry()).toBeNull();
  await emit(current, 'error');
  expect(host.querySelector('a[href="https://images.example/photo"]')).toBeNull();
  expect(host.querySelector('a[href="https://images.example/replacement"]')).toBeNull();
  const button = within(host).getByRole('button', { name: m.realm_appearance_retry_image_preview() });
  const before = apiCalls;
  button.focus();
  await user.keyboard('{Enter}');
  const retried = preview(url);
  expect(retried).not.toBe(current);
  expect(retried.getAttribute('src')).toBe(url);
  expect(retried.parentElement?.querySelector('span')?.textContent).toBe(
    available.title.slice(0, 2).toLocaleUpperCase(),
  );
  expect(host.textContent).toContain(m.realm_appearance_image_unavailable());
  expect(host.textContent).toContain(m.realm_appearance_no_image());
  expect(host.textContent).not.toContain('A. Maker');
  expect(apiCalls).toBe(before);
  await emit(current, 'load');
  expect(host.textContent).not.toContain('A. Maker');
  await emit(retried, 'load');
  expect(host.textContent).toContain('A. Maker · CC BY 4.0');
  expect(host.querySelector<HTMLAnchorElement>('a[href="https://images.example/replacement"]')?.textContent).toBe(
    'Archive source',
  );
  await paint(read());
  expect(host.querySelector('a[href="https://images.example/replacement"]')).toBeNull();
  expect(host.querySelector('a[href="https://images.example/photo"]')).toBeNull();
  await paint(read({ state: 'unavailable', value: null }));
  expect(host.querySelector('a[href="https://images.example/photo"]')).toBeNull();
  await emit(retried, 'error');
  expect(retry()).toBeNull();
  await paint(read({ state: 'available', value: replacement }));
  const cleared = preview(url);
  await emit(cleared, 'error');
  await clear(0);
  await emit(cleared, 'error');
  expect(retry()).toBeNull();
  let active = true;
  const lifetime = {
    id: 1,
    realmId: available.realmId,
    sourceId: null,
    revision: 0,
    subject: null,
    csrfToken: null,
    locale: 'en',
    ready: true,
    current: () => active,
    ticket: () => 0,
    owns: () => active,
    retire: () => {
      active = false;
    },
    snapshot: () => 0,
    subscribe: () => () => {},
    connect: () => () => {},
  } as RealmAppearanceCallerLifetime;
  await paint(read({ state: 'available', value: replacement }), lifetime);
  const retired = preview(url);
  await emit(retired, 'error');
  expect(retry()).toBeTruthy();
  lifetime.retire();
  await paint(read({ state: 'available', value: replacement }), lifetime);
  await emit(retired, 'error');
  expect(retry()).toBeNull();
});
