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
const work = { id: id('1'), label: 'Shared work', labelLanguage: 'en' };

test('available Work links return to the exact localized inventory address', async () => {
  const returnTo = copyInventoryReturnHref({ subjectId: id('9'), cursor: 'opaque-next' }, 'en')!;
  const context: CopyReadingContext = { state: 'available', work: [work], facts: [] };
  const window = new Window({ url: 'https://rezics.test' });
  try {
    const root = window.document.createElement('main');
    root.innerHTML = renderToStaticMarkup(
      <>
        <CopyReadingContextView context={context} returnTo={returnTo} locale="en" />
        <CopyReadingContextView context={context} returnTo={returnTo} locale="en" />
      </>,
    );
    const links = [...root.querySelectorAll('a')];
    expect(links.map((link) => link.textContent)).toEqual(['Shared work', 'Shared work']);
    for (const link of links) {
      const destination = new URL(link.href);
      const via = new URL(destination.searchParams.get('via')!, 'https://rezics.test');
      expect(destination.pathname.split('/')[3]).toBe(work.id);
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

test('every native state is distinct and hidden states render no nested identity', async () => {
  const states: Array<[CopyReadingContext, string]> = [
    [{ state: 'available', work: [work], facts: [] }, m.library_copy_reading_context_available()],
    [{ state: 'unsupported', facts: [] }, m.library_copy_reading_context_unsupported()],
    [{ state: 'scope' }, m.library_copy_reading_context_scope()],
    [{ state: 'withheld' }, m.library_copy_reading_context_withheld()],
    [{ state: 'missing' }, m.library_copy_reading_context_missing()],
    [{ state: 'unavailable' }, m.library_copy_reading_context_unavailable()],
  ];
  const window = new Window({ url: 'https://rezics.test' });
  try {
    const root = window.document.createElement('main');
    root.innerHTML = renderToStaticMarkup(
      <>
        {states.map(([context]) => (
          <CopyReadingContextView key={context.state} context={context} locale="en" />
        ))}
        <CopyReadingContextView locale="en" />
      </>,
    );
    const entries = [...root.querySelectorAll<HTMLElement>('[data-slot="copy-reading-context"]')];
    expect(entries.map((entry) => entry.querySelector('p')?.textContent)).toEqual([
      ...states.map(([, label]) => label),
      m.library_copy_reading_context_unavailable(),
    ]);
    expect(entries.slice(2).every((entry) => entry.querySelector('a') === null)).toBe(true);
    expect(entries.map((entry) => entry.textContent).join(' ')).not.toContain(id('1'));
  } finally {
    await window.happyDOM.close();
  }
});
