import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreateSubjectEntry } from '../src/features/catalogue/create-subject-entry';

test('creation renders a compact, wrapping anchor with a separate phone and coarse-pointer hitbox', () => {
  const html = renderToStaticMarkup(<CreateSubjectEntry locale="de" />);
  expect(html).toMatch(/^<a href="\/de\/catalogue\/new".*>Eintrag erstellen<\/a>$/);
  const classes = html.match(/class="([^"]+)"/)?.[1]?.split(' ');
  expect(classes).toEqual(
    expect.arrayContaining([
      'h-auto',
      'min-h-6',
      'max-md:hitbox-y-[11px]',
      'pointer-coarse:hitbox-y-[11px]',
      'max-w-full',
      'whitespace-normal',
      '[overflow-wrap:anywhere]',
      'focus-visible:outline-2',
      'focus-visible:outline-solid',
    ]),
  );
  expect(classes).not.toContain('whitespace-nowrap');
});
