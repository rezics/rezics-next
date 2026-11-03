import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, useState } from 'react';
import * as start from '../.storybook/react-start';
import { preparedPostReading } from '../src/stories/post-reading-fixtures';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import type { DocumentImagePresentation } from '../src/threads/document-media';
import { NativeDocumentImage } from '../src/threads/document-media-image';
import { selectDocumentImageInspectionVariant } from '../src/threads/document-image-inspection';
import { ThreadPostReadingBody } from '../src/threads/post-reading-body';
import type { ThreadDocumentMedia } from '../src/threads/document-media-read';
import type { ThreadPost } from '../src/threads/reads';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

test('disclosure, inspection, retry and reader replacement stay in one current image visit', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/', width: 390, height: 844 });
  const network = mock(async () => {
    throw new Error('Image inspection must not call a native producer');
  });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLImageElement: window.HTMLImageElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: network as unknown as typeof fetch,
  };
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  window.fetch = globals.fetch;

  const { createRoot } = await import('react-dom/client');
  const { default: userEvent } = await import(
    createRequire(require.resolve('storybook/test')).resolve('@testing-library/user-event')
  );
  const supplied = preparedPostReading(2);
  setLocale('en', { reload: false });
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    setLocale(locale, { reload: false });
    expect(m.document_image_inspection_size({ width: 390, height: 844 })).toContain('390');
  }
  setLocale('en', { reload: false });
  const longAlt = '多語言替代文字 👩🏽‍🚀 '.repeat(36);
  const longRightsHolder = '研究者權利資訊 '.repeat(35);
  const image: DocumentImagePresentation = {
    ...supplied.image,
    credit: {
      ...supplied.image.credit!,
      rightsHolder: longRightsHolder,
      via: { ...supplied.image.credit!.via, name: '來源連結 '.repeat(35) },
    },
  };
  const post = {
    ...supplied.post,
    body: {
      ...supplied.post.body,
      doc: {
        ...supplied.post.body.doc,
        content: supplied.post.body.doc.content!.map((node) =>
          node.type === 'image'
            ? { ...node, attrs: { ...node.attrs, alt: longAlt }, marks: [{ type: 'spoiler' }] }
            : node,
        ),
      },
    },
  };
  const sourceMedia = supplied.page.documentMedia as Extract<ThreadDocumentMedia, { kind: 'ready' }>;
  const media = { ...sourceMedia, images: [image] };
  type Visit = { readerKey: string; post: ThreadPost; media: ThreadDocumentMedia };
  let replace!: (visit: Visit) => void;
  function Reader() {
    const [visit, setVisit] = useState<Visit>({ readerKey: 'reader-a', post, media });
    replace = setVisit;
    return (
      <div key={visit.readerKey}>
        <ThreadPostReadingBody post={visit.post} documentMedia={visit.media} mentions={{}} locale="en" />
      </div>
    );
  }

  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document: window.document });
  const button = (rootElement: ParentNode, label: string) =>
    [...rootElement.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
    ) ?? null;
  const inspectLabel = m.document_image_inspect();
  const closeLabel = m.document_image_inspection_close();
  try {
    await act(async () => root.render(<Reader />));
    expect(host.querySelector('img')).toBeNull();
    expect(button(host, inspectLabel)).toBeNull();

    const reveal = button(host, m.thread_reveal_spoiler());
    expect(reveal).not.toBeNull();
    await act(async () => user.click(reveal!));
    const inline = host.querySelector('img')!;
    expect(inline.alt).toBe(longAlt);
    expect(button(host, inspectLabel)).toBeNull();
    await act(async () => inline.dispatchEvent(new window.Event('load')));
    const inspect = button(host, inspectLabel)!;
    expect(inspect).not.toBeNull();
    expect(inspect.className).toContain('min-h-11');

    await act(async () => user.click(inspect));
    let dialog = window.document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    let inspected = dialog.querySelector<HTMLImageElement>('[data-slot="document-image-inspection-stage"] img')!;
    const largestDelivered = selectDocumentImageInspectionVariant(image)!;
    expect(inspected.getAttribute('src')).toBe(largestDelivered.src);
    expect(dialog.textContent).toContain(longAlt);
    expect(dialog.textContent).toContain(longRightsHolder);
    expect(dialog.textContent).toContain(image.credit!.via.name);
    expect(dialog.querySelector(`[href="${image.credit!.via.url}"]`)).not.toBeNull();
    expect(dialog.querySelector('[data-slot="document-image-inspection-stage"]')!.getAttribute('data-scale')).toBe('fit');

    await act(async () => user.click(button(dialog, m.document_image_inspection_actual())!));
    const stage = dialog.querySelector<HTMLElement>('[data-slot="document-image-inspection-stage"]')!;
    expect(stage.getAttribute('data-scale')).toBe('actual');
    expect(inspected.style.width).toBe(`${largestDelivered.width}px`);
    expect(inspected.style.height).toBe(`${largestDelivered.height}px`);
    expect(stage.tabIndex).toBe(0);
    expect(button(dialog, closeLabel)!.className).toContain('min-h-11');
    expect(dialog.className).toContain('100dvh');
    expect(dialog.className).toContain('motion-reduce:animate-none');

    await act(async () => user.click(button(dialog, closeLabel)!));
    expect(window.document.activeElement).toBe(inspect);
    await act(async () => user.click(inspect));
    dialog = window.document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    inspected = dialog.querySelector<HTMLImageElement>('[data-slot="document-image-inspection-stage"] img')!;
    await act(async () => user.keyboard('{Escape}'));
    expect(window.document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(window.document.activeElement).toBe(inspect);

    await act(async () => user.click(inspect));
    dialog = window.document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    const failedSurface = dialog.querySelector<HTMLImageElement>('[data-slot="document-image-inspection-stage"] img')!;
    await act(async () => failedSurface.dispatchEvent(new window.Event('error')));
    expect(window.document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(host.textContent).not.toContain(longRightsHolder);
    expect(host.querySelector('figcaption')).toBeNull();
    expect(button(host, m.document_image_retry())).not.toBeNull();
    await act(async () => failedSurface.dispatchEvent(new window.Event('load')));
    expect(window.document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(host.textContent).not.toContain(longRightsHolder);

    await act(async () => user.click(button(host, m.document_image_retry())!));
    const retryImage = host.querySelector('img')!;
    await act(async () => retryImage.dispatchEvent(new window.Event('load')));
    const reopened = button(host, inspectLabel)!;
    await act(async () => user.click(reopened));
    const retiredDialog = window.document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    const retiredSurface = retiredDialog.querySelector<HTMLImageElement>('[data-slot="document-image-inspection-stage"] img')!;
    const revisedPost = { ...post, revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000099', sha256: '1'.repeat(64) };
    const revisedMedia = {
      ...media,
      documents: media.documents.map((document) => ({
        ...document,
        revisionId: revisedPost.revisionId,
        sha256: revisedPost.sha256,
      })),
    };
    await act(async () => replace({ readerKey: 'reader-a', post: revisedPost, media: revisedMedia }));
    expect(window.document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).not.toContain(longRightsHolder);
    await act(async () => retiredSurface.dispatchEvent(new window.Event('load')));
    expect(window.document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();

    const revisedReveal = button(host, m.thread_reveal_spoiler())!;
    await act(async () => user.click(revisedReveal));
    const revisedInline = host.querySelector('img')!;
    await act(async () => revisedInline.dispatchEvent(new window.Event('load')));
    const revisedTrigger = button(host, inspectLabel)!;
    await act(async () => user.click(revisedTrigger));
    const viewerDialog = window.document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    const viewerSurface = viewerDialog.querySelector<HTMLImageElement>('[data-slot="document-image-inspection-stage"] img')!;
    const readerReplacement = { readerKey: 'reader-b', post: revisedPost, media: revisedMedia };
    await act(async () => replace(readerReplacement));
    expect(window.document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(host.querySelector('img')).toBeNull();
    expect(button(host, inspectLabel)).toBeNull();
    await act(async () => viewerSurface.dispatchEvent(new window.Event('error')));
    expect(host.textContent).not.toContain(longRightsHolder);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.abort();
  }
});

test('1, 8 and 32 images mount one selected derivative surface and retain lazy inline loading', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/', width: 390, height: 844 });
  const network = mock(async () => {
    throw new Error('Image inspection must not call a native producer');
  });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLImageElement: window.HTMLImageElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: network as unknown as typeof fetch,
  };
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  window.fetch = globals.fetch;
  const { createRoot } = await import('react-dom/client');
  const { default: userEvent } = await import(
    createRequire(require.resolve('storybook/test')).resolve('@testing-library/user-event')
  );
  const containerId = '0192f3a0-6c1e-7b2a-9d4e-999999999999';
  const widths = [16, 32, 64, 96, 128, 192, 256, 320, 640, 960, 1280, 2560];
  const images = Array.from({ length: 32 }, (_, index): DocumentImagePresentation => ({
    id: `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`,
    containerId,
    digest: String(index).padStart(64, '0'),
    width: 1536,
    height: 1024,
    variants: Array.from({ length: 12 }, (_, variant) => {
      const width = index % 4 === 0 ? 8 + variant : widths[variant]!;
      const height = index % 4 === 0
        ? 4 + variant
        : index % 4 === 1
          ? width * 2
          : index % 4 === 2
            ? Math.max(1, Math.round(width / 2))
            : width * 1000;
      return { format: variant % 2 ? 'webp' : 'avif', width, height };
    }),
    placeholder: null,
    focalPoint: null,
    credit: null,
  }));
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document: window.document });
  const inspectLabel = m.document_image_inspect();
  const closeLabel = m.document_image_inspection_close();
  try {
    for (const count of [1, 8, 32]) {
      await act(async () =>
        root.render(
          <div key={count}>
            {images.slice(0, count).map((image) => (
              <NativeDocumentImage key={image.id} image={image} alt={`Image ${image.id}`} locale="en" />
            ))}
          </div>,
        ),
      );
      const inline = [...host.querySelectorAll('img')];
      expect(inline).toHaveLength(count);
      await act(async () => {
        for (const image of inline) image.dispatchEvent(new window.Event('load'));
      });
      const chosen = Math.floor(count / 2);
      const triggers = [...host.querySelectorAll('button')].filter((button) => button.textContent?.trim() === inspectLabel);
      expect(triggers).toHaveLength(count);
      await act(async () => user.click(triggers[chosen]!));
      const dialog = window.document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
      const active = [...dialog.querySelectorAll('[data-slot="document-image-inspection-stage"] img')];
      expect(active).toHaveLength(1);
      const selected = images[chosen]!;
      const largest = selectDocumentImageInspectionVariant(selected)!;
      expect(active[0]!.getAttribute('src')).toBe(largest.src);
      expect(inline.every((image) => image.loading === 'lazy')).toBe(true);
      expect(dialog.querySelectorAll('img')).toHaveLength(1);
      await act(async () => user.click([...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === closeLabel)!));
      expect(window.document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    }
    for (const index of [0, 1, 2, 3]) {
      const trigger = [...host.querySelectorAll('button')].filter((button) => button.textContent?.trim() === inspectLabel)[index]!;
      await act(async () => user.click(trigger));
      const dialog = window.document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
      const stage = dialog.querySelector<HTMLElement>('[data-slot="document-image-inspection-stage"]')!;
      const active = stage.querySelector<HTMLImageElement>('img')!;
      const delivered = selectDocumentImageInspectionVariant(images[index]!)!;
      expect(active.width).toBe(delivered.width);
      expect(active.height).toBe(delivered.height);
      expect(active.style.objectFit).toBe('contain');
      if (index === 0) expect(delivered.width).toBeLessThan(32);
      if (index === 1) expect(delivered.height).toBeGreaterThan(delivered.width);
      if (index === 2) expect(delivered.width).toBeGreaterThan(delivered.height);
      if (index === 3) expect(delivered.height).toBeGreaterThan(delivered.width * 100);
      await act(async () => user.click(button(dialog, m.document_image_inspection_actual())!));
      expect(active.style.width).toBe(`${delivered.width}px`);
      expect(active.style.height).toBe(`${delivered.height}px`);
      await act(async () => user.click(button(dialog, closeLabel)!));
    }
    expect(network).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.abort();
  }
});
