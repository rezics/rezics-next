import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { subjectJsonLd } from '../src/features/pages/jsonld.ts';

test('public rank, document language and source order are independent of concealed statements', () => {
  const subject = '019a0000-0000-8000-8000-000000000001';
  const documentBodies: Record<string, unknown> = {};
  const statement = (content: unknown, rank = 'normal', amount?: string, data_type = 'string') => ({
    id: crypto.randomUUID(),
    rank,
    property: { id: data_type === 'document' ? 'schema:recipeInstructions' : 'schema:recipeYield', data_type },
    value: { type: 'value', content },
    qualifiers:
      amount === undefined
        ? []
        : [{ property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount } } }],
  });
  const document = (language: string, rank = 'normal', amount?: string) => {
    const body = fromPlainText(language);
    const row = statement(
      { language, document: crypto.randomUUID(), digest: 'a'.repeat(64) },
      rank,
      amount,
      'document',
    );
    documentBodies[row.id] = {
      id: (row.value.content as { document: string }).document,
      subjectId: subject,
      candidateId: row.id,
      digest: 'a'.repeat(64),
      language,
      availability: 'available',
      body,
    };
    return row;
  };
  const build = (values: unknown[], documents: unknown[]) =>
    subjectJsonLd({
      subject: {
        id: subject,
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
      documents: Object.fromEntries(
        documents.flatMap((row) => {
          if (!row || typeof row !== 'object' || !('id' in row) || typeof row.id !== 'string') return [];
          const body = documentBodies[row.id];
          return body === undefined ? [] : [[row.id, body] as const];
        }),
      ),
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
