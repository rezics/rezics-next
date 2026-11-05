import { expect, test } from 'bun:test';
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
