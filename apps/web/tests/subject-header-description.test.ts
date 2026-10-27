import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { fromMarkdown } from '@rezics/document';
import { SubjectPage, subjectPageJsonLd, type SubjectPageData } from '../src/features/pages/subject.tsx';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { ResultList } from '../src/search/results.tsx';
import { pageHead } from '../src/shell/head.ts';

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
const loaded = () => structuredClone(recordedPage) as unknown as SubjectPageData;
const subjectOf = (page: SubjectPageData) =>
  (page.reads.r0!.body as unknown as typeof recordedPage.reads.r0.body).subject;
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
  const html = render(page, 'zh-Hans');
  expect(count(html, '>英语<')).toBe(1);
  expect(headerOf(html)).not.toContain('>英语<');
  expect(aboutOf(html)).toContain('>英语<');
  expect(count(html, summary)).toBe(1);
});

test('a summary in another language takes precedence over a description in the reader language', () => {
  const page = loaded();
  const statement = subjectOf(page).statements['schema:abstract'][0]!;
  const french = 'Un aviateur rencontre un petit prince.';
  statement.value.content = {
    language: 'fr',
    document: fromMarkdown(french, 'text'),
  } as typeof statement.value.content;
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
