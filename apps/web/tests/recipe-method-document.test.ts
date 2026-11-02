import { expect, mock, test } from 'bun:test';
import type { CompositionDocument } from '@rezics/composition';
import { fromPlainText } from '@rezics/document';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { SubjectPageData } from '../src/features/pages/subject.tsx';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectPage } = await import('../src/features/pages/subject.tsx');

const subjectId = '019a0000-0000-8000-8000-000000000001';
const candidateId = '019a0000-0000-8000-8000-000000000003';
const documentId = '019a0000-0000-8000-8000-000000000010';
const method = 'Simmer gently for twenty-five minutes.';
const body = fromPlainText(method);
const digest = 'a'.repeat(64);
const composition = {
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'header' } },
    { type: 'Statements', props: { id: 'facts', properties: ['schema:recipeInstructions'] } },
  ],
} satisfies CompositionDocument;
const recipe = {
  id: subjectId,
  type: 'schema:Recipe',
  labels: { en: 'Rice' },
  descriptions: {},
  aliases: {},
  statements: {
    'schema:recipeInstructions': [
      {
        id: candidateId,
        rank: 'normal',
        property: { id: 'schema:recipeInstructions', data_type: 'document' },
        value: {
          type: 'value',
          content: { language: 'en', document: documentId, digest },
        },
        qualifiers: [],
        references: [],
      },
    ],
  },
};
const messages = { unknown: 'Unknown', none: 'None', unlabelled: 'Unlabelled', sources: 'Sources', aliases: 'Also known as' };

function renderPage(documents: Record<string, unknown>): string {
  const page = {
    subject: subjectId,
    profile: 'sha256:0',
    template: { scope: 'generic', key: null },
    document: composition,
    reads: {
      r0: {
        status: 200,
        body: {
          subject: recipe,
          related: { 'schema:recipeInstructions': { labels: { en: 'Instructions' } } },
          documents,
        },
      },
    },
  };
  return renderToString(createElement(SubjectPage, { page: page as SubjectPageData, locale: 'en', messages }));
}

test('Recipe pages render the page.read method body and omit withheld text from JSON-LD', () => {
  const available = renderPage({
    [candidateId]: {
      id: documentId,
      subjectId,
      candidateId,
      language: 'en',
      digest,
      availability: 'available',
      body,
    },
  });
  const visible = available.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  const serialized = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(available)?.[1];
  expect(serialized).toBeDefined();
  expect(visible).toContain(method);
  expect(visible.toLowerCase()).not.toContain('unavailable');
  expect(JSON.parse(serialized!).recipeInstructions).toEqual([
    { '@type': 'HowToStep', text: method, inLanguage: 'en' },
  ]);

  const withheld = renderPage({});
  const withheldJson = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(withheld)?.[1];
  expect(withheld.toLowerCase()).toContain('unavailable');
  expect(withheld).not.toContain(method);
  expect(withheldJson).toBeDefined();
  expect(JSON.parse(withheldJson!)).not.toHaveProperty('recipeInstructions');
});
