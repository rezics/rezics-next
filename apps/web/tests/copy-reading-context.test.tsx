import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyReadingContextView } from '../src/library/copy-reading-context/view';
import { copyInventoryReturnHref } from '../src/library/copy-reading-context/navigation';
import type { CopyReadingContext } from '../src/library/copy-reading-context/types';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const id = (tail: string) => `019a1b2c-3d4e-7f00-8a00-${tail.padStart(12, '0')}`;
const work = { id: id('1'), label: 'Shared work' };
const readingContext = (editionId: string): CopyReadingContext => ({
  association: 'available',
  work: [work],
  edition: { id: editionId, label: 'The Same Title' },
  facts: [],
});

test('same-title releases keep distinct destinations and return only to the same inventory address', async () => {
  const returnTo = copyInventoryReturnHref({ subjectId: id('9'), cursor: 'opaque-next' }, 'en')!;
  const html = renderToStaticMarkup(
    <>
      <CopyReadingContextView context={readingContext(id('2'))} returnTo={returnTo} locale="en" />
      <CopyReadingContextView context={readingContext(id('3'))} returnTo={returnTo} locale="en" />
    </>,
  );
  const window = new Window({ url: 'https://rezics.test' });
  try {
    const root = window.document.createElement('main');
    root.innerHTML = html;
    const editions = [...root.querySelectorAll('a')].filter((link) => link.textContent === 'The Same Title');
    expect(editions).toHaveLength(2);
    expect(editions.map((link) => new URL(link.href).pathname.split('/')[3])).toEqual([id('2'), id('3')]);
    for (const link of editions) {
      const destination = new URL(link.href);
      const via = new URL(destination.searchParams.get('via')!, 'https://rezics.test');
      expect(via.pathname).toBe('/en/library/copies');
      expect([...via.searchParams.keys()]).toEqual(['subjectId', 'cursor']);
      expect(via.searchParams.get('subjectId')).toBe(id('9'));
      expect(via.searchParams.get('cursor')).toBe('opaque-next');
      expect(link.href).not.toMatch(/private|note|source|location/i);
    }
    expect(subjectVisitReturn(`${returnTo}&source=private`, 'en')).toBeUndefined();
  } finally {
    await window.happyDOM.close();
  }
});

test('unavailable work association stays explicit and adds no inferred destination', async () => {
  const window = new Window({ url: 'https://rezics.test' });
  try {
    const root = window.document.createElement('main');
    root.innerHTML = renderToStaticMarkup(
      <CopyReadingContextView context={{ association: 'unavailable', work: [], facts: [] }} locale="en" />,
    );
    expect(root.textContent).toContain(m.library_copy_reading_context_unavailable());
    expect(root.querySelector('a')).toBeNull();
  } finally {
    await window.happyDOM.close();
  }
});
