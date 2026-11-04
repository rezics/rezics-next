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
    { type: 'OutgoingRelations', props: { id: 'franchise', title: { en: 'Related works' }, property, limit: 8 } },
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

async function render(source: SubjectRead, page = pageFor(source), currentHref?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const route = createRootRoute({
    component: () =>
      createElement(SubjectPage, {
        page,
        currentHref,
        locale: 'ja',
        view: 'overview',
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
    { property: 'schema:hasPart', id: id(14), type: 'schema:TVEpisode', label: '第一話' },
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
  expect(bookHtml).toContain('data-slot="literary-reader"');
  expect(bookHtml).toContain('原作ビジュアルノベル');
  expect(bookHtml).toContain('作家');
  expect(bookHtml).toContain('第一巻');

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
      references: [{ parts: [tagQualifier('schema:url', 'https://vndb.org/v17', 'url')] }],
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
  expect(html).toContain('VNDB tags.rating: +2.59999990463257');
  expect(html).toContain('Supplied spoiler level: 1');
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
  }
  const unsupported = structuredClone(statementWithWeight);
  unsupported.qualifiers[1]!.value.content = 'importConfidence';
  expect(workTagWeight(unsupported, releasedTags)).toEqual({ state: 'unsupported' });
  expect(tagMarkup({ ...source, subject: { ...source.subject, statements: { 'schema:genre': [absent] } } })).toContain(
    'No source weight supplied',
  );
});

test('the 24-row preview exposes native continuation without hidden totals and distinguishes unavailable from no admitted tags', () => {
  const source = tagReading(27);
  source.subject.relationCounts = { 'schema:genre': 999999 };
  const html = tagMarkup(source);
  expect(html.match(/data-tag-index=/g)).toHaveLength(24);
  expect(html).toContain('first 24 admitted assertions');
  expect(html).toContain('/details?via=');
  expect(html).toContain('property=schema%3Agenre');
  expect(html).not.toContain('property=schema%3Acontributor');
  expect(html).not.toContain('property=wdt%3AP179');
  expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/\b27\b/);
  expect(html).not.toMatch(/(?<!\d)999999(?!\d)/);
  const empty = tagMarkup(source, 0);
  expect(empty).toContain('No admitted tag assertions');
  expect(empty).not.toContain('first 24 admitted assertions');
  expect(empty).not.toMatch(/(?<!\d)999999(?!\d)/);
  const unavailable = renderToStaticMarkup(
    createElement(SubjectConceptTags, {
      subject: source.subject,
      related: source.related,
      locale: 'en',
      spoilerThreshold: 0,
    }),
  );
  expect(unavailable).toContain('Tag evidence is unavailable');
  expect(unavailable).not.toContain('No admitted tag assertions');
});

test('evidence inspection is independent of browsing and retires on preference and equal source replacement', async () => {
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
  const source = tagReading();
  const returnHref = `/en/subjects/${id(700)}/book#work-tags?statement=${id(800)}&property=schema%3Agenre&spoiler=1&focus=browse`;
  const draw = (read: SubjectRead, threshold: number) =>
    act(async () => {
      root.render(
        createElement(SubjectConceptTags, {
          subject: read.subject,
          related: read.related,
          definitions: releasedTags,
          locale: 'en',
          spoilerThreshold: threshold,
          currentHref: returnHref,
        }),
      );
    });
  const inspect = () => host.querySelector<HTMLButtonElement>('[data-tag-action="evidence"]')!;
  try {
    await draw(source, 1);
    const browse = host.querySelector('[data-tag-action="browse"]')!;
    expect(window.document.activeElement).toBe(browse);
    expect(inspect().tagName).toBe('BUTTON');
    expect(host.querySelector('[data-tag-action="browse"]')?.tagName).toBe('A');
    await act(async () => inspect().click());
    expect(host.textContent).toContain('https://vndb.org/v17');
    expect(host.textContent).toContain(id(800));
    expect(host.textContent).toContain('not a REZICS rating or import confidence');
    await draw(structuredClone(source), 1);
    expect(host.querySelector('[data-slot="work-tag-evidence"]')).toBeNull();
    await act(async () => inspect().click());
    await draw(source, 0);
    expect(host.textContent).not.toContain('2.59999990463257');
    await draw(source, 1);
    expect(host.querySelector('[data-slot="work-tag-evidence"]')).toBeNull();
    expect(window.document.activeElement).not.toBe(host.querySelector('[data-tag-action="browse"]'));
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
  const { subjectVisitReturn, connectionReturnWindow, workFranchiseReturnHref } = await import('../src/features/pages/subject-visit-navigation');
  const { workFranchiseReturn } = await import('../src/features/catalogue/work-franchise-reading/navigation');
  for (const type of ['wd:Q689445', 'schema:TVSeries', 'schema:Book']) {
    const source = read(type, publicBook.name, id(950), 'schema:Book', publicBook.name, id(951));
    const page = pageFor(source);
    page.document = { ...page.document, content: [
      ...(page.document as CompositionDocument).content,
      { type: 'RelationGroups', props: { id: 'inverse', property, limit: 8 } },
      { type: 'OutgoingRelations', props: { id: 'empty', property: 'schema:hasPart', limit: 8 } },
      { type: 'OutgoingRelations', props: { id: 'unavailable', property: 'schema:author', limit: 8 } },
    ] } as CompositionDocument;
    const plan = planReads(platformRegistry, page.document as CompositionDocument, { subject: source.subject.id });
    const row = source.subject.statements[property]![0]!;
    page.reads[plan.nodes.franchise!] = { status: 200, body: { relations: [{
      target: id(951), statement: row,
      summary: { id: id(951), type: 'schema:Book', label: { value: publicBook.name, language: 'ja' } }, related: {},
    }], next: 'native-next' } };
    page.reads[plan.nodes.inverse!] = { status: 200, body: { links: [{
      subject: id(952), property, statement: { ...row, id: id(953), value: { type: 'value', content: id(950) } },
      summary: { id: id(952), type: 'schema:Book', label: { value: publicBook.name, language: 'ja' } }, related: {},
    }], next: null } };
    page.reads[plan.nodes.empty!] = { status: 200, body: { relations: [], next: null } };
    page.reads[plan.nodes.unavailable!] = { status: 503, body: {} };
    const origin = `/ja/subjects/${id(950)}/book?realm=${id(960)}`;
    const html = await render(source, page, origin);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://rezics.invalid'));
    for (const [stream, node] of [['out:wdt:P144', 'franchise'], ['in:wdt:P144', 'inverse'], ['out:schema:hasPart', 'empty'], ['out:schema:author', 'unavailable']]) {
      const destination = hrefs.find((url) => {
        const via = url.searchParams.get('via');
        return connectionReturnWindow(url.hash)?.stream === stream && via && new URL(via, url).hash.includes(`node=${node}`);
      });
      expect(destination).toBeDefined();
      const via = destination!.searchParams.get('via')!;
      expect(subjectVisitReturn(via, 'ja')).toBe(via);
      expect(new URL(via, destination).searchParams.get('realm')).toBe(id(960));
    }
    const inspection = hrefs.find((url) => url.pathname.endsWith('/values') || url.pathname.includes('/values/'));
    expect(inspection).toBeDefined();
    const via = inspection!.searchParams.get('via')!;
    expect(workFranchiseReturn(new URL(via, inspection).hash)).toMatchObject({ focus: 'evidence', statement: id(101), holder: id(950), node: 'franchise' });
    const finite = `${origin.replace('?realm=', '/relations?realm=')}&node=franchise&cursor=opaque%2Bcursor&property=wdt%3AP144`;
    const restored = workFranchiseReturnHref(finite, origin, 'ja', { stream: 'out:wdt:P144', node: 'franchise', spoiler: 0 });
    const restoredUrl = new URL(restored, 'https://rezics.invalid');
    expect(restoredUrl.pathname).toEndWith('/relations');
    expect(restoredUrl.searchParams.get('cursor')).toBe('opaque+cursor');
    expect(restoredUrl.searchParams.get('node')).toBe('franchise');
    expect(subjectVisitReturn(restored, 'ja')).toBe(restored);
    expect(subjectVisitReturn(restored, 'en')).toBeUndefined();
    expect(workFranchiseReturn(`${restoredUrl.hash}&focus=evidence`)).toBeUndefined();
  }
});
