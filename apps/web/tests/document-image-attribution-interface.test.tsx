import { describe, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import type { DocumentImagePresentation } from '../src/threads/document-media';
import { NativeDocumentImage } from '../src/threads/document-media-image';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window();
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  Event: window.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');

const alt = `A charcoal field drawing of a mountain village, with a river crossing the foreground and a small bridge beside the old stone mill. ${'The artist marks the evening light across the rooftops. '.repeat(5)}`;
const rightsHolder = `Mira Chen and the Regional Archive ${'Image Preservation Contributors '.repeat(3)}`;
const viaName = `The Regional Archive Collection ${'Conservation and Image Records '.repeat(4)}`;
const viaUrl = 'https://images.example.test/collections/river-village';

const image: DocumentImagePresentation = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000041',
  containerId: '0192f3a0-6c1e-7b2a-9d4e-000000000042',
  digest: 'a'.repeat(64),
  width: 960,
  height: 640,
  variants: [
    { format: 'avif', width: 960, height: 640 },
    { format: 'webp', width: 480, height: 320 },
  ],
  placeholder: null,
  focalPoint: null,
  credit: {
    rightsHolder,
    via: { name: viaName, url: viaUrl },
    license: 'CC-BY-4.0',
    obligations: ['cc:Attribution'],
  },
};

function render(props: { image: DocumentImagePresentation | null; alt: string; locale: string }) {
  return renderToStaticMarkup(createElement(NativeDocumentImage, props));
}

describe('Document image attribution interface', () => {
  test('keeps long image text and complete credit readable beside an independently focusable admitted source link', () => {
    const html = render({ image, alt, locale: 'en' });

    expect(html).toContain('data-state="ready"');
    expect(html).toContain(`alt="${alt}"`);
    expect(html).toContain(`/media/${image.id}/avif-960`);
    expect(html).toContain(`/media/${image.id}/webp-480`);
    expect(html).toContain(rightsHolder);
    expect(html).toContain(viaName);
    expect(html).toContain(`href="${viaUrl}"`);
    expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
    expect(html).toContain('CC-BY-4.0');
    expect(html).toContain('focus-visible:outline-2');
    expect(html).toContain('[overflow-wrap:anywhere]');
    expect(html.match(/<a\b/g)).toHaveLength(1);
  });

  test('explains an omitted image while keeping its identity and private credit out of the fallback', () => {
    const html = render({ image: null, alt, locale: 'en' });
    const unavailable = m.content_edition_image_unavailable({}, { locale: 'en' as never });

    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain(`aria-label="${unavailable}: ${alt}"`);
    expect(html).toContain(unavailable);
    expect(html).toContain(alt);
    expect(html).toContain('[overflow-wrap:anywhere]');
    expect(html).not.toContain(image.id);
    expect(html).not.toContain(rightsHolder);
    expect(html).not.toContain(viaName);
    expect(html).not.toContain(viaUrl);
    expect(html).not.toContain('CC-BY-4.0');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<button');
  });

  test('withholds credit when a presentation has no usable derivative', () => {
    const html = render({ image: { ...image, variants: [] }, alt, locale: 'en' });

    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain(alt);
    expect(html).not.toContain(image.id);
    expect(html).not.toContain(rightsHolder);
    expect(html).not.toContain(viaUrl);
    expect(html).not.toContain('CC-BY-4.0');
    expect(html).not.toContain('<button');
  });

  test('manually retries one admitted load at a time, withholding credit until recovery succeeds', async () => {
    const host = window.document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(createElement(NativeDocumentImage, { image, alt, locale: 'en' })));
    const first = host.querySelector('img')!;
    await act(async () => first.dispatchEvent(new window.Event('error')));
    const retry = host.querySelector('button')!;
    expect(retry.textContent).toBe('Retry');
    await act(async () => {
      retry.click();
      retry.click();
    });
    const second = host.querySelector('img')!;
    expect(second).not.toBe(first);
    expect(host.querySelectorAll('img')).toHaveLength(1);
    expect(second.getAttribute('src')).toBe(first.getAttribute('src'));
    expect(second.getAttribute('srcset')).toBe(first.getAttribute('srcset'));
    expect(second.alt).toBe(alt);
    expect(second.loading).toBe('eager');
    expect(second.closest('picture')!.hidden).toBe(true);
    expect(retry.disabled).toBe(true);
    expect(host.querySelector('figure')!.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      first.dispatchEvent(new window.Event('load'));
      first.dispatchEvent(new window.Event('error'));
    });
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).not.toContain(rightsHolder);
    expect(host.textContent).toContain(alt);
    await act(async () => second.dispatchEvent(new window.Event('error')));
    expect(host.querySelector('img')).toBeNull();
    expect(retry.disabled).toBe(false);
    expect(host.querySelector('a')).toBeNull();
    await act(async () => retry.click());
    const third = host.querySelector('img')!;
    expect(third).not.toBe(second);
    await act(async () => third.dispatchEvent(new window.Event('load')));
    expect(host.querySelector('figure')!.getAttribute('data-state')).toBe('ready');
    expect(third.closest('picture')!.hidden).toBe(false);
    expect(host.querySelector('button')).toBeNull();
    expect(host.querySelector('a')!.getAttribute('href')).toBe(viaUrl);
    expect(host.textContent).toContain(rightsHolder);
    await act(async () => root.unmount());
    await window.happyDOM.abort();
  });

  test('retries a failed image after its id or digest changes and replaces its admitted source', async () => {
    const host = window.document.createElement('div');
    const root = createRoot(host);
    const show = (next: DocumentImagePresentation | null) =>
      act(async () => root.render(createElement(NativeDocumentImage, { image: next, alt, locale: 'en' })));
    const fail = () => act(async () => host.querySelector('img')!.dispatchEvent(new window.Event('error')));
    await show(image);
    await fail();
    expect(host.querySelector('figure')?.getAttribute('data-state')).toBe('unavailable');
    expect(host.textContent).toContain(alt);
    expect(host.querySelector('a')).toBeNull();

    const replacement = {
      ...image,
      id: '0192f3a0-6c1e-7b2a-9d4e-000000000043',
      digest: 'b'.repeat(64),
      credit: { ...image.credit!, via: { name: 'New archive', url: viaUrl } },
    };
    await show(replacement);
    expect(host.querySelector('img')?.getAttribute('src')).toContain(replacement.id);
    expect(host.querySelector('a')?.getAttribute('href')).toBe(viaUrl);
    await show(image);
    expect(host.querySelector('figure')?.getAttribute('data-state')).toBe('ready');

    await fail();
    const revised = {
      ...image,
      digest: 'c'.repeat(64),
      credit: { ...image.credit!, via: { name: 'Revised archive', url: 'https://images.example.test/revised' } },
    };
    await show(revised);
    expect(host.querySelector('figure')?.getAttribute('data-state')).toBe('ready');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://images.example.test/revised');
    const retired = host.querySelector('img')!;
    await show(null);
    await act(async () => retired.dispatchEvent(new window.Event('load')));
    expect(host.querySelector('img, button, a')).toBeNull();
    await show(revised);
    await act(async () => retired.dispatchEvent(new window.Event('error')));
    expect(host.querySelector('figure')?.getAttribute('data-state')).toBe('ready');
    await act(async () => root.unmount());
    await window.happyDOM.abort();
  });
});
