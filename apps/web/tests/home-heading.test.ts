import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  platformRegistry,
  resolveTemplate,
  SLOT_NAMES,
  templateViews,
  UI_LOCALES,
  validateComposition,
  validateProfile,
  type PresentationProfile,
} from '@rezics/composition';
import platformJson from '@rezics/composition/profiles/platform.json' with { type: 'json' };
import { RoutePage, type RoutePageData } from '../src/features/pages/route.tsx';

type Node = { type: string; props: { id: string; [key: string]: unknown } };
const platform = platformJson as PresentationProfile;
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const page = (...content: Node[]) => ({ root: { props: {} }, content });
const isNodes = (value: unknown): value is Node[] =>
  Array.isArray(value) && value.every((item) => typeof item?.type === 'string' && item.props);
function* walk(nodes: readonly Node[]): Generator<Node> {
  for (const item of nodes) {
    yield item;
    for (const value of Object.values(item.props)) if (isNodes(value)) yield* walk(value);
  }
}
const messages = {
  unknown: '不明',
  none: 'なし',
  unlabelled: '名称未設定',
  sources: '出典',
  aliases: '別名',
  search: '検索',
};
const homeHeadings = Object.fromEntries(
  await Promise.all(
    UI_LOCALES.map(async (locale) => {
      const file = new URL(`../messages/${locale}.json`, import.meta.url);
      return [locale, ((await Bun.file(file).json()) as { home_heading: string }).home_heading] as const;
    }),
  ),
);
const home = () => resolveTemplate(platform, { route: '/' });
const routePage = (document: ReturnType<typeof page>): RoutePageData => ({
  route: '/',
  profile: `sha256:${'0'.repeat(64)}`,
  template: { scope: 'route', key: '/' },
  document: document as RoutePageData['document'],
  reads: {},
});

test('a level-1 heading is the page heading, and a page has at most one', () => {
  const title = { en: 'Home', ja: 'ホーム' };
  expect(validateComposition(platformRegistry, page(node('Heading', 'a', { text: title, level: 1 })))).toEqual([]);
  expect(
    validateComposition(
      platformRegistry,
      page(node('Heading', 'a', { text: title, level: 2 }), node('Heading', 'b', { text: title, level: 2 })),
    ),
  ).toEqual([]);
  expect(
    validateComposition(
      platformRegistry,
      page(
        node('Heading', 'a', { text: title, level: 1 }),
        node('Stack', 'stack', { gap: 'md', children: [node('Heading', 'b', { text: title, level: 1 })] }),
      ),
    ),
  ).toEqual([{ pointer: '/content/1/props/children/0/props/level', code: 'duplicate' }]);
  expect(
    validateComposition(
      platformRegistry,
      page(node('SubjectHeader', 'header'), node('Heading', 'a', { text: title, level: 1 })),
    ),
  ).toEqual([{ pointer: '/content/1/props/level', code: 'duplicate' }]);
  expect(
    validateComposition(
      platformRegistry,
      page(node('Heading', 'a', { text: title, level: 1 }), node('SubjectHeader', 'header')),
    ),
  ).toEqual([{ pointer: '/content/0/props/level', code: 'duplicate' }]);
  expect(validateComposition(platformRegistry, page(node('Heading', 'a', { text: title, level: 0 })))).toEqual([
    { pointer: '/content/0/props/level', code: 'invalid' },
  ]);
});

test('the platform home opens with its heading and keeps a personal slot for signed-in visitors', () => {
  expect(SLOT_NAMES).toContain('personal');
  expect(validateProfile(platformRegistry, platform)).toEqual([]);
  const content = home().document.content as Node[];
  expect(content.map(({ type }) => type)).toEqual(['Heading', 'Slot', 'TypeList', 'TypeList', 'TypeList', 'TypeList']);
  expect(content[0]).toEqual({ type: 'Heading', props: { id: 'heading', level: 1, text: homeHeadings } });
  expect(content[1]).toEqual({ type: 'Slot', props: { id: 'personal', name: 'personal', children: [] } });
  const subjectPages = [platform.generic, ...platform.bases, ...platform.types].flatMap((entry) =>
    Object.values(templateViews(entry)),
  );
  for (const document of subjectPages)
    expect(
      [...walk(document.content as Node[])].filter(({ type, props }) => type === 'Slot' && props.name === 'personal'),
    ).toEqual([]);
});

test('the route page shows the template heading as its only h1 and lets the host fill the personal slot', () => {
  const personal = createElement('p', null, '続きを読む');
  const html = renderToString(
    createElement(RoutePage, {
      page: { ...routePage(page()), document: home().document as RoutePageData['document'] },
      locale: 'ja',
      heading: 'Fallback heading',
      messages,
      personal,
    }),
  );
  expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  expect(html).toMatch(new RegExp(`<h1[^>]*lang="ja"[^>]*>${homeHeadings.ja}</h1>`));
  expect(html).not.toContain('Fallback heading');
  expect(html).toMatch(/<section[^>]*data-slot="personal"[^>]*><p>続きを読む<\/p><\/section>/);
  expect(html).not.toContain('<form');
  expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('data-slot="personal"'));

  const signedOut = renderToString(
    createElement(RoutePage, {
      page: { ...routePage(page()), document: home().document as RoutePageData['document'] },
      locale: 'ja',
      heading: 'Fallback heading',
      messages,
    }),
  );
  expect(signedOut).not.toContain('data-slot="personal"');
  expect(signedOut.match(/<h1[\s>]/g)).toHaveLength(1);

  const untitled = renderToString(
    createElement(RoutePage, {
      page: routePage(page(node('SearchBox', 'search', { placeholder: { en: 'Search', ja: '検索' } }))),
      locale: 'ja',
      heading: 'Fallback heading',
      messages,
      personal,
    }),
  );
  expect(untitled).toMatch(/<h1 class="sr-only">Fallback heading<\/h1>/);
  expect(untitled.match(/<h1[\s>]/g)).toHaveLength(1);
  expect(untitled).not.toContain('続きを読む');
});
