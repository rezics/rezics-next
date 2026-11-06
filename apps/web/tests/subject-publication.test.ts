import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { RecipePublicationEntry } from '../src/features/pages/recipe-publication';
import { recipePublicationReading } from '../src/features/pages/recipe-publication/model';
import { ReleasePublicationEntry } from '../src/features/pages/release-publication';
import { releasePublicationReading } from '../src/features/pages/release-publication/model';
import {
  publicationPropertiesFor,
  publicPublicationStatements,
  relatedSameAs,
  subjectPublicationFields,
} from '../src/features/pages/subject-metadata';
import { subjectPageJsonLd, type SubjectPageData } from '../src/features/pages/subject';
import type { Stmt } from '../src/features/pages/shared';
import type { Related, Subject } from '../src/subject/types';
import recorded from '../src/kernel/recorded/subject-page.json';

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
    createElement(RecipePublicationEntry, {
      subject,
      related: recipeRelated,
      documents: recipeDocuments,
      definitions,
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
    createElement(ReleasePublicationEntry, {
      subject,
      related: { [platform]: { type: 'skos:Concept', labels: { en: 'Nintendo Switch' } } },
      definitions,
      locale: 'en',
    }),
  );
  expect(html).toContain('data-slot="release-publication"');
  expect(html).toContain('Nintendo Switch');
  expect(html).toContain('2025-03-04');
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
