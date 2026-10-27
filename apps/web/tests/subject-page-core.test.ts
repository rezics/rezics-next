import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { fromMarkdown } from '@rezics/document';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import platform from '@rezics/composition/profiles/platform.json';
import { SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import type { PageMessages } from '../src/features/pages/data.tsx';

const subjectId = '01a1740d-7480-71e4-841f-66c04022d7d0';
const authorId = '01a1740d-7480-71e4-841f-66c04022d7d1';
const mediaId = '01a1740d-7480-71e4-841f-66c04022d7e0';
const otherMediaId = '01a1740d-7480-71e4-841f-66c04022d7e1';
const context = '00000000-0000-8000-8000-000000000000';
const value = (content: unknown) => ({ type: 'value', content });
const snak = (property: string, dataType: string, snakValue: unknown) => ({
  property: { id: property, data_type: dataType },
  value: snakValue,
});
let statementCount = 0;
const statement = (property: string, dataType: string, statementValue: unknown, extra: object = {}) => ({
  id: `01a1740d-7480-71e4-841f-${String(++statementCount).padStart(12, '0')}`,
  rank: 'normal',
  ...snak(property, dataType, statementValue),
  qualifiers: [],
  references: [],
  rezics: { release: 'sha256:0', revision: 1 },
  ...extra,
});
const spoiler = (level: number) => snak('rezics:spoilerLevel', 'quantity', value({ amount: `+${level}`, unit: '1' }));
const document = (text: string) => ({ language: 'en', document: fromMarkdown(text, 'text') });
const cover = {
  media: mediaId,
  width: 800,
  height: 1200,
  placeholder: { thumbhash: '3PcNNYSFeXh/b3eQa1p4iHaQeYD3/3gAAA==', color: '#6b4a33' },
  variants: [
    { format: 'webp' as const, width: 240 },
    { format: 'webp' as const, width: 480 },
  ],
  focalPoint: null,
  credit: { rightsHolder: 'Reynal & Hitchcock', via: { name: 'Open Library', url: 'https://openlibrary.org/' } },
};
const summary = (types: string[], withCover: typeof cover | null = cover) => ({
  id: subjectId,
  type: types[0]!,
  types,
  label: { value: 'The Little Prince', language: 'en' },
  creativeWork: true,
  cover: withCover,
});

const names = {
  [authorId]: { en: 'Antoine de Saint-Exupéry' },
  'schema:author': { en: 'Author' },
  'schema:datePublished': { en: 'Published' },
  'schema:inLanguage': { en: 'Language' },
  'schema:abstract': { en: 'Abstract' },
  'schema:image': { en: 'Image' },
  'schema:isbn': { en: 'ISBN' },
  'schema:genre': { en: 'Genre' },
  'schema:keywords': { en: 'Keywords' },
  'rezics:spoilerLevel': { en: 'spoiler level' },
  'rezics:role': { en: 'Role' },
};

function subject(statements: ReturnType<typeof statement>[], extra: Record<string, unknown> = {}) {
  const grouped: Record<string, ReturnType<typeof statement>[]> = {};
  for (const entry of statements) (grouped[entry.property.id] ??= []).push(entry);
  return {
    id: subjectId,
    type: 'schema:Book',
    revision: 1,
    release: 'sha256:0',
    context,
    resolution: {},
    labels: { en: 'The Little Prince', fr: 'Le Petit Prince', 'zh-Hant': '小王子' },
    descriptions: {},
    aliases: {},
    statements: grouped,
    ...extra,
  };
}

// The work overview with the facts of its Details view before Sources, so one render shows every property.
const work = (
  platform.bases.find(({ base }) => base === 'schema:CreativeWork') as unknown as {
    views: { overview: CompositionDocument };
  }
).views.overview;
const workWithFacts: CompositionDocument = {
  ...work,
  content: [
    ...work.content.slice(0, -1),
    { type: 'MoreStatements', props: { id: 'more-statements' } },
    ...work.content.slice(-1),
  ],
};

function pageOf(
  read: { subject: ReturnType<typeof subject>; summary?: unknown },
  template: CompositionDocument = workWithFacts,
): SubjectPageData {
  const reads: SubjectPageData['reads'] = {};
  for (const [key, planned] of Object.entries(planReads(platformRegistry, template, { subject: subjectId }).reads))
    reads[key] =
      planned.kind === 'subject'
        ? {
            status: 200,
            body: {
              related: Object.fromEntries(Object.entries(names).map(([id, label]) => [id, { labels: label }])),
              summary: null,
              ...read,
            },
          }
        : planned.kind === 'links'
          ? { status: 200, body: { links: [], count: { value: 0, exact: true }, next: null } }
          : planned.kind === 'collections'
            ? { status: 200, body: { collections: [], count: { value: 0, exact: true }, next: null } }
            : { status: 200, body: { subjects: [], total: { value: 0, relation: 'exact' }, next: null, as_of: '' } };
  return {
    subject: subjectId,
    profile: 'sha256:0',
    template: { scope: 'base', key: 'schema:CreativeWork' },
    document: template as never,
    reads,
  };
}

const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
  search: 'Search',
};
const render = (page: SubjectPageData, locale = 'en', props: Record<string, unknown> = {}) =>
  renderToString(createElement(SubjectPage, { page, locale, messages, renderJsonLd: false, ...props } as never));
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const tag = (html: string, pattern: RegExp) => pattern.exec(html)?.[0] ?? '';
const languageIn = (code: string, locale: string) => new Intl.DisplayNames([locale], { type: 'language' }).of(code)!;
const datePublished = statement(
  'schema:datePublished',
  'time',
  value({ time: '+1943-04-06T00:00:00Z', precision: 11, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' }),
);

test("the subject header shows the cover at the type's ratio, the title in the reader's language with the original beside it, type, date and principal creators", () => {
  const read = {
    subject: subject([
      statement('schema:author', 'wikibase-item', value(authorId)),
      statement('schema:inLanguage', 'string', value('fr')),
      datePublished,
    ]),
    summary: summary(['schema:Book', 'schema:CreativeWork', 'schema:Thing']),
  };
  const html = render(pageOf(read), 'en', { typeLabel: 'book' });
  // The cover is the page's own: large, eager, at the book frame.
  const frame = tag(html, /<div[^>]*data-slot="cover"[^>]*data-size="lg"[^>]*>/);
  expect(frame).toContain('data-ratio="5:7"');
  expect(html).toMatch(/<img[^>]*fetchpriority="high"[^>]*>/i);
  expect(html).toContain(`/media/${mediaId}/webp-480 480w`);
  // A phone gets a thumbnail beside the title instead.
  expect(html).toMatch(/data-slot="cover"[^>]*data-size="sm"/);
  // The title in the reader's language, the original language's title quietly beside it.
  expect(html).toMatch(/<h1[^>]*>The Little Prince<\/h1>/);
  const original = tag(html, /<[a-z]+[^>]*lang="fr"[^>]*>Le Petit Prince<\/[a-z]+>/);
  expect(original).not.toBe('');
  expect(html.indexOf(original)).toBeGreaterThan(html.indexOf('</h1>'));
  expect(html.indexOf(original)).toBeLessThan(html.indexOf('<dt'));
  // Type and date in the reader's words.
  const header = html.slice(0, html.indexOf('<dt'));
  expect(text(header)).toContain('book');
  expect(text(header)).toContain('April 6, 1943');
  expect(text(header)).not.toContain('schema:Book');
  // The principal creator is linked from the header, before any fact row.
  expect(header).toMatch(new RegExp(`href="/en/subjects/${authorId}"[^>]*>Antoine de Saint-Exupéry</a>`));

  // The frame follows the subject's type: a character is a 3:4 portrait, a recipe 4:3.
  const character = render(
    pageOf({
      subject: subject([], { type: 'wd:Q95074' }),
      summary: summary(['wd:Q95074', 'schema:Thing'], null),
    }),
  );
  expect(character).toMatch(/data-ratio="3:4"[^>]*/);
  expect(character).not.toContain('data-ratio="5:7"');
  // The definition release's own ratio wins over the table.
  expect(render(pageOf(read), 'en', { ratio: '1:1' })).toContain('data-ratio="1:1"');
  // A subject with no cover summary still draws the frame with its placeholder.
  const bare = render(pageOf({ subject: subject([]), summary: null }));
  expect(bare).toMatch(/data-slot="cover"[^>]*data-state="placeholder"/);
  expect(bare).toMatch(/<h1[^>]*>The Little Prince<\/h1>/);

  // A language the page does not offer is named, in the reader's words, next to its text.
  const traditional = pageOf({
    subject: subject([statement('schema:inLanguage', 'string', value('fr'))], {
      labels: { 'zh-Hant': '小王子' },
    }),
    summary: null,
  });
  const chinese = render(traditional, 'zh-Hans');
  expect(chinese).toMatch(/<h1[^>]*lang="zh-Hant"[^>]*>小王子<\/h1>/);
  expect(text(chinese)).toContain(languageIn('zh-Hant', 'zh-Hans'));
  // The reader's own language carries no tag.
  expect(text(render(pageOf(read), 'en'))).not.toContain(languageIn('en', 'en') + ' ');
  // A language value is a name, never a code.
  const french = render(pageOf({ subject: subject([statement('schema:inLanguage', 'string', value('fr'))]) }), 'en');
  expect(text(french)).toContain(languageIn('fr', 'en'));
  expect(french).not.toMatch(/>fr</);
});

test("the cover's credit is a caption at lg and listed again in Sources at the end of the overview", () => {
  const referenced = statement('schema:isbn', 'external-id', value('978-0156012195'), {
    references: [{ parts: [snak('schema:url', 'url', value('https://example.com/isbn'))], hash: 'a' }],
  });
  const html = render(
    pageOf({
      subject: subject([referenced]),
      summary: summary(['schema:Book', 'schema:CreativeWork']),
    }),
  );
  const caption = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(html);
  expect(caption).not.toBeNull();
  expect(text(caption![1]!)).toContain('© Reynal & Hitchcock');
  expect(caption![1]).toContain('href="https://openlibrary.org/"');
  // The caption belongs to the large cover; the thumbnail has none.
  expect(html.match(/<figcaption/g)).toHaveLength(1);

  // Sources close the overview, after every fact row, and list the credit, the fact's source and the identifier.
  const sources = html.lastIndexOf('Sources');
  expect(sources).toBeGreaterThan(html.lastIndexOf('</dl>'));
  const section = html.slice(html.lastIndexOf('<section', sources));
  expect(text(section)).toContain('© Reynal & Hitchcock');
  expect(section).toContain('href="https://openlibrary.org/"');
  expect(section).toContain('href="https://example.com/isbn"');
  expect(text(section)).toContain('978-0156012195');
  expect(section).toContain(`href="/en/subjects/${subjectId}/details"`);
  // A source is listed once, not under its fact as well.
  expect(html.match(/href="https:\/\/example\.com\/isbn"/g)).toHaveLength(1);

  // Without a cover credit or sources, there is nothing to list but the way to Details.
  const plain = render(pageOf({ subject: subject([]), summary: null }));
  expect(plain).not.toContain('<figcaption');
  expect(plain).toContain(`href="/en/subjects/${subjectId}/details"`);
});

test('a media value renders through Cover and a document value through the document renderer, never as an id or an empty row', () => {
  const read = {
    subject: subject([
      statement('schema:image', 'media', value(mediaId)),
      statement('schema:image', 'media', value(otherMediaId)),
      statement('schema:abstract', 'document', value(document('A pilot meets a prince.'))),
      statement('schema:keywords', 'string', value('')),
    ]),
    summary: summary(['schema:Book', 'schema:CreativeWork']),
  };
  const html = render(pageOf(read));
  // The summary's own cover is the header's; the other image is a Cover too, with its placeholder.
  expect(html).not.toContain(otherMediaId);
  expect(html).not.toContain(`>${mediaId}<`);
  const frames = html.match(/data-slot="cover"/g) ?? [];
  expect(frames.length).toBe(3);
  expect(html).toMatch(/<dt[^>]*>Image<\/dt>/);
  expect(html).toMatch(/<dd[^>]*>(?:(?!<\/dd>)[\s\S])*data-slot="cover"/);
  // The abstract is the document's paragraphs, not an empty labelled row.
  expect(html).toMatch(/<dt[^>]*>Abstract<\/dt>/);
  expect(html).toMatch(/<p[^>]*>A pilot meets a prince\.<\/p>/);

  // An image that is only the header's cover leaves no empty row behind.
  const only = render(
    pageOf({
      subject: subject([statement('schema:image', 'media', value(mediaId))]),
      summary: summary(['schema:Book', 'schema:CreativeWork']),
    }),
  );
  expect(only).not.toMatch(/<dt[^>]*>Image<\/dt>/);
  // A value the page cannot present is left out of the reading view.
  const unreadable = render(
    pageOf({
      subject: subject([statement('schema:abstract', 'document', value({ language: 'en', document: { doc: 1 } }))]),
    }),
  );
  expect(unreadable).not.toMatch(/<dt[^>]*>Abstract<\/dt>/);

  // The summary shown is the reader's language, with the language named when it is not theirs.
  const abstracts = pageOf({
    subject: subject([
      statement('schema:abstract', 'document', value({ language: 'zh-Hant', document: fromMarkdown('王子', 'text') })),
      statement('schema:abstract', 'document', value({ language: 'en', document: fromMarkdown('A prince', 'text') })),
    ]),
  });
  const simplified = render(abstracts, 'zh-Hans');
  expect(simplified).toMatch(/lang="zh-Hant"/);
  expect(simplified).toContain('王子');
  expect(simplified).not.toContain('A prince');
  expect(text(simplified)).toContain(languageIn('zh-Hant', 'zh-Hans'));
  const english = render(abstracts, 'en');
  expect(english).toContain('A prince');
  expect(english).not.toContain('王子');
});

test("a value or entry above the reader's spoiler level is hidden behind a reveal control, and the spoiler level is not printed as a qualifier", () => {
  const read = {
    subject: subject([
      statement('schema:genre', 'string', value('open-ending'), { qualifiers: [spoiler(0)] }),
      statement('schema:genre', 'string', value('minor-twist'), {
        qualifiers: [spoiler(1), snak('rezics:role', 'string', value('plot'))],
      }),
      statement('schema:genre', 'string', value('major-twist'), { qualifiers: [spoiler(2)] }),
      statement('schema:keywords', 'string', value('plain')),
    ]),
  };
  const render0 = (reader?: { spoilerLevel: 0 | 1 | 2; suitability: 'blur' | 'show' }) =>
    render(pageOf(read), 'en', reader ? { reader } : {});
  const hidden = render0();
  // The default reader sees level 0 only; the rest sits behind a control, absent from the page until opened.
  expect(hidden).toContain('open-ending');
  expect(hidden).not.toContain('minor-twist');
  expect(hidden).not.toContain('major-twist');
  expect(hidden).toContain('plain');
  const controls = hidden.match(/<button[^>]*aria-expanded="false"[^>]*>/g) ?? [];
  expect(controls).toHaveLength(2);
  expect(hidden.match(/Show spoiler/g)?.length).toBeGreaterThanOrEqual(2);

  const minor = render0({ spoilerLevel: 1, suitability: 'blur' });
  expect(minor).toContain('minor-twist');
  expect(minor).not.toContain('major-twist');
  expect(minor.match(/<button[^>]*aria-expanded="false"[^>]*>/g)).toHaveLength(1);

  const all = render0({ spoilerLevel: 2, suitability: 'show' });
  expect(all).toContain('major-twist');
  expect(all).not.toMatch(/<button[^>]*aria-expanded="false"[^>]*>/);

  // The level is a gate, not a fact: no qualifier row names it or prints its number. Other qualifiers stay.
  for (const html of [hidden, minor, all]) {
    expect(text(html)).not.toMatch(/spoiler level/i);
    expect(html).not.toContain('+1');
    expect(html).not.toContain('+2');
  }
  expect(text(minor)).toMatch(/Role plot/);

  // The reader's suitability setting goes to every cover on the page.
  const withheld = pageOf({
    subject: subject([]),
    summary: summary(['schema:Book', 'schema:CreativeWork'], { ...cover, withheld: 'suitability' } as never),
  });
  expect(render(withheld)).toMatch(/data-slot="cover"[^>]*data-state="withheld"/);
  expect(render(withheld, 'en', { reader: { spoilerLevel: 0, suitability: 'show' } })).not.toContain(
    'data-state="withheld"',
  );
});
