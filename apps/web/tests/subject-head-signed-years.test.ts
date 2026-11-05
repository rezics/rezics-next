import { expect, test } from 'bun:test';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { subjectHead } from '../src/features/pages/subject-head.ts';

const context = { origin: 'https://rezics.example.test', locale: 'en', path: '/en/subjects/fixture' } as never;
const title = (page: any, time: string) => {
  page.reads.r0.body.subject.statements['schema:datePublished'][0].value.content.time = time;
  return JSON.stringify(subjectHead(page, context).meta);
};

test('Subject titles distinguish signed native years and retain modern presentation', () => {
  const page = structuredClone(recordedPage) as any;
  const negative = title(page, '-0001-00-00T00:00:00Z');
  const zero = title(page, '+0000-00-00T00:00:00Z');
  const positive = title(page, '+0001-00-00T00:00:00Z');

  expect(negative).toContain('2 BC');
  expect(zero).toContain('1 BC');
  expect(negative).not.toBe(positive);
  expect(zero).not.toBe(positive);
  expect(title(page, '+2021-00-00T00:00:00Z')).toContain('2021');
  expect(negative).not.toContain('noindex, follow');
});
