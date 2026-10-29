import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContinueSection } from '../src/library/continue';

test('Continue reserves height while its personal read is pending', () => {
  const html = renderToStaticMarkup(createElement(ContinueSection, { entries: [], locale: 'en' }));
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('min-h-[20rem] sm:min-h-[24rem]');
  expect(html).not.toContain('data-slot="cover-card"');
});

test('loaded Continue cards replace the reservation without a minimum-height wrapper', () => {
  const html = renderToStaticMarkup(
    createElement(ContinueSection, {
      entries: [{ subjectId: 'book', label: 'A book in progress', summary: null, progress: null }],
      locale: 'en',
    }),
  );
  expect(html).toContain('A book in progress');
  expect(html).toContain('data-slot="cover-card"');
  expect(html).not.toContain('min-h-');
});
