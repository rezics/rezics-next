import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { fromMarkdown } from '@rezics/document';
import { pageContext, SubjectPage, subjectPageJsonLd, type SubjectPageData } from '../src/features/pages/subject.tsx';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { ResultList } from '../src/search/results.tsx';
import { pageHead } from '../src/shell/head.ts';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { subjectHead } from '../src/features/pages/subject-head.ts';

const messages = {
  unknown: 'Unknown',
  none: 'None',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
  search: 'Search',
};
const description =
  'A poetic novella in which a pilot stranded in the Sahara meets a young prince from a tiny asteroid and learns what is essential.';
const summary =
  'A pilot stranded in the Sahara meets a small prince who has left his asteroid, and learns from him what matters.';
type RecordedStatement = {
  id: string;
  rank: string;
  property: { id: string; data_type: string };
  value: { type: string; content: { language?: string; document?: unknown; digest?: string } };
  qualifiers: unknown[];
  references: unknown[];
};
type RecordedBody = {
  subject: { id: string; descriptions: Record<string, string>; statements: Record<string, RecordedStatement[]> };
  documents?: Record<string, unknown>;
};
const bodyOf = (page: SubjectPageData) => page.reads.r0!.body as unknown as RecordedBody;
const subjectOf = (page: SubjectPageData) =>
  (page.reads.r0!.body as unknown as typeof recordedPage.reads.r0.body).subject;
let nextDocument = 100;
function fillSummary(page: SubjectPageData, statement: RecordedStatement, language: string, document: unknown) {
  const body = bodyOf(page);
  const documentId = `0192f3a0-6c1e-7b2a-9d4e-${String(nextDocument++).padStart(12, '0')}`;
  const digest = 'a'.repeat(64);
  statement.value.content = { language, document: documentId, digest };
  body.documents = {
    ...body.documents,
    [statement.id]: {
      id: documentId,
      subjectId: body.subject.id,
      candidateId: statement.id,
      digest,
      language,
      availability: 'available',
      body: document,
    },
  };
  return body.documents![statement.id] as Record<string, unknown>;
}
const loaded = () => {
  const page = structuredClone(recordedPage) as unknown as SubjectPageData;
  const body = bodyOf(page);
  for (const statement of body.subject.statements['schema:abstract'] ?? []) {
    const { language, document } = statement.value.content;
    if (typeof language === 'string' && document && typeof document === 'object')
      fillSummary(page, statement, language, document);
  }
  return page;
};
const render = (page: SubjectPageData, locale = 'en') =>
  renderToString(createElement(SubjectPage, { page, locale, messages, renderJsonLd: false }));
const count = (html: string, text: string) => html.split(text).length - 1;
const headerOf = (html: string) => html.match(/<header\b[\s\S]*?<\/header>/)?.[0] ?? '';
const aboutOf = (html: string) => html.match(/<section data-slot="subject-summary"[\s\S]*?<\/section>/)?.[0] ?? '';

test('the subject page header shows no description, and the recorded paraphrased summary appears once in About', () => {
  const html = render(loaded());
  expect(headerOf(html)).toContain('<h1');
  expect(headerOf(html)).not.toContain(description);
  expect(headerOf(html)).not.toContain(summary);
  expect(html).not.toContain(description);
  expect(count(html, summary)).toBe(1);
  expect(aboutOf(html)).toContain(summary);
});

test('a subject without a summary in any language shows the description once as About prose, with its foreign language tag', () => {
  const page = loaded();
  const subject = subjectOf(page);
  delete (subject.statements as Record<string, unknown>)['schema:abstract'];
  subject.descriptions = { en: description } as typeof subject.descriptions;
  for (const locale of ['en', 'zh-Hans']) {
    const html = render(page, locale);
    expect(headerOf(html)).not.toContain(description);
    expect(count(html, description)).toBe(1);
    expect(aboutOf(html)).toMatch(new RegExp(`<p[^>]*>${description}</p>`));
    expect(aboutOf(html)).not.toContain(summary);
    expect(count(html, '>英语<')).toBe(locale === 'zh-Hans' ? 1 : 0);
    if (locale === 'zh-Hans') expect(aboutOf(html)).toContain('lang="en"');
  }
});

test('in zh-Hans, the recorded subject with English texts shows the English language tag once, in About', () => {
  const page = loaded();
  const subject = subjectOf(page);
  subject.descriptions = { en: description } as typeof subject.descriptions;
  subject.statements['schema:abstract'] = subject.statements['schema:abstract'].filter(
    (statement) => statement.value.content.language === 'en',
  );
  const html = render(page, 'zh-Hans');
  expect(count(html, '>英语<')).toBe(1);
  expect(headerOf(html)).not.toContain('>英语<');
  expect(aboutOf(html)).toContain('>英语<');
  expect(count(html, summary)).toBe(1);
});

test('a summary in another language takes precedence over a description in the reader language', () => {
  const page = loaded();
  const statement = subjectOf(page).statements['schema:abstract'][0]! as unknown as RecordedStatement;
  const french = 'Un aviateur rencontre un petit prince.';
  fillSummary(page, statement, 'fr', fromMarkdown(french, 'text'));
  const html = render(page);
  expect(aboutOf(html)).toContain(french);
  expect(html).not.toContain(description);
});

test('About omits prose when the subject has neither summary nor description', () => {
  const page = loaded();
  const subject = subjectOf(page);
  delete (subject.statements as Record<string, unknown>)['schema:abstract'];
  subject.descriptions = {} as typeof subject.descriptions;
  const html = render(page);
  expect(html).not.toContain(summary);
  expect(html).not.toContain(description);
  expect(aboutOf(html)).toContain('data-slot="subject-facts"');
  expect(aboutOf(html)).not.toContain('>英语<');
});

test('meta description, JSON-LD, search and card snippets keep the description unchanged from base', async () => {
  const page = loaded();
  const subject = subjectOf(page);
  const jsonLd = JSON.parse(subjectPageJsonLd(page, 'en')!);
  expect(jsonLd.description).toBe(description);
  const head = pageHead(
    { title: subject.labels.en, description: jsonLd.description },
    { origin: 'https://rezics.com', locale: 'en', path: `/subjects/${page.subject}` },
  );
  expect(head.meta).toContainEqual({ name: 'description', content: description });
  expect(head.meta).toContainEqual({ property: 'og:description', content: description });

  const route = createRootRoute({
    component: () => createElement(ResultList, { hits: [subject], locale: 'en', hitTypes: {}, yearProperties: [] }),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const results = renderToString(createElement(RouterProvider, { router }));
  expect(count(results, description)).toBe(1);
  expect(results).not.toContain(summary);
});

test('head and JSON-LD match the rendered public summary and nested inverse lists', () => {
  const page = loaded();
  const locale = 'zh-Hans';
  const summaryText = '灯火穿过海湾，留下可见的航线。';
  const sourceId = '0192f3a0-6c1e-7b2a-9d4e-000000000901';
  const canonicalId = '0192f3a0-6c1e-7b2a-9d4e-000000000902';
  const hiddenId = '0192f3a0-6c1e-7b2a-9d4e-000000000903';
  const hiddenLabel = '仅剧透读者可见的对象';
  const names = Array.from({ length: 16 }, (_, index) => `可见项目${String(index + 1).padStart(2, '0')}`);
  const testSubject = subjectOf(page) as unknown as RecordedBody['subject'];
  testSubject.descriptions = {} as typeof testSubject.descriptions;
  const preferred: RecordedStatement = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000904',
    rank: 'preferred',
    property: { id: 'schema:abstract', data_type: 'document' },
    value: { type: 'value', content: { language: locale } },
    qualifiers: [],
    references: [],
  };
  testSubject.statements['schema:abstract'] = [preferred, ...testSubject.statements['schema:abstract']!];
  fillSummary(page, preferred, locale, fromMarkdown(summaryText, 'text'));

  const list = (id: string, limit: number, paged = false) => ({
    type: 'SubjectList',
    props: {
      id,
      title: { [locale]: `作品${id}` },
      property: 'schema:isPartOf',
      limit,
      ...(paged ? { paged: true } : {}),
    },
  });
  const nested = {
    type: 'Slot',
    props: {
      id: 'nested-inverse-lists',
      name: 'hero',
      children: [list('paged-list', 24, true), list('coalesced-preview', 12), list('wide-list', 24)],
    },
  };
  page.document = {
    ...(page.document as unknown as CompositionDocument),
    content: [
      ...(page.document as unknown as CompositionDocument).content,
      list('small-list', 2),
      nested,
      list('repeated-wide-list', 24),
    ],
  } as unknown as SubjectPageData['document'];

  const rows = names.map((name, index) => {
    const id =
      index === 0
        ? canonicalId
        : index === 1
          ? hiddenId
          : `0192f3a0-6c1e-7b2a-9d4e-${String(904 + index).padStart(12, '0')}`;
    const statement = `0192f3a0-6c1e-7b2a-9d4e-${String(950 + index).padStart(12, '0')}`;
    return {
      subject: index === 0 ? sourceId : id,
      label: index === 1 ? hiddenLabel : name,
      type: 'schema:Book',
      summary: {
        id,
        type: 'schema:Book',
        label: { value: `Unlocalized ${index}`, language: 'en' },
      },
      statement,
      assertion: {
        id: statement,
        qualifiers:
          index === 1
            ? [
                {
                  property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
                  value: { type: 'value', content: { amount: '+1', unit: '1' } },
                },
              ]
            : [],
      },
    };
  });
  const plan = planReads(platformRegistry, page.document as unknown as CompositionDocument, pageContext(page));
  expect(plan.nodes['paged-list']).toBe(plan.nodes['coalesced-preview']);
  expect(plan.reads[plan.nodes['paged-list']!]!.kind).toBe('links');
  page.reads = { ...page.reads };
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind !== 'links' || read.property !== 'schema:isPartOf') continue;
    page.reads[key] = {
      status: 200,
      body: {
        links: rows.slice(0, read.limit),
        count: { value: rows.length, exact: true },
        next: 'next-secret-cursor',
      },
    };
  }

  const html = render(page, locale);
  expect(html).toContain(summaryText);
  expect(html).not.toContain(hiddenLabel);
  expect(html).not.toContain(hiddenId);
  const jsonBytes = subjectPageJsonLd(page, locale);
  if (!jsonBytes) throw new Error('Expected page JSON-LD');
  expect(jsonBytes).not.toContain(hiddenLabel);
  expect(jsonBytes).not.toContain(hiddenId);
  expect(jsonBytes).not.toContain('next-secret-cursor');
  const json = JSON.parse(jsonBytes) as {
    hasPart: { '@id': string; name: string; url?: string }[];
  };
  expect(json.hasPart.map(({ name }) => name)).toEqual([names[0], ...names.slice(2, 12)]);
  expect(json.hasPart[0]).toMatchObject({ '@id': `https://rezics.com/id/${canonicalId}`, name: names[0] });
  expect(json.hasPart[0]?.url?.startsWith(`https://rezics.com/zh-Hans/subjects/${canonicalId}/`)).toBe(true);
  const htmlOrder = [names[0], ...names.slice(2, 12)].map((name) => html.indexOf(name));
  expect(htmlOrder.every((index) => index >= 0)).toBe(true);
  expect(htmlOrder).toEqual([...htmlOrder].sort((left, right) => left - right));

  const head = subjectHead(page, {
    origin: 'https://rezics.com',
    locale,
    path: `/zh-Hans/subjects/${page.subject}/little-prince`,
  });
  expect(head.meta).toContainEqual({ name: 'description', content: summaryText });

  const mismatched = structuredClone(page);
  const mismatchedBody = bodyOf(mismatched);
  const bound = mismatchedBody.documents![preferred.id] as Record<string, unknown>;
  bound.digest = 'b'.repeat(64);
  const mismatchedHtml = render(mismatched, locale);
  expect(mismatchedHtml).not.toContain(summaryText);
  expect(mismatchedHtml).toContain('data-slot="subject-summary"');
  const mismatchedHead = subjectHead(mismatched, {
    origin: 'https://rezics.com',
    locale,
    path: `/zh-Hans/subjects/${mismatched.subject}/little-prince`,
  });
  expect(mismatchedHead.meta.some((item) => 'name' in item && item.name === 'description')).toBe(false);

  const unplanned = structuredClone(page);
  const unplannedDocument = unplanned.document as unknown as CompositionDocument;
  unplanned.document = {
    ...unplannedDocument,
    content: unplannedDocument.content.filter((node) => node.type !== 'Summary'),
  } as unknown as SubjectPageData['document'];
  expect(render(unplanned, locale)).not.toContain(summaryText);
  const unplannedHead = subjectHead(unplanned, {
    origin: 'https://rezics.com',
    locale,
    path: `/zh-Hans/subjects/${unplanned.subject}/little-prince`,
  });
  expect(unplannedHead.meta.some((item) => 'name' in item && item.name === 'description')).toBe(false);

  const concealedPreferred = structuredClone(page);
  const concealedSubject = subjectOf(concealedPreferred) as unknown as RecordedBody['subject'];
  concealedSubject.statements['schema:abstract']![0]!.qualifiers = [
    {
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '+1', unit: '1' } },
    },
  ];
  const concealedHead = subjectHead(concealedPreferred, {
    origin: 'https://rezics.com',
    locale,
    path: `/zh-Hans/subjects/${concealedPreferred.subject}/little-prince`,
  });
  expect(concealedHead.meta.some((item) => 'name' in item && item.name === 'description')).toBe(false);
  expect(render(concealedPreferred, locale)).not.toContain(summaryText);
});
