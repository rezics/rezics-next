import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { subjectJsonLd } from '../src/features/pages/jsonld.ts';

test('the actual released minute quantity publishes a schema.org Recipe Duration', () => {
  const subject = {
    id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01',
    type: 'schema:Recipe',
    labels: { en: 'Public native recipe' },
    descriptions: {},
    aliases: {},
    statements: {
      'schema:cookTime': [
        {
          id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02',
          rank: 'normal',
          property: { id: 'schema:cookTime', data_type: 'quantity' },
          value: { type: 'value', content: { amount: '+25', unit: 'http://www.wikidata.org/entity/Q7727' } },
          qualifiers: [],
          references: [],
        },
      ],
    },
  };
  const jsonld = subjectJsonLd({
    subject,
    related: {},
    locale: 'en',
    url: 'https://rezics.com/en/subjects/recipe',
  } as never);
  expect(jsonld['@type']).toBe('Recipe');
  expect(jsonld.cookTime).toBe('PT25M');
});

test('Recipe diet, ingredients and instructions match the public statements and related sameAs', () => {
  const diet = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
  const instructionId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e12';
  const documentId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e13';
  const digest = 'a'.repeat(64);
  const jsonld = subjectJsonLd({
    subject: {
      id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01',
      type: 'schema:Recipe',
      labels: { en: 'Garden Lantern Soup' },
      descriptions: { en: 'A quick vegetarian soup.' },
      aliases: {},
      statements: {
        'schema:cookTime': [
          {
            id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02',
            rank: 'normal',
            property: { id: 'schema:cookTime', data_type: 'quantity' },
            value: { type: 'value', content: { amount: '+25', unit: 'http://www.wikidata.org/entity/Q7727' } },
            qualifiers: [],
            references: [],
          },
        ],
        'schema:suitableForDiet': [
          {
            id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e14',
            rank: 'normal',
            property: { id: 'schema:suitableForDiet', data_type: 'wikibase-item' },
            value: { type: 'value', content: diet },
            qualifiers: [],
            references: [],
          },
        ],
        'schema:recipeIngredient': [
          {
            id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e15',
            rank: 'normal',
            property: { id: 'schema:recipeIngredient', data_type: 'monolingualtext' },
            value: { type: 'value', content: { language: 'en', text: '2 carrots' } },
            qualifiers: [],
            references: [],
          },
          {
            id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e16',
            rank: 'normal',
            property: { id: 'schema:recipeIngredient', data_type: 'monolingualtext' },
            value: { type: 'value', content: { language: 'en', text: '1 litre water' } },
            qualifiers: [],
            references: [],
          },
        ],
        'schema:recipeInstructions': [
          {
            id: instructionId,
            rank: 'normal',
            property: { id: 'schema:recipeInstructions', data_type: 'document' },
            value: { type: 'value', content: { language: 'en', document: documentId, digest } },
            qualifiers: [],
            references: [],
          },
        ],
      },
    },
    related: {
      [diet]: {
        type: 'skos:Concept',
        labels: { en: 'Vegetarian' },
        sameAs: 'https://schema.org/VegetarianDiet',
      },
    },
    documents: {
      [instructionId]: {
        id: documentId,
        subjectId: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01',
        candidateId: instructionId,
        digest,
        language: 'en',
        availability: 'available',
        body: fromPlainText('Chop the carrots.'),
      },
    },
    locale: 'en',
    url: 'https://rezics.com/en/subjects/recipe',
  } as never);
  expect(jsonld.cookTime).toBe('PT25M');
  expect(JSON.stringify(jsonld.suitableForDiet)).toContain('VegetarianDiet');
  expect(jsonld.recipeIngredient).toEqual(['2 carrots', '1 litre water']);
  expect(JSON.stringify(jsonld.recipeInstructions)).toContain('Chop the carrots.');
});
