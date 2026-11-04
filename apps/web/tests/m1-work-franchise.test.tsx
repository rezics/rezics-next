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
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled subject',
  sources: 'Sources',
  aliases: 'Also known as',
  search: 'Search',
};
const relations: Record<string, RelationDefinition> = {
  [property]: { label: 'Based on', forwardLabel: 'Based on', group: 'derivation', symmetric: false },
  'schema:author': { label: 'Author', forwardLabel: 'Author', group: 'credit', symmetric: false },
  'schema:hasPart': { label: 'Part', forwardLabel: 'Part', group: 'membership', symmetric: false },
  'wdt:P725': { label: 'Voice', forwardLabel: 'Voice', group: 'credit', symmetric: false },
};

function statement(number: number, relation: string, target: string) {
  return {
    id: id(number),
    rank: 'normal' as const,
    property: { id: relation, data_type: 'wikibase-item' as const },
    value: { type: 'value' as const, content: target },
    qualifiers: [],
    references: [],
    rezics: { release: 'sha256:showcase', revision: 1 },
  };
}

function relatedWork(type: string, label: string, locale: string) {
  return { type, types: [type], labels: { [locale]: label }, cover: null };
}

function workRead(
  workType: string,
  workLabel: string,
  workId: string,
  destinationType: string,
  destinationLabel: string,
  destinationId: string,
  locale: string,
  contributors: { property: string; id: string; type: string; label: string }[] = [],
): SubjectRead {
  const statements = {
    [property]: [statement(101, property, destinationId)],
    ...Object.fromEntries(contributors.map((entry, index) => [entry.property, [statement(200 + index, entry.property, entry.id)]])),
  };
  return {
    subject: {
      id: workId,
      type: workType,
      revision: 1,
      release: 'sha256:showcase',
      context,
      labels: { [locale]: workLabel },
      descriptions: {},
      aliases: {},
      resolution: {},
      relationCounts: { [property]: 1 },
      sourceRecords: [],
      statements,
    },
    account: null,
    summary: null,
    related: {
      [destinationId]: relatedWork(destinationType, destinationLabel, locale),
      ...Object.fromEntries(contributors.map((entry) => [entry.id, relatedWork(entry.type, entry.label, locale)])),
    },
  };
}

function pageFor(read: SubjectRead): SubjectPageData {
  const content = [
    { type: 'SubjectList', props: { id: 'franchise', title: { en: 'Related works' }, property, limit: 8 } },
    ...Object.keys(read.subject.statements)
      .filter((key) => key !== property)
      .map((key) =>
        key === 'schema:author' || key === 'wdt:P725'
          ? { type: 'Credits', props: { id: `credits-${key}`, property: key, limit: 8 } }
          : { type: 'SubjectList', props: { id: `parts-${key}`, title: { en: 'Volumes or episodes' }, property: key, limit: 8 } },
      ),
  ];
  const document = { root: { props: {} }, content } as unknown as CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject: read.subject.id });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, planned] of Object.entries(plan.reads)) {
    if (planned.kind === 'links') {
      const entries = Object.entries(read.related).filter(([, target]) => target.type !== 'wd:Q689445');
      const items = entries.map(([targetId, target], index) => ({
        subject: targetId,
        property: planned.property,
        statement: id(500 + index),
        label: Object.values(target.labels)[0] ?? '',
        type: target.type ?? 'schema:Thing',
        summary: {
          id: targetId,
          type: target.type ?? 'schema:Thing',
          types: target.types ?? [],
          label: { value: Object.values(target.labels)[0] ?? '', language: Object.keys(target.labels)[0] ?? 'en' },
          creativeWork: true,
          cover: target.cover,
        },
      }));
      reads[key] = { status: 200, body: { links: items, count: { value: items.length, exact: true }, next: null } };
    } else {
      reads[key] = { status: 200, body: read };
    }
  }
  return {
    subject: read.subject.id,
    profile: read.subject.release,
    template: { scope: 'type', key: read.subject.type },
    document,
    views: ['overview', 'relations', 'editions', 'contents', 'credits', 'characters'],
    reads,
  } satisfies SubjectPageData;
}

async function renderPage(page: SubjectPageData, locale: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const route = createRootRoute({
    component: () =>
      createElement(SubjectPage, {
        page,
        locale,
        view: 'overview',
        messages,
        relations,
        renderJsonLd: false,
      }),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const markup = renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
  );
  client.clear();
  router.dispose();
  return markup;
}

function destinationLink(markup: string, targetId: string) {
  return new RegExp(`<a\\b[^>]*href="([^"]*${targetId}[^"]*)"[^>]*>([\\s\\S]*?)<\\/a>`).exec(markup);
}

test('the Subject composition joins VN, anime and book readers with localized admitted-work links and safe returns', async () => {
  const vnId = id(1);
  const animeId = id(2);
  const bookId = id(3);
  const vn = workRead('wd:Q689445', '原作ビジュアルノベル', vnId, 'schema:TVSeries', '港のアニメ', animeId, 'ja');
  const anime = workRead('schema:TVSeries', '港のアニメ', animeId, 'schema:Book', '港の小説', bookId, 'ja', [
    { property: 'wdt:P725', id: id(11), type: 'schema:Person', label: '出演者' },
  ]);
  const book = workRead('schema:Book', '港の小説', bookId, 'wd:Q689445', '原作ビジュアルノベル', vnId, 'ja', [
    { property: 'schema:author', id: id(12), type: 'schema:Person', label: '作家' },
    { property: 'schema:hasPart', id: id(13), type: 'schema:Book', label: '第一巻' },
  ]);

  const vnMarkup = await renderPage(pageFor(vn), 'ja');
  expect(vnMarkup).toContain('data-slot="game-reader"');
  expect(vnMarkup).toContain('data-slot="work-franchise"');
  const animeLink = destinationLink(vnMarkup, animeId)!;
  const animeUrl = new URL(animeLink[1]!.replaceAll('&amp;', '&'), 'https://site.test');
  expect(animeLink[2]).toContain('映像作品');
  expect(animeLink[2]).toContain('港のアニメ');
  expect(animeUrl.pathname).toMatch(new RegExp(`^/ja/subjects/${animeId}/`));
  expect(animeUrl.searchParams.get('via')).toMatch(new RegExp(`^/ja/subjects/${vnId}/`));
  expect(animeUrl.searchParams.get('via')).toMatch(/#connections$/);
  expect(animeLink[0]).not.toContain('target="_blank"');

  const animeMarkup = await renderPage(pageFor(anime), 'ja');
  expect(animeMarkup).toContain('data-slot="screen-profile-reader"');
  expect(destinationLink(animeMarkup, bookId)?.[2]).toContain('港の小説');
  expect(animeMarkup).toContain('出演者');

  const bookMarkup = await renderPage(pageFor(book), 'ja');
  expect(bookMarkup).toContain('data-slot="literary-reader"');
  expect(destinationLink(bookMarkup, vnId)?.[2]).toContain('原作ビジュアルノベル');
  expect(bookMarkup).toContain('作家');
  expect(bookMarkup).toContain('第一巻');

  const replacement = workRead('wd:Q689445', '別のビジュアルノベル', vnId, 'schema:TVSeries', '別のアニメ', id(20), 'ja');
  const replacementMarkup = await renderPage(pageFor(replacement), 'ja');
  expect(replacementMarkup).toContain('別のアニメ');
  expect(destinationLink(replacementMarkup, animeId)).toBeNull();

  const withheld = workRead('wd:Q689445', '原作ビジュアルノベル', vnId, 'schema:TVSeries', '非公開のアニメ', animeId, 'ja');
  withheld.related = {};
  const withheldMarkup = await renderPage(pageFor(withheld), 'ja');
  expect(withheldMarkup).not.toContain('data-slot="work-franchise"');
  expect(withheldMarkup).not.toContain(animeId);
});
