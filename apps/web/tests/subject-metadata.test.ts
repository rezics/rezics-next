import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernelClient } from '@rezics/client';
import type { CoverSummary } from '@rezics/ui/cover';
import recorded from '../src/kernel/recorded/subject-page.json';
import missing from '../src/kernel/recorded/missing-subject-page.json';
import { renderSubject } from './helpers/subject-render';
import type { Stmt } from '../src/features/pages/shared';
import type { Related } from '../src/subject/types';
import { subjectHref } from '../src/subject/subject-href';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadSubjectPage, SubjectPage, subjectBody } = await import('../src/features/pages/subject');
const { subjectHead } = await import('../src/features/pages/subject-head');
const { QUESTION } = await import('../src/features/pages/subject-ratings');
type SubjectPageData = import('../src/features/pages/subject').SubjectPageData;

const origin = 'https://public.example.test';
const id = recorded.subject;
const creator = recorded.reads.r0.body.subject.statements['schema:author'][0]!.value.content;
const GLOBAL = '00000000-0000-8000-8000-000000000000';
const messages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
};
const cover: CoverSummary = {
  media: 'current-public-cover',
  width: 1200,
  height: 1800,
  placeholder: { thumbhash: '', color: '#354535' },
  focalPoint: null,
  variants: [
    { format: 'webp', width: 480 },
    { format: 'avif', width: 1200 },
    { format: 'webp', width: 1200 },
  ],
  credit: { rightsHolder: 'Not the publisher', license: 'Not a subject licence' },
};
const bookCatalogue = {
  state: 'released' as const,
  type: 'schema:Book',
  digest: bundledDigest,
  definitions: { types: bundledRelease.types, properties: bundledRelease.properties },
  directions: [
    {
      state: 'admitted' as const,
      property: 'schema:author',
      direction: 'forward' as const,
      inverse: null,
      sourceTypes: ['schema:Book'],
      targetTypes: ['schema:Person'],
      release: bundledDigest,
      qualifiers: [],
    },
  ],
};

function fixture(
  options: { cover?: CoverSummary | null; statements?: Record<string, Stmt[]>; related?: Related } = {},
): SubjectPageData {
  const page: SubjectPageData = structuredClone(recorded);
  page.reads.r0 = {
    status: 200,
    body: {
      ...structuredClone(recorded.reads.r0.body),
      summary: { ...recorded.reads.r0.body.summary, cover: options.cover ?? null },
      subject: {
        ...structuredClone(recorded.reads.r0.body.subject),
        ...(options.statements ? { statements: options.statements } : {}),
      },
      ...(options.related ? { related: options.related } : {}),
    },
  };
  return page;
}

function head(page: SubjectPageData, locale = 'en') {
  return subjectHead(page, {
    origin,
    locale,
    path: subjectHref({ id, label: recorded.reads.r0.body.subject.labels.en }, locale).href,
    typeLabel: 'Book',
  });
}

function meta(result: ReturnType<typeof head>, key: string): string | undefined {
  const entry = result.meta.find(
    (item) => ('property' in item && item.property === key) || ('name' in item && item.name === key),
  );
  return entry && 'content' in entry ? entry.content : undefined;
}

const statement = (property: string, data_type: string, content: unknown): Stmt => ({
  id: '0494501a-36af-8cc7-95c9-d7ffe4728299',
  rank: 'normal',
  property: { id: property, data_type },
  value: { type: 'value', content },
  qualifiers: [],
  references: [],
});

test('the recorded native page joins its visible creators and editions without additional requests', async () => {
  const sent: string[] = [];
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      sent.push(`${request.method} ${new URL(request.url).pathname}`);
      expect(await request.json()).toEqual({ target: { subject: id }, languages: ['en'] });
      return Response.json(recorded);
    },
  });
  const loaded = await loadSubjectPage(client, id);
  if (loaded.kind !== 'page') throw new Error('Expected the recorded public page');
  loaded.page.catalogue = bookCatalogue;
  const html = await renderSubject(
    createElement(SubjectPage, { page: loaded.page, locale: 'en', messages, renderJsonLd: false }),
    `/en/subjects/${id}`,
  );
  const result = head(loaded.page);
  const json = JSON.parse(result.scripts[0]!.children);
  const creatorLabel = recorded.reads.r0.body.related[creator].labels.en;
  const creatorPath = subjectHref({ id: creator, label: creatorLabel }, 'en').href;
  const creatorVisit = new URL(creatorPath, origin);
  creatorVisit.searchParams.set(
    'via',
    `${subjectHref({ id, label: recorded.reads.r0.body.subject.labels.en }, 'en').href}#literary-reader`,
  );
  expect(html).toContain(`href="${creatorVisit.pathname}${creatorVisit.search}"`);
  expect(json.author).toEqual({
    '@id': `https://rezics.com/id/${creator}`,
    '@type': 'Person',
    name: creatorLabel,
    url: `${origin}${creatorPath}`,
  });
  expect(json.workExample).toHaveLength(recorded.reads.r1.body.links.length);
  for (const [index, edition] of recorded.reads.r1.body.links.entries()) {
    const path = subjectHref({ id: edition.subject, label: edition.label }, 'en').href;
    expect(html).toContain(`href="${path}"`);
    expect(json.workExample[index]).toEqual({
      '@id': `https://rezics.com/id/${edition.subject}`,
      '@type': 'Thing',
      name: edition.label,
      url: `${origin}${path}`,
    });
    expect(json.workExample[index]).not.toHaveProperty('publisher');
    expect(json.workExample[index]).not.toHaveProperty('datePublished');
  }
  expect(json['@id']).toBe(`https://rezics.com/id/${id}`);
  expect(json.url).toBe(`${origin}${subjectHref({ id, label: json.name }, 'en').href}`);
  expect(JSON.stringify(json)).not.toContain('/@');
  expect(sent).toEqual(['POST /v1/pages:read']);
});

test('the head and structured image use only the currently authorized visible cover variants and localized title', async () => {
  const page = fixture({ cover });
  const result = head(page, 'ja');
  const json = JSON.parse(result.scripts[0]!.children);
  const html = await renderSubject(
    createElement(SubjectPage, { page, locale: 'ja', messages, renderJsonLd: false }),
    `/ja/subjects/${id}`,
  );
  expect(html).toContain('/media/current-public-cover/webp-1200');
  expect(meta(result, 'og:image')).toBe(`${origin}/media/current-public-cover/webp-1200`);
  expect(meta(result, 'og:image:width')).toBe('1200');
  expect(meta(result, 'og:image:height')).toBe('1800');
  expect(meta(result, 'og:image:alt')).toBe(recorded.reads.r0.body.subject.labels.ja);
  expect(meta(result, 'twitter:image')).toBe(meta(result, 'og:image'));
  expect(meta(result, 'twitter:image:alt')).toBe(meta(result, 'og:image:alt'));
  expect(json.image).toEqual({ '@type': 'ImageObject', url: meta(result, 'og:image'), width: 1200, height: 1800 });
  expect(json).not.toHaveProperty('publisher');
  expect(json).not.toHaveProperty('license');
  expect(JSON.stringify(json)).not.toContain('Not the publisher');
  for (const unavailable of [
    null,
    { ...cover, variants: [] },
    { ...cover, withheld: 'suitability' as const },
    { ...cover, width: 0 },
  ]) {
    const hidden = head(fixture({ cover: unavailable }));
    expect(meta(hidden, 'og:image')).toBe(`${origin}/cards/default.png`);
    expect(meta(hidden, 'og:image:alt')).toBe('REZICS');
    expect(JSON.parse(hidden.scripts[0]!.children)).not.toHaveProperty('image');
    expect(JSON.stringify(hidden)).not.toContain(cover.media);
  }
});

test('identity, rank, native ratings and related failures retain the public disclosure boundary', () => {
  const identity = 'https://example.org/identities/the-little-prince';
  const hiddenDate = statement('schema:datePublished', 'time', { time: '+2099-01-01T00:00:00Z', precision: 11 });
  hiddenDate.qualifiers = [
    {
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '+1', unit: '1' } },
    },
  ];
  const page = fixture({
    related: {},
    statements: {
      'schema:author': recorded.reads.r0.body.subject.statements['schema:author'],
      'schema:datePublished': [hiddenDate],
      'schema:sameAs': [
        statement('schema:sameAs', 'url', identity),
        statement('schema:sameAs', 'external-id', 'https://not-an-identity.example'),
        statement('schema:sameAs', 'url', 'javascript:private'),
      ],
      'wdt:P648': [statement('wdt:P648', 'external-id', 'OL123W')],
      'schema:aggregateRating': [statement('schema:aggregateRating', 'string', 'Imported private score')],
    },
  });
  page.reads.r1 = { status: 503, body: recorded.reads.r1.body };
  const result = subjectHead(page, {
    origin,
    locale: 'en',
    path: '/subjects/current',
    ratings: {
      figure: {
        questionId: QUESTION,
        populationId: GLOBAL,
        scale: { min: 0, max: 40, displayStep: 4 },
        state: 'ready',
        count: 4,
        mean: null,
        score: null,
      },
    },
  });
  const json = JSON.parse(result.scripts[0]!.children);
  expect(json.sameAs).toBe(identity);
  expect(json.identifier).toEqual([
    { '@type': 'PropertyValue', propertyID: 'http://www.wikidata.org/entity/P648', value: 'OL123W' },
  ]);
  for (const field of ['author', 'datePublished', 'aggregateRating', 'workExample'])
    expect(json).not.toHaveProperty(field);
  expect(JSON.stringify(result)).not.toContain('2099');
  expect(JSON.stringify(result)).not.toContain('Imported private score');
  expect(JSON.stringify(result)).not.toContain(recorded.reads.r1.body.links[0]!.label);
  const preferred = statement('schema:sameAs', 'url', 'https://concealed.example');
  preferred.rank = 'preferred';
  preferred.value = { type: 'somevalue' };
  const suppressed = head(
    fixture({ statements: { 'schema:sameAs': [statement('schema:sameAs', 'url', identity), preferred] } }),
  );
  expect(JSON.parse(suppressed.scripts[0]!.children)).not.toHaveProperty('sameAs');
});

test('unavailable public targets retain truthful failures and cannot populate a fallback with old subject data', async () => {
  const sent: string[] = [];
  let status = 404;
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      sent.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json(status === 404 ? missing : { ...missing, status, code: 'semantic_not_ready' }, { status });
    },
  });
  expect(await loadSubjectPage(client, id)).toEqual({ kind: 'missing' });
  status = 503;
  await expect(loadSubjectPage(client, id)).rejects.toThrow('semantic_not_ready');
  expect(sent).toEqual(['POST /v1/pages:read', 'POST /v1/pages:read']);
  const page = fixture({ cover });
  page.reads.r0 = { status: 404, body: recorded.reads.r0.body };
  expect(subjectBody(page)).toBeUndefined();
  const result = head(page);
  expect(result.scripts).toHaveLength(0);
  expect(meta(result, 'og:image')).toBe(`${origin}/cards/default.png`);
  expect(meta(result, 'og:image:alt')).toBe('REZICS');
  expect(JSON.stringify(result)).not.toContain(recorded.reads.r0.body.subject.labels.en);
});

test('title years use the reader and structured-data date meaning', () => {
  const value = {
    time: '+2099-01-01T00:00:00Z',
    precision: 11,
    calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
  };
  for (const [content, year] of [
    [value, true],
    [{ ...value, time: '+2099-00-00T00:00:00Z', precision: 9 }, true],
    [{ ...value, time: '+2099-99-99T00:00:00Z' }, false],
    [{ ...value, precision: 12 }, false],
    [{ ...value, calendarmodel: 'http://www.wikidata.org/entity/Q1985786' }, false],
    [{ ...value, timezone: 60 }, false],
    [{ ...value, before: 1 }, false],
  ] as const) {
    const result = head(
      fixture({ statements: { 'schema:datePublished': [statement('schema:datePublished', 'time', content)] } }),
    );
    expect(meta(result, 'og:title')!.includes('2099')).toBe(year);
    expect(Object.hasOwn(JSON.parse(result.scripts[0]!.children), 'datePublished')).toBe(year);
  }
});
