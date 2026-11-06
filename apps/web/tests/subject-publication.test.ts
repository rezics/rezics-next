import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import type { Stmt } from '../src/features/pages/shared';
import type { Related, Subject } from '../src/subject/types';
import { defaultReader } from '../src/subject/reader';
import recorded from '../src/kernel/recorded/subject-page.json';

mock.module('cloudflare:workers', () => ({ env: {} }));
type SubjectPageData = import('../src/features/pages/subject').SubjectPageData;
const { recipePublicationReading } = await import('../src/features/pages/recipe-publication/model');
const { releasePublicationReading } = await import('../src/features/pages/release-publication/model');
const { gamePublicationReading } = await import('../src/features/pages/game-publication/model');
const { agentPublicationReading } = await import('../src/features/pages/agent-publication/model');
const { literarySelected } = await import('../src/features/catalogue/literary-reader/model');
const { publicationPropertiesFor, publicPublicationStatements, relatedSameAs, subjectPublicationFields } =
  await import('../src/features/pages/subject-metadata');
const { gamePageInitial, subjectPageJsonLd } = await import('../src/features/pages/subject');
const { PublicationOverlayView } = await import('../src/features/pages/data');

const diet = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const platform = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e21';
const instructionId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e12';
const documentId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e13';
const digest = 'a'.repeat(64);
const minute = 'http://www.wikidata.org/entity/Q7727';
const definitions = { types: bundledRelease.types, properties: bundledRelease.properties };

const statement = (property: string, dataType: string, content: unknown, extras: Partial<Stmt> = {}): Stmt => ({
  id: extras.id ?? '0494501a-36af-8cc7-95c9-d7ffe4728299',
  rank: extras.rank ?? 'normal',
  property: { id: property, data_type: dataType },
  value: extras.value ?? { type: 'value', content },
  qualifiers: extras.qualifiers ?? [],
  references: extras.references ?? [],
});

function recipeSubject(statements: Record<string, Stmt[]>): Subject {
  return {
    ...(recorded.reads.r0.body.subject as Subject),
    type: 'schema:Recipe',
    labels: { en: 'Garden Lantern Soup' },
    descriptions: { en: 'A quick vegetarian soup.' },
    aliases: {},
    statements,
  };
}

const recipeDocuments = {
  [instructionId]: {
    id: documentId,
    subjectId: recorded.subject,
    candidateId: instructionId,
    digest,
    language: 'en',
    availability: 'available',
    body: fromPlainText('Chop the carrots.\nSimmer until tender.'),
  },
};

const recipeRelated = {
  [diet]: { type: 'skos:Concept', labels: { en: 'VegetarianDiet' }, sameAs: 'https://schema.org/VegetarianDiet' },
} as Related;

test('released Recipe overlay projects cook time, diet, ingredients and instructions from the current page', () => {
  const subject = recipeSubject({
    'schema:cookTime': [statement('schema:cookTime', 'quantity', { amount: '+25', unit: minute })],
    'schema:suitableForDiet': [statement('schema:suitableForDiet', 'wikibase-item', diet)],
    'schema:recipeIngredient': [
      statement('schema:recipeIngredient', 'monolingualtext', { language: 'en', text: '2 carrots' }),
    ],
    'schema:recipeInstructions': [
      statement(
        'schema:recipeInstructions',
        'document',
        { language: 'en', document: documentId, digest },
        { id: instructionId },
      ),
    ],
  });
  expect(publicationPropertiesFor('schema:Recipe', definitions)).toEqual([
    'schema:cookTime',
    'schema:suitableForDiet',
    'schema:recipeIngredient',
    'schema:recipeInstructions',
  ]);
  expect(subjectPublicationFields(subject, definitions, undefined, 'en').map((field) => field.property)).toEqual([
    'schema:cookTime',
    'schema:suitableForDiet',
    'schema:recipeIngredient',
    'schema:recipeInstructions',
  ]);
  const reading = recipePublicationReading(subject, definitions, 'en');
  expect(reading?.fields.map((field) => field.property)).toEqual([
    'schema:cookTime',
    'schema:suitableForDiet',
    'schema:recipeIngredient',
    'schema:recipeInstructions',
  ]);
  expect(relatedSameAs(recipeRelated[diet])).toBe('https://schema.org/VegetarianDiet');
  const html = renderToString(
    createElement(PublicationOverlayView, {
      reading: { kind: 'recipe', fields: reading!.fields },
      subject,
      related: recipeRelated,
      documents: recipeDocuments,
      locale: 'en',
    }),
  );
  expect(html).toContain('data-slot="recipe-publication"');
  expect(html).toContain('VegetarianDiet');
  expect(html).toContain('2 carrots');
  expect(html).toContain('Chop the carrots.');
  expect(html.replaceAll('<!-- -->', '')).toMatch(/25\s*min/i);
});

test('withheld Recipe diet stays out of the overlay and JSON-LD keeps hydrated instruction documents', () => {
  const hidden = statement('schema:suitableForDiet', 'wikibase-item', diet, {
    qualifiers: [
      {
        property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
        value: { type: 'value', content: { amount: '+1', unit: '1' } },
      },
    ],
  });
  const subject = recipeSubject({
    'schema:suitableForDiet': [hidden],
    'schema:recipeInstructions': [
      statement(
        'schema:recipeInstructions',
        'document',
        { language: 'en', document: documentId, digest },
        { id: instructionId },
      ),
    ],
  });
  expect(publicPublicationStatements(subject, 'schema:suitableForDiet')).toEqual([]);
  expect(recipePublicationReading(subject, definitions, 'en')?.fields.map((field) => field.property)).toEqual([
    'schema:recipeInstructions',
  ]);
  const page = structuredClone(recorded) as SubjectPageData;
  page.reads.r0.body.subject = subject;
  page.reads.r0.body.related = recipeRelated;
  page.reads.r0.body.documents = recipeDocuments;
  page.catalogue = {
    state: 'released',
    type: 'schema:Recipe',
    digest: bundledDigest,
    definitions,
  };
  const json = JSON.parse(subjectPageJsonLd(page, 'en', { origin: 'https://public.example.test' })!);
  expect(json).not.toHaveProperty('suitableForDiet');
  expect(JSON.stringify(json.recipeInstructions)).toContain('Chop the carrots.');
});

test('software-release overlay publishes platform, date and language from the current page', () => {
  const subject = {
    ...(recorded.reads.r0.body.subject as Subject),
    type: 'wd:Q20631656',
    labels: { en: 'Lantern Voyage Switch Release' },
    statements: {
      'schema:gamePlatform': [statement('schema:gamePlatform', 'wikibase-item', platform)],
      'schema:datePublished': [
        statement('schema:datePublished', 'time', {
          time: '+2025-03-04T00:00:00Z',
          precision: 11,
          calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
        }),
      ],
      'schema:inLanguage': [statement('schema:inLanguage', 'string', 'ja')],
    },
  };
  expect(releasePublicationReading(subject, definitions, 'en')?.fields.map((field) => field.property)).toEqual([
    'schema:gamePlatform',
    'schema:datePublished',
    'schema:inLanguage',
  ]);
  const html = renderToString(
    createElement(PublicationOverlayView, {
      reading: { kind: 'release', fields: releasePublicationReading(subject, definitions, 'en')!.fields },
      subject,
      related: { [platform]: { type: 'skos:Concept', labels: { en: 'Nintendo Switch' } } },
      locale: 'en',
    }),
  );
  expect(html).toContain('data-slot="release-publication"');
  expect(html).toContain('Nintendo Switch');
  expect(html).toContain('2025-03-04');
});

test('released Game overlay and reader seed publish platform from the current page without edition fetch', () => {
  const subject = {
    ...(recorded.reads.r0.body.subject as Subject),
    type: 'schema:VideoGame',
    labels: { en: 'Lantern Voyage' },
    statements: {
      'schema:gamePlatform': [statement('schema:gamePlatform', 'wikibase-item', platform)],
    },
  };
  expect(publicationPropertiesFor('schema:VideoGame', definitions)).toEqual(['schema:gamePlatform']);
  expect(gamePublicationReading(subject, definitions, 'en')?.fields.map((field) => field.property)).toEqual([
    'schema:gamePlatform',
  ]);
  const html = renderToString(
    createElement(PublicationOverlayView, {
      reading: { kind: 'game', fields: gamePublicationReading(subject, definitions, 'en')!.fields },
      subject,
      related: { [platform]: { type: 'skos:Concept', labels: { en: 'Nintendo Switch' } } },
      locale: 'en',
    }),
  );
  expect(html).toContain('data-slot="game-publication"');
  expect(html).toContain('Nintendo Switch');
  const initial = gamePageInitial(
    subject,
    { [platform]: { type: 'skos:Concept', labels: { en: 'Nintendo Switch' } } },
    undefined,
    definitions,
    bundledDigest,
    'en',
  );
  expect(initial?.ok).toBe(true);
  if (!initial?.ok) throw new Error('expected a ready game publication seed');
  expect(initial.editionsAdmitted).toBe(false);
  expect(initial.editions).toEqual([]);
  expect(initial.caughtUp).toBe(true);
  expect(initial.groups.some((group) => group.fields.some((field) => field.property === 'schema:gamePlatform'))).toBe(
    true,
  );
});

test('automated agent overlay publishes sameAs and omits withheld identity links', () => {
  const hidden = 'https://secret.invalid/private';
  const subject = {
    ...(recorded.reads.r0.body.subject as Subject),
    type: 'schema:SoftwareApplication',
    labels: { en: 'Lantern Reader' },
    statements: {
      'schema:sameAs': [
        statement('schema:sameAs', 'url', 'https://wikidata.org/entity/Q1'),
        statement('schema:sameAs', 'url', hidden, {
          qualifiers: [
            {
              property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
              value: { type: 'value', content: { amount: '+1', unit: '1' } },
            },
          ],
        }),
      ],
      'schema:url': [statement('schema:url', 'url', 'https://lantern.example.test/')],
    },
  };
  expect(publicationPropertiesFor('schema:SoftwareApplication', definitions)).toEqual(['schema:sameAs', 'schema:url']);
  expect(agentPublicationReading(subject, definitions, 'en')?.fields.map((field) => field.property)).toEqual([
    'schema:sameAs',
    'schema:url',
  ]);
  const html = renderToString(
    createElement(PublicationOverlayView, {
      reading: { kind: 'agent', fields: agentPublicationReading(subject, definitions, 'en')!.fields },
      subject,
      related: {},
      locale: 'en',
    }),
  );
  expect(html).toContain('data-slot="agent-publication"');
  expect(html).toContain('https://wikidata.org/entity/Q1');
  expect(html).toContain('https://lantern.example.test/');
  expect(html).not.toContain(hidden);
});

test('released Book form, word count and tag agree in JSON-LD and withheld author stays out', () => {
  const form = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e31';
  const tag = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e32';
  const hiddenAuthor = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e33';
  const page = structuredClone(recorded) as SubjectPageData;
  page.reads.r0.body.subject = {
    ...(recorded.reads.r0.body.subject as Subject),
    type: 'schema:Book',
    labels: { en: 'Lantern Archive' },
    descriptions: { en: 'A journey through a lantern library.' },
    statements: {
      'schema:wordCount': [statement('schema:wordCount', 'quantity', { amount: '+1200001', unit: '1' })],
      'wdt:P7937': [statement('wdt:P7937', 'wikibase-item', form)],
      'schema:keywords': [statement('schema:keywords', 'wikibase-item', tag)],
      'schema:author': [
        statement('schema:author', 'wikibase-item', hiddenAuthor, {
          qualifiers: [
            {
              property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
              value: { type: 'value', content: { amount: '+1', unit: '1' } },
            },
          ],
        }),
      ],
    },
  };
  page.reads.r0.body.related = {
    [form]: { type: 'skos:Concept', labels: { en: 'Light novel' } },
    [tag]: { type: 'skos:Concept', labels: { en: 'Harem' } },
    [hiddenAuthor]: { type: 'schema:Person', labels: { en: 'Withheld Author Sentinel' } },
  } as Related;
  page.catalogue = { state: 'released', type: 'schema:Book', digest: bundledDigest, definitions };
  expect(publicationPropertiesFor('schema:Book', definitions)).toEqual([
    'schema:author',
    'schema:wordCount',
    'wdt:P7937',
    'schema:keywords',
  ]);
  expect(
    literarySelected(page.reads.r0.body.subject as Subject, 'schema:keywords', defaultReader).map(
      (statement) => statement.value.content,
    ),
  ).toEqual([tag]);
  const json = JSON.parse(subjectPageJsonLd(page, 'en', { origin: 'https://public.example.test' })!);
  expect(json.wordCount).toBe(1_200_001);
  expect(JSON.stringify(json.additionalType)).toContain('Light novel');
  expect(JSON.stringify(json.keywords)).toContain('Harem');
  expect(JSON.stringify(json)).not.toContain('Withheld Author Sentinel');
  expect(json).not.toHaveProperty('author');
});

test('configured public origin is the only host in sharing metadata and JSON-LD', () => {
  const page = structuredClone(recorded) as SubjectPageData;
  const origin = 'https://canonical.example.test';
  const json = JSON.parse(subjectPageJsonLd(page, 'en', { origin })!);
  expect(json.url.startsWith(`${origin}/`)).toBe(true);
  expect(json.url).not.toContain('untrusted-host.invalid');
  expect(json.image === undefined || JSON.stringify(json.image).includes(origin)).toBe(true);
});

test('Person, Organization and automated agent JSON-LD publish sameAs and omit withheld links', () => {
  const origin = 'https://public.example.test';
  const hidden = 'https://secret.invalid/private';
  for (const [type, schemaType] of [
    ['schema:Person', 'Person'],
    ['schema:Organization', 'Organization'],
    ['schema:SoftwareApplication', 'SoftwareApplication'],
  ] as const) {
    const page = structuredClone(recorded) as SubjectPageData;
    page.reads.r0.body.subject = {
      ...(recorded.reads.r0.body.subject as Subject),
      type,
      labels: { en: 'Lantern Agent' },
      descriptions: { en: 'A public catalogue agent.' },
      statements: {
        'schema:sameAs': [
          statement('schema:sameAs', 'url', 'https://wikidata.org/entity/Q1'),
          statement('schema:sameAs', 'url', hidden, {
            qualifiers: [
              {
                property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
                value: { type: 'value', content: { amount: '+1', unit: '1' } },
              },
            ],
          }),
        ],
      },
    };
    page.catalogue = { state: 'released', type, digest: bundledDigest, definitions };
    const json = JSON.parse(
      subjectPageJsonLd(page, 'en', { origin, schemaOrgType: `https://schema.org/${schemaType}` })!,
    );
    expect(json['@type']).toBe(schemaType);
    expect(json.sameAs).toBe('https://wikidata.org/entity/Q1');
    expect(JSON.stringify(json)).not.toContain(hidden);
  }
});
