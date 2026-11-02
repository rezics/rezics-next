import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { subjectJsonLd } from '../src/features/pages/jsonld.ts';

test('public rank, document language and source order are independent of concealed statements', () => {
  const statement = (content: unknown, rank = 'normal', amount?: string, data_type = 'string') => ({
    rank,
    property: { data_type },
    value: { type: 'value', content },
    qualifiers:
      amount === undefined
        ? []
        : [{ property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount } } }],
  });
  const document = (language: string, rank = 'normal', amount?: string) =>
    statement({ language, document: fromPlainText(language) }, rank, amount, 'document');
  const build = (values: unknown[], documents: unknown[]) =>
    subjectJsonLd({
      subject: {
        id: 'recipe',
        type: 'schema:Recipe',
        labels: { en: 'Public' },
        descriptions: {},
        aliases: {},
        statements: {
          'schema:recipeYield': values,
          'schema:recipeInstructions': documents,
          'schema:inLanguage': [statement('ja')],
        },
      },
      related: {},
      locale: 'fr',
      url: 'https://rezics.com/fr/subjects/recipe',
    } as never);
  const visible = [statement('First'), statement('Second'), statement('Deprecated', 'deprecated')];
  const documents = [document('en'), document('ja')];
  const expected = build(visible, documents);
  expect(expected.recipeYield).toEqual(['First', 'Second']);
  expect(expected.recipeInstructions).toEqual({ '@type': 'HowToStep', text: 'ja', inLanguage: 'ja' });
  for (const amount of ['1', '2', 'unreadable']) {
    expect(
      build(
        [...visible, statement('Concealed', 'preferred', amount)],
        [document('fr', 'preferred', amount), ...documents, document('fr', 'normal', amount)],
      ),
    ).toEqual(expected);
  }
  expect(
    build([...visible, statement('Preferred', 'preferred')], [...documents, document('en', 'preferred')]),
  ).toMatchObject({ recipeYield: 'Preferred', recipeInstructions: { text: 'en', inLanguage: 'en' } });
});
