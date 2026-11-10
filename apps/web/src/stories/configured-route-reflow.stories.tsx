import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  type CompositionDocument,
  type CompositionNode,
  platformRegistry,
  validateComposition,
} from '@rezics/composition';
import { useLayoutEffect } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { PresentationPreview } from '../features/pages/presentation-preview';
import { PublishedPresentationPage } from '../features/pages/presentation-preview-view';
import { RoutePage, type RoutePageData } from '../features/pages/route';
import { subjectPageMessages } from '../features/pages/route-support';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const title = 'BibliothèquesHistoiresEtCollections'.repeat(4);
const prose = `3 < 4 & "texte littéral"\n${'UneHistoireSansEspace'.repeat(24)}\n\n第二段落と読書の案内。作品やコレクションを探してみましょう。`;
const labels = [
  { fr: 'DécouvrirLesBibliothèquesEtLeursCollections' },
  { ja: 'すべての作品とコレクションを見つける' },
  { ar: 'اقرأ جميع الأعمال والمجموعات المتاحة' },
];
const hrefs = [
  '/search?type=schema%3ABook&sort=new#results',
  'https://example.org/reading?q=a%2Fb#chapters',
  '/collections?view=all',
];
const node = (type: string, id: string, props: Record<string, unknown>): CompositionNode => ({
  type,
  props: { id, ...props },
});

function readingDocument(density: 'comfortable' | 'compact'): CompositionDocument {
  return {
    root: { props: { appearance: { density, surface: 'flat', headingScale: 'lg' } } },
    content: [
      node('Slot', 'header', {
        name: 'header',
        children: [node('Heading', 'title', { level: 1, text: { fr: title } })],
      }),
      node('Columns', 'reading', {
        split: 'end',
        start: [
          node('Heading', 'intro', { level: 2, text: { fr: 'Lire et découvrir' } }),
          node('Text', 'prose', { text: { fr: prose } }),
        ],
        end: [
          node('Columns', 'tools', {
            split: 'even',
            start: [
              node('SearchBox', 'search', { placeholder: { fr: 'Rechercher dans les œuvres et les collections' } }),
            ],
            end: [
              node('Slot', 'navigation', {
                name: 'aside',
                children: [
                  node('Heading', 'navigation-title', { level: 3, text: { ja: '作品とコレクション' } }),
                  node('LinkGrid', 'links', { links: hrefs.map((href, index) => ({ href, label: labels[index]! })) }),
                ],
              }),
            ],
          }),
        ],
      }),
      node('Slot', 'footer', {
        name: 'footer',
        children: [node('Heading', 'note', { level: 4, text: { fr: 'Notes de lecture' } })],
      }),
    ],
  };
}

type JourneyProps = {
  surface: 'route' | 'published-preview';
  density: 'comfortable' | 'compact';
  width: number;
  largeText: boolean;
  rtl: boolean;
};

// Inert, bounded configuration fixtures through both real public renderers. No native-read proof.
function ConfiguredReadingJourney({ surface, density, width, largeText, rtl }: JourneyProps) {
  const locale = getLocale();
  useLayoutEffect(() => {
    const previous = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = largeText ? '200%' : '100%';
    return () => {
      document.documentElement.style.fontSize = previous;
    };
  }, [largeText]);
  const page: RoutePageData = {
    route: '/reading',
    profile: `sha256:${'a'.repeat(64)}`,
    template: { scope: 'route', key: '/reading' },
    document: readingDocument(density) as RoutePageData['document'],
    reads: {},
  };
  const result: Extract<PresentationPreview, { ok: true }> = {
    ok: true,
    target: { route: page.route },
    locale,
    head: 1,
    page: { ...page, subject: null },
  };
  const messages = subjectPageMessages();
  return (
    <PatternStory path="/reading">
      <main
        data-slot="configured-reading-journey"
        data-surface={surface}
        data-large-text={largeText}
        dir={rtl ? 'rtl' : 'ltr'}
        lang={locale}
        style={{ width: `min(100%, ${width}px)` }}
        className="min-w-0 p-4"
      >
        {surface === 'published-preview' ? (
          <PublishedPresentationPage result={result} />
        ) : (
          <RoutePage
            page={page}
            locale={locale}
            heading={title}
            messages={{ ...messages, search: [messages.search, m.search_heading(), messages.search].join(' · ') }}
          />
        )}
      </main>
    </PatternStory>
  );
}

// Authored UNRUN under minimal verification. These assertions require a real browser and the app stylesheet.
async function readingJourney({ canvasElement }: { canvasElement: HTMLElement }) {
  const main = await within(canvasElement).findByRole('main');
  const view = within(main);
  await document.fonts.ready;
  const locale = main.lang;
  await expect(validateComposition(platformRegistry, readingDocument('comfortable'))).toEqual([]);
  await expect(view.getByRole('heading', { level: 1, name: title })).toHaveAttribute('lang', 'fr');
  await expect(view.getAllByRole('heading').map((heading) => heading.tagName)).toEqual(['H1', 'H2', 'H3', 'H4']);
  await expect(main.querySelector('header h1')).not.toBeNull();
  await expect(main.querySelector('aside h3')).not.toBeNull();
  await expect(main.querySelector('footer h4')).not.toBeNull();
  const paragraphs = main.querySelectorAll('p');
  await expect(paragraphs[0]?.textContent).toBe(`3 < 4 & "texte littéral"${'UneHistoireSansEspace'.repeat(24)}`);
  await expect(paragraphs[0]?.querySelectorAll('br')).toHaveLength(1);
  await expect(paragraphs[1]?.textContent).toBe('第二段落と読書の案内。作品やコレクションを探してみましょう。');
  if (main.dataset.largeText === 'true')
    await expect(parseFloat(getComputedStyle(document.documentElement).fontSize)).toBeGreaterThanOrEqual(32);
  await expect(getComputedStyle(main).direction).toBe(main.dir);
  const form = view.getByRole('search') as HTMLFormElement;
  const input = view.getByRole('searchbox') as HTMLInputElement;
  const button = view.getByRole('button');
  const links = view.getAllByRole('link') as HTMLAnchorElement[];
  await expect(form).toHaveAttribute('method', 'get');
  await expect(form).toHaveAttribute('action', `/${encodeURIComponent(locale)}/search`);
  await expect(input).toHaveAttribute('name', 'q');
  await expect(input).toHaveAttribute('aria-label', input.placeholder);
  await expect(button).toHaveAttribute('type', 'submit');
  await expect(links.map((link) => link.getAttribute('href'))).toEqual([
    `/${locale}${hrefs[0]}`,
    hrefs[1],
    `/${locale}${hrefs[2]}`,
  ]);
  await expect(links.map((link) => link.textContent)).toEqual(
    Object.values(labels).map((label) => Object.values(label)[0]),
  );

  // Check actual containment, including every wrapped text fragment rather than only the element's box.
  const mainBox = main.getBoundingClientRect();
  for (const element of [main, form, input, button, ...links, ...view.getAllByRole('heading'), ...paragraphs]) {
    const box = element.getBoundingClientRect();
    await expect(box.left).toBeGreaterThanOrEqual(mainBox.left - 1);
    await expect(box.right).toBeLessThanOrEqual(mainBox.right + 1);
    await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    if (element.matches('button, a')) await expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight + 1);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const fragment of range.getClientRects()) {
        await expect(fragment.left).toBeGreaterThanOrEqual(box.left - 1);
        await expect(fragment.right).toBeLessThanOrEqual(box.right + 1);
        if (element.matches('button, a')) {
          await expect(fragment.top).toBeGreaterThanOrEqual(box.top - 1);
          await expect(fragment.bottom).toBeLessThanOrEqual(box.bottom + 1);
        }
      }
    }
  }
  await expect(input.getBoundingClientRect().width).toBeGreaterThanOrEqual(
    Math.min(192, form.getBoundingClientRect().width) - 1,
  );
  const controls = [input, button, ...links];
  const restFocusStyles = controls.map((control) => {
    const style = getComputedStyle(control);
    return `${style.boxShadow} ${style.outline}`;
  });
  for (const control of controls) {
    await expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(control).toBeVisible();
  }
  const submissions: { prevented: boolean; destination: string }[] = [];
  const captureSubmit = (event: SubmitEvent) => {
    const url = new URL(form.action);
    url.search = new URLSearchParams(Array.from(new FormData(form), ([key, value]) => [key, String(value)])).toString();
    submissions.push({ prevented: event.defaultPrevented, destination: url.pathname + url.search });
    event.preventDefault(); // Test-only navigation capture; the production form has no handler.
  };
  form.addEventListener('submit', captureSubmit);
  try {
    input.focus();
    await userEvent.type(input, '心 & livres');
    for (const [index, control] of controls.entries()) {
      if (index > 0) await userEvent.tab();
      await expect(control).toHaveFocus();
      await expect(control.matches(':focus-visible')).toBe(true);
      const focused = getComputedStyle(control);
      await expect(`${focused.boxShadow} ${focused.outline}`).not.toBe(restFocusStyles[index]);
      if (index < 2) await userEvent.keyboard('{Enter}');
    }
    await expect(submissions).toEqual([
      { prevented: false, destination: `/${locale}/search?q=%E5%BF%83+%26+livres` },
      { prevented: false, destination: `/${locale}/search?q=%E5%BF%83+%26+livres` },
    ]);
    await userEvent.tab({ shift: true });
    await expect(links[1]!).toHaveFocus();
  } finally {
    form.removeEventListener('submit', captureSubmit);
  }
}

const meta = {
  title: 'Site Shell/Configured Route Reflow',
  id: 'pages-configured-route-reflow',
  component: ConfiguredReadingJourney,
  args: { surface: 'route', density: 'comfortable', width: 320, largeText: false, rtl: false },
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: { phone320: { name: 'Phone 320', styles: { width: '320px', height: '800px' }, type: 'mobile' } },
    },
    docs: {
      description: {
        component:
          'A complete configured reading route and its published-preview renderer. Bounded static configuration, long French/Japanese/Arabic labels, inherited RTL and 200% root text. Authored browser assertions are UNRUN under minimal verification; no native or visual receipt.',
      },
    },
  },
  play: readingJourney,
} satisfies Meta<typeof ConfiguredReadingJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Phone320: Story = { globals: { locale: 'fr' } };
export const CompactPhone320: Story = { ...Phone320, args: { density: 'compact' } };
export const LargeTextPhone320: Story = { ...Phone320, args: { largeText: true } };
export const CompactLargeTextPhone320: Story = { ...Phone320, args: { density: 'compact', largeText: true } };
export const NestedColumns: Story = {
  args: { width: 960 },
  globals: { locale: 'fr' },
};
export const CompactNestedColumns: Story = { ...NestedColumns, args: { width: 960, density: 'compact' } };
export const PublishedPreviewPhone320: Story = { ...Phone320, args: { surface: 'published-preview' } };
export const PublishedPreviewLargeText: Story = {
  ...Phone320,
  args: { surface: 'published-preview', largeText: true },
};
export const PublishedPreviewCompactColumns: Story = {
  ...NestedColumns,
  args: { surface: 'published-preview', density: 'compact', width: 960 },
};
export const RightToLeftLargeText: Story = {
  ...Phone320,
  args: { rtl: true, largeText: true },
  globals: { locale: 'ja' },
};
export const PublishedPreviewRightToLeft: Story = {
  ...RightToLeftLargeText,
  args: { surface: 'published-preview', rtl: true, density: 'compact', largeText: true },
};
