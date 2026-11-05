import { expect, test } from 'bun:test';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { subjectHead } from '../src/features/pages/subject-head.ts';

const head = (page: any) =>
  subjectHead(page, { origin: 'https://rezics.example.test', locale: 'en', path: '/en/subjects/fixture' } as never);

test('visible statements determine Subject release year and indexing eligibility', () => {
  const page = structuredClone(recordedPage) as any;
  const body = page.reads.r0.body;
  const subject = body.subject;
  const normal = subject.statements['schema:datePublished'][0];
  normal.value.content.time = '+2021-00-00T00:00:00Z';
  const preferred = structuredClone(normal);
  preferred.rank = 'preferred';
  preferred.value.content.time = '+2099-00-00T00:00:00Z';
  preferred.qualifiers = [
    {
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '+1', unit: '1' } },
    },
  ];
  subject.statements = { 'schema:datePublished': [normal, preferred] };
  subject.descriptions = {};
  body.summary = null;

  const visible = head(page);
  expect(JSON.stringify(visible.meta)).toContain('2021');
  expect(JSON.stringify(visible.meta)).not.toContain('noindex, follow');

  subject.statements = { 'schema:datePublished': [preferred] };
  expect(JSON.stringify(head(page).meta)).toContain('noindex, follow');
});
