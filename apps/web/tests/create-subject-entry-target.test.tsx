import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreateSubjectEntry } from '../src/features/catalogue/create-subject-entry';

test('creation is a pre-hydration anchor with wrapping, phone-sized and keyboard-focus styles', () => {
  const html = renderToStaticMarkup(<CreateSubjectEntry locale="de" />);
  expect(html).toContain('href="/de/catalogue/new"');
  for (const token of ['h-auto', 'min-h-11', 'min-w-11', 'max-w-full', 'whitespace-normal', 'focus-visible:outline-2'])
    expect(html).toContain(token);
  expect(html).not.toContain('whitespace-nowrap');
});
