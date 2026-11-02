import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { MediaImage } from '../src/components/media-image.tsx';

const webTests = join(import.meta.dir, '../../../apps/web/tests');
const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', webTests))));
const window = new Window();
for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true }))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const view = (media: string, onImageLoad?: () => void, onImageError?: () => void) =>
  createElement(MediaImage, {
    media, width: 320, height: 240, variants: [{ format: 'webp', width: 320 }],
    src: ({ media, format, width }) => `/${media}/${format}/${width}`, alt: media, sizes: '100vw', onImageLoad, onImageError,
  });
type ImageEvent = { currentTarget: HTMLImageElement };
const handlers = (image: HTMLImageElement) => {
  const key = Object.getOwnPropertyNames(image).find((name) => name.startsWith('__reactProps$'));
  return key ? (image as unknown as Record<string, { onLoad: (event: ImageEvent) => void; onError: (event: ImageEvent) => void }>)[key] : undefined;
};

test('bounds cached, changed, retired and remounted image completion callbacks', async () => {
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const calls: string[] = [];
  const cached = view('cached', () => calls.push('cached'));
  host.innerHTML = renderToString(cached);
  const cachedImage = host.querySelector('img')!;
  Object.defineProperties(cachedImage, { complete: { value: true }, currentSrc: { value: '/cached.webp' }, naturalWidth: { value: 320 } });
  let root = hydrateRoot(host, cached);
  await act(async () => {});
  await act(async () => root.render(view('cached', () => calls.push('churned'))));
  expect(calls).toEqual(['cached']);

  await act(async () => root.render(view('pending', () => calls.push('old'))));
  const pending = host.querySelector('img')!;
  Object.defineProperty(pending, 'complete', { configurable: true, value: false });
  const oldLoad = handlers(pending)!.onLoad;
  await act(async () => root.render(view('pending', () => calls.push('current'))));
  Object.defineProperty(pending, 'naturalWidth', { configurable: true, value: 320 });
  await act(async () => oldLoad({ currentTarget: pending }));
  expect(calls).toEqual(['cached', 'current']);

  const errors: string[] = [];
  await act(async () => root.render(view('A', undefined, () => errors.push('error'))));
  const first = host.querySelector('img')!;
  const stale = handlers(first)!.onError;
  for (const media of ['B', 'A']) await act(async () => root.render(view(media, undefined, () => errors.push('error'))));
  await act(async () => stale({ currentTarget: first }));
  expect(errors).toEqual([]);
  expect(host.querySelector('[data-slot="media-image"]')?.getAttribute('data-state')).toBe('image');

  const current = host.querySelector('img')!;
  const retired = handlers(current)!.onError;
  await act(async () => root.unmount());
  await act(async () => retired({ currentTarget: current }));
  expect(errors).toEqual([]);
  root = createRoot(host);
  const retry: string[] = [];
  await act(async () => root.render(view('A', () => retry.push('retry'))));
  const retried = host.querySelector('img')!;
  Object.defineProperty(retried, 'naturalWidth', { configurable: true, value: 320 });
  await act(async () => handlers(retried)!.onLoad({ currentTarget: retried }));
  expect(retry).toEqual(['retry']);
  await act(async () => root.unmount());
  await window.happyDOM.abort();
});
