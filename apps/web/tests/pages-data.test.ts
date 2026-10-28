import { expect, test } from 'bun:test';
import { slug } from '@rezics/definitions/slug';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { dataComponents, PageData, SubjectSources, type PageMessages } from '../src/features/pages/data.tsx';
import { layoutComponents, pageDefinitions, PageRoot } from '../src/features/pages/layout.tsx';
import { CompositionRender } from '../src/features/pages/render.tsx';

const subjectId = '01a1740d-7480-71e4-841f-66c04022d7d0';
const author = '01a1740d-7480-71e4-841f-66c04022d7d1';
const work = '01a1740d-7480-71e4-841f-66c04022d7d2';
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
const source = (url: string) => ({ parts: [snak('schema:url', 'url', value(url))], hash: url });
const read = {
  subject: {
    id: subjectId,
    type: 'schema:Book',
    revision: 1,
    release: 'sha256:0',
    context: '00000000-0000-8000-8000-000000000000',
    resolution: {},
    labels: { en: 'The Little Prince', fr: 'Le Petit Prince', ja: '星の王子さま' },
    descriptions: { en: 'A novella' },
    aliases: { fr: ['Le Petit Prince illustré'] },
    statements: {
      'schema:author': [
        statement('schema:author', 'wikibase-item', value(author), {
          qualifiers: [snak('rezics:role', 'wikibase-item', { type: 'novalue' })],
          references: [source('https://example.com/a'), source('https://example.com/a')],
        }),
      ],
      'schema:numberOfPages': [statement('schema:numberOfPages', 'quantity', value({ amount: '+1096', unit: '1' }))],
      'schema:isbn': [
        statement('schema:isbn', 'external-id', value('978-0156012195')),
        statement('schema:isbn', 'external-id', value('000-old'), { rank: 'deprecated' }),
      ],
      'schema:illustrator': [statement('schema:illustrator', 'wikibase-item', { type: 'somevalue' })],
      'schema:datePublished': [
        statement('schema:datePublished', 'time', value({ time: '+1943-04-06T00:00:00Z', precision: 9 })),
      ],
      'schema:url': [statement('schema:url', 'url', value('javascript:alert(1)'))],
    },
  },
  related: {
    [author]: { labels: { en: 'Antoine de <Saint-Exupéry>' } },
    'schema:author': { labels: { en: 'Author', fr: 'Auteur' } },
    'schema:numberOfPages': { labels: { en: 'Pages' } },
    'schema:isbn': { labels: { en: 'ISBN' } },
    'schema:illustrator': { labels: { en: 'Illustrator' } },
    'schema:datePublished': { labels: { en: 'Published' } },
    'schema:url': { labels: { en: 'Website' } },
    'rezics:role': { labels: { en: 'Role' } },
  },
};
// A subject list reads the inverse links; the kernel names each holder in the reader's language.
const list = {
  links: [
    {
      subject: work,
      property: 'schema:author',
      statement: '01a1740d-7480-71e4-841f-66c04022d7f2',
      type: 'schema:Book',
      label: 'Vol de nuit',
      summary: null,
    },
  ],
  count: { value: 1, exact: true },
  next: null,
};
const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
};
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const document = {
  root: { props: {} },
  content: [
    node('SubjectHeader', 'header'),
    node('Summary', 'about'),
    node('Statements', 'facts', { properties: ['schema:author', 'schema:numberOfPages', 'schema:genre'] }),
    node('MoreStatements', 'more'),
    node('SubjectList', 'works', { title: { en: 'Works', fr: 'Œuvres' }, property: 'schema:author', limit: 6 }),
    node('Heading', 'end', { text: { en: 'The end', fr: 'Fin' }, level: 2 }),
  ],
};
const render = (locale: string, reads: Record<string, { status: number; body: unknown }>) =>
  renderToString(
    createElement(
      PageData,
      { locale, subject: subjectId, document, reads, messages } as never,
      createElement(CompositionRender, {
        document,
        definitions: pageDefinitions,
        components: { ...layoutComponents, ...dataComponents },
        root: PageRoot,
      } as never),
    ),
  );
const ok = { r0: { status: 200, body: read }, r1: { status: 200, body: list } };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test("data components render the subject read in the reader's locale", () => {
  const html = render('fr', ok);
  expect(html).toMatch(/<h1[^>]*>Le Petit Prince<\/h1>/);
  expect(html).toMatch(/<p[^>]*lang="en"[^>]*>A novella<\/p>/);
  expect(text(html)).toContain('Le Petit Prince illustré');
  expect(html).toMatch(/<dt[^>]*>Auteur<\/dt>/);
  expect(html).toMatch(
    new RegExp(
      `href="/fr/subjects/${author}/${slug('Antoine de <Saint-Exupéry>')}"[^>]*>Antoine de &lt;Saint-Exupéry&gt;</a>`,
    ),
  );
  expect(text(html)).toMatch(/Role No value/);
  expect(text(html)).toMatch(/Pages 1\s?096/);
  expect(text(html)).toContain('978-0156012195');
  expect(html).not.toContain('000-old');
  expect(text(html)).toMatch(/Illustrator Unknown value/);
  expect(text(html)).toMatch(/Published 1943/);
  // A fact's sources are listed once, in the Sources section, not under the fact.
  expect(html).not.toContain('https://example.com/a');
  const sources = renderToString(
    createElement(
      PageData,
      { locale: 'fr', subject: subjectId, document, reads: ok, messages } as never,
      createElement(SubjectSources),
    ),
  );
  expect(sources.match(/href="https:\/\/example\.com\/a"/g)).toHaveLength(1);
  // The author is linked from the header and from the fact row.
  expect(
    html.match(new RegExp(`href="/fr/subjects/${author}/${slug('Antoine de <Saint-Exupéry>')}"`, 'g')),
  ).toHaveLength(2);
  const order = ['Auteur', 'Pages', 'ISBN', 'Illustrator', 'Published', 'Œuvres', 'Fin'].map((needle) =>
    html.indexOf(needle),
  );
  expect(order.every((position, index) => position > 0 && (index === 0 || position > order[index - 1]!))).toBe(true);
  expect(html).toMatch(new RegExp(`href="/fr/subjects/${work}/${slug('Vol de nuit')}"[^>]*>Vol de nuit</a>`));
  const english = render('en', ok);
  expect(english).toMatch(/<h1[^>]*>The Little Prince<\/h1>/);
  expect(english).toMatch(/<dt[^>]*>Author<\/dt>/);
  expect(text(english)).toContain('The end');
});

test('a failed read says so under its heading and an empty one leaves its component out', () => {
  const failed = render('fr', {
    r0: { status: 404, body: { code: 'not_found' } },
    r1: { status: 503, body: { code: 'index_not_ready' } },
  });
  expect(failed).not.toMatch(/<h1/);
  // A list whose read failed says so with a retry instead of silently vanishing.
  expect(failed).toMatch(/data-slot="subject-list" data-state="failed"/);
  // The list names its failed section with a retry; the header and the facts, whose read also failed, are left out.
  expect(failed).toContain('data-state="failed"');
  expect(failed).toContain('Œuvres');
  expect(failed).not.toContain('Auteur');
  expect(failed).toContain('Fin');
  const empty = render('fr', {
    r0: { status: 200, body: { ...read, subject: { ...read.subject, statements: {} } } },
    r1: { status: 200, body: { ...list, links: [] } },
  });
  expect(empty).toMatch(/<h1[^>]*>Le Petit Prince<\/h1>/);
  expect(empty).not.toContain('Auteur');
  expect(empty).not.toContain('ISBN');
  expect(empty).not.toContain('Œuvres');
  expect(render('fr', {})).not.toMatch(/<h1/);
});

test('values are text and links stay safe', () => {
  const html = render('fr', ok);
  expect(html).not.toMatch(/href="javascript:/);
  expect(text(html)).toContain('javascript:alert(1)');
  expect(html).not.toContain('<Saint-Exupéry>');
  const linked = renderToString(
    createElement(
      PageData,
      {
        locale: 'ja',
        subject: subjectId,
        document,
        reads: ok,
        messages,
        link: ({ href, lang, children }: { href: string; lang?: string; children: unknown }) =>
          createElement('a', { href, lang, 'data-router': 'yes' }, children as never),
      } as never,
      createElement(CompositionRender, {
        document,
        definitions: pageDefinitions,
        components: { ...layoutComponents, ...dataComponents },
        root: PageRoot,
      } as never),
    ),
  );
  expect(linked).toMatch(new RegExp(`<a href="/ja/subjects/${work}/${slug('Vol de nuit')}"[^>]*data-router="yes"`));
  expect(linked).toMatch(/<h1[^>]*>星の王子さま<\/h1>/);
  expect(linked).toMatch(/>Vol de nuit</);
});
