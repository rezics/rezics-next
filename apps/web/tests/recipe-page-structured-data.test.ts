import { expect, test } from 'bun:test';
import { fromMarkdown, fromPlainText, normalizeDocument, withDocumentIds, checkDocument } from '@rezics/document';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { loadSubjectPage, SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import { serializeJsonLd, subjectJsonLd } from '../src/features/pages/jsonld.ts';

const id = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const diet = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02';
const hiddenDiet = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e03';
const minute = 'http://www.wikidata.org/entity/Q7727';
const value = (content: unknown) => ({ type: 'value', content });
const statement = (
  property: string,
  data_type: string,
  content: unknown,
  rank = 'normal',
  qualifiers: unknown[] = [],
) => ({
  id: crypto.randomUUID(),
  rank,
  property: { id: property, data_type },
  value: value(content),
  qualifiers,
  references: [],
});
const instruction = (language: string, document: unknown, rank = 'normal', qualifiers: unknown[] = []) =>
  statement('schema:recipeInstructions', 'document', { language, document }, rank, qualifiers);
const instructions = fromMarkdown(
  '## Prepare\n\n1. Rinse the rice.\n2. Add water.\n\n## Cook\n\nSimmer for 25 minutes.',
  'blocks',
);
const body = {
  subject: {
    id,
    type: 'schema:Recipe',
    labels: { en: 'Public rice', ja: '公開のご飯' },
    descriptions: {},
    aliases: {},
    statements: {
      'schema:cookTime': [statement('schema:cookTime', 'quantity', { amount: '+25', unit: minute })],
      'schema:recipeInstructions': [
        instruction('en', instructions),
        instruction('ja', fromPlainText('米を洗う。\n水を加える。')),
      ],
      'schema:suitableForDiet': [
        statement('schema:suitableForDiet', 'wikibase-item', diet),
        statement('schema:suitableForDiet', 'wikibase-item', hiddenDiet),
      ],
    },
  },
  related: {
    'schema:cookTime': { labels: { en: 'Cooking time' } },
    'schema:recipeInstructions': { labels: { en: 'Instructions' } },
    'schema:suitableForDiet': { labels: { en: 'Diet' } },
    [diet]: { labels: { en: 'Vegetarian' } },
  },
};
const build = (entries: unknown[], locale = 'en') =>
  subjectJsonLd({
    ...body,
    subject: { ...body.subject, statements: { 'schema:recipeInstructions': entries } },
    locale,
    url: 'https://rezics.com/en/subjects/rice',
  } as never);
const step = (text: string, inLanguage = 'en') => ({ '@type': 'HowToStep', text, inLanguage });
const expected = [
  {
    '@type': 'HowToSection',
    name: 'Prepare',
    inLanguage: 'en',
    itemListElement: [step('Rinse the rice.'), step('Add water.')],
  },
  { '@type': 'HowToSection', name: 'Cook', inLanguage: 'en', itemListElement: [step('Simmer for 25 minutes.')] },
];

test('nested lists, tasks and table cells keep exact reading order and authored leaf languages', () => {
  const paragraph = (text: string, lang?: string) => ({
    type: 'paragraph',
    ...(lang ? { attrs: { lang } } : {}),
    content: [{ type: 'text', text }],
  });
  const document = normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: withDocumentIds({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [
                paragraph('Prepare the rice.'),
                {
                  type: 'bulletList',
                  content: [{ type: 'listItem', content: [paragraph('米を洗う。', 'ja')] }],
                },
                paragraph('Then add water.'),
              ],
            },
          ],
        },
        {
          type: 'taskList',
          attrs: { lang: 'fr' },
          content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph('Laisser reposer.')] }],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [paragraph('Finish.')] },
                { type: 'tableCell', attrs: { lang: 'ja' }, content: [paragraph('盛り付ける。')] },
              ],
            },
          ],
        },
      ],
    }),
  });
  expect(checkDocument(document)).toBe(true);
  expect(build([instruction('en', document)]).recipeInstructions).toEqual([
    step('Prepare the rice.'),
    step('米を洗う。', 'ja'),
    step('Then add water.'),
    step('Laisser reposer.', 'fr'),
    step('Finish.'),
    step('盛り付ける。', 'ja'),
  ]);
});

test('a selected concealed language never falls back to a different public instruction body', () => {
  const concealed = [
    { property: { id: 'rezics:spoilerLevel', data_type: 'quantity' }, value: value({ amount: '+1', unit: '1' }) },
  ];
  const entries = [
    instruction('en', fromPlainText('Concealed English.'), 'normal', concealed),
    instruction('ja', fromPlainText('米を洗う。')),
  ];
  expect(build(entries, 'en')).not.toHaveProperty('recipeInstructions');
  expect(build(entries, 'ja').recipeInstructions).toEqual(step('米を洗う。', 'ja'));
});

test('validated documents preserve ordered sections, steps, source rank and selected language', () => {
  expect(checkDocument(instructions)).toBe(true);
  expect(build([instruction('en', instructions)]).recipeInstructions).toEqual(expected);
  expect(build(body.subject.statements['schema:recipeInstructions'], 'ja').recipeInstructions).toEqual([
    step('米を洗う。', 'ja'),
    step('水を加える。', 'ja'),
  ]);
  expect(
    build([
      instruction('en', fromPlainText('Normal omitted.')),
      instruction('en', fromPlainText('Preferred.'), 'preferred'),
    ]).recipeInstructions,
  ).toEqual(step('Preferred.'));
  expect(build([instruction('en', fromPlainText('Deprecated omitted.'), 'deprecated')])).not.toHaveProperty(
    'recipeInstructions',
  );
  expect(build([instruction('ja', fromPlainText('実際の日本語。'))], 'fr').recipeInstructions).toEqual(
    step('実際の日本語。', 'ja'),
  );
});

test('unknown, malformed, concealed documents and inline spoilers cannot disclose private branches', () => {
  for (const document of [
    { type: 'doc', content: [] },
    {},
    null,
    { ...instructions, version: 'future' },
    { ...instructions, doc: { type: 'doc', content: [{ type: 'script', text: 'private' }] } },
  ]) {
    expect(build([instruction('en', document)])).not.toHaveProperty('recipeInstructions');
  }
  for (const type of ['somevalue', 'novalue']) {
    const held = instruction('en', instructions);
    expect(build([{ ...held, value: { type } }])).not.toHaveProperty('recipeInstructions');
  }
  const concealed = [
    { property: { id: 'rezics:spoilerLevel', data_type: 'quantity' }, value: value({ amount: '+1', unit: '1' }) },
  ];
  expect(build([instruction('en', fromPlainText('Private statement.'), 'normal', concealed)])).not.toHaveProperty(
    'recipeInstructions',
  );
  const content = fromMarkdown(
    'Public >!private inline!< finish.\n\n>!entire private paragraph!<\n\n1. Visible step.\n2. >!private list step!<',
  );
  expect(build([instruction('en', content)]).recipeInstructions).toEqual([
    step('Public  finish.'),
    step('Visible step.'),
  ]);
  const hostile = '</script><script>alert(1)</script> & \u2028\u2029';
  const serialized = serializeJsonLd(build([instruction('en', fromPlainText(hostile))]));
  expect(serialized).not.toContain('<');
  expect(serialized).not.toContain('>');
  expect(serialized).not.toContain('&');
  expect(JSON.parse(serialized).recipeInstructions).toEqual(step(hostile));
});

test('document reading units publish only visible ruby, breaks, mention and extension fallback text', () => {
  const document = normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: withDocumentIds({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'ruby', attrs: { rt: 'annotation' }, content: [{ type: 'text', text: '米' }] },
            { type: 'hardBreak' },
            { type: 'mention', attrs: { accountId: diet } },
            {
              type: 'extensionInline',
              attrs: {
                definition: 'demo',
                version: '1',
                fallback: 'Visible fallback',
                payload: { secret: 'private payload' },
              },
            },
          ],
        },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rest.' }] }] },
      ],
    }),
  });
  expect(build([instruction('en', document)]).recipeInstructions).toEqual([
    step('米\n@Visible fallback'),
    step('Rest.'),
  ]);
  expect(JSON.stringify(build([instruction('en', document)]))).not.toContain('private payload');
});

const composition = {
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'header' } },
    {
      type: 'Statements',
      props: { id: 'facts', properties: ['schema:cookTime', 'schema:recipeInstructions', 'schema:suitableForDiet'] },
    },
  ],
} satisfies CompositionDocument;
const messages = {
  unknown: 'Unknown',
  none: 'None',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
};

test('the composed SubjectPage publishes the same read, visible Recipe facts and instruction order at fixed read cost', async () => {
  const plan = planReads(platformRegistry, composition, { subject: id });
  expect(Object.values(plan.reads).map((read) => read.kind)).toEqual(['subject']);
  for (const size of [0, 8, 64]) {
    const records = new Map<string, unknown>(
      Array.from({ length: size }, (_, i) => [crypto.randomUUID(), { private: `Unrelated ${i}` }]),
    );
    records.set(id, body);
    let reads = 0;
    const representation: SubjectPageData = {
      subject: id,
      profile: 'sha256:0',
      template: { scope: 'generic', key: null },
      document: composition as never,
      reads: Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: records.get(id) }])),
    };
    const client = createKernelClient('https://kernel.invalid', {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        reads++;
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toBe('/v1/pages:read');
        expect(await request.json()).toEqual({ target: { subject: id }, languages: ['en'] });
        return Response.json(representation);
      }) as typeof fetch,
    });
    const loaded = await loadSubjectPage(client, id);
    if (loaded.kind !== 'page') throw new Error(`Expected Recipe page, got ${loaded.kind}`);
    const page = loaded.page;
    expect(page.reads).toEqual(representation.reads);
    const html = renderToString(createElement(SubjectPage, { page, locale: 'en', messages }));
    const script = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html);
    expect(script).not.toBeNull();
    const jsonld = JSON.parse(script![1]!);
    expect(jsonld.cookTime).toBe('PT25M');
    expect(jsonld.recipeInstructions).toEqual(expected);
    expect(jsonld.suitableForDiet).toEqual({ '@id': `https://rezics.com/id/${diet}`, name: 'Vegetarian' });
    const visible = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
    expect(visible).toContain('Public rice');
    expect(visible).toContain('25');
    const rinse = visible.indexOf('Rinse the rice.');
    const water = visible.indexOf('Add water.');
    const simmer = visible.indexOf('Simmer for 25 minutes.');
    expect(rinse).toBeGreaterThan(-1);
    expect(water).toBeGreaterThan(rinse);
    expect(simmer).toBeGreaterThan(water);
    expect(visible).not.toContain('米を洗う。');
    // The page renders all disclosed related identities, including this unlabeled diet target.
    // It must not be promoted into Recipe schema.org diet data without a public ontology mapping.
    expect(JSON.stringify(jsonld)).not.toContain(hiddenDiet);
    expect(html).not.toContain('VegetarianDiet');
    expect(html).not.toContain('Unrelated');
    expect(reads).toBe(1);
    expect(records.size).toBe(size + 1);
    const japanese = renderToString(createElement(SubjectPage, { page, locale: 'ja', messages }));
    expect(japanese).toContain('米を洗う。');
    expect(japanese).not.toContain('Rinse the rice.');
  }
});

test('serialized instruction bytes grow only with supplied public text', () => {
  for (const size of [1, 8, 64]) {
    const text = 'Rice. '.repeat(size);
    const result = build([instruction('en', fromPlainText(text))]);
    expect(result.recipeInstructions).toEqual(step(text));
    const serialized = serializeJsonLd(result);
    expect(serialized.length - text.length).toBe(
      serializeJsonLd(build([instruction('en', fromPlainText('X'))])).length - 1,
    );
  }
});

test('an internal snapshot beside a public document reference cannot authorize publication', () => {
  const entry = instruction('en', id);
  const internal = {
    ...entry,
    value: value({ language: 'en', document: id, internal: { body: fromPlainText('Private internal document.') } }),
  };
  expect(build([internal])).not.toHaveProperty('recipeInstructions');
  expect(JSON.stringify(build([internal]))).not.toContain('Private internal document.');
  const unknownPreferred = { ...instruction('en', instructions, 'preferred'), value: { type: 'somevalue' } };
  expect(build([instruction('en', fromPlainText('Do not fall back.')), unknownPreferred])).not.toHaveProperty(
    'recipeInstructions',
  );
});

test('explicit block language survives and concealed page instructions stay out of its JSON-LD', () => {
  const document = normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: withDocumentIds({
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { lang: 'ja' }, content: [{ type: 'text', text: '米を洗う。' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Public ' },
            { type: 'text', text: 'concealed method', marks: [{ type: 'spoiler' }] },
            { type: 'text', text: ' finish.' },
          ],
        },
      ],
    }),
  });
  const publicBody = {
    ...body,
    subject: {
      ...body.subject,
      statements: { ...body.subject.statements, 'schema:recipeInstructions': [instruction('en', document)] },
    },
  };
  const plan = planReads(platformRegistry, composition, { subject: id });
  const page: SubjectPageData = {
    subject: id,
    profile: 'sha256:0',
    template: { scope: 'generic', key: null },
    document: composition as never,
    reads: Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: publicBody }])),
  };
  const html = renderToString(createElement(SubjectPage, { page, locale: 'en', messages }));
  const serialized = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)![1]!;
  expect(JSON.parse(serialized).recipeInstructions).toEqual([step('米を洗う。', 'ja'), step('Public  finish.')]);
  expect(serialized).not.toContain('concealed method');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('lang="ja"');
});
