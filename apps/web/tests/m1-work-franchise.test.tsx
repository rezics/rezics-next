import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SubjectRead } from '@rezics/client';
import { SubjectPage, type SubjectPageData } from '../src/features/pages/subject';
import type { PageMessages } from '../src/features/pages/data';
import type { RelationDefinition } from '../src/subject/relations';

const property = 'wdt:P144';
const context = '00000000-0000-8000-8000-000000000000';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const messages: PageMessages = { unknown: 'Unknown', none: 'None', unlabelled: 'Unlabelled', sources: 'Sources', aliases: 'Aliases', search: 'Search' };
const relations: Record<string, RelationDefinition> = Object.fromEntries(
  [property, 'schema:author', 'schema:hasPart', 'wdt:P725'].map((key) => [key, { label: 'Related', forwardLabel: 'Related', group: 'credit', symmetric: false }]),
);
const statement = (n: number, p: string, target: string) => ({
  id: id(n), rank: 'normal' as const, property: { id: p, data_type: 'wikibase-item' as const },
  value: { type: 'value' as const, content: target }, qualifiers: [], references: [],
  rezics: { release: 'sha256:showcase', revision: 1 },
});

function read(type: string, label: string, work: string, destinationType: string, destination: string, destinationId: string,
  entries: { property: string; id: string; type: string; label: string }[] = []): SubjectRead {
  const relatedEntries = [[destinationId, destinationType, destination], ...entries.map((e) => [e.id, e.type, e.label])];
  return {
    subject: {
      id: work, type, revision: 1, release: 'sha256:showcase', context, labels: { ja: label }, descriptions: {},
      aliases: {}, resolution: {}, relationCounts: { [property]: 1 }, sourceRecords: [],
      statements: Object.fromEntries([[property, [statement(101, property, destinationId)]],
        ...entries.map((e, i) => [e.property, [statement(200 + i, e.property, e.id)]]),
      ]),
    },
    account: null, summary: null,
    related: Object.fromEntries(relatedEntries.map(([targetId, targetType, targetLabel]) => [targetId, {
      type: targetType, types: [targetType], labels: { ja: targetLabel }, cover: null,
    }])),
  };
}

function pageFor(source: SubjectRead): SubjectPageData {
  const content = [
    { type: 'SubjectList', props: { id: 'franchise', title: { en: 'Related works' }, property, limit: 8 } },
    ...Object.keys(source.subject.statements).filter((key) => key !== property).map((key) => key === 'schema:author' || key === 'wdt:P725'
      ? { type: 'Credits', props: { id: key, property: key, limit: 8 } }
      : { type: 'SubjectList', props: { id: key, title: { en: 'Parts' }, property: key, limit: 8 } }),
  ];
  const document = { root: { props: {} }, content } as unknown as CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject: source.subject.id });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, planned] of Object.entries(plan.reads)) {
    if (planned.kind !== 'links') { reads[key] = { status: 200, body: source }; continue; }
    const entries = Object.entries(source.related).filter(([, item]) => item.type !== 'wd:Q689445');
    reads[key] = { status: 200, body: { links: entries.map(([targetId, item], i) => ({
      subject: targetId, property: planned.property, statement: id(500 + i), label: Object.values(item.labels)[0] ?? '',
      type: item.type ?? 'schema:Thing', summary: { id: targetId, type: item.type ?? 'schema:Thing', types: item.types ?? [],
        label: { value: Object.values(item.labels)[0] ?? '', language: 'ja' }, creativeWork: true, cover: item.cover },
    })), count: { value: entries.length, exact: true }, next: null } };
  }
  return { subject: source.subject.id, profile: source.subject.release, template: { scope: 'type', key: source.subject.type },
    document, views: ['overview', 'relations', 'editions', 'contents', 'credits', 'characters'], reads } satisfies SubjectPageData;
}

async function render(source: SubjectRead) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const route = createRootRoute({ component: () => createElement(SubjectPage, {
    page: pageFor(source), locale: 'ja', view: 'overview', messages, relations, renderJsonLd: false,
  }) });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
  client.clear(); router.dispose();
  return html;
}
const link = (html: string, target: string) => new RegExp(`<a\\b[^>]*href="([^"]*${target}[^"]*)"[^>]*>([\\s\\S]*?)<\\/a>`).exec(html);

test('Subject composition joins the VN, anime and book with localized, disclosed links and safe return', async () => {
  const vnId = id(1), animeId = id(2), bookId = id(3);
  const vn = read('wd:Q689445', '原作ビジュアルノベル', vnId, 'schema:TVSeries', '港のアニメ', animeId);
  const anime = read('schema:TVSeries', '港のアニメ', animeId, 'schema:Book', '港の小説', bookId, [
    { property: 'wdt:P725', id: id(11), type: 'schema:Person', label: '出演者' },
    { property: 'schema:hasPart', id: id(14), type: 'schema:TVEpisode', label: '第一話' },
  ]);
  const book = read('schema:Book', '港の小説', bookId, 'wd:Q689445', '原作ビジュアルノベル', vnId, [
    { property: 'schema:author', id: id(12), type: 'schema:Person', label: '作家' },
    { property: 'schema:hasPart', id: id(13), type: 'schema:Book', label: '第一巻' },
  ]);

  const vnHtml = await render(vn), animeUrl = new URL(link(vnHtml, animeId)![1]!.replaceAll('&amp;', '&'), 'https://site.test');
  expect(vnHtml).toContain('data-slot="game-reader"');
  expect(link(vnHtml, animeId)?.[2]).toContain('映像作品');
  expect(animeUrl.pathname).toMatch(new RegExp(`^/ja/subjects/${animeId}/`));
  expect(animeUrl.searchParams.get('via')).toMatch(new RegExp(`^/ja/subjects/${vnId}/.*#connections$`));
  expect(link(vnHtml, animeId)?.[0]).not.toContain('target="_blank"');

  const animeHtml = await render(anime);
  expect(animeHtml).toContain('data-slot="screen-profile-reader"');
  expect(animeHtml).toContain('港の小説');
  expect(animeHtml).toContain('出演者');
  expect(animeHtml).toContain('第一話');
  const bookHtml = await render(book);
  expect(bookHtml).toContain('data-slot="literary-reader"');
  expect(bookHtml).toContain('原作ビジュアルノベル');
  expect(bookHtml).toContain('作家');
  expect(bookHtml).toContain('第一巻');

  const replacement = await render(read('wd:Q689445', '別のビジュアルノベル', vnId, 'schema:TVSeries', '別のアニメ', id(20)));
  expect(replacement).toContain('別のアニメ');
  expect(link(replacement, animeId)).toBeNull();
  const withheld = read('wd:Q689445', '原作ビジュアルノベル', vnId, 'schema:TVSeries', '非公開のアニメ', animeId);
  withheld.related = {};
  const withheldHtml = await render(withheld);
  expect(withheldHtml).not.toContain('data-slot="work-franchise"');
  expect(withheldHtml).not.toContain(animeId);
});
