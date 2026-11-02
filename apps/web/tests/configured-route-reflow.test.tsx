import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { planReads, platformRegistry, validateComposition, type CompositionDocument } from '@rezics/composition';
import type { PresentationPreview } from '../src/features/pages/presentation-preview';
import type { RoutePageData } from '../src/features/pages/route';

// Authored UNRUN under minimal verification. DOM checks cover meaning and keyboard behavior;
// the companion story owns real CSS geometry, focus appearance and 200% text assertions.
const title = 'LesBibliothèquesEtLeursHistoires'.repeat(4);
const prose = `3 < 4 & "texte littéral"\r\n${'SansEspace'.repeat(50)}\r\n\r\n第二段落と読書の案内`;
const placeholder = 'Rechercher dans les œuvres et les collections';
const submit = 'Rechercher dans toutes les œuvres et les collections publiques';
const labels = [
  'DécouvrirLesBibliothèquesEtLeursCollections',
  'すべての作品とコレクションを見つける',
  'اقرأ جميع الأعمال والمجموعات المتاحة',
];
const hrefs = [
  '/search?type=schema%3ABook&sort=new#results',
  'https://example.org/reading?q=a%2Fb#chapters',
  '/collections?view=all',
];
const node = (type: string, id: string, props: Record<string, unknown>) => ({ type, props: { id, ...props } });

function document(density: 'comfortable' | 'compact'): CompositionDocument {
  return {
    root: { props: { appearance: { density, surface: 'flat', headingScale: 'lg' } } },
    content: [
      node('Slot', 'header', {
        name: 'header',
        children: [node('Heading', 'title', { level: 1, text: { fr: title } })],
      }),
      node('Slot', 'personal', {
        name: 'personal',
        children: [node('Text', 'personal-note', { text: 'Personal appendix' })],
      }),
      node('Columns', 'reading', {
        split: 'end',
        start: [
          node('Heading', 'intro', { level: 2, text: 'Reading' }),
          node('Text', 'prose', { text: { fr: prose } }),
        ],
        end: [
          node('Columns', 'tools', {
            split: 'even',
            start: [node('SearchBox', 'search', { placeholder: { fr: placeholder } })],
            end: [
              node('Slot', 'navigation', {
                name: 'aside',
                children: [
                  node('Heading', 'navigation-title', { level: 3, text: { ja: '作品とコレクション' } }),
                  node('LinkGrid', 'links', {
                    links: hrefs.map((href, index) => ({
                      href,
                      label: { [index === 2 ? 'ar' : index === 1 ? 'ja' : 'fr']: labels[index]! },
                    })),
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      node('Slot', 'footer', {
        name: 'footer',
        children: [node('Heading', 'note', { level: 4, text: 'Reading notes' })],
      }),
    ],
  };
}

test('configured route and published preview retain native search, literal reading and independent localized navigation', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/fr/reading', width: 320, height: 800 });
  const requests: unknown[] = [];
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLIFrameElement: window.HTMLIFrameElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    fetch: async (input: unknown) => {
      requests.push(input);
      throw new Error('Unexpected configured page read');
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { RoutePage } = await import('../src/features/pages/route');
  const { PublishedPresentationPage } = await import('../src/features/pages/presentation-preview-view');
  const { CompositionRender } = await import('../src/features/pages/render');
  const { layoutComponents, PageRoot, pageDefinitions } = await import('../src/features/pages/layout');
  const { PageData } = await import('../src/features/pages/data');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const originalLocale = getLocale();
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main');
  host.style.width = '320px';
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const messages = { unknown: '', none: '', unlabelled: '', sources: '', aliases: '', search: submit };
  try {
    for (const locale of ['fr', 'ja'] as const)
      for (const density of ['comfortable', 'compact'] as const) {
        setLocale(locale, { reload: false });
        const doc = document(density);
        expect(validateComposition(platformRegistry, doc)).toEqual([]);
        expect(planReads(platformRegistry, doc, { subject: null }).reads).toEqual({});
        for (const preview of [false, true]) {
          host.dir = locale === 'ja' ? 'rtl' : 'ltr'; // Inherited RTL with supported UI locale and Arabic content.
          window.document.documentElement.style.fontSize = density === 'compact' ? '200%' : '100%';
          const page: RoutePageData = {
            route: '/reading',
            profile: `sha256:${'a'.repeat(64)}`,
            template: { scope: 'route', key: '/reading' },
            document: doc as RoutePageData['document'],
            reads: {},
          };
          const result: Extract<PresentationPreview, { ok: true }> = {
            ok: true,
            locale,
            target: { route: page.route },
            head: 1,
            page: { ...page, subject: null },
          };
          await act(async () =>
            root.render(
              preview ? (
                <PublishedPresentationPage result={result} />
              ) : (
                <RoutePage
                  page={page}
                  locale={locale}
                  heading="Fallback heading"
                  messages={messages}
                  personal={<p>Personal reading</p>}
                />
              ),
            ),
          );
          const view = within(host as unknown as HTMLElement);
          expect(view.getAllByRole('heading').map((heading: HTMLElement) => heading.tagName)).toEqual([
            'H1',
            'H2',
            'H3',
            'H4',
          ]);
          const heading = view.getByRole('heading', { level: 1, name: title });
          expect(heading.getAttribute('lang')).toBe('fr');
          expect(heading.closest('header')).not.toBeNull();
          expect(view.queryByText('Fallback heading')).toBeNull();
          expect(view.getByRole('heading', { level: 3 }).getAttribute('lang')).toBe(locale === 'ja' ? null : 'ja');
          expect(host.querySelector('footer h4')?.textContent).toBe('Reading notes');
          const paragraphs = Array.from(host.querySelectorAll('p'));
          const literal = paragraphs.find((p) => p.textContent?.startsWith('3 < 4'))!;
          expect(literal.textContent).toBe(`3 < 4 & "texte littéral"${'SansEspace'.repeat(50)}`);
          expect(literal.querySelectorAll('br')).toHaveLength(1);
          expect(literal.querySelector('b')).toBeNull();
          expect(literal.nextElementSibling?.textContent).toBe('第二段落と読書の案内');
          expect(view.queryByText('Personal reading') !== null).toBe(!preview);
          expect(view.queryByText('Personal appendix') !== null).toBe(!preview);
          const form = view.getByRole('search') as HTMLFormElement;
          const input = view.getByRole('searchbox', { name: placeholder }) as HTMLInputElement;
          const button = view.getByRole('button', { name: preview ? m.search_submit() : submit });
          expect(form.getAttribute('method')).toBe('get');
          expect(form.getAttribute('action')).toBe(`/${locale}/search`);
          expect(input.name).toBe('q');
          expect(input.placeholder).toBe(placeholder);
          expect(input.getAttribute('lang')).toBe(locale === 'fr' ? null : 'fr');
          expect(button.getAttribute('type')).toBe('submit');
          const links = view.getAllByRole('link') as HTMLAnchorElement[];
          const destinations = [`/${locale}${hrefs[0]}`, hrefs[1], `/${locale}${hrefs[2]}`];
          expect(links.map((link) => link.textContent)).toEqual(labels);
          expect(links.map((link) => link.getAttribute('href'))).toEqual(destinations);
          expect(links.map((link) => link.getAttribute('lang'))).toEqual([
            locale === 'fr' ? null : 'fr',
            locale === 'ja' ? null : 'ja',
            'ar',
          ]);
          expect(links.every((link) => link.closest('aside') && link.parentElement?.tagName === 'LI')).toBe(true);
          const submissions: { prevented: boolean; query: string | null }[] = [];
          form.addEventListener('submit', (event) => {
            submissions.push({
              prevented: event.defaultPrevented,
              query: new window.FormData(form as never).get('q') as string | null,
            });
            event.preventDefault(); // Observe the native submission without navigating the test document.
          });
          input.focus();
          await act(async () => {
            await user.type(input, '心 & livres');
            await user.keyboard('{Enter}');
          });
          await act(async () => user.tab());
          expect(window.document.activeElement).toBe(button);
          await act(async () => user.keyboard('{Enter}'));
          expect(submissions).toEqual([
            { prevented: false, query: '心 & livres' },
            { prevented: false, query: '心 & livres' },
          ]);
          for (const [index, link] of links.entries()) {
            await act(async () => user.tab());
            expect(window.document.activeElement).toBe(link);
            let activated: string | null = null;
            link.addEventListener(
              'click',
              (event) => {
                expect(event.defaultPrevented).toBe(false);
                activated = link.getAttribute('href');
                event.preventDefault();
              },
              { once: true },
            );
            await act(async () => user.keyboard('{Enter}'));
            expect(activated).toBe(destinations[index]!);
          }
          await act(async () => user.tab({ shift: true }));
          expect(window.document.activeElement).toBe(links[1]!);
          expect(requests).toEqual([]);
        }
      }
    // Defensive renderer inputs retain the original filtering; they are not publishable documents.
    const malformed = {
      root: { props: {} },
      content: [
        node('LinkGrid', 'empty', { links: [] }),
        node('LinkGrid', 'malformed', {
          links: [
            null,
            false,
            'invalid',
            {},
            { href: 7 },
            { href: '/kept?x=a%2Fb#part', label: { fr: 'Kept destination' } },
          ],
        }),
      ],
    };
    await act(async () =>
      root.render(
        <PageData locale="fr-CA" document={malformed} reads={{}} messages={messages}>
          <CompositionRender
            document={malformed}
            definitions={pageDefinitions}
            components={layoutComponents}
            root={PageRoot}
          />
        </PageData>,
      ),
    );
    expect(host.querySelectorAll('ul')[0]?.children).toHaveLength(0);
    expect(host.querySelectorAll('li')).toHaveLength(1);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/fr-CA/kept?x=a%2Fb#part');
    expect(host.querySelector('a')?.textContent).toBe('Kept destination');
    expect(requests).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    setLocale(originalLocale, { reload: false });
    window.happyDOM.abort();
    mock.restore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
