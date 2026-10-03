import { resourceHref } from '../features/address/path.ts';
import { beforeAll, describe, expect, test } from 'bun:test';
import { pagingOf } from '../features/work-page/also-enjoyed-row.tsx';
import {
  alsoEnjoyedGroups,
  alsoEnjoyedTitle,
  alsoEnjoyedWork,
} from '../features/work-page/also-enjoyed.tsx';
import * as fixture from '../features/work-page/fixtures.ts';
import { messages } from '../features/work-page/messages.ts';
import { REVIEWS_ANCHOR } from '../features/work-page/ratings.tsx';
import { REVIEWS_REGION } from '../features/work-page/reviews.tsx';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';

beforeAll(seedServedTypes);

describe('Readers also enjoyed', () => {
  test('each reason Main gives is its own row, in Main’s order', () => {
    const groups = alsoEnjoyedGroups([
      ...fixture.coReaderPicks.slice(0, 2),
      ...fixture.similarPicks,
      ...fixture.realmPicks.slice(0, 1),
    ]);
    expect(groups.map((group) => [group.basis, group.works.length])).toEqual([
      ['co-readers', 2],
      ['similar', 2],
      ['realm', 1],
    ]);
    expect(alsoEnjoyedGroups([])).toEqual([]);
  });

  test('a card opens the Work, draws its cover by Work id and kind, and carries Goodreads’ rating', () => {
    const [book] = fixture.coReaderPicks;
    expect(alsoEnjoyedWork(book!)).toMatchObject({
      id: book!.id,
      href: resourceHref('/w/', book!.id.slice(-36)),
      kind: 'book',
      authors: [{ name: 'Benjamin Wood', href: '/authors/open-library/OL1A' }],
      rating: { mean: 4, count: 94, max: 5 },
    });
    expect(alsoEnjoyedWork(fixture.realmPicks[1]!)).toMatchObject({
      kind: 'package',
      rating: null,
    });
  });

  test('titles say why: co-readers, likeness or a named community', () => {
    const title = (
      basis: 'co-readers' | 'similar' | 'realm',
      book: boolean,
      realms = fixture.realms.slice(0, 1),
      locale: 'en' | 'zh-Hans' = 'en',
    ) => alsoEnjoyedTitle(basis, { book, realms }, messages[locale], locale);
    expect(title('co-readers', true)).toBe('Readers also enjoyed');
    expect(title('similar', true)).toBe('Similar books');
    expect(title('similar', false)).toBe('Similar works');
    expect(title('realm', true)).toBe('More from Tidewater Readers');
    // Main draws on the first communities featuring the Work; with several it cannot say whose each card is.
    expect(title('realm', true, fixture.realms)).toBe('More from the communities that feature it');
    expect(title('realm', true, [])).toBe('More from the communities that feature it');
    expect(title('co-readers', true, [], 'zh-Hans')).toBe('读过的人也喜欢');
    expect(title('realm', true, fixture.realms.slice(1), 'zh-Hans')).toBe(
      '海洋文学研究会的更多作品',
    );
  });

  test('a page is as many whole cards as fit, and the row’s end is its last page', () => {
    // Four 166-pixel cards and three 24-pixel gaps fill a 736-pixel column.
    const wide = { width: 736, scrollWidth: 9 * 190 - 24, stride: 190, gap: 24, count: 9 };
    expect(pagingOf({ ...wide, offset: 0 })).toEqual({
      page: 0,
      pages: 3,
      perPage: 4,
      start: true,
      end: false,
    });
    expect(pagingOf({ ...wide, offset: 760 })).toMatchObject({ page: 1, start: false, end: false });
    expect(pagingOf({ ...wide, offset: wide.scrollWidth - wide.width })).toMatchObject({
      page: 2,
      end: true,
    });
    // A phone shows two cards and a peek of the third.
    expect(
      pagingOf({
        offset: 0,
        width: 358,
        scrollWidth: 9 * 166 - 16,
        stride: 166,
        gap: 16,
        count: 9,
      }),
    ).toMatchObject({ perPage: 2, pages: 5 });
    // Everything fits: one page, both edges reached; a row not yet laid out is one page too.
    expect(
      pagingOf({ offset: 0, width: 736, scrollWidth: 736, stride: 190, gap: 24, count: 3 }),
    ).toEqual({ page: 0, pages: 1, perPage: 4, start: true, end: true });
    expect(
      pagingOf({ offset: 0, width: 0, scrollWidth: 0, stride: 0, gap: 0, count: 4 }),
    ).toMatchObject({ pages: 1 });
  });
});

test('the header’s review count leads to the reviews section', () => {
  expect(REVIEWS_ANCHOR).toBe(REVIEWS_REGION);
});
