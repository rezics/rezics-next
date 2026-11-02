import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { UI_LOCALES } from '@rezics/composition';
import { act } from 'react';
import type { CoverSummary } from '@rezics/ui/cover';

const picture = (media: string): CoverSummary => ({
  media,
  width: 4,
  height: 6,
  placeholder: { thumbhash: '', color: '#456' },
  variants: [{ format: 'webp', width: 240 }],
  focalPoint: null,
  credit: null,
});

test('cover replacement focuses the displayed-locale subject cover group and leaves the previous viewer closed', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/book', width: 1280 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const [{ createRoot }, { SubjectPageCover }, { m }, { setLocale }] = await Promise.all([
    import('react-dom/client'),
    import('../src/features/pages/subject-page-cover'),
    import('../src/paraglide/messages.js'),
    import('../src/paraglide/runtime.js'),
  ]);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const src = (media: string, format: 'avif' | 'webp', width: number) =>
    `https://media.test/${media}/${format}/${width}`;
  const render = (title: string, media: string, locale: (typeof UI_LOCALES)[number]) =>
    act(async () => {
      root.render(
        <SubjectPageCover
          subject={{ id: 'subject', title, types: ['schema:Book'] }}
          cover={picture(media)}
          size="lg"
          src={src}
          suitability="blur"
          labels={{}}
          title={title}
          via="via"
          openLabel={`Open cover: ${title}`}
          closeLabel="Close cover"
          locale={locale}
        />,
      );
    });
  try {
    for (const locale of UI_LOCALES) {
      setLocale(locale === 'en' ? 'ja' : 'en', { reload: false });
      const title = `Current ${locale}`;
      await render('Previous', 'media-a', locale);
      await act(async () => {
        host.querySelector('button')!.click();
      });
      expect(window.document.querySelector('[data-slot="cover-viewer-image"]')?.getAttribute('src')).toContain(
        'media-a',
      );
      await render(title, 'media-b', locale);
      const group = host.querySelector<HTMLElement>('[role="group"]')!;
      const name = m.subject_cover_group({ title }, { locale });
      expect(group.getAttribute('aria-label')).toBe(name);
      expect(name).not.toBe(m.subject_cover_group({ title }));
      expect(window.document.activeElement).toBe(group);
      expect(window.document.querySelector('[data-slot="cover-viewer-image"]')).toBeNull();
      expect([...host.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
        expect.stringContaining('media-b'),
      ]);
    }
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
