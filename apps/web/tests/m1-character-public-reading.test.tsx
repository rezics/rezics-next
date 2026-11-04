import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createHash } from 'node:crypto';
import * as start from '../.storybook/react-start';
import { peopleFactsExample } from '../src/features/catalogue/people-facts/examples';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
const { CharacterReader } = await import('../src/features/pages/showcase-people/character');

test('the Character profile uses exact native documents and withholds mismatched or unavailable bodies', () => {
  const fixture = peopleFactsExample(true);
  const body = fromPlainText('The supplied public Character biography.');
  const digest = createHash('sha256').update(serializeDocument(body)).digest('hex');
  const document = '00000000-0000-4000-8000-000000000099';
  const statement = fixture.statement('schema:abstract', { document, digest, language: 'en' }, 'document');
  fixture.read.subject.statements = { 'schema:abstract': [statement] };
  const exact = {
    id: document,
    subjectId: fixture.read.subject.id,
    candidateId: statement.id,
    digest,
    language: 'en',
    availability: 'available',
    body,
    revision: 1,
    origin: 'account',
    author: fixture.read.subject.id,
    licence: 'CC-BY-4.0',
  };
  const render = (value: unknown) =>
    renderToStaticMarkup(
      createElement(CharacterReader, {
        public: { ...fixture.read, documents: { [statement.id]: value } } as typeof fixture.read,
        locale: 'en',
        release: fixture.release,
      }),
    );
  expect(render(exact)).toContain('The supplied public Character biography.');
  for (const mismatch of [
    { id: 'other' },
    { subjectId: 'other' },
    { candidateId: 'other' },
    { digest: '0'.repeat(64) },
    { language: 'ja' },
    { availability: 'erased' },
    { body: {} },
  ])
    expect(render({ ...exact, ...mismatch })).not.toContain('The supplied public Character biography.');
});
