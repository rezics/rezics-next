import type { Release } from '@rezics/definitions';
import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import native from '@rezics/composition/profiles/platform.json';
import type { SubjectRead } from '@rezics/client';
import type { SubjectPageData } from '../src/features/pages/subject';
import type { PageMessages } from '../src/features/pages/data';
import type { RelationDefinition } from '../src/subject/relations';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectPage } = await import('../src/features/pages/subject');
const { WorkFranchiseReading } = await import('../src/features/pages/showcase-work');

const property = 'wdt:P144';
const context = '00000000-0000-8000-8000-000000000000';
const workDocument = (
  native.bases.find(({ base }) => base === 'schema:CreativeWork') as unknown as {
    views: { overview: CompositionDocument };
  }
).views.overview;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const messages: PageMessages = {
  unknown: 'Unknown',
  none: 'None',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Aliases',
  search: 'Search',
};
const relations: Record<string, RelationDefinition> = Object.fromEntries(
  [property, 'schema:author', 'schema:hasPart', 'wdt:P725'].map((key) => [
    key,
    { label: 'Related', forwardLabel: 'Related', group: 'credit', symmetric: false },
  ]),
);
const statement = (n: number, p: string, target: string) => ({
  id: id(n),
  rank: 'normal' as const,
  property: { id: p, data_type: 'wikibase-item' as const },
  value: { type: 'value' as const, content: target },
  qualifiers: [],
  references: [],
  rezics: { release: 'sha256:showcase', revision: 1 },
});

function read(
  type: string,
  label: string,
  work: string,
  destinationType: string,
  destination: string,
  destinationId: string,
  entries: { property: string; id: string; type: string; label: string }[] = [],
): SubjectRead {
  const relatedEntries = [
    [destinationId, destinationType, destination],
    ...entries.map((e) => [e.id, e.type, e.label]),
  ];
  return {
    subject: {
      id: work,
      type,
      revision: 1,
      release: 'sha256:showcase',
      context,
      labels: { ja: label },
      descriptions: {},
      aliases: {},
      resolution: {},
      relationCounts: { [property]: 1 },
      sourceRecords: [],
      statements: Object.fromEntries([
        [property, [statement(101, property, destinationId)]],
        ...entries.map((e, i) => [e.property, [statement(200 + i, e.property, e.id)]]),
      ]),
    },
    account: null,
    summary: null,
    related: Object.fromEntries(
      relatedEntries.map(([targetId, targetType, targetLabel]) => [
        targetId,
        {
          type: targetType,
          types: [targetType],
          labels: { ja: targetLabel },
          cover: null,
        },
      ]),
    ),
  };
}

function pageFor(source: SubjectRead): SubjectPageData {
  const content = [
    workDocument.content[0]!,
    {
      type: 'OutgoingRelations',
      props: { id: 'franchise', title: { en: 'Related works' }, property, limit: 8, paged: true },
    },
    ...Object.keys(source.subject.statements)
      .filter((key) => key !== property)
      .map((key) =>
        key === 'schema:author' || key === 'wdt:P725'
          ? { type: 'Credits', props: { id: key, property: key, limit: 8 } }
          : { type: 'SubjectList', props: { id: key, title: { en: 'Parts' }, property: key, limit: 8 } },
      ),
  ];
  const document = { ...workDocument, content } as CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject: source.subject.id });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, planned] of Object.entries(plan.reads)) {
    if (planned.kind === 'subject') {
      reads[key] = { status: 200, body: source };
      continue;
    }
    if (planned.kind === 'relations') {
      reads[key] = {
        status: 200,
        body: {
          relations: (source.subject.statements[planned.property] ?? []).map((statement) => {
            const target = statement.value.content as string;
            const entry = source.related[target];
            return {
              target,
              statement,
              label: Object.values(entry?.labels ?? {})[0] ?? '',
              summary: entry
                ? {
                    id: target,
                    type: entry.type,
                    types: entry.types,
                    label: { value: Object.values(entry.labels)[0] ?? '', language: 'ja' },
                    cover: null,
                  }
                : null,
              related: {},
            };
          }),
          next: null,
        },
      };
      continue;
    }
    if (planned.kind !== 'links') continue;
    const entries = Object.entries(source.related).filter(([, item]) => item.type !== 'wd:Q689445');
    reads[key] = {
      status: 200,
      body: {
        links: entries.map(([targetId, item], i) => ({
          subject: targetId,
          property: planned.property,
          statement: id(500 + i),
          label: Object.values(item.labels)[0] ?? '',
          type: item.type ?? 'schema:Thing',
          summary: {
            id: targetId,
            type: item.type ?? 'schema:Thing',
            types: item.types ?? [],
            label: { value: Object.values(item.labels)[0] ?? '', language: 'ja' },
            creativeWork: true,
            cover: item.cover,
          },
        })),
        count: { value: entries.length, exact: true },
        next: null,
      },
    };
  }
  return {
    subject: source.subject.id,
    profile: source.subject.release,
    template: { scope: 'base', key: 'schema:CreativeWork' },
    document,
    views: ['overview', 'relations', 'editions', 'contents', 'credits', 'characters'],
    reads,
  } satisfies SubjectPageData;
}

async function render(
  source: SubjectRead,
  page = pageFor(source),
  currentHref?: string,
  selected?: { node: string; property: string; direction: 'forward' | 'inverse'; cursor?: string },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const route = createRootRoute({
    component: () =>
      createElement(SubjectPage, {
        page,
        currentHref,
        locale: 'ja',
        view: selected ? 'relations' : 'overview',
        ...(selected
          ? {
              selectedNode: selected.node,
              selectedStreamProperty: selected.property,
              selectedStreamDirection: selected.direction,
              ...(selected.cursor !== undefined ? { selectedCursor: selected.cursor } : {}),
              finiteWorkRegionReader: WorkFranchiseReading,
            }
          : {}),
        messages,
        relations,
        renderJsonLd: false,
      }),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
  );
  client.clear();
  return html;
}
const link = (html: string, target: string) =>
  new RegExp(`<a\\b[^>]*href="([^"]*${target}[^"]*)"[^>]*>([\\s\\S]*?)<\\/a>`).exec(html);

test('Subject composition joins the VN, anime and book with localized, disclosed links and safe return', async () => {
  const vnId = id(1),
    animeId = id(2),
    bookId = id(3);
  const vn = read('wd:Q689445', '原作ビジュアルノベル', vnId, 'schema:TVSeries', '港のアニメ', animeId);
  const anime = read('schema:TVSeries', '港のアニメ', animeId, 'schema:Book', '港の小説', bookId, [
    { property: 'wdt:P725', id: id(11), type: 'schema:Person', label: '出演者' },
    { property: 'schema:hasPart', id: id(14), type: 'schema:Episode', label: '第一話' },
  ]);
  const book = read('schema:Book', '港の小説', bookId, 'wd:Q689445', '原作ビジュアルノベル', vnId, [
    { property: 'schema:author', id: id(12), type: 'schema:Person', label: '作家' },
    { property: 'schema:hasPart', id: id(13), type: 'schema:Book', label: '第一巻' },
  ]);

  const vnHtml = await render(vn),
    animeUrl = new URL(link(vnHtml, animeId)![1]!.replaceAll('&amp;', '&'), 'https://site.test');
  expect(vnHtml).toContain('data-slot="game-reader"');
  expect(vnHtml).toContain('映像作品');
  expect(animeUrl.pathname).toMatch(new RegExp(`^/ja/subjects/${animeId}/`));
  expect(animeUrl.searchParams.get('via')).toMatch(new RegExp(`^/ja/subjects/${vnId}/.*#work-franchise\\?stream=`));
  expect(link(vnHtml, animeId)?.[0]).not.toContain('target="_blank"');

  const animeHtml = await render(anime);
  expect(animeHtml).toContain('data-slot="screen-profile-reader"');
  expect(animeHtml).toContain('港の小説');
  expect(animeHtml).toContain('出演者');
  expect(animeHtml).toContain('第一話');
  const bookHtml = await render(book);
  expect(bookHtml).toContain('data-slot="book-overview"');
  expect(bookHtml).not.toContain('data-slot="literary-reader"');
  expect(bookHtml).not.toContain('data-slot="work-franchise"');
  expect(link(bookHtml, vnId)).toBeNull();
  expect(bookHtml).toContain('作家');
  expect(bookHtml).not.toContain('第一巻');
  // The canonical Relations reader still owns the same selected native window and return.
  const bookRelations = await render(book, pageFor(book), undefined, {
    node: 'adaptations',
    property: 'wdt:P144',
    direction: 'inverse',
  });
  expect(bookRelations).not.toContain('data-slot="book-overview"');

  const replacement = await render(
    read('wd:Q689445', '別のビジュアルノベル', vnId, 'schema:TVSeries', '別のアニメ', id(20)),
  );
  expect(replacement).toContain('別のアニメ');
  expect(link(replacement, animeId)).toBeNull();
  const withheld = read('wd:Q689445', '原作ビジュアルノベル', vnId, 'schema:TVSeries', '非公開のアニメ', animeId);
  withheld.related = {};
  const withheldHtml = await render(withheld);
  expect(withheldHtml).toContain('data-slot="work-franchise"');
  expect(withheldHtml).not.toContain(animeId);
});

// Captured provider evidence supplies the decimal token; association ids here belong only to this test read.
const capturedWeights = (await import('../../../services/kernel/test/fixtures/vndb-source-weight-v17.json')).default;
const publicBook = (await import('../../../specs/fixtures/imports/bangumi/public-book-meta-tags.json')).default;
const releasedTags = (await import('../src/kernel/recorded/definitions-release.json')).default
  .release as unknown as Release;
const { SubjectConceptTags } = await import('../src/features/pages/subject-slots');
const { readWorkTags, workTagWeight } = await import('../src/features/pages/showcase-work/tags');
const tagQualifier = (property: string, content: unknown, datatype = 'quantity') => ({
  property: { id: property, data_type: datatype },
  value: { type: 'value', content },
});
function tagReading(size = 1) {
  const source = read('schema:Book', publicBook.name, id(700), 'skos:Concept', publicBook.meta_tags[1]!, id(701));
  source.subject.relationCounts = { 'schema:genre': size };
  const weight = capturedWeights.results[0]!.tags[0]!;
  source.subject.statements = {
    'schema:genre': Array.from({ length: size }, (_, n) => ({
      ...statement(800 + n, 'schema:genre', id(701)),
      qualifiers: [
        tagQualifier('rezics:sourceTagWeight', { amount: `+${weight.rating}`, unit: '1' }),
        tagQualifier('rezics:sourceTagWeightMetric', 'vndbTagsRating', 'string'),
        tagQualifier('rezics:spoilerLevel', { amount: '+1', unit: '1' }),
      ],
      references: [
        {
          parts: [
            tagQualifier('schema:url', 'https://vndb.org/v17', 'url'),
            tagQualifier('rezics:sourceTagId', 'g3', 'string'),
            tagQualifier('rezics:sourceSnapshot', `unversioned:sha256:${'a'.repeat(64)}`, 'string'),
          ],
        },
        { parts: [tagQualifier('schema:url', 'https://api.vndb.org/kana#post-vn', 'url')] },
      ],
    })) as SubjectRead['subject']['statements'][string],
  };
  return source;
}
function tagMarkup(source: SubjectRead, spoilerThreshold = 1, definitions = releasedTags) {
  return renderToStaticMarkup(
    createElement(SubjectConceptTags, {
      subject: source.subject,
      related: source.related,
      definitions,
      locale: 'en',
      spoilerThreshold,
    }),
  );
}

test('tag assertions preserve exact provider meaning, duplicate rows, original identity and disclosure before previewing', () => {
  const source = tagReading(2);
  source.related[id(701)] = { ...source.related[id(701)]!, redirect: id(799) } as never;
  source.subject.statements['schema:genre']![0]!.rank = 'preferred';
  const tags = readWorkTags(source.subject, source.related, releasedTags, 'en', 1);
  expect(tags.state).toBe('ready');
  if (tags.state !== 'ready') throw new Error('Expected admitted tags');
  expect(tags.tags.map((tag) => tag.statement.id)).toEqual([id(800), id(801)]);
  expect(tags.tags[0]?.weight).toEqual({ state: 'source', amount: '+2.59999990463257', metric: 'vndbTagsRating' });
  const html = tagMarkup(source);
  expect(html.match(/data-tag-index=/g)).toHaveLength(2);
  expect(html).toContain('VNDB aggregate rating: 2.59999990463257 / 3');
  expect(html).toContain('Spoiler level: 1');
  expect(html).not.toContain(id(799));
  expect(html).toContain(`/subjects/${id(701)}/`);
  for (const threshold of [0, 2]) {
    const concealed = structuredClone(source);
    if (threshold === 2)
      concealed.subject.statements['schema:genre']![0]!.qualifiers.push(
        tagQualifier('rezics:spoilerLevel', { amount: '+0', unit: 'unknown' }) as never,
      );
    const markup = tagMarkup(concealed, threshold);
    if (threshold === 0) {
      expect(markup).not.toContain(id(701));
      expect(markup).not.toContain('2.59999990463257');
      expect(markup).not.toContain(publicBook.meta_tags[1]!);
    } else expect(markup.match(/data-tag-index=/g)).toHaveLength(1);
  }
  const statementWithWeight = source.subject.statements['schema:genre']![0]!;
  const absent = { ...statementWithWeight, qualifiers: [] };
  expect(workTagWeight(absent, releasedTags)).toEqual({ state: 'absent' });
  for (const [amount, unit] of [
    ['+0', '1'],
    ['+3.00000000000000000001', '1'],
    ['+2', 'confidence'],
  ]) {
    const unsupported = structuredClone(statementWithWeight);
    unsupported.qualifiers[0]!.value.content = { amount, unit } as never;
    expect(workTagWeight(unsupported, releasedTags)).toEqual({ state: 'unavailable' });
    expect(
      tagMarkup({ ...source, subject: { ...source.subject, statements: { 'schema:genre': [unsupported] } } }),
    ).not.toContain('data-state="available"');
  }
  const unsupported = structuredClone(statementWithWeight);
  unsupported.qualifiers[1]!.value.content = 'importConfidence';
  expect(workTagWeight(unsupported, releasedTags)).toEqual({ state: 'unsupported' });
  expect(tagMarkup({ ...source, subject: { ...source.subject, statements: { 'schema:genre': [absent] } } })).toContain(
    'No source weight recorded',
  );
  const unknown = structuredClone(statementWithWeight);
  unknown.qualifiers = [
    { property: { id: 'rezics:spoilerLevel', data_type: 'quantity' }, value: { type: 'somevalue' } },
  ];
  const withStatements = (statements: (typeof source.subject.statements)[string]) => ({
    ...source,
    subject: { ...source.subject, statements: { 'schema:genre': statements } },
  });
  expect(tagMarkup(withStatements([unknown]), 2)).toBe(tagMarkup(withStatements([]), 2));
});

test('the installed tag window pages disclosed assertions without borrowing native totals and distinguishes unavailable from empty', () => {
  const source = tagReading(27);
  source.subject.relationCounts = { 'schema:genre': 999999 };
  const html = tagMarkup(source);
  expect(html.match(/data-tag-index=/g)).toHaveLength(12);
  expect(html).toContain('More tags');
  expect(html).toContain('27 tags');
  expect(html).toContain('role=schema%3Agenre');
  expect(html).not.toContain('role=schema%3Acontributor');
  expect(html).not.toContain('role=wdt%3AP179');
  expect(html).not.toMatch(/(?<!\d)999999(?!\d)/);
  const empty = tagMarkup(source, 0);
  expect(empty).toContain('No work tags are disclosed in this reading.');
  expect(empty).not.toContain('More tags');
  expect(empty).not.toMatch(/(?<!\d)999999(?!\d)/);
  const unavailable = renderToStaticMarkup(
    createElement(SubjectConceptTags, {
      subject: source.subject,
      related: source.related,
      locale: 'en',
      spoilerThreshold: 0,
    }),
  );
  expect(unavailable).toContain('Tags are unavailable for this released reading.');
  expect(unavailable).not.toContain('No work tags are disclosed in this reading.');
});

test('return restores the exact assertion beyond the first tag window without replaying focus after replacement', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test/en/subjects/${id(700)}/book` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const source = tagReading(27);
  const returnHref = `/en/subjects/${id(700)}/book#work-tags?statement=${id(825)}&property=schema%3Agenre&spoiler=1&focus=browse`;
  const draw = (read: SubjectRead, threshold: number, currentHref = returnHref) =>
    act(async () => {
      root.render(
        createElement(SubjectConceptTags, {
          subject: read.subject,
          related: read.related,
          definitions: releasedTags,
          locale: 'en',
          spoilerThreshold: threshold,
          currentHref,
        }),
      );
    });
  const browse = () => host.querySelector<HTMLAnchorElement>('[data-tag-action="browse"]')!;
  const evidence = () => host.querySelector<HTMLAnchorElement>('[data-tag-action="evidence"]')!;
  const more = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'More tags')!;
  try {
    await draw(source, 1);
    expect(window.document.activeElement === host.querySelector('[data-tag-index="25"] a')).toBe(true);
    expect(host.querySelectorAll('[data-tag-index]')).toHaveLength(3);
    expect(more().disabled).toBe(true);
    expect(browse().tagName).toBe('A');
    expect(evidence().tagName).toBe('A');
    const exactReturn = new URL(evidence().href).searchParams.get('returnTo')!;
    expect(exactReturn).toContain(`statement=${id(824)}`);
    expect(exactReturn).toContain('focus=evidence');
    const previous = () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Previous tags')!;
    await act(async () => previous().click());
    expect(host.querySelectorAll('[data-tag-index]')).toHaveLength(12);
    await act(async () => previous().click());
    expect(previous().disabled).toBe(true);
    await act(async () => more().click());
    await act(async () => more().click());
    expect(host.querySelectorAll('[data-tag-index]')).toHaveLength(3);
    expect(more().disabled).toBe(true);
    await draw(structuredClone(source), 1);
    expect(host.querySelector('[data-tag-index="0"]')).not.toBeNull();
    expect(window.document.activeElement === browse()).toBe(false);
    await draw(source, 0);
    expect(host.textContent).not.toContain('2.59999990463257');
    await draw(source, 1);
    expect(window.document.activeElement === browse()).toBe(false);
    await draw(source, 1, returnHref.replace('focus=browse', 'focus=evidence'));
    expect(
      window.document.activeElement === host.querySelector('[data-tag-index="25"] [data-tag-action="evidence"]'),
    ).toBe(true);
    await draw(source, 0, returnHref.replace(id(825), id(999)));
    expect(window.document.activeElement === host.querySelector('h2')).toBe(true);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});

test('each VN, anime and book relation stream keeps its selected region through Connections and inspection', async () => {
  const { subjectVisitReturn, connectionReturnWindow, connectionReturnHref, withSubjectVisitReturn } =
    await import('../src/features/pages/subject-visit-navigation');
  const { workFranchiseReturn } = await import('../src/features/catalogue/work-franchise-reading/navigation');
  const { Route: finiteRelationsRoute } = await import('../src/routes/subjects/$id_.$slug_.relations');
  const { Route: finiteViewRoute } = await import('../src/routes/subjects/$id_.$slug_.$view');
  const validateFiniteSearch = finiteRelationsRoute.options.validateSearch as (
    search: Record<string, unknown>,
  ) => Record<string, unknown>;
  const validateViewSearch = finiteViewRoute.options.validateSearch as (
    search: Record<string, unknown>,
  ) => Record<string, unknown>;
  for (const type of ['wd:Q689445', 'schema:TVSeries', 'schema:Book']) {
    const source = read(type, publicBook.name, id(950), 'schema:Book', publicBook.name, id(951));
    const page = pageFor(source);
    page.document = {
      ...page.document,
      content: [
        ...(page.document as CompositionDocument).content,
        { type: 'RelationGroups', props: { id: 'inverse', property, limit: 8 } },
        { type: 'OutgoingRelations', props: { id: 'empty', property: 'schema:hasPart', limit: 8 } },
        { type: 'OutgoingRelations', props: { id: 'unavailable', property: 'schema:author', limit: 8 } },
      ],
    } as CompositionDocument;
    page.requestedRealm = id(960);
    const plan = planReads(platformRegistry, page.document as CompositionDocument, {
      subject: source.subject.id,
    });
    const row = source.subject.statements[property]![0]!;
    page.reads[plan.nodes.franchise!] = {
      status: 200,
      body: {
        relations: [
          {
            target: id(951),
            statement: row,
            summary: { id: id(951), type: 'schema:Book', label: { value: publicBook.name, language: 'ja' } },
            related: {},
          },
        ],
        next: 'native-next',
      },
    };
    page.reads[plan.nodes.inverse!] = {
      status: 200,
      body: {
        links: [
          {
            subject: id(952),
            property,
            statement: { ...row, id: id(953), value: { type: 'value', content: id(950) } },
            summary: { id: id(952), type: 'schema:Book', label: { value: publicBook.name, language: 'ja' } },
            related: {},
          },
        ],
        next: null,
      },
    };
    page.reads[plan.nodes.empty!] = { status: 200, body: { relations: [], next: null } };
    page.reads[plan.nodes.unavailable!] = { status: 503, body: {} };
    const overviewOrigin = `/ja/subjects/${id(950)}/book?realm=${id(960)}`;
    const html = await render(source, page, overviewOrigin);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(
      (match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://rezics.invalid'),
    );
    for (const [stream, node] of [
      ['out:wdt:P144', 'franchise'],
      ['in:wdt:P144', 'inverse'],
      ['out:schema:hasPart', 'empty'],
      ['out:schema:author', 'unavailable'],
    ]) {
      const destination = hrefs.find((url) => {
        const via = url.searchParams.get('via');
        return (
          connectionReturnWindow(url.hash)?.stream === stream && via && new URL(via, url).hash.includes(`node=${node}`)
        );
      });
      expect(destination).toBeDefined();
      const via = destination!.searchParams.get('via')!;
      expect(subjectVisitReturn(via, 'ja')).toBe(via);
      expect(new URL(via, destination).searchParams.get('realm')).toBe(id(960));
    }
    const inspection = hrefs.find((url) => url.pathname.endsWith('/value'));
    expect(inspection).toBeDefined();
    const via = inspection!.searchParams.get('via')!;
    expect(workFranchiseReturn(new URL(via, inspection).hash)).toMatchObject({
      focus: 'evidence',
      statement: id(101),
      holder: id(950),
      node: 'franchise',
      stream: 'out:wdt:P144',
    });
    expect(subjectVisitReturn(via, 'ja')).toBe(via);

    const cursor = 'native+current-cursor';
    const selectedPage = structuredClone(page);
    selectedPage.continuation = { node: 'franchise', cursor };
    const selectedPlan = planReads(platformRegistry, selectedPage.document as CompositionDocument, {
      subject: source.subject.id,
      continuation: selectedPage.continuation,
    });
    selectedPage.reads[selectedPlan.nodes.franchise!] = page.reads[plan.nodes.franchise!]!;
    const origin =
      `/ja/subjects/${id(950)}/book/relations?realm=${id(960)}&node=franchise` +
      `&streamProperty=${encodeURIComponent(property)}&streamDirection=forward&cursor=${encodeURIComponent(cursor)}`;
    const selection = { node: 'franchise', property, direction: 'forward' as const, cursor };
    const routeSearch = Object.fromEntries(new URL(origin, 'https://rezics.invalid').searchParams);
    for (const validate of [validateFiniteSearch, validateViewSearch])
      expect(validate(routeSearch)).toMatchObject({
        node: selection.node,
        streamProperty: property,
        streamDirection: 'forward',
        cursor,
        realm: id(960),
      });
    expect(subjectVisitReturn(`${origin}#work-franchise`, 'ja')).toBe(`${origin}#work-franchise`);
    const finiteHtml = await render(source, selectedPage, `${origin}#work-franchise`, selection);
    const finiteHrefs = [...finiteHtml.matchAll(/href="([^"]+)"/g)].map(
      (match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://rezics.invalid'),
    );
    expect(finiteHtml.match(/data-work-stream=/g)).toHaveLength(1);
    const finiteConnection = finiteHrefs.find((url) => connectionReturnWindow(url.hash)?.stream === 'out:wdt:P144');
    expect(finiteConnection).toBeDefined();
    const finiteVia = finiteConnection!.searchParams.get('via')!;
    const finiteOrigin = new URL(finiteVia, finiteConnection);
    expect(
      ['realm', 'node', 'streamProperty', 'streamDirection', 'cursor'].map((key) => finiteOrigin.searchParams.get(key)),
    ).toEqual([id(960), selection.node, property, 'forward', cursor]);
    const finiteInspection = finiteHrefs.find((url) => url.pathname.endsWith('/value'));
    expect(finiteInspection).toBeDefined();
    const inspectedVia = finiteInspection!.searchParams.get('via')!;
    const inspectedOrigin = new URL(inspectedVia, finiteInspection!);
    expect(workFranchiseReturn(inspectedOrigin.hash)).toMatchObject({ node: 'franchise', stream: 'out:wdt:P144' });
    expect((await render(source, selectedPage, inspectedVia, selection)).match(/data-work-stream=/g)).toHaveLength(1);
    for (const [key, value] of [
      ['node', 'other'],
      ['streamProperty', 'schema:author'],
    ] as const) {
      const mismatchedOrigin = new URL(inspectedVia, finiteInspection!);
      mismatchedOrigin.searchParams.set(key, value);
      const mismatchedAddress = `${mismatchedOrigin.pathname}${mismatchedOrigin.search}${mismatchedOrigin.hash}`;
      expect(subjectVisitReturn(mismatchedAddress, 'ja')).toBeUndefined();
    }
    const native = connectionReturnHref(source.subject.id, publicBook.name, 'ja', id(960), {
      stream: 'out:wdt:P144',
      cursor: 'opaque+cursor',
      reading: 'a'.repeat(64),
      focus: id(101),
      holder: source.subject.id,
      control: 'evidence',
    });
    const returned = withSubjectVisitReturn(native, inspectedVia, 'ja');
    expect(subjectVisitReturn(returned, 'ja')).toBe(returned);
    const restored = new URL(returned, 'https://rezics.invalid');
    expect(connectionReturnWindow(restored.hash)).toMatchObject({ cursor: 'opaque+cursor', control: 'evidence' });
    expect(restored.searchParams.get('via')).toBe(inspectedVia);
    expect(new URL(inspectedVia, new URL(returned, 'https://rezics.invalid')).searchParams.get('cursor')).toBe(cursor);
    expect(subjectVisitReturn(returned, 'en')).toBeUndefined();
    expect(workFranchiseReturn(`${new URL(inspectedVia, finiteInspection!).hash}&focus=evidence`)).toBeUndefined();
  }
});
