import { expect, test } from 'bun:test';
import {
  documentRead,
  MAX_PAGE_DOCUMENTS,
  pageDocumentReferences,
  resolveTemplate,
  type PresentationProfile,
  type CompositionDocument,
} from '../src/index.ts';

import profile from '../profiles/platform.json';

const id = '019a0000-0000-8000-8000-000000000001';
const document = '019a0000-0000-8000-8000-000000000002';
const candidate = '019a0000-0000-8000-8000-000000000003';
const reference = { document, digest: 'a'.repeat(64), language: 'en' };
const row = (content: unknown, rank = 'normal', id = candidate, qualifiers?: unknown[]) => ({
  id,
  rank,
  property: { id: 'schema:abstract', data_type: 'document' },
  value: { type: 'value', content },
  ...(qualifiers === undefined ? {} : { qualifiers }),
});
const page = (...content: CompositionDocument['content']): CompositionDocument => ({ root: { props: {} }, content });

test('the internal document descriptor names only configured statement surfaces on the disclosed subject', () => {
  const configured = page({ type: 'Statements', props: { id: 'facts', properties: ['schema:abstract'] } });
  expect(documentRead(configured, id, ['schema:recipeInstructions'])).toEqual({
    kind: 'documents',
    id,
    properties: ['schema:abstract'],
  });
  expect(documentRead(configured, null, ['schema:abstract'])).toBeNull();
  expect(documentRead(page({ type: 'SubjectHeader', props: { id: 'header' } }), id, ['schema:abstract'])).toBeNull();
  expect(
    documentRead(page({ type: 'MoreStatements', props: { id: 'more' } }), id, [
      'schema:recipeInstructions',
      'schema:abstract',
    ]),
  ).toEqual({
    kind: 'documents',
    id,
    properties: ['schema:abstract', 'schema:recipeInstructions'],
  });
  expect(MAX_PAGE_DOCUMENTS).toBe(15);
});

test('document selection follows current best rank, unknown snaks and the reader/original language chain', () => {
  const subject = {
    statements: {
      'schema:name': [{ rank: 'normal', value: { type: 'value', content: { language: 'ja', text: '米' } } }],
      'schema:abstract': [row(reference), row({ ...reference, language: 'ja' })],
    },
  };
  expect(pageDocumentReferences(subject, ['schema:abstract'], 'fr')).toEqual([
    { candidate, ...reference, language: 'ja' },
  ]);
  expect(pageDocumentReferences(subject, ['schema:abstract'], 'en')).toEqual([{ candidate, ...reference }]);
  expect(pageDocumentReferences(subject, ['schema:recipeInstructions'], 'en')).toEqual([]);
  subject.statements['schema:abstract'] = [
    row(reference),
    { ...row(reference, 'preferred'), value: { type: 'somevalue', content: undefined } },
  ];
  expect(pageDocumentReferences(subject, ['schema:abstract'], 'en')).toEqual([]);
  expect(
    pageDocumentReferences(
      { statements: { 'schema:abstract': [row({ language: 'en', document: { doc: {} } })] } },
      ['schema:abstract'],
      'en',
    ),
  ).toEqual([]);
  const earlier = '019a0000-0000-8000-8000-000000000000';
  const later = '019a0000-0000-8000-8000-000000000004';
  expect(
    pageDocumentReferences(
      {
        statements: {
          'schema:abstract': [
            row({ ...reference, document: '019a0000-0000-8000-8000-000000000005' }, 'normal', later),
            row({ ...reference, document: '019a0000-0000-8000-8000-000000000006' }, 'normal', earlier),
            row(reference, 'preferred', '019a0000-0000-8000-8000-000000000007', [
              {
                property: { id: 'rezics:spoilerLevel' },
                value: { type: 'value', content: { amount: '+1', unit: '1' } },
              },
            ]),
          ],
        },
      },
      ['schema:abstract'],
      'en',
    ),
  ).toEqual([
    {
      candidate: earlier,
      document: '019a0000-0000-8000-8000-000000000006',
      digest: reference.digest,
      language: 'en',
    },
  ]);
});

test('the shipped Recipe configuration selects instructions and its shared summary without another renderer', () => {
  const page = resolveTemplate(profile as PresentationProfile, { type: 'schema:Recipe' }).document;
  expect(documentRead(page, id, [], candidate)).toEqual({
    kind: 'documents',
    id,
    context: candidate,
    properties: [
      'schema:abstract',
      'schema:author',
      'schema:cookTime',
      'schema:datePublished',
      'schema:recipeIngredient',
      'schema:recipeInstructions',
      'schema:recipeYield',
      'schema:suitableForDiet',
    ],
  });
});
