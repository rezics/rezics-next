import { describe, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import type { DocumentImagePresentation } from '../src/threads/document-media';
import { NativeDocumentImage } from '../src/threads/document-media-image';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window();
for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true }))
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
  });

  test('withholds credit when a presentation has no usable derivative', () => {
    const html = render({ image: { ...image, variants: [] }, alt, locale: 'en' });

    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain(alt);
    expect(html).not.toContain(image.id);
    expect(html).not.toContain(rightsHolder);
    expect(html).not.toContain(viaUrl);
    expect(html).not.toContain('CC-BY-4.0');
  });

  test('retries a failed image after its id or digest changes and replaces its admitted source', async () => {
    const host = window.document.createElement('div');
    const root = createRoot(host);
    const show = (next: DocumentImagePresentation) =>
      act(async () => root.render(createElement(NativeDocumentImage, { image: next, alt, locale: 'en' })));
    const fail = () => act(async () => host.querySelector('img')!.dispatchEvent(new window.Event('error')));
    await show(image);
    await fail();
    expect(host.querySelector('figure')?.getAttribute('data-state')).toBe('unavailable');
    expect(host.textContent).toContain(alt);
    expect(host.querySelector('a')).toBeNull();

    const replacement = { ...image, id: '0192f3a0-6c1e-7b2a-9d4e-000000000043', digest: 'b'.repeat(64), credit: { ...image.credit!, via: { name: 'New archive', url: viaUrl } } };
    await show(replacement);
    expect(host.querySelector('img')?.getAttribute('src')).toContain(replacement.id);
    expect(host.querySelector('a')?.getAttribute('href')).toBe(viaUrl);
    await show(image);
    expect(host.querySelector('figure')?.getAttribute('data-state')).toBe('ready');

    await fail();
    const revised = { ...image, digest: 'c'.repeat(64), credit: { ...image.credit!, via: { name: 'Revised archive', url: 'https://images.example.test/revised' } } };
    await show(revised);
    expect(host.querySelector('figure')?.getAttribute('data-state')).toBe('ready');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://images.example.test/revised');
    await act(async () => root.unmount());
    await window.happyDOM.abort();
  });
});
