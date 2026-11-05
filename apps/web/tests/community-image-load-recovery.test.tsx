import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, Fragment } from 'react';
import type { RealmPresentationImage } from '../src/threads/board-community-source';
import { CommunityAvatar, CommunityBanner } from '../src/community/community-presentation-parts';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window();
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');

const realmId = '01a1a100-0000-7000-8000-000000000002';
const avatar: RealmPresentationImage = {
  id: '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0001',
  containerId: realmId,
  digest: 'a'.repeat(64),
  width: 320,
  height: 480,
  variants: [{ format: 'webp', width: 320, height: 480 }],
  placeholder: null,
  focalPoint: { x: 0.3, y: 0.65 },
  credit: null,
};
const banner: RealmPresentationImage = {
  ...avatar,
  id: '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0003',
  width: 1920,
  height: 320,
  focalPoint: { x: 0.35, y: 0.6 },
};

function presentation(
  nextBanner: RealmPresentationImage | null,
  nextAvatar: RealmPresentationImage | null,
  owner = realmId,
) {
  return createElement(
    Fragment,
    null,
    createElement(CommunityBanner, { banner: nextBanner, realmId: owner }),
    createElement(CommunityAvatar, { avatar: nextAvatar, realmId: owner, name: 'Reading Club' }),
    createElement('p', { 'data-slot': 'participation-state' }, 'Joined'),
  );
}

test('recovers banner and avatar with one explicit retry of the same admitted derivative', async () => {
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(presentation(banner, avatar)));

  for (const image of Array.from(host.querySelectorAll<HTMLImageElement>('img'))) {
    const isBanner = image.closest('[data-slot="media-image"]') !== null;
    const container = image.closest(isBanner ? '[data-slot="community-banner-image"]' : '[data-slot="avatar"]')!;
    await act(async () => image.dispatchEvent(new window.Event('error')));
    const control = container.querySelector<HTMLButtonElement>('button[data-slot="community-image-retry"]')!;
    expect(control.textContent).toBe(m.realm_appearance_retry_image());
    expect(control.tabIndex).toBe(0);
    control.focus();
    expect(window.document.activeElement).toBe(control);
    const source = image.getAttribute('src');
    const sourceSet = image.getAttribute('srcset');
    await act(async () => {
      control.click();
      control.click();
    });
    const replacement = host.querySelector<HTMLImageElement>(
      isBanner ? '[data-slot="media-image"] img' : '[data-slot="avatar-image"]',
    )!;
    expect(replacement).not.toBe(image);
    expect(replacement.getAttribute('src')).toBe(source);
    expect(replacement.getAttribute('srcset')).toBe(sourceSet);
    expect(
      host.querySelectorAll(isBanner ? '[data-slot="media-image"] img' : '[data-slot="avatar-image"]'),
    ).toHaveLength(1);
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(host.querySelector('[data-slot="participation-state"]')?.textContent).toBe('Joined');
    Object.defineProperty(replacement, 'naturalWidth', { configurable: true, value: 320 });
    await act(async () => replacement.dispatchEvent(new window.Event('load')));
    expect(container.querySelector('button[data-slot="community-image-retry"]')).toBeNull();
  }

  await act(async () => root.unmount());
  await window.happyDOM.abort();
});

test('retires retry state on replacement or absence and leaves unavailable derivatives unavailable', async () => {
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(presentation(banner, avatar)));
  const oldImages = Array.from(host.querySelectorAll<HTMLImageElement>('img'));
  await act(async () => oldImages.forEach((image) => image.dispatchEvent(new window.Event('error'))));
  const replacementBanner = { ...banner, id: '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0004' };
  const replacementAvatar = { ...avatar, id: '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0005' };
  await act(async () => root.render(presentation(replacementBanner, replacementAvatar)));
  await act(async () => oldImages.forEach((image) => image.dispatchEvent(new window.Event('error'))));
  expect(host.querySelectorAll('button[data-slot="community-image-retry"]')).toHaveLength(0);
  expect(host.querySelector('[data-slot="community-banner-image"]')?.getAttribute('data-image-load-state')).toBe(
    'loading',
  );
  expect(host.querySelector('[data-slot="avatar"]')?.getAttribute('data-image-load-state')).toBe('loading');

  const retired = Array.from(host.querySelectorAll<HTMLImageElement>('img'));
  await act(async () => root.render(presentation(null, null)));
  await act(async () => retired.forEach((image) => image.dispatchEvent(new window.Event('error'))));
  expect(host.querySelectorAll('img, button[data-slot="community-image-retry"]')).toHaveLength(0);
  expect(host.querySelector('[data-slot="board-banner-fallback"]')?.getAttribute('data-image-load-state')).toBe(
    'absent',
  );

  const unavailable = { ...banner, variants: [] };
  await act(async () => root.render(presentation(unavailable, { ...avatar, variants: [] })));
  expect(host.querySelectorAll('img, button[data-slot="community-image-retry"]')).toHaveLength(0);
  expect(host.querySelector('[data-slot="community-banner-image"]')?.getAttribute('data-image-load-state')).toBe(
    'unavailable',
  );
  expect(host.querySelector('[data-slot="avatar"]')?.getAttribute('data-image-load-state')).toBe('unavailable');

  await act(async () => root.unmount());
  await window.happyDOM.abort();
});
